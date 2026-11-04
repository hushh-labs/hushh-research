from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes.one.calls import router


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_firebase_auth] = lambda: "synthetic-owner"
    with TestClient(app) as session:
        yield session


def test_capabilities_fail_closed_without_relay_or_qualification(client, monkeypatch):
    for name in (
        "DIRECT_CALLS_ENABLED",
        "DIRECT_MESSAGES_E2EE_QUALIFIED",
        "DIRECT_CALLS_NATIVE_QUALIFIED",
    ):
        monkeypatch.delenv(name, raising=False)
    response = client.get("/api/one/messages/calls/capabilities")
    assert response.status_code == 200
    assert response.json()["available"] is False
    assert response.json()["agentParticipation"] is False
    assert response.headers["cache-control"] == "private, no-store"


def test_validation_and_size_errors_do_not_echo_signaling_or_allow_cache(client):
    marker = "private-synthetic-signaling-must-not-be-echoed"
    body = {
        "proof": {
            "deviceId": "synthetic-device",
            "nonce": str(uuid4()),
            "expiresAt": 10,
            "signature": marker,
        },
        "payload": {"callId": str(uuid4())},
    }
    response = client.post("/api/one/messages/calls/credentials", json=body)
    assert response.status_code == 422
    assert marker not in response.text
    assert response.headers["cache-control"] == "private, no-store"
    response = client.post(
        "/api/one/messages/calls/create", content=marker, headers={"Content-Length": "650001"}
    )
    assert response.status_code == 413
    assert marker not in response.text
    assert response.headers["cache-control"] == "private, no-store"
