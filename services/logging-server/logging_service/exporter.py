import os
from contextlib import nullcontext
from pathlib import Path

from .schema import compact, digest, iso


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
        self.state = {"lastSuccess": None, "lastError": None}

    def flush(self, force=False):
        with self.store.lock, (self.store.export_lock() if hasattr(self.store, "export_lock") else nullcontext(True)) as acquired:
            if not acquired:
                return 0
            if hasattr(self.store, "deletion_targets"):
                for name in self.store.deletion_targets():
                    self.sink.remove(name)
            self.store.prepare_exports()
            completed = 0
            for job in self.store.jobs(force):
                try:
                    self.check_lease(job)
                    receipt = self.sink.put(job["object_name"], job["content"])
                    self.check_lease(job)
                    self.after_write(job)
                    self.check_lease(job)
                    manifest = {key: job[key] for key in ("job_id", "object_name", "stream", "partition_path", "row_count", "content_hash")}
                    manifest.update(schema_version=1, prepared_at=job["created_at"])
                    if receipt:
                        manifest["storage"] = receipt
                    self.sink.put(f"manifests/{job['job_id']}.json", compact(manifest) + "\n")
                    self.check_lease(job)
                    self.store.mark(job, receipt=receipt)
                    completed += 1
                    self.state.update(lastSuccess=iso(self.store.now()), lastError=None)
                except Exception as error:
                    self.store.mark(job, error)
                    self.state["lastError"] = type(error).__name__
            return completed

    def check_lease(self, job):
        if hasattr(self.store, "check_export_lease"):
            self.store.check_export_lease(job)

    def delete(self, reader):
        with self.store.lock, (self.store.export_lock(wait=True) if hasattr(self.store, "export_lock") else nullcontext(True)):
            for job in self.store.revoke(reader):
                self.sink.remove(job["object_name"])
                self.sink.remove(f"manifests/{job['job_id']}.json")
            self.store.finish_deletion(reader)
