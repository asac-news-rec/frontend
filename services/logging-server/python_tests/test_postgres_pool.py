import os
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from logging_service.app import Settings, create_app
from logging_service.exporter import Exporter, LocalSink
from logging_service.postgres import INTAKE_LOCK, PostgresStore
from logging_service.postgres_pool import PooledPostgresStore, _IntakeSession, READER_NAMESPACE, lock_key
from logging_service.schema import InputError, iso

pytestmark = pytest.mark.skipif(not os.environ.get("TEST_POSTGRES_URL"), reason="Opt-in real PostgreSQL tests")


@pytest.fixture
def database():
    url = os.environ["TEST_POSTGRES_URL"]
    name = "logging_pool_test_" + uuid4().hex
    with psycopg.connect(url, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    config = conninfo_to_dict(url)
    config["dbname"] = name
    target = make_conninfo(**config)
    try:
        with closing(PostgresStore(target, initialize=True)):
            pass
        yield target
    finally:
        # Only this fixture's uniquely created disposable database is removed.
        with psycopg.connect(url, autocommit=True) as admin:
            admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))


def record(reader="reader", impression="imp", **changes):
    return dict(request_id="request", impression_id=impression, reader_id=reader,
                article_id="article", position=1, served_at=iso(int(time.time() * 1000)), **changes)


def event(impression="imp"):
    return dict(event_id=str(uuid4()), event_type="article_open", impression_id=impression,
                event_time=iso(int(time.time() * 1000)), page_type="list")


def test_export_pages_preserve_interval_payload_membership_and_retry(database, monkeypatch, caplog):
    import logging_service.postgres as postgres
    monkeypatch.setattr(postgres, "EXPORT_PREPARE_BATCH_SIZE", 2)
    now = int(time.time() * 1000)
    with closing(PostgresStore(database, now=lambda: now)) as store:
        rows = [record(f"reader-{i % 2}", f"imp-{i}") for i in range(7)]
        store.intake_served({"records": rows})
        for row in rows:
            store.intake_actions({"events": [event(row["impression_id"])]}, row["reader_id"], True)
        store.intake_served({"records": [record("revoked", "revoked"), record("outside", "outside")]})
        store.revoke("revoked")
        store.db.execute("UPDATE served_records SET received_at=? WHERE impression_id=?", (iso(now + 1000), "outside"))
        with caplog.at_level("INFO", logger="logging_service.postgres"):
            store.prepare_exports((iso(now), iso(now + 1000)), "test-interval")
        jobs = store.db.execute("SELECT * FROM export_jobs").fetchall()
        identities = {j["job_id"] for j in jobs}
        assert sum(j["row_count"] for j in jobs) == 14
        assert all(1 <= j["row_count"] <= 2 and j["object_name"].endswith(".jsonl.gz") for j in jobs)
        assert store.db.execute("SELECT count(*) FROM export_members").fetchone()[0] == 14
        for job in jobs:
            payload = [json.loads(line) for line in job["content"].splitlines()]
            assert len(payload) == job["row_count"]
            assert all(p["received_at"] == iso(now) for p in payload)
            if job["stream"] == "actions":
                assert all(p["source"] == "browser" and p["measurement_version"] == "stationary-visible-v1" for p in payload)
            else:
                assert all(p["reader_id"] == job["reader_id"] for p in payload)
        store.prepare_exports((iso(now), iso(now + 1000)), "test-interval")
        assert {j["job_id"] for j in store.jobs(True)} == identities
        messages = [r.message for r in caplog.records if r.message.startswith("logging_export_prepare_batch")]
        assert len(messages) == 8  # Four bounded pages for each stream.
        assert all("wait_ms=" in m and "work_ms=" in m and "failed=False" in m for m in messages)
        assert all("reader-" not in m and "imp-" not in m for m in messages)


