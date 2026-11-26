"""Stateless intake: broker acknowledgement, never a DB/GCS completion claim."""
import base64
import hashlib
import hmac
import json
import logging
import re
import time

from .schema import InputError, action, canonical, compact, envelope, identifier, iso, served

logger = logging.getLogger(__name__)


class PubSubIntake:
    def __init__(self, topic, signing_key, *, client=None, now=None, timeout=1.0):
        if not re.fullmatch(r"projects/[a-z0-9-]+/topics/[A-Za-z][A-Za-z0-9._~+%-]{2,254}", topic):
            raise ValueError("INVALID_PUBSUB_TOPIC")
        if len(signing_key) < 32:
            raise ValueError("LOGGING_RECEIPT_KEY_MIN_32_CHARS")
        if client is None:
            # Use the synchronous GAPIC RPC: no unbounded background publish queue.
            from google.pubsub_v1.services.publisher import PublisherClient
            client = PublisherClient()
        self.client, self.topic = client, topic
        self.key, self.timeout = signing_key.encode(), timeout
        self.now = now or (lambda: int(time.time() * 1000))

    def signature(self, payload):
        return hmac.new(self.key, b"served-receipt-v1\0" + payload.encode(), hashlib.sha256).hexdigest()

    def receipt(self, record, at):
        payload = base64.urlsafe_b64encode(compact({"served": record, "expires": at + 86400000}).encode()).decode().rstrip("=")
        token = payload + "." + self.signature(payload)
        if len(token) > 4096:
            raise InputError("SERVED_RECEIPT_TOO_LARGE")
        return token

    def verify(self, token, reader, impression, at):
        if not isinstance(token, str) or len(token) > 4096:
            raise InputError("SERVED_RECEIPT_REQUIRED")
        try:
            payload, signature = token.split(".")
            if not hmac.compare_digest(signature.encode(), self.signature(payload).encode()):
                raise ValueError()
            claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
            if type(claims["expires"]) is not int or claims["expires"] <= at:
                raise ValueError()
            owner = claims["served"]
            if owner["reader_id"] != reader or owner["impression_id"] != impression:
                raise ValueError()
            return owner
        except (ValueError, KeyError, TypeError, UnicodeError):
            raise InputError("SERVED_RECEIPT_INVALID") from None

    def publish(self, stream, records):
        if not records:
            return None
        # One request is one broker message. Retrying an ambiguous RPC may duplicate
        # it; downstream MUST deduplicate by record ID, not Pub/Sub message ID.
        data = compact({"schema_version": 2, "stream": stream, "records": records}).encode()
        started = time.monotonic()
        try:
            response = self.client.publish(request={"topic": self.topic, "messages": [
                {"data": data, "attributes": {"schema_version": "2", "stream": stream}}
            ]}, retry=None, timeout=self.timeout)
            if len(response.message_ids) != 1 or not response.message_ids[0]:
                raise RuntimeError("PUBSUB_ACK_MISSING")
        except Exception as error:
            logger.warning("pubsub_publish_failed stream=%s elapsed_ms=%d reason=%s", stream,
                           int((time.monotonic() - started) * 1000), type(error).__name__)
            raise
        return response.message_ids[0]

    @staticmethod
    def rejected(value, key, code):
        identity = value.get(key) if isinstance(value, dict) else None
        return {key: identity[:128] if isinstance(identity, str) else None, "status": "rejected", "code": code}

    def intake_served(self, body, atomic=False, max_records=None):
        results, records, seen = [], [], {}
        at = self.now()
        for value in envelope(body, "records"):
            try:
                row = served(value, at)
                receipt = self.receipt(row, at)
                identity = row["impression_id"]
                raw = canonical(row)[0]
                if identity in seen and seen[identity] != raw:
                    raise InputError("IMPRESSION_ID_CONFLICT")
                duplicate = identity in seen
                if not duplicate:
                    records.append({**row, "received_at": iso(at)})
                    seen[identity] = raw
                results.append({"impression_id": identity, "status": "duplicate" if duplicate else "accepted",
                                "served_receipt": receipt})
            except InputError as error:
                if atomic:
                    raise
                results.append(self.rejected(value, "impression_id", str(error)))
        message = self.publish("served", records)
        return {"results": results, "ack_stage": "pubsub", "message_id": message}

    def intake_actions(self, body, reader, enabled, source="browser", max_records=None):
        identifier(reader)
        if not enabled:
            raise InputError("COLLECTION_DISABLED")
        if source not in ("browser", "simulator"):
            raise InputError("INVALID_CONTEXT")
        results, records, seen = [], [], {}
        at = self.now()
        for value in envelope(body, "events"):
            try:
                if not isinstance(value, dict):
                    raise InputError("INVALID_OBJECT")
                row = action({k: v for k, v in value.items() if k != "served_receipt"}, at)
                owner = self.verify(value.get("served_receipt"), reader, row["impression_id"], at)
                # Preserve the trusted join context even if files arrive out of order.
                record = {**row, "reader_id": reader, "request_id": owner["request_id"],
                          "article_id": owner["article_id"], "position": owner["position"],
                          "served_at": owner["served_at"], "source": source,
                          "measurement_version": "stationary-visible-v1"}
                identity, raw = row["event_id"], canonical(record)[0]
                if identity in seen and seen[identity] != raw:
                    raise InputError("EVENT_ID_CONFLICT")
                duplicate = identity in seen
                if not duplicate:
                    records.append({**record, "received_at": iso(at)})
                    seen[identity] = raw
                results.append({"event_id": identity, "status": "duplicate" if duplicate else "accepted"})
            except InputError as error:
                results.append(self.rejected(value, "event_id", str(error)))
        message = self.publish("actions", records)
        return {"results": results, "ack_stage": "pubsub", "message_id": message}

    def readiness(self):
        return {"mode": "pubsub", "ack_stage": "pubsub", "gcs_verified": False,
                "deletion_supported": False}

    def close(self):
        self.client.transport.close()
