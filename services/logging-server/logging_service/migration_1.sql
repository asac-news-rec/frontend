
    CREATE TABLE served_records (
     impression_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,user_id TEXT NOT NULL,
     article_id TEXT NOT NULL,position INTEGER NOT NULL CHECK(position>0),served_at TEXT NOT NULL,
     received_at TEXT NOT NULL,canonical_json TEXT NOT NULL,canonical_hash TEXT NOT NULL
    ) STRICT;
    CREATE INDEX served_user ON served_records(user_id);
    CREATE TABLE action_records (
     event_id TEXT PRIMARY KEY,impression_id TEXT NOT NULL REFERENCES served_records(impression_id),
     event_type TEXT NOT NULL CHECK(event_type IN ('exposure','article_open','like','unlike')),
     page_type TEXT NOT NULL CHECK(page_type IN ('list','detail')),event_time TEXT NOT NULL,
     ended_at TEXT,duration_ms INTEGER,received_at TEXT NOT NULL,canonical_json TEXT NOT NULL,
     canonical_hash TEXT NOT NULL,source TEXT NOT NULL CHECK(source IN ('browser','simulator')),
     schema_version INTEGER NOT NULL,measurement_version TEXT NOT NULL,
     CHECK ((event_type='exposure' AND ended_at IS NOT NULL AND duration_ms>0) OR
      (event_type!='exposure' AND ended_at IS NULL AND duration_ms IS NULL))
    ) STRICT;
    CREATE INDEX actions_impression ON action_records(impression_id);
    PRAGMA user_version=1;
   