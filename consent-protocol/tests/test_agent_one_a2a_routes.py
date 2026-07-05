"""Agent One A2A route contract tests."""

from __future__ import annotations

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.one import a2a
from hushh_mcp.consent.token import issue_token, validate_token
from hushh_mcp.constants import ConsentScope


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(a2a.router)
    app.include_router(a2a.well_known_router)
    return TestClient(app)


def _token(
    scope: ConsentScope = ConsentScope.AGENT_ONE_ORCHESTRATE,
    user_id: str = "user-one",
    agent_id: str = "developer:brand-agent",
) -> str:
    return issue_token(user_id, agent_id, scope).token


def _principal(agent_id: str = "developer:brand-agent") -> SimpleNamespace:
    return SimpleNamespace(
        app_id="app_brand",
        agent_id=agent_id,
        display_name="Brand Agent",
        allowed_tool_groups=("core_consent",),
        brand_image_url=None,
        website_url=None,
    )


def _patch_developer_auth(monkeypatch, *, agent_id: str = "developer:brand-agent") -> None:
    monkeypatch.setattr(a2a, "authenticate_developer_principal", lambda **_: _principal(agent_id))


def _patch_db_token_validation(monkeypatch) -> None:
    async def _validate(token, expected_scope=None, **kwargs):
        return validate_token(token, expected_scope, **kwargs)

    monkeypatch.setattr(a2a, "validate_token_with_db", _validate)


def test_agent_card_is_manifest_backed():
    response = _client().get("/api/one/a2a/card")

    assert response.status_code == 200
    payload = response.json()
    assert payload["agentId"] == "agent_one"
    assert payload["name"] == "Agent One"
    assert payload["requiredScopes"] == ["agent.one.orchestrate"]
    assert payload["protocol"]["developerAuth"] == "Authorization: Bearer <developer-token>"
    assert payload["protocol"]["consentHeader"] == "X-Consent-Token"
    assert payload["endpoints"]["message"] == "/api/one/a2a/message"
    assert payload["capabilities"]["specialist_delegation"] is True


def test_standard_well_known_agent_card_matches_manifest_card():
    client = _client()
    standard = client.get("/.well-known/agent-card.json")
    compat = client.get("/api/one/a2a/card")

    assert standard.status_code == 200
    assert standard.json() == compat.json()


def test_message_requires_consent_token_or_developer_auth():
    response = _client().post("/api/one/a2a/message", json={"message": "Who are you?"})

    assert response.status_code == 401
    assert response.json()["detail"]["error_code"] == "DEVELOPER_TOKEN_REQUIRED"


