"""Security boundary for the Meta test webhook ingress."""

from __future__ import annotations

import hashlib
import hmac
import json
import logging

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.one.whatsapp_pilot import router


def _client(monkeypatch) -> TestClient:
    monkeypatch.setenv("HUSHH_WHATSAPP_PILOT_VERIFY_TOKEN", "test-verify-token")
    monkeypatch.setenv("HUSHH_META_APP_SECRET", "test-app-secret")
    monkeypatch.setenv("HUSHH_WHATSAPP_PILOT_WABA_ID", "test-waba")
    monkeypatch.setenv("HUSHH_WHATSAPP_PILOT_PHONE_NUMBER_ID", "test-phone")
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _signed_headers(body: bytes) -> dict[str, str]:
    digest = hmac.new(b"test-app-secret", body, hashlib.sha256).hexdigest()
    return {"X-Hub-Signature-256": f"sha256={digest}"}


def test_verification_requires_exact_token(monkeypatch):
    with _client(monkeypatch) as client:
        path = "/api/one/whatsapp/pilot/webhook"
        params = {"hub.mode": "subscribe", "hub.challenge": "12345"}
        assert client.get(path, params={**params, "hub.verify_token": "test-verify-token"}).text == "12345"
        assert client.get(path, params={**params, "hub.verify_token": "incorrect"}).status_code == 403
        monkeypatch.delenv("HUSHH_WHATSAPP_PILOT_VERIFY_TOKEN")
        assert client.get(path, params={**params, "hub.verify_token": "test-verify-token"}).status_code == 503


def test_signed_message_is_acknowledged_without_logging_private_content(monkeypatch, caplog):
    body = json.dumps(
        {
            "object": "whatsapp_business_account",
            "entry": [{
                "id": "test-waba",
                "changes": [{
                    "field": "messages",
                    "value": {
                        "messaging_product": "whatsapp",
                        "metadata": {"phone_number_id": "test-phone"},
                        "messages": [{"id": "private-message-id", "from": "private-sender", "text": {"body": "private-message-body"}}],
                    },
                }],
            }],
        }
    ).encode()
    with caplog.at_level(logging.INFO, logger="api.routes.one.whatsapp_pilot"):
        with _client(monkeypatch) as client:
            path = "/api/one/whatsapp/pilot/webhook"
            assert client.post(path, content=body, headers=_signed_headers(body)).json() == {"accepted": True}
            assert client.post(path, content=body).status_code == 401
    assert "inbound=1 statuses=0" in caplog.text
    assert "private-sender" not in caplog.text
    assert "private-message-body" not in caplog.text
    assert "private-message-id" not in caplog.text


def test_signed_event_for_other_business_is_ignored(monkeypatch, caplog):
    body = json.dumps({"object": "whatsapp_business_account", "entry": [{"id": "other-waba", "changes": []}]}).encode()
    with caplog.at_level(logging.INFO, logger="api.routes.one.whatsapp_pilot"):
        with _client(monkeypatch) as client:
            response = client.post("/api/one/whatsapp/pilot/webhook", content=body, headers=_signed_headers(body))
    assert response.status_code == 200
    assert "inbound=0 statuses=0" in caplog.text
