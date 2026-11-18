-- Connect to behavior_logs after API initialization.
-- Use an operator authorized to grant privileges on the database and schema objects.
-- Set logging_database and airflow_role as psql variables before running this file.
BEGIN;
GRANT CONNECT ON DATABASE :"logging_database" TO :"airflow_role";
GRANT USAGE ON SCHEMA behavior_logging TO :"airflow_role";

-- The API processes reader revocation and writes deletion targets. Airflow only
-- reads those targets to remove any remaining GCS objects.
GRANT SELECT ON behavior_logging.schema_version,
    behavior_logging.revoked_users, behavior_logging.deletion_targets
    TO :"airflow_role";
GRANT SELECT, DELETE ON behavior_logging.served_records,
    behavior_logging.action_records TO :"airflow_role";
GRANT SELECT, INSERT, DELETE ON behavior_logging.export_members TO :"airflow_role";
GRANT SELECT, INSERT ON behavior_logging.export_jobs TO :"airflow_role";
GRANT UPDATE (status, attempts, last_error, next_attempt_at, storage_receipt, content)
    ON behavior_logging.export_jobs TO :"airflow_role";
COMMIT;