def test_export_page_failure_rolls_back_only_page_and_retry_keeps_committed_jobs(database, monkeypatch):
    import logging_service.postgres as postgres
    monkeypatch.setattr(postgres, "EXPORT_PREPARE_BATCH_SIZE", 2)
    with closing(PostgresStore(database)) as store:
        store.intake_served({"records": [record(impression=f"imp-{i}") for i in range(5)]})
        insert = store._insert_export_groups
        calls = 0

        def fail_second_page(*args):
            nonlocal calls
            calls += 1
            result = insert(*args)
            if calls == 2:
                raise RuntimeError("simulated interruption before page commit")
            return result

        monkeypatch.setattr(store, "_insert_export_groups", fail_second_page)
        with pytest.raises(RuntimeError, match="simulated interruption"):
            store.prepare_exports()
        saved = store.jobs(True)
        assert len(saved) == 1 and saved[0]["row_count"] == 2
        assert store.db.execute("SELECT count(*) FROM export_members").fetchone()[0] == 2
        monkeypatch.setattr(store, "_insert_export_groups", insert)
        store.prepare_exports()
        assert sum(j["row_count"] for j in store.jobs(True)) == 5
        assert store.db.execute("SELECT count(*) FROM export_members").fetchone()[0] == 5
        assert store.get("export_jobs", "job_id", saved[0]["job_id"])["content_hash"] == saved[0]["content_hash"]


@pytest.mark.parametrize("pooled", [False, True])
def test_intake_progresses_between_export_pages_with_export_lease_held(database, monkeypatch, tmp_path, pooled):
    import logging_service.postgres as postgres
    monkeypatch.setattr(postgres, "EXPORT_PREPARE_BATCH_SIZE", 2)
    reached, release = threading.Event(), threading.Event()
    with closing(PostgresStore(database)) as worker, closing(
            PooledPostgresStore(database) if pooled else PostgresStore(database)) as intake:
        intake.intake_served({"records": [record(impression=f"imp-{i}") for i in range(5)]})
        batch = worker._prepare_export_batch

        def pause_after_commit(stream, after, *args):
            rows = batch(stream, after, *args)
            if stream == "served" and after == "":
                reached.set()
                assert release.wait(5)
            return rows

        monkeypatch.setattr(worker, "_prepare_export_batch", pause_after_commit)
        with ThreadPoolExecutor(max_workers=2) as threads:
            exporting = threads.submit(Exporter(worker, LocalSink(tmp_path)).flush, True)
            try:
                assert reached.wait(3)
                accepted = threads.submit(intake.intake_served, {"records": [record("new-reader", "new-imp")]})
                assert accepted.result(timeout=2)["results"][0]["status"] == "accepted"
                assert not exporting.done()
            finally:
                release.set()
            assert exporting.result(timeout=3) > 0


def test_export_rechecks_revocation_on_each_page(database, monkeypatch):
    import logging_service.postgres as postgres
    monkeypatch.setattr(postgres, "EXPORT_PREPARE_BATCH_SIZE", 2)
    with closing(PostgresStore(database)) as worker, closing(PostgresStore(database)) as revoker:
        worker.intake_served({"records": [record(impression=f"imp-{i}") for i in range(5)]})
        batch = worker._prepare_export_batch

        def revoke_after_first_page(stream, after, *args):
            rows = batch(stream, after, *args)
            if stream == "served" and after == "":
                revoker.revoke("reader")
            return rows

        monkeypatch.setattr(worker, "_prepare_export_batch", revoke_after_first_page)
        worker.prepare_exports()
        assert worker.db.execute("SELECT count(*) FROM export_members").fetchone()[0] == 2
        assert worker.jobs(True) == []  # Prepared jobs of a revoked reader cannot upload.


def test_different_readers_progress_while_one_transaction_is_paused(database, monkeypatch):
    reached, release = threading.Event(), threading.Event()
    original = _IntakeSession.capacity

    def pause(session, *args):
        if "slow-reader" in session.readers:
            reached.set()
            assert release.wait(5)
        return original(session, *args)

    monkeypatch.setattr(_IntakeSession, "capacity", pause)
    with closing(PooledPostgresStore(database)) as store, ThreadPoolExecutor(max_workers=2) as workers:
        slow = workers.submit(store.intake_served, {"records": [record("slow-reader", "slow")]})
        try:
            assert reached.wait(3)
            fast = workers.submit(store.intake_served, {"records": [record("fast-reader", "fast")]})
            assert fast.result(timeout=2)["results"][0]["status"] == "accepted"
            assert not slow.done()
        finally:
            release.set()
        assert slow.result(timeout=3)["results"][0]["status"] == "accepted"


