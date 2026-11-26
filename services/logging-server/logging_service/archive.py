"""Offline QA for downloaded Pub/Sub text export objects, not a production ETL."""
import argparse
import json
from pathlib import Path


def read_archive(paths):
    records, fingerprints = {}, {}
    duplicates = 0
    for path in paths:
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            batch = json.loads(line)
            stream = batch.get("stream")
            if batch.get("schema_version") != 2 or stream not in ("served", "actions") or not isinstance(batch.get("records"), list):
                raise ValueError("INVALID_ARCHIVE_ENVELOPE")
            key = "event_id" if stream == "actions" else "impression_id"
            for record in batch["records"]:
                identity = record.get(key)
                if not isinstance(identity, str) or not identity:
                    raise ValueError("INVALID_ARCHIVE_RECORD")
                pair = stream, identity
                # received_at varies on ambiguous publish retries; event/served
                # time and all identity/context fields must remain identical.
                fingerprint = json.dumps({k: v for k, v in record.items() if k != "received_at"}, sort_keys=True, ensure_ascii=False)
                if pair in fingerprints:
                    if fingerprints[pair] != fingerprint:
                        raise ValueError("ARCHIVE_ID_CONFLICT")
                    duplicates += 1
                else:
                    fingerprints[pair], records[pair] = fingerprint, record
    return records, duplicates


def audit_archive(records, audit_path):
    expected = set()
    for line in Path(audit_path).read_text(encoding="utf-8-sig").splitlines():
        row = json.loads(line)
        if row.get("kind") == "event_ack":
            expected.add(("actions", row["event_id"]))
        elif row.get("kind") == "feed":
            expected.update(("served", item["impression_id"]) for item in row["items"])
    missing = expected - records.keys()
    return {"expected_unique": len(expected), "missing": len(missing),
            "archive_matches_audit": bool(expected) and not missing}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("objects", nargs="+", type=Path)
    parser.add_argument("--audit", type=Path)
    args = parser.parse_args()
    records, duplicates = read_archive(args.objects)
    result = {"served": sum(s == "served" for s, _ in records),
              "actions": sum(s == "actions" for s, _ in records), "duplicates": duplicates}
    if args.audit:
        result.update(audit_archive(records, args.audit))
    print(json.dumps(result))  # Counts only; no reader IDs, event bodies or receipts.
    return 1 if args.audit and not result["archive_matches_audit"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
