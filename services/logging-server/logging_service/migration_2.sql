
   CREATE TABLE export_jobs(job_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,stream TEXT NOT NULL,partition_path TEXT NOT NULL,object_name TEXT NOT NULL UNIQUE,content TEXT NOT NULL,content_hash TEXT NOT NULL,row_count INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'prepared',attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,created_at TEXT NOT NULL);
   CREATE TABLE export_members(stream TEXT NOT NULL,record_id TEXT NOT NULL,job_id TEXT NOT NULL REFERENCES export_jobs(job_id),PRIMARY KEY(stream,record_id));
   CREATE TABLE revoked_users(user_id TEXT PRIMARY KEY,revoked_at TEXT NOT NULL);
   PRAGMA user_version=2;
  