def test_concurrent_duplicate_conflict_and_cross_reader_global_ids(database):
    with closing(PooledPostgresStore(database)) as store, ThreadPoolExecutor(max_workers=8) as workers:
        row = record()
        results = list(workers.map(lambda _: store.intake_served({"records": [row]})["results"][0]["status"], range(24)))
        assert results.count("accepted") == 1 and results.count("duplicate") == 23
        click = event()
        results = list(workers.map(lambda _: store.intake_actions({"events": [click]}, "reader", True)["results"][0]["status"], range(24)))
        assert results.count("accepted") == 1 and results.count("duplicate") == 23
        assert store.intake_actions({"events": [{**click, "event_type": "like"}]}, "reader", True)["results"][0]["code"] == "EVENT_ID_CONFLICT"
        # Both requests refer to one globally unique impression, with different reader locks.
        collisions = [{**row, "reader_id": f"r-{i}", "impression_id": "shared-id"} for i in range(8)]
        results = list(workers.map(lambda r: store.intake_served({"records": [r]})["results"][0], collisions))
        assert sum(r["status"] == "accepted" for r in results) == 1
        assert sum(r.get("code") == "IMPRESSION_ID_CONFLICT" for r in results) == 7
        assert store.readiness()["served"] == 2
        assert store.readiness()["actions"] == 1


def test_global_capacity_is_exact_under_parallel_readers_and_atomic_batch(database):
    with closing(PooledPostgresStore(database)) as store, ThreadPoolExecutor(max_workers=8) as workers:
        def send(i):
            try:
                store.intake_served({"records": [record(f"reader-{i}", f"imp-{i}")]}, max_records=7)
                return "accepted"
            except OverflowError:
                return "full"
        results = list(workers.map(send, range(24)))
        assert results.count("accepted") == 7 and results.count("full") == 17
        assert store.readiness()["served"] == 7
        with pytest.raises(InputError):
            store.intake_served({"records": [record("new", "valid"), record("new", "bad", score=True)]}, atomic=True)
        assert store.readiness()["served"] == 7


def test_multi_reader_batches_reverse_order_do_not_deadlock(database):
    with closing(PooledPostgresStore(database)) as store, ThreadPoolExecutor(max_workers=4) as workers:
        rows = [record(f"reader-{i}", f"imp-{i}") for i in range(10)]
        results = list(workers.map(lambda i: store.intake_served({"records": rows if i % 2 else list(reversed(rows))}, atomic=True), range(16)))
        assert sum(r["status"] == "accepted" for result in results for r in result["results"]) == 10
        assert store.readiness()["served"] == 10


def test_revocation_waits_for_intake_then_blocks_late_events(database, tmp_path, monkeypatch):
    reached, release = threading.Event(), threading.Event()
    original = _IntakeSession.insert_records

    def pause(session, *args):
        reached.set()
        assert release.wait(5)
        return original(session, *args)

    monkeypatch.setattr(_IntakeSession, "insert_records", pause)
    with closing(PooledPostgresStore(database)) as store, closing(PostgresStore(database)) as legacy, ThreadPoolExecutor(max_workers=2) as workers:
        incoming = workers.submit(store.intake_served, {"records": [record()]})
        try:
            assert reached.wait(3)
            deletion = workers.submit(Exporter(legacy, LocalSink(tmp_path)).delete, "reader")
            with pytest.raises(TimeoutError): deletion.result(timeout=.1)
        finally:
            release.set()
        assert incoming.result(timeout=3)["results"][0]["status"] == "accepted"
        deletion.result(timeout=3)
        assert legacy.counts() == {"served": 0, "actions": 0}
        assert store.intake_served({"records": [record()]})["results"][0]["code"] == "USER_REVOKED"
        with pytest.raises(InputError, match="USER_REVOKED"):
            store.intake_actions({"events": [event()]}, "reader", True)


