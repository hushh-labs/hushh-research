"""Contract tests for the opt-in official ADK A2A transport."""

from __future__ import annotations

import importlib.util
from types import SimpleNamespace

import pytest
from flask import Flask
from starlette.testclient import TestClient

from hushh_mcp.adk_bridge import official_a2a

# The official transport is opt-in and depends on the google-adk[a2a] extra;
# environments without it must still pass the suite (the module itself raises
# a clean RuntimeError at app-creation time, which is its documented contract).
_HAS_OFFICIAL_A2A = importlib.util.find_spec("a2a") is not None
requires_official_a2a = pytest.mark.skipif(
    not _HAS_OFFICIAL_A2A,
    reason="google-adk[a2a] extra not installed; official transport unavailable",
)


@pytest.mark.asyncio
async def test_official_transport_rejects_missing_consent_header():
    context = SimpleNamespace(call_context=SimpleNamespace(state={"headers": {}}))

    with pytest.raises(PermissionError, match="X-Consent-Token"):
        await official_a2a._authorize_request(context)


@pytest.mark.asyncio
async def test_official_transport_keeps_raw_consent_token_out_of_call_context(monkeypatch):
    async def validate(_: str, __: str):
        return SimpleNamespace(ok=True, user_id="reviewer-user")

    monkeypatch.setattr(official_a2a, "validate_a2a_consent_token_with_db", validate)
    context = SimpleNamespace(
        call_context=SimpleNamespace(state={"headers": {"x-consent-token": "secret-token"}})
    )

    user_id, token = await official_a2a._authorize_request(context)

    assert user_id == "reviewer-user"
    assert token == "secret-token"
    assert context.call_context.state[official_a2a._AUTH_STATE_KEY] == {"user_id": "reviewer-user"}
    assert "secret-token" not in repr(context.call_context.state)


@requires_official_a2a
def test_official_transport_advertises_the_adk_extension(monkeypatch):
    monkeypatch.setenv("HUSHH_KAI_A2A_PUBLIC_URL", "https://a2a.example.test")
    app = official_a2a.create_kai_official_a2a_app()

    with TestClient(app) as client:
        response = client.get("/.well-known/agent-card.json")

    assert response.status_code == 200
    card = response.json()
    assert card["url"] == "https://a2a.example.test"
    assert card["capabilities"]["extensions"] == [
        {
            "uri": official_a2a.ADK_A2A_EXTENSION_URI,
            "description": "Uses ADK's improved A2A executor implementation.",
            "required": False,
        }
    ]


@requires_official_a2a
def test_official_transport_returns_clean_auth_error_before_adk_execution():
    app = official_a2a.create_kai_official_a2a_app()
    payload = {
        "jsonrpc": "2.0",
        "id": "missing-consent",
        "method": "message/send",
        "params": {
            "message": {
                "messageId": "m1",
                "role": "user",
                "parts": [{"kind": "text", "text": "AAPL"}],
            }
        },
    }

    with TestClient(app) as client:
        response = client.post("/", json=payload)

    assert response.status_code == 401
    assert response.json()["error"]["message"].startswith("CONSENT_REQUIRED")


def test_legacy_transport_remains_the_default(monkeypatch):
    import server_a2a

    monkeypatch.delenv("HUSHH_KAI_A2A_TRANSPORT", raising=False)

    assert isinstance(server_a2a.create_app(), Flask)

    monkeypatch.setenv("HUSHH_KAI_A2A_TRANSPORT", "unsupported")
    with pytest.raises(ValueError, match="HUSHH_KAI_A2A_TRANSPORT"):
        server_a2a.create_app()
