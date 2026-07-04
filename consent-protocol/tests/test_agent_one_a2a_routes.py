"""Agent One A2A route contract tests."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.one import a2a
from hushh_mcp.consent.token import issue_token
from hushh_mcp.constants import ConsentScope


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(a2a.router)
    return TestClient(app)


def _token(
    scope: ConsentScope = ConsentScope.AGENT_ONE_ORCHESTRATE,
    user_id: str = "user-one",
) -> str:
    return issue_token(user_id, "calling_agent", scope).token


def test_agent_card_is_manifest_backed():
    response = _client().get("/api/one/a2a/card")

    assert response.status_code == 200
    payload = response.json()
    assert payload["agentId"] == "agent_one"
    assert payload["name"] == "Agent One"
    assert payload["requiredScopes"] == ["agent.one.orchestrate"]
    assert payload["protocol"]["consentHeader"] == "X-Consent-Token"
    assert payload["endpoints"]["message"] == "/api/one/a2a/message"
    assert payload["capabilities"]["specialist_delegation"] is True


def test_message_requires_consent_token():
    response = _client().post("/api/one/a2a/message", json={"message": "Who are you?"})

    assert response.status_code == 401
    assert response.json()["detail"] == "Missing X-Consent-Token"


def test_message_rejects_wrong_scope():
    response = _client().post(
        "/api/one/a2a/message",
        json={"message": "Analyze my portfolio"},
        headers={"X-Consent-Token": _token(ConsentScope.AGENT_KAI_ANALYZE)},
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "Invalid consent token"


def test_message_rejects_user_mismatch():
    response = _client().post(
        "/api/one/a2a/message",
        json={"message": "Who are you?", "userId": "other-user"},
        headers={"X-Consent-Token": _token(user_id="user-one")},
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "Token user does not match request user"


def test_message_routes_general_turn_to_one():
    response = _client().post(
        "/api/one/a2a/message",
        json={"message": "Who are you?", "userId": "user-one", "conversationId": "conv-1"},
        headers={"X-Consent-Token": _token(user_id="user-one")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["agentId"] == "agent_one"
    assert payload["userId"] == "user-one"
    assert payload["conversationId"] == "conv-1"
    assert payload["delegation"] is None
    assert "One" in payload["response"]


def test_message_surfaces_specialist_delegation():
    response = _client().post(
        "/api/one/a2a/message",
        json={"message": "Please review my portfolio allocation"},
        headers={"X-Consent-Token": _token(user_id="user-one")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["userId"] == "user-one"
    assert payload["delegation"]["delegated"] is True
    assert payload["delegation"]["target_agent"] == "agent_kai"
    assert payload["delegation"]["domain"] == "finance"
