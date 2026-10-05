"""What the app learns before it asks for a key: the catalog and the agent's advert.

C3: an agent that can hold a sealed selection says so on ``/pod/info`` and on every
heartbeat; the hub keeps that advert only in its exact shape, and the owner's status
shows it, or ``null`` for an older agent, which is the app's cue to offer an update.
C5: the provider list the app renders is server-owned.
"""

from __future__ import annotations

import pytest

from api.routes.one import personal_agent
from api.routes.one.pod_capabilities import ai_selection_advert, pod_capabilities
from api.routes.one.pod_heartbeat import _read_self_report
from hushh_mcp.services import pod_ai_selection

with pytest.MonkeyPatch.context() as _pod_import_env:
    _pod_import_env.setenv("HUSSH_POD_MODE", "1")
    import pod_server

ADVERT = {"version": 1, "providers": ["gemini", "openai"]}


class _Request:
    def __init__(self, body) -> None:
        self._body = body

    async def json(self):
        return self._body


class _Client:
    def __init__(self) -> None:
        self.bodies: list[dict] = []

    def post(self, _path: str, *, json: dict):
        self.bodies.append(json)
        return type("Response", (), {"status_code": 200})()


async def test_the_pod_advertises_on_info_and_on_every_beat():
    assert pod_capabilities()["aiSelection"] == ADVERT
    client = _Client()
    assert await pod_server._heartbeat_once(client) is True
    assert client.bodies[0]["aiSelection"] == ADVERT


async def test_the_hub_keeps_the_advert_only_in_its_exact_shape():
    report = await _read_self_report(
        _Request({"imageTag": "dev-1", "aiSelection": {**ADVERT, "keyHint": "sk-..."}})
    )
    assert report == {"imageTag": "dev-1", "aiSelection": ADVERT}, "extra keys are dropped"


@pytest.mark.parametrize(
    "advert",
    [
        {"version": True, "providers": ["openai"]},
        {"version": 0, "providers": ["openai"]},
        {"version": 1, "providers": "openai"},
        {"version": 1, "providers": ["Open AI"]},
        {"version": 1, "providers": [f"p{i}" for i in range(9)]},
        ["gemini", "openai"],
    ],
    ids=["bool_version", "zero_version", "string_providers", "bad_id", "too_many", "not_object"],
)
async def test_a_malformed_advert_reads_as_no_advert(advert):
    """Negative controls for the shape check: never a partial or coerced advert."""
    assert ai_selection_advert(advert) is None
    assert await _read_self_report(_Request({"aiSelection": advert})) is None


class _Registry:
    def __init__(self, row: dict) -> None:
        self._row = row

    async def get(self, _user_id: str):
        return self._row


def _row(observed: dict | None) -> dict:
    metadata = {"observed": observed} if observed is not None else {}
    return {
        "user_id": "u1",
        "hushh_id": "h1",
        "status": "provisioned",
        "backend_metadata": metadata,
    }


@pytest.mark.parametrize(
    ("observed", "expected"),
    [
        ({"imageTag": "dev-2", "aiSelection": ADVERT}, ADVERT),
        ({"imageTag": "dev-1"}, None),  # an older agent: offer the update
        (None, None),
    ],
    ids=["advertised", "older_agent", "never_reported"],
)
async def test_the_owners_status_shows_the_running_agents_advert(monkeypatch, observed, expected):
    monkeypatch.setattr(personal_agent, "personal_agent_enabled", lambda: True)
    status = await personal_agent.resolve_personal_agent_status(
        user_id="u1", registry=_Registry(_row(observed))
    )
    assert "aiSelection" in status and status["aiSelection"] == expected


def test_a_sealed_openai_selection_turns_web_search_off_in_the_report(monkeypatch):
    from api.routes.one.pod_capabilities import web_search_capability
    from hushh_mcp.services.pod_ai_selection import AiSelection

    for name in ("AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_DEPLOYMENT"):
        monkeypatch.delenv(name, raising=False)
    assert web_search_capability()["available"] is True, "negative control: own Gemini"
    pod_ai_selection.set_active_ai_selection(
        AiSelection("openai", None, "sk-x", None, None, None, 1, "s", 1)
    )
    try:
        assert web_search_capability() == {"available": False, "reason": "requires_gemini_model"}
    finally:
        pod_ai_selection.set_active_ai_selection(None)


# -- C5: the provider catalog -----------------------------------------------------------


def test_the_provider_catalog_is_server_owned_and_signed_in_only():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from api.middleware import require_firebase_auth
    from api.routes.one import router as one_router
    from api.routes.one.runtime_providers import router

    paths = {getattr(r, "path", "") for r in one_router.routes}
    assert "/api/one/runtime/providers" in paths, "mounted on the hub's One router"

    app = FastAPI()
    app.include_router(router)
    client = TestClient(app, raise_server_exceptions=False)
    assert client.get("/api/one/runtime/providers").status_code in {401, 403}

    app.dependency_overrides[require_firebase_auth] = lambda: "uid-1"
    assert client.get("/api/one/runtime/providers").json() == {
        "version": 1,
        "providers": [
            {
                "id": "gemini",
                "name": "Google Gemini",
                "availability": "available",
                "methods": ["own_key"],
                "agentCapability": "gemini",
            },
            {
                "id": "openai",
                "name": "OpenAI",
                "availability": "available",
                "methods": ["own_key"],
                "agentCapability": "openai",
                "defaultModel": "gpt-5.6-luna",
            },
            {"id": "anthropic", "name": "Claude", "availability": "coming_soon", "methods": []},
            {"id": "grok", "name": "Grok", "availability": "coming_soon", "methods": []},
        ],
    }
    available = {
        p["agentCapability"]
        for p in client.get("/api/one/runtime/providers").json()["providers"]
        if p["availability"] == "available"
    }
    assert available == set(ADVERT["providers"]), "every offered provider is one an agent can run"
