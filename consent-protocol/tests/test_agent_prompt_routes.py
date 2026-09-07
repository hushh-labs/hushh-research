"""Route-contract tests for GET /api/one/agent-prompt (prompt-sync read path).

TestClient with the cap.agent.prompt.sync dependency overridden and the prompt
service monkeypatched to a fake, so the route is exercised without auth or a
database. Verifies the flag gate, that the served agent is the caller's OWN token
identity (no client agent_id param), the signed-prompt body, conditional GET
(ETag / If-None-Match -> 304), not-found, and the missing-identity guard.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.one import agent_prompt as ap
from hushh_mcp.services.personal_agent_prompt_service import ResolvedPrompt

_SHA = "a" * 64


def _resolved(**over) -> ResolvedPrompt:
    base = dict(
        agent_id="personal_agent",
        channel="default",
        version="v1",
        prompt_text="stay private",
        prompt_sha256=_SHA,
        signature="aps1_deadbeef",
        status="active",
    )
    base.update(over)
    return ResolvedPrompt(**base)


def _build(monkeypatch, *, enabled=True, resolved=None, raises=None, agent_id="personal_agent"):
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1" if enabled else "0")
    seen: dict = {}

    class FakeService:
        async def get_active_prompt(self, *, agent_id, channel="default"):
            seen["agent_id"] = agent_id
            seen["channel"] = channel
            if raises is not None:
                raise raises
            return resolved

    monkeypatch.setattr(ap, "_service", lambda: FakeService())

    token_data: dict = {"user_id": "uid1", "scope": "cap.agent.prompt.sync"}
    if agent_id is not None:
        token_data["agent_id"] = agent_id

    app = FastAPI()
    app.include_router(ap.router)
    # The route's auth entry point is now _authenticate_prompt_caller, which resolves a
    # pod's Google ID token when POD_HUB_IDENTITY_AUTH_ENABLED is on and otherwise
    # delegates to _require_prompt_sync unchanged. Overriding the entry point keeps
    # these tests about the route's behaviour rather than about either auth mechanism.
    app.dependency_overrides[ap._authenticate_prompt_caller] = lambda: token_data
    return TestClient(app), seen


def test_requires_flag(monkeypatch):
    client, _ = _build(monkeypatch, enabled=False, resolved=_resolved())
    resp = client.get("/api/one/agent-prompt")
    assert resp.status_code == 404


def test_returns_own_signed_prompt(monkeypatch):
    client, seen = _build(monkeypatch, resolved=_resolved())
    resp = client.get("/api/one/agent-prompt")
    assert resp.status_code == 200
    body = resp.json()
    assert body["agentId"] == "personal_agent"
    assert body["version"] == "v1"
    assert body["prompt"] == "stay private"
    assert body["promptSha256"] == _SHA
    assert body["signature"] == "aps1_deadbeef"
    assert resp.headers["etag"] == f'"{_SHA}"'
    # The served agent is the token identity, never a client-supplied value.
    assert seen["agent_id"] == "personal_agent"


def test_agent_id_comes_from_token_not_query(monkeypatch):
    # A client-supplied agent_id query param is ignored; the token identity wins.
    client, seen = _build(monkeypatch, resolved=_resolved(), agent_id="agent_kai")
    resp = client.get("/api/one/agent-prompt", params={"agent_id": "agent_nav"})
    assert resp.status_code == 200
    assert seen["agent_id"] == "agent_kai"


def test_missing_token_agent_identity_returns_403(monkeypatch):
    client, _ = _build(monkeypatch, resolved=_resolved(), agent_id=None)
    resp = client.get("/api/one/agent-prompt")
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "AGENT_IDENTITY_MISSING"


def test_conditional_get_returns_304(monkeypatch):
    client, _ = _build(monkeypatch, resolved=_resolved())
    resp = client.get("/api/one/agent-prompt", headers={"If-None-Match": f'"{_SHA}"'})
    assert resp.status_code == 304
    assert resp.headers["etag"] == f'"{_SHA}"'
    assert resp.content == b""


def test_conditional_get_miss_returns_200(monkeypatch):
    client, _ = _build(monkeypatch, resolved=_resolved())
    resp = client.get("/api/one/agent-prompt", headers={"If-None-Match": '"other-hash"'})
    assert resp.status_code == 200


def test_not_found_when_no_active_prompt(monkeypatch):
    client, _ = _build(monkeypatch, resolved=None)
    resp = client.get("/api/one/agent-prompt")
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "PROMPT_NOT_FOUND"


def test_invalid_prompt_query_returns_400(monkeypatch):
    client, _ = _build(monkeypatch, raises=ValueError("agent_id is required"))
    resp = client.get("/api/one/agent-prompt")
    assert resp.status_code == 400
    assert resp.json()["detail"]["code"] == "INVALID_PROMPT_QUERY"