def test_pool_exhaustion_and_lock_timeout_return_503_then_recover(database):
    config = Settings("pool-test-token-not-a-real-secret", database_url=database,
                      postgres_pool_enabled=True, postgres_pool_size=1, postgres_pool_timeout=.05)
    with TestClient(create_app(config), raise_server_exceptions=False) as client:
        client.headers["Authorization"] = "Bearer " + config.token
        body = {"records": [record()]}
        with client.app.state.store.pool.connection():
            assert client.post("/internal/served", json=body).status_code == 503
        with psycopg.connect(database, autocommit=True) as blocking:
            with blocking.transaction():
                blocking.execute("SELECT pg_advisory_xact_lock(%s)", (INTAKE_LOCK,))
                assert client.post("/internal/served", json=body).status_code == 503
        assert client.app.state.store.readiness()["served"] == 0
        assert client.post("/internal/served", json=body).json()["results"][0]["status"] == "accepted"
        assert client.post("/internal/served", json=body).json()["results"][0]["status"] == "duplicate"
        # A broken idle connection must never produce a successful ACK.
        with client.app.state.store.pool.connection() as connection:
            connection.close()
        assert client.post("/events", json={"events": [event()]}, headers={"x-news-reader": "reader", "x-collection-enabled": "true"}).json()["results"][0]["status"] == "accepted"


def test_full_pool_queue_returns_503_and_same_payload_retry_is_idempotent(database):
    config = Settings("pool-test-token-not-a-real-secret", database_url=database,
                      postgres_pool_enabled=True, postgres_pool_size=1, postgres_pool_timeout=5)
    with TestClient(create_app(config), raise_server_exceptions=False) as client:
        client.headers["Authorization"] = "Bearer " + config.token
        pool = client.app.state.store.pool
        body = {"records": [record()]}
        def borrow():
            with pool.connection():
                pass
        with ThreadPoolExecutor(max_workers=64) as workers:
            with pool.connection():
                pending = [workers.submit(borrow) for _ in range(64)]
                deadline = time.monotonic() + 3
                while pool.get_stats()["requests_waiting"] < 64 and time.monotonic() < deadline:
                    time.sleep(.01)
                assert pool.get_stats()["requests_waiting"] == 64
                response = client.post("/internal/served", json=body)
                assert response.status_code == 503
                assert response.json() == {"error": "STORAGE_UNAVAILABLE"}
            for future in pending:
                future.result(timeout=3)
        assert client.app.state.store.readiness()["served"] == 0
        assert client.post("/internal/served", json=body).json()["results"][0]["status"] == "accepted"
        assert client.post("/internal/served", json=body).json()["results"][0]["status"] == "duplicate"


def test_full_capacity_duplicate_invalid_and_atomic_rollback(database):
    with closing(PooledPostgresStore(database)) as store:
        row = record()
        store.intake_served({"records": [row]}, max_records=1)
        assert store.intake_served({"records": [row]}, atomic=True, max_records=1)["results"][0]["status"] == "duplicate"
        invalid = record("other", "bad", score=True)
        assert store.intake_served({"records": [invalid]}, max_records=1)["results"][0]["status"] == "rejected"
        with pytest.raises(InputError):
            store.intake_served({"records": [invalid]}, atomic=True, max_records=1)
        with pytest.raises(OverflowError):
            store.intake_served({"records": [record("other", "new")]}, atomic=True, max_records=1)
        assert store.readiness()["served"] == 1


def test_concurrent_delete_is_bounded_and_slot_recovers_after_failure(database, tmp_path, monkeypatch):
    reached, release = threading.Event(), threading.Event()
    monkeypatch.setattr("logging_service.gcs.GCSSink", lambda *args: LocalSink(tmp_path))
    original = Exporter.delete
    def failing_delete(self, reader):
        reached.set()
        assert release.wait(5)
        raise RuntimeError("synthetic deletion failure")
    config = Settings("pool-test-token-not-a-real-secret", database_url=database, postgres_pool_enabled=True)
    with TestClient(create_app(config), raise_server_exceptions=False) as client, ThreadPoolExecutor(max_workers=1) as workers:
        client.headers["Authorization"] = "Bearer " + config.token
        monkeypatch.setattr(Exporter, "delete", failing_delete)
        first = workers.submit(client.post, "/internal/delete-user", json={"reader_id": "reader"})
        try:
            assert reached.wait(3)
            # If another connection is attempted, this test fails instead of 503 DELETE_BUSY.
            with monkeypatch.context() as patch:
                def unexpected_connection(*args, **kwargs):
                    raise AssertionError("extra deletion connection")
                patch.setattr("logging_service.postgres.PostgresStore", unexpected_connection)
                busy = client.post("/internal/delete-user", json={"reader_id": "other"})
                assert busy.status_code == 503 and busy.json() == {"error": "DELETE_BUSY"}
                assert busy.headers["Retry-After"] == "1"
        finally:
            release.set()
        assert first.result(timeout=3).status_code == 503
        monkeypatch.setattr(Exporter, "delete", original)
        assert client.post("/internal/delete-user", json={"reader_id": "reader"}).json() == {"deleted": True}


