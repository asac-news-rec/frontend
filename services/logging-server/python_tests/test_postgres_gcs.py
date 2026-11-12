import json
import os
import subprocess
import sys
import time
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from logging_service.app import Settings, create_app
from logging_service.exporter import Exporter
from logging_service.gcs import GCSSink
from logging_service.postgres import PostgresStore
from logging_service.schema import iso

pytestmark = pytest.mark.skipif(not os.environ.get("TEST_POSTGRES_URL") or not os.environ.get("STORAGE_EMULATOR_HOST"), reason="Opt-in PostgreSQL + GCS emulator integration")
TOKEN = "postgres-integration-test-token-only"


@pytest.fixture
def database():
    # Never truncate a supplied database. Create and remove only a unique test DB.
    url = os.environ["TEST_POSTGRES_URL"]
    name = "logging_test_" + uuid4().hex
    with psycopg.connect(url, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    config = conninfo_to_dict(url)
    config["dbname"] = name
    try:
        yield make_conninfo(**config)
    finally:
        with psycopg.connect(url, autocommit=True) as admin:
            admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))


@pytest.fixture
def sink():
    sink = GCSSink("integration-raw-logs", "local-integration", uuid4().hex)
    if not sink.bucket.exists():
        sink.client.create_bucket(sink.bucket)
    return sink


def records(now=None):
    stamp = iso(now if now is not None else int(time.time() * 1000))
    row = dict(request_id="req", impression_id="imp", reader_id="reader", article_id="a", position=1, served_at=stamp)
    event = dict(event_id=str(uuid4()), event_type="article_open", event_time=stamp, impression_id="imp", page_type="list")
    return row, event


def test_postgres_commit_ack_and_worker_receipt(database, sink):
    config = Settings(TOKEN, database_url=database, gcs_bucket=sink.bucket.name, gcs_project="local-integration", gcs_prefix=sink.prefix)
    row, event = records()
    metadata = dict(score=0.42, model_version="ctr-v3", features_as_of="2026-01-01T00:00:00.123456Z")
    row.update(metadata)
    with TestClient(create_app(config)) as client:
        client.headers["Authorization"] = f"Bearer {TOKEN}"
        assert client.post("/internal/served", json={"records": [row]}).json()["results"][0]["status"] == "accepted"
        headers = {"x-news-reader": "reader", "x-collection-enabled": "true"}
        assert client.post("/events", json={"events": [event]}, headers=headers).json()["results"][0]["status"] == "accepted"
        assert client.post("/events", json={"events": [event]}, headers=headers).json()["results"][0]["status"] == "duplicate"
        assert client.get("/ready").json()["exporter"]["mode"] == "external-worker"
    store = PostgresStore(database)
    assert store.counts() == {"served": 1, "actions": 1}
    assert Exporter(store, sink).flush(True) == 2
    jobs = store.db.execute("SELECT * FROM export_jobs").fetchall()
    assert all(j["status"] == "uploaded" and j["storage_receipt"]["generation"] for j in jobs)
    served_job = next(job for job in jobs if job["stream"] == "served")
    exported = json.loads(sink.bucket.blob(f"{sink.prefix}/{served_job['object_name']}").download_as_text())
    assert {key: exported[key] for key in metadata} == metadata
    assert store.db.execute("SELECT count(*) FROM pg_partitioned_table WHERE partrelid IN (SELECT oid FROM pg_class WHERE relnamespace='behavior_logging'::regnamespace)").fetchone()[0] == 0
    store.close()


def test_upload_ack_loss_reuses_same_name_generation(database, sink):
    row, event = records()
    store = PostgresStore(database)
    store.intake_served({"records": [row]})
    store.intake_actions({"events": [event]}, "reader", True)

    def fail_after_upload(job):
        raise OSError("process lost response after successful object write")

    assert Exporter(store, sink, fail_after_upload).flush(True) == 0
    jobs = store.jobs(True)
    generations = {}
    for job in jobs:
        blob = sink.blob(job["object_name"])
        blob.reload()
        generations[job["job_id"]] = str(blob.generation)
    store.close()
    store = PostgresStore(database)
    assert Exporter(store, sink).flush(True) == 2
    assert len(list(sink.client.list_blobs(sink.bucket, prefix=sink.prefix))) == 4
    for job in store.db.execute("SELECT * FROM export_jobs").fetchall():
        assert job["storage_receipt"]["generation"] == generations[job["job_id"]]
        assert sink.blob(job["object_name"]).download_as_bytes() == job["content"].encode()
    store.close()


def test_conflict_never_overwrites_and_failed_upload_stays_pending(database, sink):
    store = PostgresStore(database)
    row, _ = records()
    store.intake_served({"records": [row]})
    store.prepare_exports()
    job = store.jobs(True)[0]
    sink.put(job["object_name"], "different content")
    assert Exporter(store, sink).flush(True) == 0
    assert store.jobs(True)[0]["status"] == "prepared"
    assert sink.blob(job["object_name"]).download_as_bytes() == b"different content"
    store.close()


def test_multiple_api_connections_and_worker_lock(database, sink):
    store = PostgresStore(database)
    row, event = records()
    store.intake_served({"records": [row]})

    def receive(_):
        other = PostgresStore(database)
        try:
            return other.intake_actions({"events": [event]}, "reader", True)["results"][0]["status"]
        finally:
            other.close()

    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(receive, range(12)))
    assert results.count("accepted") == 1
    assert results.count("duplicate") == 11
    other = PostgresStore(database)
    with store.export_lock() as acquired:
        assert acquired
        assert Exporter(other, sink).flush(True) == 0
        # Intake uses a different transaction lock, so it is not blocked by GCS work.
        assert other.intake_actions({"events": [{**event, "event_id": str(uuid4())}]}, "reader", True)["results"][0]["status"] == "accepted"
    assert Exporter(other, sink).flush(True) == 2
    other.close()
    store.close()


