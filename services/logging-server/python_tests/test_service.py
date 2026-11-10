import json
import shutil
import sqlite3
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from logging_service.app import ServiceLock, Settings, create_app
from logging_service.exporter import Exporter, LocalSink
from logging_service.schema import InputError, canonical, iso
from logging_service.store import Store, partition

TOKEN = "test-only-fastapi-logging-token-32"


def record(**changes):
    return dict(request_id="req-1", impression_id="imp-1", reader_id="reader-1", article_id="article-1", position=1,
                served_at=iso(int(time.time() * 1000)), **changes)


def event(kind="article_open", **changes):
    return {"event_id": str(uuid4()), "event_type": kind, "event_time": iso(int(time.time() * 1000)),
            "impression_id": "imp-1", "page_type": "detail" if kind == "article_close" else "list", **changes}


@pytest.fixture
def config(tmp_path):
    return Settings(TOKEN, str(tmp_path / "db.sqlite"), str(tmp_path / "objects"), 100)


@pytest.fixture
def client(config):
    with TestClient(create_app(config), raise_server_exceptions=False) as client:
        client.headers["Authorization"] = f"Bearer {TOKEN}"
        yield client


def accept(client):
    row = record()
    assert client.post("/internal/served", json={"records": [row]}).json()["results"][0]["status"] == "accepted"
    return row


def send(client, rows, reader="reader-1", source="browser"):
    return client.post("/events", json={"events": rows}, headers={"x-news-reader": reader, "x-collection-enabled": "true", "x-news-source": source})


def test_auth_health_openapi(client):
    assert client.get("/health", headers={"Authorization": ""}).json() == {"status": "alive"}
    assert client.get("/ready", headers={"Authorization": ""}).status_code == 401
    assert client.post("/events", json={"events": []}, headers={"Authorization": "Bearer invalid"}).status_code == 401
    assert client.get("/ready").headers["cache-control"] == "no-store"
    assert "HTTPBearer" in client.get("/openapi.json").json()["components"]["securitySchemes"]


def test_http_ack_identity_and_source(client):
    row = accept(client)
    assert client.post("/internal/served", json={"records": [row]}).json()["results"][0]["status"] == "duplicate"
    row["position"] = 2
    assert client.post("/internal/served", json={"records": [row]}).json()["results"][0]["code"] == "IMPRESSION_ID_CONFLICT"
    action = event()
    assert send(client, [action], source="simulator").json()["results"][0]["status"] == "accepted"
    assert send(client, [action], source="simulator").json()["results"][0]["status"] == "duplicate"
    assert send(client, [action]).json()["results"][0]["code"] == "EVENT_ID_CONFLICT"
    assert send(client, [event()], reader="other").json()["results"][0]["code"] == "IMPRESSION_FORBIDDEN"
    assert send(client, [event(impression_id="not-ready")]).json()["results"][0]["status"] == "retryable"
    assert send(client, [event("article_close")]).json()["results"][0]["status"] == "accepted"
    assert client.post("/events", json={"events": [action]}).status_code == 400


def test_input_limits_and_partial_ack(client):
    accept(client)
    assert client.post("/events", content="{}", headers={"Content-Type": "text/plain"}).status_code == 415
    assert client.post("/events", content="{", headers={"Content-Type": "application/json"}).status_code == 400
    assert client.post("/events", content="x" * 262145).status_code == 413
    assert client.post("/events", json={"events": []}).status_code == 400
    assert client.post("/events", json={"events": [event()] * 101}).status_code == 400
    action = event()
    result = send(client, [action, {**event(), "event_id": "bad"}, action]).json()["results"]
    assert [r["status"] for r in result] == ["accepted", "rejected", "duplicate"]
    assert send(client, [event("article_open", page_type="detail")]).json()["results"][0]["code"] == "INVALID_EVENT_FIELDS"
    assert send(client, [event(event_time="2026-02-30T00:00:00Z")]).json()["results"][0]["code"] == "INVALID_TIME"


def upload(client, rows, count=None, request="req-1"):
    return client.post("/internal/served-file", files={"file": ("feed.jsonl", "\n".join(json.dumps(r) for r in rows), "application/x-ndjson")},
                       data={"request_id": request, "expected_item_count": str(count if count is not None else len(rows))})


def test_file_atomic_commit_duplicate_and_conflict(client):
    row = record()
    assert upload(client, [row]).status_code == 200
    assert upload(client, [row]).json()["results"][0]["status"] == "duplicate"
    new = {**row, "impression_id": "imp-2"}
    conflict = {**row, "position": 2}
    assert upload(client, [new, conflict]).status_code == 400
    assert client.get("/ready").json()["served"] == 1  # New row rolls back too.
    assert upload(client, [new], count=2).status_code == 400
    assert upload(client, [new], request="wrong").status_code == 400
    assert upload(client, [new, new]).status_code == 400
    assert upload(client, [new]).status_code == 200


