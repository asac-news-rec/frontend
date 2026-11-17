"""PostgreSQL persistence using the same normalized records and ACK contract.

The shared Store owns domain rules. This adapter translates its small SQL subset,
while PostgreSQL transaction locks serialize duplicate/capacity/deletion decisions
across API processes. No time-partitioned database tables are created.
"""
import threading
import time
from contextlib import contextmanager
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .schema import iso
from .store import Store

INTAKE_LOCK = 2700101
EXPORT_LOCK = 2700102


class Row(dict):
    def __getitem__(self, key):
        return list(self.values())[key] if isinstance(key, int) else super().__getitem__(key)


class Cursor:
    def __init__(self, cursor):
        self.cursor = cursor

    def fetchone(self):
        row = self.cursor.fetchone()
        return Row(row) if row is not None else None

    def fetchall(self):
        return [Row(row) for row in self.cursor.fetchall()]

    def __iter__(self):
        return iter(self.fetchall())


class Database:
    def __init__(self, connection):
        self.connection = connection

    @staticmethod
    def translate(query):
        query = query.replace("?", "%s")
        if "INSERT OR IGNORE INTO" in query:
            query = query.replace("INSERT OR IGNORE INTO", "INSERT INTO") + " ON CONFLICT DO NOTHING"
        return query

    def execute(self, query, values=None):
        return Cursor(self.connection.execute(self.translate(query), values))

    def executemany(self, query, values):
        with self.connection.cursor() as cursor:
            cursor.executemany(self.translate(query), values)

    def close(self):
        self.connection.close()


