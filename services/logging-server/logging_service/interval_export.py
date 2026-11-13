"""Export one Airflow data interval using the logging service's durable jobs."""
from contextlib import closing
from datetime import datetime, timezone
import os

from .exporter import Exporter
from .gcs import GCSSink
from .postgres import PostgresStore


def export_interval(start, end):
    if any(not isinstance(bound, datetime) or bound.utcoffset() is None
           or bound.microsecond % 1000 for bound in (start, end)) or start >= end:
        raise ValueError("Expected a nonempty, timezone-aware interval aligned to milliseconds")
    interval = tuple(bound.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
                     for bound in (start, end))
    path = f"interval_start={interval[0]}/interval_end={interval[1]}"
    sink = GCSSink(os.environ["GCS_BUCKET"], os.environ["GOOGLE_CLOUD_PROJECT"], os.environ.get("GCS_PREFIX", ""))
    with closing(PostgresStore(os.environ["LOGGING_DATABASE_URL"])) as store:
        return Exporter(store, sink).flush(force=True, interval=interval, interval_path=path)
