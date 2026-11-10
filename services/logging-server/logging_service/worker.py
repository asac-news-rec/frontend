"""Separate PostgreSQL-to-GCS worker. Repeated runs reuse immutable job names."""
import argparse
import logging
import signal
import threading

from .app import Settings
from .exporter import Exporter
from .gcs import GCSSink
from .postgres import PostgresStore


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--force", action="store_true", help="Ignore the persisted retry delay")
    args = parser.parse_args()
    config = Settings.environment()
    if not config.database_url:
        raise ValueError("WORKER_REQUIRES_POSTGRES")
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    sink = GCSSink(config.gcs_bucket, config.gcs_project, config.gcs_prefix)
    while not stop.is_set():
        store = None
        try:
            store = PostgresStore(config.database_url)
            exporter = Exporter(store, sink)
            try:
                exporter.flush(args.force)
                if exporter.state["lastError"]:
                    raise RuntimeError("EXPORT_FAILED")
            finally:
                store.close()
                store = None
        except Exception:
            logging.error("Export cycle failed; persisted jobs will be retried")
            if args.once:
                raise
        finally:
            if store:
                store.close()
        if args.once:
            break
        stop.wait(config.flush_ms / 1000)


if __name__ == "__main__":
    main()
