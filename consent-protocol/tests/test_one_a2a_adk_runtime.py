"""Agent One external A2A on the ADK runtime (WS1 convergence).

Verifies the flag-gated ADK path: consent-gated turns run on One's text
head (same agent tree as voice), consent token rides in session state,
and the legacy orchestrator remains reachable via AGENT_ONE_A2A_RUNTIME=legacy.
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
    return issue_token(user_id, "developer:brand-agent", ConsentScope.AGENT_ONE_ORCHESTRATE).token


def _patch_auth(monkeypatch) -> None:
    principal = SimpleNamespace(
        app_id="app_brand",
        agent_id="developer:brand-agent",
        display_name="Brand Agent",
        allowed_tool_groups=("core_consent",),
        brand_image_url=None,
        website_url=None,
    )
    monkeypatch.setattr(a2a, "authenticate_developer_principal", lambda **_: principal)

    async def _validate(token, expected_scope=None, **kwargs):
        return validate_token(token, expected_scope, **kwargs)

    monkeypatch.setattr(a2a, "validate_token_with_db", _validate)


def test_adk_runtime_is_default(monkeypatch):
    monkeypatch.delenv("AGENT_ONE_A2A_RUNTIME", raising=False)
    assert a2a._adk_runtime_enabled() is True
    monkeypatch.setenv("AGENT_ONE_A2A_RUNTIME", "legacy")
    assert a2a._adk_runtime_enabled() is False
    monkeypatch.setenv("AGENT_ONE_A2A_RUNTIME", "adk")
    assert a2a._adk_runtime_enabled() is True


def test_message_runs_adk_turn_with_consent_in_state(monkeypatch):
    _patch_auth(monkeypatch)
    monkeypatch.delenv("AGENT_ONE_A2A_RUNTIME", raising=False)

    captured: dict = {}

    async def _fake_turn(*, user_id, consent_token, message, timezone):
        captured.update(
            user_id=user_id,
            consent_token=consent_token,
            message=message,
            timezone=timezone,
        )
        return "Hello from One's ADK head."

    monkeypatch.setattr(a2a, "_run_adk_turn", _fake_turn)

    class _ForbiddenOrchestrator:
        def handle_message(self, **_kwargs):  # pragma: no cover - must not run
            raise AssertionError("legacy orchestrator must not run on ADK path")

    monkeypatch.setattr(a2a, "get_orchestrator", lambda: _ForbiddenOrchestrator())

    token = _token()
    response = _client().post(
        "/api/one/a2a/message",
        json={"message": "Who are you?", "userId": "user-one", "conversationId": "conv-9"},
        headers={"Authorization": "Bearer hdk_demo", "X-Consent-Token": token},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["agentId"] == "agent_one"
    assert payload["userId"] == "user-one"
    assert payload["conversationId"] == "conv-9"
    assert payload["response"] == "Hello from One's ADK head."
    assert payload["delegation"] is None
    assert payload["isComplete"] is True
    assert captured["user_id"] == "user-one"
    assert captured["consent_token"] == token
    assert captured["message"] == "Who are you?"


def test_adk_failure_returns_500_without_leaking(monkeypatch):
    _patch_auth(monkeypatch)
    monkeypatch.delenv("AGENT_ONE_A2A_RUNTIME", raising=False)

    async def _boom(**_kwargs):
        raise RuntimeError("model backend unavailable: secret-detail")

    monkeypatch.setattr(a2a, "_run_adk_turn", _boom)

    response = _client().post(
        "/api/one/a2a/message",
        json={"message": "Who are you?"},
        headers={"Authorization": "Bearer hdk_demo", "X-Consent-Token": _token()},
    )

    assert response.status_code == 500
    assert response.json()["detail"] == "Agent One could not process the request"
    assert "secret-detail" not in response.text


def test_legacy_flag_falls_back_to_orchestrator(monkeypatch):
    _patch_auth(monkeypatch)
    monkeypatch.setenv("AGENT_ONE_A2A_RUNTIME", "legacy")

    class _Orchestrator:
        def handle_message(self, **kwargs):
            return {"response": "legacy reply", "delegation": None}

    monkeypatch.setattr(a2a, "get_orchestrator", lambda: _Orchestrator())

    async def _forbidden(**_kwargs):  # pragma: no cover - must not run
        raise AssertionError("ADK path must not run in legacy mode")

    monkeypatch.setattr(a2a, "_run_adk_turn", _forbidden)

    response = _client().post(
        "/api/one/a2a/message",
        json={"message": "Who are you?"},
        headers={"Authorization": "Bearer hdk_demo", "X-Consent-Token": _token()},
    )

    assert response.status_code == 200
    assert response.json()["response"] == "legacy reply"


def test_run_adk_turn_places_consent_in_session_state(monkeypatch):
    """The consent token must ride in session state, never the prompt."""
    import asyncio

    from hushh_mcp.one_adk import agent_tree

    created: dict = {}

    class _FakeSessionService:
        async def create_session(self, *, app_name, user_id, session_id, state):
            created.update(app_name=app_name, user_id=user_id, session_id=session_id, state=state)

        async def delete_session(self, *, app_name, user_id, session_id):
            created["deleted"] = session_id

    class _FakeEvent:
        def __init__(self, text):
            self.content = SimpleNamespace(parts=[SimpleNamespace(text=text)])

        def is_final_response(self):
            return True

    class _FakeRunner:
        session_service = _FakeSessionService()

        async def run_async(self, *, user_id, session_id, new_message):
            created["prompt"] = new_message.parts[0].text
            yield _FakeEvent("adk says hi")

    monkeypatch.setattr(agent_tree, "get_one_text_runner", lambda: _FakeRunner())

    fake_token = "HCT:secret-token"  # noqa: S105 - synthetic test value
    result = asyncio.run(
        a2a._run_adk_turn(
            user_id="user-one",
            consent_token=fake_token,
            message="hello",
            timezone="America/Los_Angeles",
        )
    )

    assert result == "adk says hi"
    assert created["state"][agent_tree.STATE_CONSENT_TOKEN] == fake_token
    assert created["state"][agent_tree.STATE_USER_ID] == "user-one"
    assert created["state"][agent_tree.STATE_TIMEZONE] == "America/Los_Angeles"
    assert created["prompt"] == "hello"
    assert fake_token not in created["prompt"]
    assert created["deleted"] == created["session_id"]
