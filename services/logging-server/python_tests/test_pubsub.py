import json
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from logging_service.app import Settings, create_app
from logging_service.archive import audit_archive, read_archive
from logging_service.pubsub import PubSubIntake
from logging_service.schema import InputError, iso

TOKEN = "test-only-api-authentication-token"
KEY = "test-only-separate-served-signing-key"
TOPIC = "projects/test-project/topics/behavior-raw"
NOW = 1795650000000


class Publisher:
    def __init__(self):
        self.messages = []
        self.failure = False
        self.closed = False
        self.transport = SimpleNamespace(close=self.close)

    def close(self):
        self.closed = True

    def publish(self, *, request, retry, timeout):
        assert retry is None and timeout == 1.0
        assert request["topic"] == TOPIC
        if self.failure:
            raise TimeoutError("ambiguous publish")
        self.messages.extend(request["messages"])
        return SimpleNamespace(message_ids=[str(len(self.messages))])


def record(**changes):
    return {"request_id": "request-test", "impression_id": "impression-test", "reader_id": "reader-test",
            "article_id": "article-test", "position": 1, "served_at": iso(NOW), **changes}


def event(receipt, **changes):
    return {"event_id": str(uuid4()), "event_type": "article_open", "event_time": iso(NOW),
            "impression_id": "impression-test", "page_type": "list", "served_receipt": receipt, **changes}


def make_intake():
    publisher = Publisher()
    intake = PubSubIntake(TOPIC, KEY, client=publisher, now=lambda: NOW)
    return intake, publisher


def test_publish_ack_then_stateless_receipt_and_archive(tmp_path):
    intake, publisher = make_intake()
    response = intake.intake_served({"records": [record()]})
    assert response["ack_stage"] == "pubsub"
    receipt = response["results"][0]["served_receipt"]
    # A different worker / restart requires neither an inbox nor a cache.
    restarted = PubSubIntake(TOPIC, KEY, client=publisher, now=lambda: NOW)
    click = event(receipt)
    for _ in range(2):
        result = restarted.intake_actions({"events": [click]}, "reader-test", True)
        assert result["results"][0]["status"] == "accepted"
    data = [json.loads(m["data"]) for m in publisher.messages]
    assert data[1]["records"][0]["article_id"] == "article-test"
    assert data[1]["records"][0]["reader_id"] == "reader-test"
    assert "served_receipt" not in data[1]["records"][0]
    # GCS text mode emits one message per line; ordering is not assumed.
    archive = tmp_path / "export.jsonl"
    archive.write_text("\n".join(json.dumps(m) for m in reversed(data)), encoding="utf-8")
    records, duplicates = read_archive([archive])
    assert len(records) == 2 and duplicates == 1
    audit = tmp_path / "audit.jsonl"
    audit.write_text(json.dumps({"kind": "event_ack", "event_id": click["event_id"]}), encoding="utf-8")
    assert audit_archive(records, audit)["archive_matches_audit"]
    data[2]["records"][0]["page_type"] = "detail"
    archive.write_text("\n".join(json.dumps(m) for m in data), encoding="utf-8")
    with pytest.raises(ValueError, match="ARCHIVE_ID_CONFLICT"):
        read_archive([archive])


@pytest.mark.parametrize("change", ["missing", "tampered", "reader", "impression", "expired", "wrong-key"])
def test_receipt_rejects_forgery_and_cross_reader(change):
    intake, publisher = make_intake()
    receipt = intake.intake_served({"records": [record()]})["results"][0]["served_receipt"]
    row, reader = event(receipt), "reader-test"
    if change == "missing": row.pop("served_receipt")
    if change == "tampered": row["served_receipt"] += "x"
    if change == "reader": reader = "someone-else"
    if change == "impression": row["impression_id"] = "another-impression"
    if change == "expired":
        intake.now = lambda: NOW + 86400000
        row["event_time"] = iso(NOW + 86400000)
    if change == "wrong-key": intake.key = b"different-32-character-signing-key"
    response = intake.intake_actions({"events": [row]}, reader, True)
    assert response["results"][0]["status"] == "rejected"
    assert len(publisher.messages) == 1