def test_capacity_batch_does_not_overfill(config):
    with TestClient(create_app(Settings(TOKEN, config.database, config.export_dir, 100, 1))) as client:
        client.headers["Authorization"] = f"Bearer {TOKEN}"
        row = record()
        result = client.post("/internal/served", json={"records": [row, {**row, "impression_id": "imp-2"}]})
        assert result.status_code == 503
        assert client.get("/ready").json()["served"] == 0
        assert upload(client, [row]).status_code == 200
        assert upload(client, [row]).status_code == 200
        assert send(client, [event()]).status_code == 503


def test_periodic_export_and_restart(config):
    row, action = record(), event()
    with TestClient(create_app(config)) as client:
        client.headers["Authorization"] = f"Bearer {TOKEN}"
        client.post("/internal/served", json={"records": [row]})
        send(client, [action])
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            ready = client.get("/ready").json()
            if ready["pendingRecords"] == 0 and ready["pendingJobs"] == 0:
                break
            time.sleep(.03)
        else:
            pytest.fail("periodic flush did not finish")
    files = list(Path(config.export_dir).rglob("*.jsonl"))
    assert len(files) == 2
    assert len(list(Path(config.export_dir).rglob("*.json"))) == 2
    with TestClient(create_app(config)) as client:
        client.headers["Authorization"] = f"Bearer {TOKEN}"
        assert send(client, [action]).json()["results"][0]["status"] == "duplicate"
        assert client.post("/internal/flush", json={}).status_code == 200
    assert list(Path(config.export_dir).rglob("*.jsonl")) == files


def test_revocation_deletes_files_and_blocks_late_actions(client, config):
    accept(client)
    send(client, [event()])
    client.post("/internal/flush", json={})
    assert client.post("/internal/delete-user", json={"reader_id": "reader-1"}).json() == {"deleted": True}
    assert client.get("/ready").json()["served"] == 0
    assert not list(Path(config.export_dir).rglob("*.jsonl"))
    assert send(client, [event()]).status_code == 403
    assert client.post("/internal/delete-user", json={"reader_id": "reader-1"}).status_code == 200


def test_export_recovery_and_collision(tmp_path):
    database, objects = tmp_path / "db.sqlite", tmp_path / "objects"
    store = Store(database)
    row = record()
    store.intake_served({"records": [row]})
    sink = LocalSink(objects)

    def crash(job):
        raise OSError("after file write")

    assert Exporter(store, sink, crash).flush() == 0
    original = store.jobs(True)[0]
    store.close()
    store = Store(database)
    exporter = Exporter(store, sink)
    assert exporter.flush(True) == 1
    assert (objects / original["object_name"]).read_text() == original["content"]
    with pytest.raises(ValueError, match="OBJECT_CONTENT_CONFLICT"):
        sink.put(original["object_name"], "different")
    with pytest.raises(ValueError, match="INVALID_OBJECT_PATH"):
        sink.put("../escape", "bad")
    exporter.delete("reader-1")
    store.close()


def test_deletion_failure_keeps_tombstone(tmp_path, monkeypatch):
    store = Store(tmp_path / "db.sqlite")
    sink = LocalSink(tmp_path / "objects")
    exporter = Exporter(store, sink)
    store.intake_served({"records": [record()]})
    exporter.flush()
    original = sink.remove
    monkeypatch.setattr(sink, "remove", lambda name: (_ for _ in ()).throw(OSError("disk error")))
    with pytest.raises(OSError):
        exporter.delete("reader-1")
    with pytest.raises(InputError, match="USER_REVOKED"):
        store.intake_actions({"events": [event()]}, "reader-1", True)
    assert exporter.flush(True) == 0
    monkeypatch.setattr(sink, "remove", original)
    exporter.delete("reader-1")
    assert store.counts() == {"served": 0, "actions": 0}
    store.close()


def test_storage_failure_rolls_back_batch(client):
    accept(client)
    store = client.app.state.store
    store.db.execute("CREATE TRIGGER fail_write BEFORE INSERT ON action_records BEGIN SELECT RAISE(ABORT,'disk failure'); END")
    assert send(client, [event(), event()]).status_code == 503
    assert store.counts()["actions"] == 0


def test_future_version_and_process_lock(tmp_path):
    database = str(tmp_path / "db.sqlite")
    with sqlite3.connect(database) as db:
        db.execute("PRAGMA user_version=6")
    with pytest.raises(RuntimeError, match="UNSUPPORTED_SCHEMA_VERSION"):
        Store(database)
    lease = ServiceLock(database)
    try:
        with pytest.raises(RuntimeError, match="LOGGING_ALREADY_RUNNING"):
            ServiceLock(database)
    finally:
        lease.close()
    ServiceLock(database).close()
    assert partition("2026-11-03T00:04:59.000Z") == "date=2026-11-03/hour=09/minute=00"
    assert partition("2026-11-03T09:04:59.000+09:00") == "date=2026-11-03/hour=09/minute=00"


