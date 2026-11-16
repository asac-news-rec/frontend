import logging
import os
from pathlib import Path
from threading import Lock

from .schema import compact, digest, iso

logger = logging.getLogger(__name__)


class LocalSink:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def target(self, name):
        file = (self.root / name).resolve()
        if not file.is_relative_to(self.root) or file == self.root:
            raise ValueError("INVALID_OBJECT_PATH")
        return file

    def put(self, name, content):
        file = self.target(name)
        file.parent.mkdir(parents=True, exist_ok=True)
        if file.exists():
            if digest(file.read_text(encoding="utf-8")) != digest(content):
                raise ValueError("OBJECT_CONTENT_CONFLICT")
            return
        temp = Path(str(file) + ".tmp")
        with temp.open("w", encoding="utf-8", newline="") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, file)
        if os.name != "nt":
            fd = os.open(file.parent, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)

    def remove(self, name):
        file = self.target(name)
        file.unlink(missing_ok=True)
        Path(str(file) + ".tmp").unlink(missing_ok=True)


class Exporter:
    def __init__(self, store, sink, after_write=lambda job: None):
        self.store, self.sink, self.after_write = store, sink, after_write
        self.io_lock = Lock()
        self.state = {"lastSuccess": None, "lastError": None}

    def flush(self, force=False):
        with self.io_lock:
            with self.store.lock:
                self.store.prepare_exports()
                jobs = self.store.jobs(force)
            completed = 0
            last_error = None
            for job in jobs:
                try:
                    self.sink.put(job["object_name"], job["content"])
                    self.after_write(job)
                    manifest = {key: job[key] for key in ("job_id", "object_name", "stream", "partition_path", "row_count", "content_hash")}
                    manifest.update(schema_version=1, prepared_at=job["created_at"])
                    self.sink.put(f"manifests/{job['job_id']}.json", compact(manifest) + "\n")
                    with self.store.lock:
                        self.store.mark(job)
                    completed += 1
                    self.state["lastSuccess"] = iso(self.store.now())
                except Exception as error:
                    last_error = type(error).__name__
                    self.state["lastError"] = last_error
                    try:
                        with self.store.lock:
                            self.store.mark(job, error)
                    except Exception as mark_error:
                        last_error = f"{last_error}; mark: {type(mark_error).__name__}"
                        self.state["lastError"] = last_error
                        logger.error("Failed to record export job %s: %s", job["job_id"], type(mark_error).__name__)
            self.state["lastError"] = last_error
            return completed

    def delete(self, reader):
        with self.io_lock:
            with self.store.lock:
                jobs = self.store.revoke(reader)
            for job in jobs:
                self.sink.remove(job["object_name"])
                self.sink.remove(f"manifests/{job['job_id']}.json")
            self.store.finish_deletion(reader)