def test_same_request_duplicates_conflicts_and_atomic_validation():
    intake, publisher = make_intake()
    with pytest.raises(InputError):
        intake.intake_served({"records": [record(), record(position=0)]}, atomic=True)
    assert not publisher.messages
    result = intake.intake_served({"records": [record(), record(), record(article_id="conflict")]})
    assert [r["status"] for r in result["results"]] == ["accepted", "duplicate", "rejected"]
    assert len(json.loads(publisher.messages[0]["data"])["records"]) == 1
    click = event(result["results"][0]["served_receipt"])
    response = intake.intake_actions({"events": [click, click, {**click, "event_type": "like"}]}, "reader-test", True)
    assert [r["status"] for r in response["results"]] == ["accepted", "duplicate", "rejected"]
    assert len(json.loads(publisher.messages[1]["data"])["records"]) == 1


def test_pubsub_app_never_opens_db_or_claims_gcs_or_deletion(tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("database instantiated in Pub/Sub mode")
    monkeypatch.setattr("logging_service.app.Store", forbidden)
    publisher = Publisher()
    config = Settings(TOKEN, database=str(tmp_path / "must-not-exist.sqlite"), pubsub_topic=TOPIC, receipt_key=KEY)
    with TestClient(create_app(config, publisher_client=publisher), raise_server_exceptions=False) as client:
        assert client.post("/internal/served", json={"records": [record()]}).status_code == 401
        client.headers["Authorization"] = "Bearer " + TOKEN
        client.app.state.store.now = lambda: NOW
        ready = client.get("/ready").json()
        assert ready["mode"] == "pubsub" and ready["gcs_verified"] is False
        result = client.post("/internal/served", json={"records": [record()]}).json()
        receipt = result["results"][0]["served_receipt"]
        headers = {"x-news-reader": "reader-test", "x-collection-enabled": "true"}
        assert client.post("/events", json={"events": [event(receipt)]}, headers=headers).json()["ack_stage"] == "pubsub"
        publisher.failure = True
        response = client.post("/internal/served", json={"records": [record()]})
        assert response.status_code == 503 and "results" not in response.json()
        assert client.post("/internal/delete-user", json={"reader_id": "reader-test"}).status_code == 501
        assert client.post("/internal/flush", json={}).json()["gcs_verified"] is False
    assert publisher.closed
    assert not list(tmp_path.iterdir())


def test_environment_pubsub_ignores_legacy_database_secret(monkeypatch):
    monkeypatch.setenv("LOGGING_STORE", "pubsub")
    monkeypatch.setenv("LOGGING_TOKEN", TOKEN)
    monkeypatch.setenv("LOGGING_PUBSUB_TOPIC", TOPIC)
    monkeypatch.setenv("LOGGING_RECEIPT_KEY", KEY)
    monkeypatch.setenv("LOGGING_DATABASE_URL", "postgresql://unused")
    config = Settings.environment()
    assert config.database_url is None and config.pubsub_topic == TOPIC
    monkeypatch.delenv("LOGGING_RECEIPT_KEY")
    with pytest.raises(ValueError): Settings.environment()
    monkeypatch.delenv("LOGGING_PUBSUB_TOPIC")
    with pytest.raises(ValueError): Settings.environment()


def test_official_sdk_serializes_one_message_and_preserves_rpc_deadline(monkeypatch):
    from google.auth.credentials import AnonymousCredentials
    from google.pubsub_v1.services.publisher import PublisherClient
    from google.pubsub_v1.types import PublishResponse

    client = PublisherClient(credentials=AnonymousCredentials())
    observed = []

    def rpc(request, *, retry, timeout, metadata):
        observed.append(request)
        assert retry is None and timeout == 1.0
        return PublishResponse(message_ids=["fixture-message"])

    monkeypatch.setitem(client.transport._wrapped_methods, client.transport.publish, rpc)
    intake = PubSubIntake(TOPIC, KEY, client=client, now=lambda: NOW)
    try:
        response = intake.intake_served({"records": [record()]})
        assert response["message_id"] == "fixture-message"
        assert observed[0].topic == TOPIC
        assert len(observed[0].messages) == 1
        assert json.loads(observed[0].messages[0].data)["stream"] == "served"
    finally:
        intake.close()
