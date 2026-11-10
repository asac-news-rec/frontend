import calendar
import hashlib
import json
import re
from datetime import datetime, timezone


class InputError(ValueError):
    pass


def compact(value):
    # Match JSON.stringify for the normalized wire records used by the Node service.
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def canonical(value):
    raw = compact(value)
    return raw, digest(raw)


def identifier(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 128:
        raise InputError("INVALID_ID")
    return value


def shape(value, keys):
    if not isinstance(value, dict):
        raise InputError("INVALID_OBJECT")
    if set(value) - set(keys):
        raise InputError("UNKNOWN_FIELD")


def timestamp(value, now=None):
    if not isinstance(value, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})", value
    ):
        raise InputError("INVALID_TIME")
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
        epoch = calendar.timegm(dt.utctimetuple()) * 1000 + dt.microsecond // 1000
    except (ValueError, OverflowError):
        raise InputError("INVALID_TIME") from None
    if now is not None and not now - 86400000 <= epoch <= now + 300000:
        raise InputError("TIME_OUT_OF_RANGE")
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def envelope(body, key):
    shape(body, [key])
    rows = body.get(key)
    if not isinstance(rows, list) or not 1 <= len(rows) <= 100:
        raise InputError("INVALID_ENVELOPE")
    return rows


def served(value, now):
    shape(value, ["request_id", "impression_id", "reader_id", "article_id", "position", "served_at"])
    result = {key: identifier(value.get(key)) for key in ["request_id", "impression_id", "reader_id", "article_id"]}
    position = value.get("position")
    if type(position) is not int or not 1 <= position <= 9007199254740991:
        raise InputError("INVALID_POSITION")
    return {**result, "position": position, "served_at": timestamp(value.get("served_at"), now)}


def action(value, now):
    shape(value, ["event_id", "event_type", "event_time", "impression_id", "page_type", "duration_ms", "ended_at"])
    eid = value.get("event_id")
    if not isinstance(eid, str) or not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", eid, re.I):
        raise InputError("INVALID_EVENT_ID")
    kind, page = value.get("event_type"), value.get("page_type")
    if kind not in ("exposure", "article_open", "article_close", "like", "unlike") or page not in ("list", "detail"):
        raise InputError("INVALID_EVENT")
    result = {"event_id": eid.lower(), "event_type": kind, "event_time": timestamp(value.get("event_time"), now),
              "impression_id": identifier(value.get("impression_id")), "page_type": page}
    if kind == "exposure":
        duration = value.get("duration_ms")
        if type(duration) is not int or not 1 <= duration <= 86400000:
            raise InputError("INVALID_DURATION")
        result.update(duration_ms=duration, ended_at=timestamp(value.get("ended_at"), now))
        if result["ended_at"] < result["event_time"]:
            raise InputError("INVALID_INTERVAL")
        if page != "list":
            raise InputError("INVALID_EVENT_FIELDS")
    elif "duration_ms" in value or "ended_at" in value or (kind == "article_open" and page != "list") or (kind == "article_close" and page != "detail"):
        raise InputError("INVALID_EVENT_FIELDS")
    if len(compact(value).encode()) > 4096:
        raise InputError("EVENT_TOO_LARGE")
    return result
