"""Airflow DAG for exporting committed behavior logs."""
import os
from datetime import datetime, timedelta

import pendulum
try:
    from airflow.sdk import dag, get_current_context, task
except ModuleNotFoundError as error:
    if error.name != "airflow.sdk":
        raise
    from airflow.decorators import dag, task
    from airflow.operators.python import get_current_context
from airflow.timetables.interval import CronDataIntervalTimetable


cron = os.getenv("BEHAVIOR_EXPORT_CRON")
start_date = os.getenv("BEHAVIOR_EXPORT_START")
if cron and not start_date:
    raise ValueError("BEHAVIOR_EXPORT_START is required when scheduling behavior export")


@dag(
    dag_id="export_behavior_logs",
    schedule=CronDataIntervalTimetable(cron, timezone="UTC") if cron else None,
    start_date=pendulum.parse(start_date, tz="UTC") if start_date else None,
    catchup=True,
    max_active_runs=1,
    is_paused_upon_creation=True,
)
def behavior_export():
    @task(retries=3, retry_delay=timedelta(minutes=1), do_xcom_push=False)
    def upload():
        from logging_service.interval_export import export_interval

        context = get_current_context()
        conf = context["dag_run"].conf or {}
        if "interval_start" in conf or "interval_end" in conf:
            start = datetime.fromisoformat(conf["interval_start"])
            end = datetime.fromisoformat(conf["interval_end"])
        else:
            start = context.get("data_interval_start")
            end = context.get("data_interval_end")
        export_interval(start, end)

    upload()


export_behavior_logs = behavior_export()
