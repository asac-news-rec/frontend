
    CREATE TABLE action_records_v5 (
     event_id TEXT PRIMARY KEY,impression_id TEXT NOT NULL REFERENCES served_records(impression_id),
     event_type TEXT NOT NULL CHECK(event_type IN ('exposure','article_open','article_close','like','unlike')),
     page_type TEXT NOT NULL CHECK(page_type IN ('list','detail')),event_time TEXT NOT NULL,
     ended_at TEXT,duration_ms INTEGER,received_at TEXT NOT NULL,canonical_json TEXT NOT NULL,
     canonical_hash TEXT NOT NULL,source TEXT NOT NULL CHECK(source IN ('browser','simulator')),
     schema_version INTEGER NOT NULL,measurement_version TEXT NOT NULL,
     CHECK ((event_type='exposure' AND ended_at IS NOT NULL AND duration_ms>0) OR
      (event_type!='exposure' AND ended_at IS NULL AND duration_ms IS NULL))
    ) STRICT;
    INSERT INTO action_records_v5 SELECT * FROM action_records;
    DROP TABLE action_records;
    ALTER TABLE action_records_v5 RENAME TO action_records;
    CREATE INDEX actions_impression ON action_records(impression_id);
    PRAGMA user_version=5;
