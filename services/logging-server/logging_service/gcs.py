import os

from google.api_core.exceptions import NotFound, PreconditionFailed
from google.auth.credentials import AnonymousCredentials
from google.cloud import storage
from google.cloud.storage.retry import DEFAULT_RETRY_IF_GENERATION_SPECIFIED

from .schema import digest


class GCSSink:
    def __init__(self, bucket, project=None, prefix="", client=None):
        if not bucket:
            raise ValueError("GCS_BUCKET_REQUIRED")
        self.prefix = prefix.strip("/")
        if any(part in (".", "..") for part in self.prefix.split("/")):
            raise ValueError("INVALID_GCS_PREFIX")
        self.client = client or storage.Client(project=project,
            **({"credentials": AnonymousCredentials()} if os.environ.get("STORAGE_EMULATOR_HOST") else {}))
        self.bucket = self.client.bucket(bucket)

    def blob(self, name):
        if name.startswith("/") or any(part in (".", "..") for part in name.split("/")):
            raise ValueError("INVALID_OBJECT_PATH")
        return self.bucket.blob(f"{self.prefix}/{name}" if self.prefix else name)

    def put(self, name, content):
        blob = self.blob(name)
        hashed = digest(content)
        blob.metadata = {"sha256": hashed}
        try:
            blob.upload_from_string(content.encode("utf-8"), content_type="application/x-ndjson" if name.endswith(".jsonl") else "application/json",
                if_generation_match=0, checksum="crc32c", timeout=30, retry=DEFAULT_RETRY_IF_GENERATION_SPECIFIED)
        except PreconditionFailed:
            # A prior upload may have succeeded just before the process lost its ACK.
            # Read the exact generation and compare bytes; never overwrite on conflict.
            blob.reload(timeout=30)
            existing = blob.download_as_bytes(if_generation_match=blob.generation, timeout=30)
            if digest(existing.decode("utf-8")) != hashed:
                raise ValueError("OBJECT_CONTENT_CONFLICT") from None
        if not blob.generation:
            blob.reload(timeout=30)
        return {"bucket": self.bucket.name, "object_name": blob.name, "generation": str(blob.generation), "sha256": hashed}

    def remove(self, name):
        blob = self.blob(name)
        try:
            blob.reload(timeout=30)
            blob.delete(if_generation_match=blob.generation, timeout=30, retry=DEFAULT_RETRY_IF_GENERATION_SPECIFIED)
        except NotFound:
            pass