def test_existing_export_format_and_new_arrivals_during_gcs_io(database, tmp_path):
    import json
    reached, release = threading.Event(), threading.Event()
    sink = LocalSink(tmp_path)
    original_put = sink.put

    def put(name, content):
        reached.set()
        assert release.wait(5)
        return original_put(name, content)

    sink.put = put
    with closing(PooledPostgresStore(database)) as store, closing(PostgresStore(database)) as legacy, ThreadPoolExecutor(max_workers=2) as workers:
        row = record()
        store.intake_served({"records": [row]})
        store.intake_actions({"events": [event()]}, "reader", True)
        exported = workers.submit(Exporter(legacy, sink).flush, True)
        try:
            assert reached.wait(3)
            assert store.intake_served({"records": [record("other", "late")]})["results"][0]["status"] == "accepted"
        finally:
            release.set()
        assert exported.result(timeout=3) == 2
        files = list(tmp_path.rglob("*.jsonl"))
        assert len(files) == 2
        served = next(json.loads(p.read_text()) for p in files if "served" in p.parts)
        assert {k: served[k] for k in row} == row
        assert "received_at" in served and "schema_version" not in served
        assert legacy.readiness()["pendingRecords"] == 1


def test_api_deletion_keeps_dedicated_export_connection_and_pool_usable(database, tmp_path, monkeypatch):
    sink = LocalSink(tmp_path)
    monkeypatch.setattr("logging_service.gcs.GCSSink", lambda *args: sink)
    config = Settings("pool-test-token-not-a-real-secret", database_url=database, postgres_pool_enabled=True)
    with TestClient(create_app(config)) as client:
        client.headers["Authorization"] = "Bearer " + config.token
        assert client.post("/internal/served", json={"records": [record()]}).status_code == 200
        with closing(PostgresStore(database)) as legacy:
            assert Exporter(legacy, sink).flush(True) == 1
        assert list(tmp_path.rglob("*.jsonl"))
        assert client.post("/internal/delete-user", json={"reader_id": "reader"}).json() == {"deleted": True}
        assert not list(tmp_path.rglob("*.jsonl"))
        assert client.post("/internal/served", json={"records": [record()]}).json()["results"][0]["code"] == "USER_REVOKED"
        assert client.post("/internal/served", json={"records": [record("another", "new")]}).json()["results"][0]["status"] == "accepted"


def test_reader_lock_is_shared_between_independent_pools(database, caplog):
    with closing(PooledPostgresStore(database)) as first, closing(PooledPostgresStore(database)) as second:
        with psycopg.connect(database, autocommit=True) as blocking:
            with blocking.transaction():
                blocking.execute("SELECT pg_advisory_xact_lock(%s,%s)", (READER_NAMESPACE, lock_key("blocked-reader")))
                assert first.intake_served({"records": [record("free-reader", "free")]})["results"][0]["status"] == "accepted"
                with pytest.raises(psycopg.errors.LockNotAvailable):
                    second.intake_served({"records": [record("blocked-reader", "blocked")]})
        assert second.intake_served({"records": [record("blocked-reader", "blocked")]})["results"][0]["status"] == "accepted"
        diagnostics = [r.getMessage() for r in caplog.records if "logging_pool_transaction" in r.getMessage()]
        assert diagnostics and "reader_wait_ms=" in diagnostics[0]
        assert all("blocked-reader" not in message for message in diagnostics)


def test_capacity_across_two_pools_and_legacy_writer(database):
    with closing(PooledPostgresStore(database)) as first, closing(PooledPostgresStore(database)) as second, closing(PostgresStore(database)) as legacy:
        # Include a legacy writer, as during a rolling deployment.
        stores = [first, second, legacy]
        def send(i):
            try:
                stores[i % 3].intake_served({"records": [record(f"r-{i}", f"i-{i}")]}, max_records=5)
                return True
            except OverflowError:
                return False
        with ThreadPoolExecutor(max_workers=6) as workers:
            assert sum(workers.map(send, range(18))) == 5
        assert legacy.counts() == {"served": 5, "actions": 0}
