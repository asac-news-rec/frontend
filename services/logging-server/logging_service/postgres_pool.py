"""Pooled intake with reader/record locks; legacy workers keep their exclusive gate.

Lock order: shared INTAKE gate -> sorted readers -> sorted record IDs -> capacity.
The final capacity check and insertion remain serialized to preserve the exact
global limit. Validation and ownership/duplicate reads can run concurrently.
"""
import hashlib
import logging
import time
from contextlib import closing, contextmanager, nullcontext

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .postgres import Database, INTAKE_LOCK, PostgresStore
from .schema import envelope, identifier
from .store import Store

logger = logging.getLogger(__name__)
CAPACITY_LOCK = 2700103
READER_NAMESPACE = 2700201
SERVED_NAMESPACE = 2700202
ACTION_NAMESPACE = 2700203


def lock_key(value):
    # Stable across processes. A hash collision causes extra serialization only;
    # ownership/duplicate checks always compare the original IDs in the database.
    return int.from_bytes(hashlib.sha256(value.encode()).digest()[:4], "big", signed=True)


class _IntakeSession(Store):
    def __init__(self, connection, readers, keys, namespace, now, timings):
        self.connection, self.db = connection, Database(connection)
        self.readers, self.keys, self.namespace = readers, keys, namespace
        self.now, self.timings = now, timings

    def acquire(self, name, sql, values):
        started = time.perf_counter()
        try:
            self.connection.execute(sql, values)
        finally:
            self.timings[name] += (time.perf_counter() - started) * 1000

    @contextmanager
    def transaction(self):
        with self.connection.transaction():
            # An old API/worker obtains this same key exclusively. This preserves
            # mixed-revision safety, export snapshots, revocation and pruning.
            self.acquire("maintenance_wait_ms", "SELECT pg_advisory_xact_lock_shared(%s)", (INTAKE_LOCK,))
            for name, namespace, values in [("reader_wait_ms", READER_NAMESPACE, self.readers),
                                             ("record_wait_ms", self.namespace, self.keys)]:
                if values:
                    # One round trip per lock domain, not one per article.
                    self.acquire(name, """WITH ordered AS MATERIALIZED (
                        SELECT unnest(%s::integer[]) AS lock_id ORDER BY lock_id
                    ) SELECT pg_advisory_xact_lock(%s, lock_id) FROM ordered""",
                        (sorted({lock_key(value) for value in values}), namespace))
            yield

    def capacity(self, rows, table, key, maximum):
        # Reader locks do not cover malicious cross-reader reuse of a globally
        # unique ID. Record locks are already held before this lookup.
        candidates = {r[key] for r in rows if isinstance(r, dict) and isinstance(r.get(key), str)}
        if key == "event_id":
            candidates = {value.lower() for value in candidates}
        return self.get_many(table, key, candidates)

    def insert_records(self, query, rows, maximum):
        if not rows:
            return
        self.acquire("capacity_wait_ms", "SELECT pg_advisory_xact_lock(%s)", (CAPACITY_LOCK,))
        # READ COMMITTED refreshes the snapshot after the previous writer commits.
        # Do not release this lock before our INSERT and COMMIT are complete.
        if sum(self.counts().values()) + len(rows) > maximum:
            raise OverflowError("INBOX_CAPACITY")
        super().insert_records(query, rows, maximum)

    def jobs(self, force=False):
        # PostgreSQL requires a boolean parameter for OR (SQLite uses int).
        return PostgresStore.jobs(self, force)


class PooledPostgresStore:
    def __init__(self, url, now=None, *, initialize=False, pool_size=4, pool_timeout=1.0):
        if type(pool_size) is not int or not 1 <= pool_size <= 32 or not 0 < pool_timeout <= 5:
            raise ValueError("INVALID_POSTGRES_POOL_LIMITS")
        # Startup schema/version checks retain the legacy exclusive lock.
        with closing(PostgresStore(url, initialize=initialize)):
            pass
        self.now = now or (lambda: int(time.time() * 1000))
        # Compatibility with the HTTP readiness wrapper only; never a process lock.
        self.lock = nullcontext()
        self.pool = ConnectionPool(url, min_size=pool_size, max_size=pool_size,
            timeout=pool_timeout, max_waiting=64, open=False,
            kwargs={"autocommit": True, "row_factory": dict_row, "connect_timeout": 5},
            configure=self.configure)
        try:
            self.pool.open(wait=True, timeout=10)
        except BaseException:
            self.pool.close()
            raise

    @staticmethod
    def configure(connection):
        connection.execute("SET search_path TO behavior_logging")
        connection.execute("SET default_transaction_isolation TO 'read committed'")
        connection.execute("SET lock_timeout TO '1000ms'")
        connection.execute("SET statement_timeout TO '5000ms'")

    @contextmanager
    def session(self, readers=(), keys=(), namespace=SERVED_NAMESPACE):
        started = time.perf_counter()
        timings = dict(pool_wait_ms=0, maintenance_wait_ms=0, reader_wait_ms=0, record_wait_ms=0, capacity_wait_ms=0)
        checked_out, failed = False, False
        try:
            with self.pool.connection() as connection:
                checked_out = True
                timings["pool_wait_ms"] = (time.perf_counter() - started) * 1000
                yield _IntakeSession(connection, readers, keys, namespace, self.now, timings)
        except BaseException:
            failed = True
            raise
        finally:
            total = (time.perf_counter() - started) * 1000
            if not checked_out:
                timings["pool_wait_ms"] = total
            if total >= 500 or failed:
                logger.warning("logging_pool_transaction total_ms=%d pool_wait_ms=%d maintenance_wait_ms=%d "
                    "reader_wait_ms=%d record_wait_ms=%d capacity_wait_ms=%d work_ms=%d failed=%s", total,
                    *timings.values(), max(0, total - sum(timings.values())), failed)

    def intake_served(self, body, atomic=False, max_records=100000):
        rows = envelope(body, "records")
        readers = {r["reader_id"] for r in rows if isinstance(r, dict) and isinstance(r.get("reader_id"), str)}
        keys = {r["impression_id"] for r in rows if isinstance(r, dict) and isinstance(r.get("impression_id"), str)}
        with self.session(readers, keys) as session:
            return session.intake_served(body, atomic, max_records)

    def intake_actions(self, body, reader, enabled, source="browser", max_records=100000):
        identifier(reader)
        rows = envelope(body, "events")
        keys = {r["event_id"].lower() for r in rows if isinstance(r, dict) and isinstance(r.get("event_id"), str)}
        with self.session([reader], keys, ACTION_NAMESPACE) as session:
            return session.intake_actions(body, reader, enabled, source, max_records)

    def readiness(self):
        with self.session() as session:
            return {**session.readiness(), "pool": self.pool.get_stats()}

    def close(self):
        self.pool.close()