def test_concurrent_duplicate_commits_once(tmp_path):
    store = Store(tmp_path / "db.sqlite")
    store.intake_served({"records": [record()]})
    click = event()
    try:
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: store.intake_actions({"events": [click]}, "reader-1", True)["results"][0]["status"], range(20)))
        assert results.count("accepted") == 1
        assert results.count("duplicate") == 19
        assert store.counts()["actions"] == 1
    finally:
        store.close()


def test_thousand_records_wake_export_worker(config):
    config = Settings(TOKEN, config.database, config.export_dir, 3600000)
    with TestClient(create_app(config)) as client:
        client.headers["Authorization"] = f"Bearer {TOKEN}"
        row = record()
        for batch in range(10):
            rows = [{**row, "impression_id": f"imp-{batch}-{n}"} for n in range(100)]
            assert client.post("/internal/served", json={"records": rows}).status_code == 200
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            ready = client.get("/ready").json()
            if ready["pendingRecords"] == ready["pendingJobs"] == 0:
                break
            time.sleep(.03)
        else:
            pytest.fail("1000 records did not wake the exporter")


@pytest.mark.parametrize("version", [1, 2, 3, 4, 5])
def test_legacy_versions_keep_data(tmp_path, version):
    database = tmp_path / "db.sqlite"
    root = Path(__file__).resolve().parents[1] / "logging_service"
    row, sample = record(), event()
    old = {key: value for key, value in row.items()}
    old = {"request_id": old["request_id"], "impression_id": old["impression_id"], "user_id": old["reader_id"],
           "article_id": old["article_id"], "position": old["position"], "served_at": old["served_at"]}
    with sqlite3.connect(database) as db:
        db.executescript((root / "migration_1.sql").read_text())
        raw, hashed = canonical(old)
        db.execute("INSERT INTO served_records VALUES(?,?,?,?,?,?,?,?,?)", (row["impression_id"], row["request_id"], row["reader_id"], row["article_id"], row["position"], row["served_at"], row["served_at"], raw, hashed))
        if version >= 2:
            db.executescript((root / "migration_2.sql").read_text())
        if version >= 3:
            db.executescript("ALTER TABLE export_jobs ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=3;")
    if version >= 4:
        store = Store(database)
        store.intake_actions({"events": [sample]}, "reader-1", True)
        store.close()
        if version == 4:
            with sqlite3.connect(database) as db:
                db.execute("PRAGMA user_version=4")
    store = Store(database)
    assert store.intake_served({"records": [row]})["results"][0]["status"] == "duplicate"
    if version >= 4:
        assert store.intake_actions({"events": [sample]}, "reader-1", True)["results"][0]["status"] == "duplicate"
    assert store.db.execute("PRAGMA user_version").fetchone()[0] == 5
    store.close()


@pytest.mark.skipif(not shutil.which("node"), reason="Node required only for migration interoperability test")
def test_node_database_hashes_and_prepared_jobs(tmp_path):
    service = Path(__file__).resolve().parents[1]
    database = tmp_path / "node.sqlite"
    code = """
import {openLoggingStore} from './repository.mjs';
const store=openLoggingStore({database:process.argv[1]});
const row={request_id:'req-é😀',impression_id:'imp-1',reader_id:'reader-1',article_id:'한글',position:1,served_at:new Date().toISOString()};
const action={event_id:'a964bf1d-4c32-48be-98b8-5fa4606b10c9',event_type:'exposure',event_time:row.served_at,impression_id:'imp-1',page_type:'list',duration_ms:1000,ended_at:new Date(Date.now()+1000).toISOString()};
store.intakeServed({internal:true},{records:[row]});store.intakeActions({readerId:'reader-1',collectionEnabled:true},{events:[action]});store.prepareExports();store.close();console.log(JSON.stringify({row,action}));
"""
    result = subprocess.run(["node", "--input-type=module", "-e", code, str(database)], cwd=service, capture_output=True, text=True, encoding="utf-8", check=True)
    payload = json.loads(result.stdout)
    store = Store(database)
    assert store.intake_served({"records": [payload["row"]]})["results"][0]["status"] == "duplicate"
    assert store.intake_actions({"events": [payload["action"]]}, "reader-1", True)["results"][0]["status"] == "duplicate"
    jobs = store.jobs(True)
    assert Exporter(store, LocalSink(tmp_path / "objects")).flush(True) == 2
    for job in jobs:
        assert (tmp_path / "objects" / job["object_name"]).read_bytes() == job["content"].encode()
    store.close()