def test_message_without_consent_token_creates_pending_consent_request(monkeypatch):
    inserted: dict[str, object] = {}
    orchestrator_called = False

    async def _resolve_user(body):
        return "user-one"

    class _FakeConsentDBService:
        async def get_covering_active_tokens(
            self,
            user_id: str,
            *,
            agent_id: str | None = None,
            requested_scope: str,
        ):
            assert user_id == "user-one"
            assert agent_id == "developer:brand-agent"
            assert requested_scope == "agent.one.orchestrate"
            return []

        async def get_pending_request_for_scope(
            self,
            user_id: str,
            *,
            agent_id: str,
            scope: str,
        ):
            assert user_id == "user-one"
            assert agent_id == "developer:brand-agent"
            assert scope == "agent.one.orchestrate"
            return None

        async def insert_event(self, **kwargs):
            inserted.update(kwargs)
            return 1

    class _FailingOrchestrator:
        def handle_message(self, **kwargs):
            nonlocal orchestrator_called
            orchestrator_called = True
            raise AssertionError("orchestrator must not execute before consent")

    monkeypatch.setattr(
        a2a,
        "authenticate_developer_principal",
        lambda **_: _principal(),
    )
    monkeypatch.setattr(a2a, "_resolve_consent_user_id", _resolve_user)
    monkeypatch.setattr(a2a, "ConsentDBService", _FakeConsentDBService)
    monkeypatch.setattr(a2a, "get_orchestrator", lambda: _FailingOrchestrator())

    response = _client().post(
        "/api/one/a2a/message",
        json={
            "message": "Please coordinate my task",
            "email": "user@example.com",
            "conversationId": "conv-1",
        },
        headers={"Authorization": "Bearer hdk_demo"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["isComplete"] is False
    assert payload["userId"] == "user-one"
    assert payload["consent"]["status"] == "pending"
    assert payload["consent"]["requiredScope"] == "agent.one.orchestrate"
    assert payload["consent"]["tokenRequired"] is True
    assert inserted["action"] == "REQUESTED"
    assert inserted["scope"] == "agent.one.orchestrate"
    assert inserted["agent_id"] == "developer:brand-agent"
    assert inserted["metadata"]["request_source"] == "agent_one_a2a_consent_v1"
    assert inserted["metadata"]["requester_actor_type"] == "a2a_agent"
    assert "connector_public_key" not in inserted["metadata"]
    assert orchestrator_called is False


def test_message_without_consent_token_reports_existing_pending_request(monkeypatch):
    async def _resolve_user(body):
        return "user-one"

    class _FakeConsentDBService:
        async def get_covering_active_tokens(self, *args, **kwargs):
            return []

        async def get_pending_request_for_scope(self, *args, **kwargs):
            return {
                "id": "req_pending",
                "requestUrl": "http://localhost:3000/consents?tab=pending&requestId=req_pending",
                "pollTimeoutAt": 123456,
                "approvalTimeoutAt": 123456,
            }

    monkeypatch.setattr(
        a2a,
        "authenticate_developer_principal",
        lambda **_: _principal(),
    )
    monkeypatch.setattr(a2a, "_resolve_consent_user_id", _resolve_user)
    monkeypatch.setattr(a2a, "ConsentDBService", _FakeConsentDBService)

    response = _client().post(
        "/api/one/a2a/message",
        json={"message": "Please coordinate my task", "userId": "user-one"},
        headers={"Authorization": "Bearer hdk_demo"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["isComplete"] is False
    assert payload["consent"]["status"] == "pending"
    assert payload["consent"]["requestId"] == "req_pending"


def test_message_with_consent_token_requires_developer_auth():
    response = _client().post(
        "/api/one/a2a/message",
        json={"message": "Who are you?"},
        headers={"X-Consent-Token": _token()},
    )

    assert response.status_code == 401
    assert response.json()["detail"]["error_code"] == "DEVELOPER_TOKEN_REQUIRED"


def test_message_rejects_wrong_scope(monkeypatch):
    _patch_developer_auth(monkeypatch)
    _patch_db_token_validation(monkeypatch)

    response = _client().post(
        "/api/one/a2a/message",
        json={"message": "Analyze my portfolio"},
        headers={
            "Authorization": "Bearer hdk_demo",
            "X-Consent-Token": _token(ConsentScope.AGENT_KAI_ANALYZE),
        },
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "Invalid consent token"


def test_message_rejects_developer_app_mismatch(monkeypatch):
    _patch_developer_auth(monkeypatch, agent_id="developer:other-agent")
    _patch_db_token_validation(monkeypatch)

    response = _client().post(
        "/api/one/a2a/message",
        json={"message": "Who are you?"},
        headers={
            "Authorization": "Bearer hdk_demo",
            "X-Consent-Token": _token(agent_id="developer:brand-agent"),
        },
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "Token app does not match caller"


def test_message_rejects_db_revoked_token(monkeypatch):
    _patch_developer_auth(monkeypatch)

    async def _revoked(*args, **kwargs):
        return False, "Token has been revoked (DB check)", None

    monkeypatch.setattr(a2a, "validate_token_with_db", _revoked)

    response = _client().post(
        "/api/one/a2a/message",
        json={"message": "Who are you?"},
        headers={
            "Authorization": "Bearer hdk_demo",
            "X-Consent-Token": _token(),
        },
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "Invalid consent token"


def test_message_rejects_user_mismatch(monkeypatch):
    _patch_developer_auth(monkeypatch)
    _patch_db_token_validation(monkeypatch)

    response = _client().post(
        "/api/one/a2a/message",
        json={"message": "Who are you?", "userId": "other-user"},
        headers={
            "Authorization": "Bearer hdk_demo",
            "X-Consent-Token": _token(user_id="user-one"),
        },
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "Token user does not match request user"


def test_message_rejects_email_target_mismatch(monkeypatch):
    _patch_developer_auth(monkeypatch)
    _patch_db_token_validation(monkeypatch)

    async def _resolve_user(body):
        return "other-user"

    monkeypatch.setattr(a2a, "_resolve_consent_user_id", _resolve_user)

    response = _client().post(
        "/api/one/a2a/message",
        json={"message": "Who are you?", "email": "other@example.com"},
        headers={
            "Authorization": "Bearer hdk_demo",
            "X-Consent-Token": _token(user_id="user-one"),
        },
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "Token user does not match request user"


def test_message_routes_general_turn_to_one(monkeypatch):
    _patch_developer_auth(monkeypatch)
    _patch_db_token_validation(monkeypatch)

    response = _client().post(
        "/api/one/a2a/message",
        json={"message": "Who are you?", "userId": "user-one", "conversationId": "conv-1"},
        headers={
            "Authorization": "Bearer hdk_demo",
            "X-Consent-Token": _token(user_id="user-one"),
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["agentId"] == "agent_one"
    assert payload["userId"] == "user-one"
    assert payload["conversationId"] == "conv-1"
    assert payload["delegation"] is None
    assert "One" in payload["response"]


def test_message_surfaces_specialist_delegation(monkeypatch):
    _patch_developer_auth(monkeypatch)
    _patch_db_token_validation(monkeypatch)

    response = _client().post(
        "/api/one/a2a/message",
        json={"message": "Please review my portfolio allocation"},
        headers={
            "Authorization": "Bearer hdk_demo",
            "X-Consent-Token": _token(user_id="user-one"),
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["userId"] == "user-one"
    assert payload["delegation"]["delegated"] is True
    assert payload["delegation"]["target_agent"] == "agent_kai"
    assert payload["delegation"]["domain"] == "finance"
