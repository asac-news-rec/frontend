import json
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .schema import InputError, action, canonical, compact, digest, envelope, identifier, iso, served


def partition(value):
    date = datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc) + timedelta(hours=9)
    return f"date={date:%Y-%m-%d}/hour={date:%H}/minute={date.minute // 5 * 5:02d}"


class Store:
    def __init__(self, database, now=None):
        self.now = now or (lambda: int(time.time() * 1000))
        self.lock = threading.RLock()
        if str(database) != ":memory:":
            Path(database).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(database), isolation_level=None, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        try:
            self.db.executescript("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;")
            self.migrate()
        except BaseException:
            self.db.close()
            raise

    def migrate(self):
        version = self.db.execute("PRAGMA user_version").fetchone()[0]
        if version > 5:
            raise RuntimeError("UNSUPPORTED_SCHEMA_VERSION")
        root = Path(__file__).parent
        # Execute whole scripts transactionally, including version changes.
        for target, script in [(1, "migration_1.sql"), (2, "migration_2.sql")]:
            if version < target:
                self.db.executescript("BEGIN IMMEDIATE;" + (root / script).read_text() + "COMMIT;")
        if version < 3:
            self.db.executescript("BEGIN IMMEDIATE; ALTER TABLE export_jobs ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=3; COMMIT;")
        if version < 4:
            with self.transaction():
                for table in ("served_records", "export_jobs", "revoked_users"):
                    self.db.execute(f"ALTER TABLE {table} RENAME COLUMN user_id TO reader_id")
                self.db.execute("DROP INDEX served_user")
                self.db.execute("CREATE INDEX served_reader ON served_records(reader_id)")
                for row in self.db.execute("SELECT impression_id, canonical_json FROM served_records").fetchall():
                    old = json.loads(row["canonical_json"])
                    record = {key: old[key] for key in ("request_id", "impression_id")}
                    record.update(reader_id=old["user_id"], article_id=old["article_id"], position=old["position"], served_at=old["served_at"])
                    raw, hashed = canonical(record)
                    self.db.execute("UPDATE served_records SET canonical_json=?,canonical_hash=? WHERE impression_id=?", (raw, hashed, row["impression_id"]))
                self.db.execute("PRAGMA user_version=4")
        if version < 5:
            self.db.executescript("BEGIN IMMEDIATE;" + (root / "migration_3.sql").read_text() + "COMMIT;")

    @contextmanager
    def transaction(self):
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                yield
                self.db.execute("COMMIT")
            except BaseException:
                self.db.execute("ROLLBACK")
                raise

    def get(self, table, key, value):
        row = self.db.execute(f"SELECT * FROM {table} WHERE {key}=?", (value,)).fetchone()
        return dict(row) if row else None

    def intake_served(self, body, atomic=False, max_records=100000):
        rows = envelope(body, "records")
        with self.transaction():
            self.capacity(rows, "served_records", "impression_id", max_records)
            results = []
            at = self.now()
            for value in rows:
                try:
                    record = served(value, at)
                    if self.get("revoked_users", "reader_id", record["reader_id"]):
                        raise InputError("USER_REVOKED")
                    raw, hashed = canonical(record)
                    old = self.get("served_records", "impression_id", record["impression_id"])
                    if old and old["canonical_hash"] != hashed:
                        raise InputError("IMPRESSION_ID_CONFLICT")
                    if not old:
                        self.db.execute("INSERT INTO served_records VALUES(?,?,?,?,?,?,?,?,?)", (
                            record["impression_id"], record["request_id"], record["reader_id"], record["article_id"],
                            record["position"], record["served_at"], iso(at), raw, hashed))
                    results.append({"impression_id": record["impression_id"], "status": "duplicate" if old else "accepted"})
                except InputError as error:
                    if atomic:
                        raise
                    results.append(self.rejected(value, "impression_id", str(error)))
            return {"results": results}

    @staticmethod
    def rejected(value, key, code, status="rejected"):
        identity = value.get(key) if isinstance(value, dict) else None
        return {key: identity[:128] if isinstance(identity, str) else None, "status": status, "code": code}

    def capacity(self, rows, table, key, maximum):
        candidates = {r.get(key) for r in rows if isinstance(r, dict) and isinstance(r.get(key), str)}
        if key == "event_id":
            candidates = {identity.lower() for identity in candidates}
        new = sum(not self.get(table, key, identity) for identity in candidates)
        if new and sum(self.counts().values()) + new > maximum:
            raise OverflowError("INBOX_CAPACITY")

    def intake_actions(self, body, reader, enabled, source="browser", max_records=100000):
        identifier(reader)
        if not enabled:
            raise InputError("COLLECTION_DISABLED")
        if source not in ("browser", "simulator"):
            raise InputError("INVALID_CONTEXT")
        rows = envelope(body, "events")
        with self.transaction():
            if self.get("revoked_users", "reader_id", reader):
                raise InputError("USER_REVOKED")
            self.capacity(rows, "action_records", "event_id", max_records)
            results = []
            at = self.now()
            for value in rows:
                try:
                    record = action(value, at)
                    owner = self.get("served_records", "impression_id", record["impression_id"])
                    if not owner:
                        results.append(self.rejected(record, "event_id", "IMPRESSION_NOT_READY", "retryable"))
                        continue
                    if owner["reader_id"] != reader:
                        raise InputError("IMPRESSION_FORBIDDEN")
                    raw, hashed = canonical(record)
                    old = self.get("action_records", "event_id", record["event_id"])
                    if old and (old["canonical_hash"] != hashed or old["source"] != source or old["measurement_version"] != "stationary-visible-v1"):
                        raise InputError("EVENT_ID_CONFLICT")
                    if not old:
                        self.db.execute("INSERT INTO action_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (
                            record["event_id"], record["impression_id"], record["event_type"], record["page_type"], record["event_time"],
                            record.get("ended_at"), record.get("duration_ms"), iso(at), raw, hashed, source, 1, "stationary-visible-v1"))
                    results.append({"event_id": record["event_id"], "status": "duplicate" if old else "accepted"})
                except InputError as error:
                    results.append(self.rejected(value, "event_id", str(error)))
            return {"results": results}

    def counts(self):
        return {name: self.db.execute(f"SELECT count(*) FROM {table}").fetchone()[0] for name, table in [("served", "served_records"), ("actions", "action_records")]}

    def prepare_exports(self):
        with self.transaction():
            rows = self.db.execute("SELECT s.*, 'served' AS stream, impression_id AS record_id, served_at AS time FROM served_records s WHERE NOT EXISTS(SELECT 1 FROM export_members m WHERE m.stream='served' AND m.record_id=s.impression_id) ORDER BY impression_id").fetchall()
            rows += self.db.execute("SELECT a.*,s.reader_id,'actions' AS stream,event_id AS record_id,event_time AS time FROM action_records a JOIN served_records s USING(impression_id) WHERE NOT EXISTS(SELECT 1 FROM export_members m WHERE m.stream='actions' AND m.record_id=a.event_id) ORDER BY event_id").fetchall()
            groups = {}
            for row in rows:
                if not self.get("revoked_users", "reader_id", row["reader_id"]):
                    groups.setdefault((row["stream"], row["reader_id"], partition(row["time"])), []).append(row)
            for (stream, reader, part), records in groups.items():
                for offset in range(0, len(records), 1000):
                    chunk, job = records[offset:offset + 1000], str(uuid.uuid4())
                    exported = []
                    for row in chunk:
                        item = {**json.loads(row["canonical_json"]), "received_at": row["received_at"]}
                        if stream == "actions":
                            item.update({key: row[key] for key in ("source", "schema_version", "measurement_version")})
                        exported.append(compact(item))
                    content = "\n".join(exported) + "\n"
                    self.db.execute("INSERT INTO export_jobs(job_id,reader_id,stream,partition_path,object_name,content,content_hash,row_count,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                                    (job, reader, stream, part, f"{stream}/{part}/part-{job}.jsonl", content, digest(content), len(chunk), iso(self.now())))
                    self.db.executemany("INSERT INTO export_members VALUES(?,?,?)", [(stream, r["record_id"], job) for r in chunk])

    def jobs(self, force=False):
        return [dict(r) for r in self.db.execute("SELECT j.* FROM export_jobs j WHERE status!='uploaded' AND NOT EXISTS(SELECT 1 FROM revoked_users r WHERE r.reader_id=j.reader_id) AND (? OR next_attempt_at<=?) ORDER BY created_at,job_id", (int(force), self.now()))]

    def mark(self, job, error=None):
        if error is None:
            self.db.execute("UPDATE export_jobs SET status='uploaded',last_error=NULL,attempts=attempts+1 WHERE job_id=?", (job["job_id"],))
        else:
            delay = min(1800000, 1000 * 2 ** min(job["attempts"], 11))
            self.db.execute("UPDATE export_jobs SET attempts=attempts+1,last_error=?,next_attempt_at=? WHERE job_id=?", (str(error)[:300], self.now() + delay, job["job_id"]))

    def readiness(self):
        pending = sum(self.db.execute(f"SELECT count(*) FROM {table} s WHERE NOT EXISTS(SELECT 1 FROM export_members m WHERE m.stream=? AND m.record_id=s.{key})", (stream,)).fetchone()[0]
                      for stream, table, key in [("served", "served_records", "impression_id"), ("actions", "action_records", "event_id")])
        return {"pendingRecords": pending, "pendingJobs": len(self.jobs(True)), **self.counts()}

    def revoke(self, reader):
        identifier(reader)
        self.db.execute("INSERT OR IGNORE INTO revoked_users VALUES(?,?)", (reader, iso(self.now())))
        return [dict(r) for r in self.db.execute("SELECT * FROM export_jobs WHERE reader_id=?", (reader,))]

    def finish_deletion(self, reader):
        with self.transaction():
            self.db.execute("DELETE FROM export_members WHERE job_id IN (SELECT job_id FROM export_jobs WHERE reader_id=?)", (reader,))
            self.db.execute("DELETE FROM export_jobs WHERE reader_id=?", (reader,))
            self.db.execute("DELETE FROM action_records WHERE impression_id IN (SELECT impression_id FROM served_records WHERE reader_id=?)", (reader,))
            self.db.execute("DELETE FROM served_records WHERE reader_id=?", (reader,))

    def close(self):
        self.db.close()