def test_five_minute_event_time_and_late_arrival(database, sink):
    # Fixed clock ensures tests do not depend on today's calendar date.
    now = 1793664600000  # 2026-11-03T00:10:00Z
    store = PostgresStore(database, now=lambda: now)
    row, event = records(now - 301000)
    store.intake_served({"records": [row]})
    store.intake_actions({"events": [event]}, "reader", True)
    assert Exporter(store, sink).flush(True) == 2
    late = {**event, "event_id": str(uuid4())}
    store.intake_actions({"events": [late]}, "reader", True)
    assert Exporter(store, sink).flush(True) == 1
    jobs = store.db.execute("SELECT * FROM export_jobs WHERE stream='actions'").fetchall()
    assert len(jobs) == 2 and jobs[0]["partition_path"] == jobs[1]["partition_path"]
    assert jobs[0]["object_name"] != jobs[1]["object_name"]
    assert "minute=00" in jobs[0]["object_name"]
    store.close()


def test_actual_worker_process_and_delete(database, sink):
    store = PostgresStore(database)
    row, event = records()
    store.intake_served({"records": [row]})
    store.intake_actions({"events": [event]}, "reader", True)
    subprocess.run([sys.executable, "-m", "logging_service.worker", "--once", "--force"], check=True,
        cwd=Path(__file__).resolve().parents[1], env={**os.environ, "LOGGING_STORE": "postgres", "LOGGING_TOKEN": TOKEN,
            "LOGGING_DATABASE_URL": database, "GCS_BUCKET": sink.bucket.name, "GOOGLE_CLOUD_PROJECT": "local-integration", "GCS_PREFIX": sink.prefix})
    assert not store.jobs(True)
    Exporter(store, sink).delete("reader")
    assert store.counts() == {"served": 0, "actions": 0}
    assert not list(sink.client.list_blobs(sink.bucket, prefix=sink.prefix))
    store.close()


def test_manifest_ack_loss_and_db_reconnection(database, sink, monkeypatch):
    store = PostgresStore(database)
    row, event = records()
    store.intake_served({"records": [row]})
    # Simulate a closed backend connection. The next intake opens a new connection.
    store.connection.close()
    assert store.intake_actions({"events": [event]}, "reader", True)["results"][0]["status"] == "accepted"
    real_mark = store.mark

    def fail_state_commit(job, error=None, receipt=None):
        if error is None:
            raise OSError("lost database response after manifest upload")
        return real_mark(job, error)

    monkeypatch.setattr(store, "mark", fail_state_commit)
    assert Exporter(store, sink).flush(True) == 0
    before = {blob.name: str(blob.generation) for blob in sink.client.list_blobs(sink.bucket, prefix=sink.prefix)}
    assert len(before) == 4
    monkeypatch.setattr(store, "mark", real_mark)
    assert Exporter(store, sink).flush(True) == 2
    after = {blob.name: str(blob.generation) for blob in sink.client.list_blobs(sink.bucket, prefix=sink.prefix)}
    assert before == after
    store.close()


def test_postgres_file_batch_atomicity(database, sink):
    config = Settings(TOKEN, database_url=database)
    row, _ = records()
    with TestClient(create_app(config)) as client:
        client.headers["Authorization"] = f"Bearer {TOKEN}"
        assert client.post("/internal/served", json={"records": [row]}).status_code == 200
        rows = [{**row, "impression_id": "new-imp"}, {**row, "position": 2}]
        response = client.post("/internal/served-file", files={"file": ("feed.jsonl", "\n".join(json.dumps(r) for r in rows), "application/x-ndjson")}, data={"request_id": "req", "expected_item_count": "2"})
        assert response.status_code == 400
        assert client.get("/ready").json()["served"] == 1


def test_lost_worker_lease_delete_then_late_gcs_write_is_swept(database, sink):
    worker = PostgresStore(database)
    deleter = PostgresStore(database)
    row, _ = records()
    worker.intake_served({"records": [row]})
    before_write, resume = threading.Event(), threading.Event()
    original_put = sink.put

    class PausedSink:
        def put(self, name, content):
            if name.endswith(".jsonl"):
                before_write.set()
                assert resume.wait(10)
            return original_put(name, content)

        def remove(self, name):
            return sink.remove(name)

    pid = worker.connection.info.backend_pid
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(Exporter(worker, PausedSink()).flush, True)
        try:
            assert before_write.wait(10)
            with psycopg.connect(database, autocommit=True) as admin:
                admin.execute("SELECT pg_terminate_backend(%s)", (pid,))
            Exporter(deleter, sink).delete("reader")
            assert deleter.counts() == {"served": 0, "actions": 0}
            assert len(deleter.deletion_targets()) == 2
        finally:
            resume.set()
        with pytest.raises(Exception):
            future.result(timeout=10)
    worker.close()
    # The already-issued external upload can still finish after deletion.
    names = [b.name for b in sink.client.list_blobs(sink.bucket, prefix=sink.prefix)]
    assert len(names) == 1 and names[0].endswith(".jsonl")
    assert not deleter.jobs(True)
    recovered = PostgresStore(database)
    assert Exporter(recovered, sink).flush(True) == 0
    assert not list(sink.client.list_blobs(sink.bucket, prefix=sink.prefix))
    with pytest.raises(ValueError, match="USER_REVOKED"):
        recovered.intake_actions({"events": [records()[1]]}, "reader", True)
    recovered.close()
    deleter.close()
