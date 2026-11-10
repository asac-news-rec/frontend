"""Creates only an explicitly configured emulator bucket, never a cloud bucket."""
import os
import time

from google.api_core.exceptions import Conflict
from google.auth.credentials import AnonymousCredentials
from google.cloud import storage


def main():
    if not os.environ.get("STORAGE_EMULATOR_HOST"):
        raise ValueError("EMULATOR_HOST_REQUIRED")
    client = storage.Client(project=os.environ.get("GOOGLE_CLOUD_PROJECT", "local-integration"), credentials=AnonymousCredentials())
    bucket = os.environ["GCS_BUCKET"]
    for attempt in range(30):
        try:
            client.create_bucket(bucket, timeout=3)
            return
        except Conflict:
            return
        except Exception:
            if attempt == 29:
                raise
            time.sleep(1)


if __name__ == "__main__":
    main()
