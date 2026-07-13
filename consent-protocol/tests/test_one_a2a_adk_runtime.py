"""Containment tests for external One invocation authority.

The proprietary compatibility endpoint is intentionally invocation-only while
official A2A Tasks are implemented. It must never pass a cap.one.invoke token
into the ambient One ADK graph, whose private specialists require independent
information/action authority.
"""

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
    return TestClient(app)


def _token(user_id: str = "user-one") -> str:
    return issue_token(user_id, "developer:brand-agent", ConsentScope.CAP_ONE_INVOKE).token


def _patch_auth(monkeypatch) -> None:
    principal = SimpleNamespace(
        app_id="app_brand",
        agent_id="developer:brand-agent",
        display_name="Brand Agent",
        allowed_tool_groups=("core_consent",),
        allowed_capabilities=("cap.one.invoke",),
        brand_image_url=None,
        website_url=None,
    )
    monkeypatch.setattr(a2a, "authenticate_developer_principal", lambda **_: principal)

    async def _validate(token, expected_scope=None, **kwargs):
        return validate_token(token, expected_scope, **kwargs)

    monkeypatch.setattr(a2a, "validate_token_with_db", _validate)


def test_external_route_has_no_ambient_adk_execution_path() -> None:
    assert not hasattr(a2a, "_run_adk_turn")
    assert not hasattr(a2a, "_adk_runtime_enabled")


def test_general_invocation_runs_bounded_one_coordinator(monkeypatch) -> None:
    _patch_auth(monkeypatch)

    class _Coordinator:
        def handle_message(self, **kwargs):
            assert kwargs["consent_token"] == token
            return {"response": "bounded reply", "delegation": None}

    token = _token()
    monkeypatch.setattr(a2a, "get_orchestrator", lambda: _Coordinator())
    response = _client().post(
        "/api/one/a2a/message",
        json={"message": "Who are you?"},
        headers={"Authorization": "Bearer hdk_demo", "X-Consent-Token": token},
    )

    assert response.status_code == 200
    assert response.json()["response"] == "bounded reply"
    assert response.json()["isComplete"] is True


def test_specialist_dispatch_stops_at_auth_required(monkeypatch) -> None:
    _patch_auth(monkeypatch)

    class _Coordinator:
        def handle_message(self, **_kwargs):
            return {
                "response": "I need exact data authority before continuing.",
                "delegation": {"delegated": True, "target_agent": "agent_email"},
            }

    monkeypatch.setattr(a2a, "get_orchestrator", lambda: _Coordinator())
    response = _client().post(
        "/api/one/a2a/message",
        json={"message": "Read my email"},
        headers={"Authorization": "Bearer hdk_demo", "X-Consent-Token": _token()},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["isComplete"] is False
    assert payload["delegation"]["status"] == "auth_required"
    assert payload["delegation"]["errorCode"] == "EXACT_AUTHORITY_REQUIRED"
    assert "agent_email" not in str(payload)