class PostgresStore(Store):
    def __init__(self, url, now=None, *, initialize=False):
        self.url = url
        self.now = now or (lambda: int(time.time() * 1000))
        self.lock = threading.RLock()
        self._export_connection = None
        self.connection = psycopg.connect(url, autocommit=True, row_factory=dict_row, connect_timeout=5)
        self.db = Database(self.connection)
        try:
            self.connection.execute("SET search_path TO behavior_logging")
            if initialize:
                self._initialize_schema()
            if not self._schema_exists():
                raise RuntimeError("POSTGRES_SCHEMA_NOT_INITIALIZED")
            self._check_schema_version()
        except BaseException:
            self.connection.close()
            raise

    def _schema_exists(self):
        result = self.connection.execute(
            "SELECT to_regclass('behavior_logging.schema_version') AS table_name"
        ).fetchone()
        return result["table_name"] is not None

    def _check_schema_version(self):
        versions = self.connection.execute("SELECT version FROM schema_version").fetchall()
        if [row["version"] for row in versions] != [1]:
            raise RuntimeError("UNSUPPORTED_POSTGRES_SCHEMA_VERSION")

    def _initialize_schema(self):
        with self.connection.transaction():
            self.connection.execute("SELECT pg_advisory_xact_lock(%s)", (INTAKE_LOCK,))
            self.connection.execute("CREATE SCHEMA IF NOT EXISTS behavior_logging")
            if self._schema_exists():
                self._check_schema_version()
            self.connection.execute((Path(__file__).parent / "postgres.sql").read_text(encoding="utf-8"))

    @contextmanager
    def transaction(self):
        with self.lock:
            if self.connection.closed or self.connection.broken:
                if self._export_connection is not None:
                    raise RuntimeError("EXPORT_LEASE_LOST")
                self.connection = psycopg.connect(self.url, autocommit=True, row_factory=dict_row, connect_timeout=5)
                self.connection.execute("SET search_path TO behavior_logging")
                self.db = Database(self.connection)
            with self.connection.transaction():
                self.connection.execute("SELECT pg_advisory_xact_lock(%s)", (INTAKE_LOCK,))
                yield

    def prune_exported_records(self):
        cutoff = iso(self.now() - 24 * 60 * 60 * 1000)
        with self.export_lock(wait=True), self.transaction():
            counts = {}
            # Served rows are still needed to join and authorize remaining actions.
            streams = (
                ("actions", "action_records", "event_id", "event_time", ""),
                ("served", "served_records", "impression_id", "served_at",
                 "AND NOT EXISTS (SELECT 1 FROM action_records a WHERE a.impression_id=r.impression_id)"),
            )
            for stream, table, key, occurred_at, dependency in streams:
                result = self.connection.execute(f"""
                    WITH removed AS (
                        DELETE FROM {table} r
                        WHERE r.received_at < %s AND r.{occurred_at} < %s
                        AND EXISTS (
                            SELECT 1 FROM export_members m JOIN export_jobs j USING (job_id)
                            WHERE m.stream=%s AND m.record_id=r.{key}
                            AND j.status='uploaded' AND j.storage_receipt->>'generation' IS NOT NULL
                        )
                        {dependency}
                        RETURNING r.{key}
                    )
                    DELETE FROM export_members m USING removed r
                    WHERE m.stream=%s AND m.record_id=r.{key}
                    """, (cutoff, cutoff, stream, stream))
                counts[stream] = result.rowcount
            # Keep object names and receipts so delete-user can still remove GCS objects.
            self.connection.execute("""
                UPDATE export_jobs j SET content=''
                WHERE j.status='uploaded' AND j.content<>''
                AND j.storage_receipt->>'generation' IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM export_members m WHERE m.job_id=j.job_id)
                """)
            return counts

    def jobs(self, force=False, interval_path=None):
        return [dict(row) for row in self.connection.execute(
            "SELECT j.* FROM export_jobs j WHERE status!='uploaded' AND NOT EXISTS "
            "(SELECT 1 FROM revoked_users r WHERE r.reader_id=j.reader_id) AND (%s OR next_attempt_at<=%s) "
            "AND (%s::text IS NULL OR partition_path=%s) ORDER BY created_at,job_id",
            (force, self.now(), interval_path, interval_path))]

    def mark(self, job, error=None, receipt=None):
        self.check_export_lease(job)
        if error is None:
            self.connection.execute("UPDATE export_jobs SET status='uploaded',last_error=NULL,attempts=attempts+1,storage_receipt=%s WHERE job_id=%s",
                                    (Jsonb(receipt), job["job_id"]))
        else:
            super().mark(job, error)

    @contextmanager
    def export_lock(self, wait=False):
        # A session lock spans GCS calls but does not hold the intake transaction lock.
        with self.lock:
            if wait:
                self.connection.execute("SELECT pg_advisory_lock(%s)", (EXPORT_LOCK,))
                acquired = True
            else:
                acquired = self.connection.execute("SELECT pg_try_advisory_lock(%s) AS acquired", (EXPORT_LOCK,)).fetchone()["acquired"]
            try:
                if acquired:
                    self._export_connection = self.connection
                yield acquired
            finally:
                self._export_connection = None
                if acquired:
                    if not self.connection.closed and not self.connection.broken:
                        self.connection.execute("SELECT pg_advisory_unlock(%s)", (EXPORT_LOCK,))

    def check_export_lease(self, job):
        if self._export_connection is not self.connection or self.connection.closed or self.connection.broken:
            raise RuntimeError("EXPORT_LEASE_LOST")
        active = self.connection.execute("SELECT 1 FROM export_jobs j WHERE job_id=%s AND NOT EXISTS "
            "(SELECT 1 FROM revoked_users r WHERE r.reader_id=j.reader_id)", (job["job_id"],)).fetchone()
        if not active:
            raise RuntimeError("EXPORT_REVOKED")

    def deletion_targets(self):
        return [r["object_name"] for r in self.connection.execute("SELECT object_name FROM deletion_targets ORDER BY object_name")]

    def revoke(self, reader):
        with self.transaction():
            jobs = super().revoke(reader)
            for job in jobs:
                for name in (job["object_name"], f"manifests/{job['job_id']}.json"):
                    self.connection.execute("INSERT INTO deletion_targets VALUES(%s,%s) ON CONFLICT DO NOTHING", (reader, name))
            return jobs
