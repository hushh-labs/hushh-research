"""Contained Agent One invocation-preview route contract tests."""

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
    scope: ConsentScope = ConsentScope.CAP_ONE_INVOKE,
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
        allowed_capabilities=("cap.one.invoke",),
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
    assert payload["contract"] == "hussh.one.invocation-preview.v1"
    assert payload["officialA2A"] is False
    assert payload["endpoint"] == "http://testserver/api/one/a2a/message"
    assert "supportedInterfaces" not in payload
    assert "protocolVersion" not in payload
    assert "preferredTransport" not in payload
    assert payload["requiredScopes"] == ["cap.one.invoke"]
    assert payload["securitySchemes"]["developerBearer"] == {
        "type": "http",
        "scheme": "bearer",
        "bearerFormat": "developer-token",
        "description": "Developer token issued for the partner app.",
    }
    assert payload["securitySchemes"]["userConsentToken"] == {
        "type": "apiKey",
        "in": "header",
        "name": "X-Consent-Token",
        "description": (
            "User-approved invocation token scoped to cap.one.invoke. "
            "Required when executing an approved user request."
        ),
    }
    assert payload["security"] == [{"developerBearer": []}]
    assert payload["securityRequirements"] == [{"developerBearer": []}]
    assert payload["protocol"]["developerAuth"] == "Authorization: Bearer <developer-token>"
    assert payload["protocol"]["consentHeader"] == "X-Consent-Token"
    assert payload["endpoints"]["message"] == "/api/one/a2a/message"
    assert payload["capabilities"] == {
        "streaming": False,
        "pushNotifications": False,
        "stateTransitionHistory": False,
        "extendedAgentCard": False,
    }
    assert payload["defaultInputModes"] == ["text/plain", "application/json"]
    assert payload["defaultOutputModes"] == ["application/json", "text/plain"]
    assert [skill["id"] for skill in payload["skills"]] == [
        "consent_managed_personal_data",
        "account_opening_identity_data",
        "privacy_and_vault_coordination",
        "financial_eligibility_data",
    ]
    financial_skill = next(
        skill for skill in payload["skills"] if skill["id"] == "financial_eligibility_data"
    )
    assert financial_skill["examples"] == [
        "I need your financial net worth score, so that I can review your eligibility to join my Hedge Fund.",
        "I need your last 3 months bank statement details for each of your connected bank accounts.",
    ]
    for skill in payload["skills"]:
        assert skill["inputModes"] == ["text/plain", "application/json"]
        assert skill["outputModes"] == ["application/json", "text/plain"]
        assert skill["security"] == [{"developerBearer": [], "userConsentToken": []}]
        assert skill["securityRequirements"] == [{"developerBearer": [], "userConsentToken": []}]
    assert "specialists" not in payload
    assert "agent_kai" not in str(payload)
    assert "agent_nav" not in str(payload)
    assert "agent_kyc" not in str(payload)
    assert "agent_location" not in str(payload)


def test_official_well_known_agent_card_is_not_advertised_before_conformance():
    client = _client()
    standard = client.get("/.well-known/agent-card.json")
    compat = client.get("/api/one/a2a/card")

    assert standard.status_code == 404
    assert compat.status_code == 200
    assert compat.json()["officialA2A"] is False


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
            assert requested_scope == "cap.one.invoke"
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
            assert scope == "cap.one.invoke"
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
    assert payload["consent"]["requiredScope"] == "cap.one.invoke"
    assert payload["consent"]["tokenRequired"] is True
    assert inserted["action"] == "REQUESTED"
    assert inserted["scope"] == "cap.one.invoke"
    assert inserted["agent_id"] == "developer:brand-agent"
    assert inserted["metadata"]["request_source"] == "one_invocation_preview_v1"
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


def test_message_requires_exact_authority_before_specialist_dispatch(monkeypatch):
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
    assert payload["delegation"] == {
        "delegated": True,
        "status": "auth_required",
        "errorCode": "EXACT_AUTHORITY_REQUIRED",
        "message": (
            "One may identify the next consent step, but cap.one.invoke does not "
            "authorize specialist data access or actions."
        ),
    }
    assert payload["isComplete"] is False
    assert "target_agent" not in str(payload)
    assert "agent_kai" not in str(payload)
