CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY);
INSERT INTO schema_version VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS served_records (
 impression_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, reader_id TEXT NOT NULL,
 article_id TEXT NOT NULL, position BIGINT NOT NULL CHECK(position>0), served_at TEXT NOT NULL,
 received_at TEXT NOT NULL, canonical_json TEXT NOT NULL, canonical_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS served_reader ON served_records(reader_id);
CREATE INDEX IF NOT EXISTS served_received_at ON served_records(received_at);
CREATE TABLE IF NOT EXISTS action_records (
 event_id TEXT PRIMARY KEY, impression_id TEXT NOT NULL REFERENCES served_records(impression_id),
 event_type TEXT NOT NULL CHECK(event_type IN ('exposure','article_open','article_close','like','unlike')),
 page_type TEXT NOT NULL CHECK(page_type IN ('list','detail')), event_time TEXT NOT NULL,
 ended_at TEXT, duration_ms BIGINT, received_at TEXT NOT NULL, canonical_json TEXT NOT NULL,
 canonical_hash TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('browser','simulator')),
 schema_version INTEGER NOT NULL, measurement_version TEXT NOT NULL,
 CHECK ((event_type='exposure' AND ended_at IS NOT NULL AND duration_ms>0) OR
        (event_type!='exposure' AND ended_at IS NULL AND duration_ms IS NULL))
);
CREATE INDEX IF NOT EXISTS actions_impression ON action_records(impression_id);
CREATE INDEX IF NOT EXISTS actions_received_at ON action_records(received_at);
CREATE TABLE IF NOT EXISTS export_jobs (
 job_id TEXT PRIMARY KEY, reader_id TEXT NOT NULL, stream TEXT NOT NULL,
 partition_path TEXT NOT NULL, object_name TEXT NOT NULL UNIQUE, content TEXT NOT NULL,
 content_hash TEXT NOT NULL, row_count INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'prepared',
 attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL,
 next_attempt_at BIGINT NOT NULL DEFAULT 0, storage_receipt JSONB
);
CREATE TABLE IF NOT EXISTS export_members (
 stream TEXT NOT NULL, record_id TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES export_jobs(job_id),
 PRIMARY KEY(stream,record_id)
);
CREATE TABLE IF NOT EXISTS revoked_users(reader_id TEXT PRIMARY KEY,revoked_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS export_members_job ON export_members(job_id);
-- Retain object names after deleting originals/jobs: a disconnected uploader can
-- finish a previously issued GCS request after the advisory lock has disappeared.
CREATE TABLE IF NOT EXISTS deletion_targets (
 reader_id TEXT NOT NULL REFERENCES revoked_users(reader_id), object_name TEXT PRIMARY KEY
);
