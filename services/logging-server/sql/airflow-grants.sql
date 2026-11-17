-- Connect to behavior_logs after API initialization.
-- Use an operator authorized to grant privileges on the database and schema objects.
BEGIN;
GRANT CONNECT ON DATABASE behavior_logs TO logging_airflow;
GRANT USAGE ON SCHEMA behavior_logging TO logging_airflow;

GRANT SELECT ON behavior_logging.schema_version,
    behavior_logging.revoked_users, behavior_logging.deletion_targets
    TO logging_airflow;
GRANT SELECT, DELETE ON behavior_logging.served_records,
    behavior_logging.action_records TO logging_airflow;
GRANT SELECT, INSERT, DELETE ON behavior_logging.export_members TO logging_airflow;
GRANT SELECT, INSERT ON behavior_logging.export_jobs TO logging_airflow;
GRANT UPDATE (status, attempts, last_error, next_attempt_at, storage_receipt, content)
    ON behavior_logging.export_jobs TO logging_airflow;
COMMIT;
