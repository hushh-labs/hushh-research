"""GET /api/one/voice/readiness is the single server-owned flag."""

from __future__ import annotations

from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes.one import voice

LIVE_MODEL = "gemini-live-2.5-flash-native-audio"


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(voice.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "firebase_uid_123"
    return app


@pytest.fixture(autouse=True)
def _reset_cache():
    voice.reset_readiness_cache()
    yield
    voice.reset_readiness_cache()


def test_disabled_flag_reports_disabled_without_touching_the_provider(monkeypatch):
    monkeypatch.delenv("ONE_VOICE_LIVE_ENABLED", raising=False)

    def _never(**_kwargs):
        raise AssertionError("no provider client may be constructed while disabled")

    monkeypatch.setattr(voice, "build_managed_live_client", _never)
    response = TestClient(_app()).get("/api/one/voice/readiness")
    assert response.status_code == 200
    assert response.json() == {
        "enabled": False,
        "status": "disabled",
        "model": None,
        "location": None,
        "protocol_version": "one-voice-v1",
        "ws_path": "/api/one/voice/live",
    }


def test_enabled_flag_without_model_pin_is_not_configured(monkeypatch):
    monkeypatch.setenv("ONE_VOICE_LIVE_ENABLED", "true")
    monkeypatch.delenv("VERTEX_LIVE_MODEL_ID", raising=False)
    monkeypatch.setenv("VERTEX_LIVE_LOCATION", "us-central1")
    body = TestClient(_app()).get("/api/one/voice/readiness").json()
    assert body["enabled"] is False
    assert body["status"] == "not_configured"


def test_ready_when_the_connect_probe_succeeds(monkeypatch):
    monkeypatch.setenv("ONE_VOICE_LIVE_ENABLED", "true")
    monkeypatch.setenv("VERTEX_LIVE_MODEL_ID", LIVE_MODEL)
    monkeypatch.setenv("VERTEX_LIVE_LOCATION", "us-central1")

    async def _ok(_config):
        return None

    monkeypatch.setattr(voice, "_probe_live_connect", _ok)
    body = TestClient(_app()).get("/api/one/voice/readiness").json()
    assert body == {
        "enabled": True,
        "status": "ready",
        "model": LIVE_MODEL,
        "location": "us-central1",
        "protocol_version": "one-voice-v1",
        "ws_path": "/api/one/voice/live",
    }


def test_provider_outage_hides_voice_and_never_reflects_provider_text(monkeypatch):
    monkeypatch.setenv("ONE_VOICE_LIVE_ENABLED", "true")
    monkeypatch.setenv("VERTEX_LIVE_MODEL_ID", LIVE_MODEL)
    monkeypatch.setenv("VERTEX_LIVE_LOCATION", "us-central1")

    async def _dunning(_config):
        raise RuntimeError("1008 None. Lightning dunning decision is deny for project: projects/x")

    monkeypatch.setattr(voice, "_probe_live_connect", _dunning)
    response = TestClient(_app()).get("/api/one/voice/readiness")
    assert response.status_code == 200
    body = response.json()
    assert body["enabled"] is False
    assert body["status"] == "provider_unavailable"
    assert "dunning" not in response.text


def test_readiness_probe_result_is_cached(monkeypatch):
    monkeypatch.setenv("ONE_VOICE_LIVE_ENABLED", "true")
    monkeypatch.setenv("VERTEX_LIVE_MODEL_ID", LIVE_MODEL)
    monkeypatch.setenv("VERTEX_LIVE_LOCATION", "us-central1")
    calls = []

    async def _ok(_config):
        calls.append(1)

    monkeypatch.setattr(voice, "_probe_live_connect", _ok)
    client = TestClient(_app())
    client.get("/api/one/voice/readiness")
    client.get("/api/one/voice/readiness")
    assert len(calls) == 1


# --- session minting + socket gating ----------------------------------------

from api.middleware import require_vault_owner_token  # noqa: E402

CONV = "11111111-2222-4333-8444-555555555555"


def _owner_app() -> FastAPI:
    app = FastAPI()
    app.include_router(voice.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": "owner-1",
        "token": "HCT:x",
    }
    return app


def test_session_mint_is_refused_while_disabled(monkeypatch):
    monkeypatch.delenv("ONE_VOICE_LIVE_ENABLED", raising=False)
    response = TestClient(_owner_app()).post(
        "/api/one/voice/sessions", json={"conversation_id": CONV}
    )
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "ONE_VOICE_LIVE_DISABLED"


def test_session_mint_returns_a_single_use_ticket(monkeypatch):
    monkeypatch.setattr(voice, "get_owner_hosting_mode", AsyncMock(return_value="shared"))
    monkeypatch.setenv("ONE_VOICE_LIVE_ENABLED", "true")
    monkeypatch.setenv("VERTEX_LIVE_MODEL_ID", LIVE_MODEL)
    monkeypatch.setenv("VERTEX_LIVE_LOCATION", "us-central1")
    body = (
        TestClient(_owner_app())
        .post("/api/one/voice/sessions", json={"conversation_id": CONV, "client": "ios"})
        .json()
    )
    assert body["ws_path"] == "/api/one/voice/live"
    assert body["ticket"].startswith("v1.")
    from hushh_mcp.one_voice.tickets import parse_ticket

    claims = parse_ticket(body["ticket"])
    assert (
        claims.user_id == "owner-1"
        and claims.conversation_id == CONV
        and claims.session_id == body["session_id"]
    )


def test_socket_closes_before_any_provider_while_disabled(monkeypatch):
    monkeypatch.delenv("ONE_VOICE_LIVE_ENABLED", raising=False)

    def _never(**_kwargs):
        raise AssertionError("no provider client may be constructed while disabled")

    monkeypatch.setattr(voice, "build_managed_live_client", _never)
    client = TestClient(_owner_app())
    with client.websocket_connect("/api/one/voice/live?ticket=whatever") as ws:
        frame = ws.receive_json()
        assert frame == {
            "type": "error",
            "code": "ONE_VOICE_LIVE_DISABLED",
            "message": "Voice is not available.",
        }


def test_socket_rejects_a_bad_ticket_without_a_provider(monkeypatch):
    monkeypatch.setenv("ONE_VOICE_LIVE_ENABLED", "true")
    monkeypatch.setenv("VERTEX_LIVE_MODEL_ID", LIVE_MODEL)
    monkeypatch.setenv("VERTEX_LIVE_LOCATION", "us-central1")

    def _never(**_kwargs):
        raise AssertionError("no provider client before a valid ticket")

    monkeypatch.setattr(voice, "build_managed_live_client", _never)
    client = TestClient(_owner_app())
    with client.websocket_connect("/api/one/voice/live?ticket=v1.bad.ticket") as ws:
        frame = ws.receive_json()
        assert frame["type"] == "error" and frame["code"] == "ticket_signature"


def test_retired_paths_stay_retired_while_live_is_enabled(monkeypatch):
    monkeypatch.setenv("ONE_VOICE_LIVE_ENABLED", "true")
    monkeypatch.setenv("VERTEX_LIVE_MODEL_ID", LIVE_MODEL)
    monkeypatch.setenv("VERTEX_LIVE_LOCATION", "us-central1")
    from api.routes.one import retired_voice

    app = FastAPI()
    app.include_router(retired_voice.router)
    client = TestClient(app)
    assert client.post("/api/one/adk/relay-session").status_code == 410
    with client.websocket_connect("/api/one/adk/live") as ws:
        assert ws.receive_json() == {"type": "error", "code": "ONE_LIVE_RETIRED"}


@pytest.mark.parametrize(
    "mode,status,code",
    [
        ("byoc", 409, "AGENT_PRIVATE_RUNTIME_REQUIRED"),
        ("pending", 409, "AGENT_PRIVATE_RUNTIME_REQUIRED"),
        ("hussh_pods", 409, "AGENT_PRIVATE_RUNTIME_REQUIRED"),
        ("unknown", 503, "AGENT_HOSTING_UNAVAILABLE"),
        ("invalid", 503, "AGENT_HOSTING_UNAVAILABLE"),
        (None, 503, "AGENT_HOSTING_UNAVAILABLE"),
    ],
)
def test_hosting_is_rechecked_before_ticket_and_socket(monkeypatch, mode, status, code):
    monkeypatch.setenv("ONE_VOICE_LIVE_ENABLED", "true")
    monkeypatch.setenv("VERTEX_LIVE_MODEL_ID", LIVE_MODEL)
    monkeypatch.setenv("VERTEX_LIVE_LOCATION", "us-central1")
    resolver = AsyncMock(return_value=mode)
    if mode is None:
        resolver.side_effect = RuntimeError("private provider diagnostic")
    monkeypatch.setattr(voice, "get_owner_hosting_mode", resolver)
    issuer = Mock(side_effect=AssertionError("must refuse before ticket"))
    monkeypatch.setattr(voice, "issue_ticket", issuer)
    client = TestClient(_owner_app())
    response = client.post("/api/one/voice/sessions", json={"conversation_id": CONV})
    assert response.status_code == status
    assert response.json()["detail"]["code"] == code
    assert "private provider" not in response.text
    issuer.assert_not_called()

    # Placement may change after a valid ticket was issued.
    from hushh_mcp.one_voice.tickets import issue_ticket, parse_ticket

    ticket, _ = issue_ticket(user_id="owner-1", session_id="synthetic", conversation_id=CONV)
    consume = AsyncMock(return_value=parse_ticket(ticket))
    monkeypatch.setattr(voice, "consume_ticket", consume)
    constructor = Mock(side_effect=AssertionError("must refuse before provider/session"))
    monkeypatch.setattr(voice, "VoiceSession", constructor)
    existing = object()
    monkeypatch.setattr(voice, "_active_sessions", {"owner-1": existing})
    with client.websocket_connect("/api/one/voice/live?ticket=" + ticket) as ws:
        assert ws.receive_json()["code"] == code
        assert ws.receive()["code"] == voice.protocol.CLOSE_DISABLED
    consume.assert_awaited_once_with(ticket)
    resolver.assert_awaited_with("owner-1")
    constructor.assert_not_called()
    assert voice._active_sessions["owner-1"] is existing


async def test_shared_socket_keeps_existing_session_authentication(monkeypatch):
    from types import SimpleNamespace

    from hushh_mcp.one_voice.tickets import issue_ticket, parse_ticket

    monkeypatch.setenv("ONE_VOICE_LIVE_ENABLED", "true")
    monkeypatch.setenv("VERTEX_LIVE_MODEL_ID", LIVE_MODEL)
    monkeypatch.setenv("VERTEX_LIVE_LOCATION", "us-central1")
    hosting = AsyncMock(return_value="shared")
    monkeypatch.setattr(voice, "get_owner_hosting_mode", hosting)
    ticket, _ = issue_ticket(user_id="owner-1", session_id="synthetic", conversation_id=CONV)
    monkeypatch.setattr(voice, "consume_ticket", AsyncMock(return_value=parse_ticket(ticket)))
    session = SimpleNamespace(run=AsyncMock())
    constructor = Mock(return_value=session)
    monkeypatch.setattr(voice, "VoiceSession", constructor)
    monkeypatch.setattr(voice, "_active_sessions", {})
    socket = SimpleNamespace(
        headers={}, accept=AsyncMock(), close=AsyncMock(), send_json=AsyncMock()
    )
    await voice.voice_live(socket, ticket=ticket)
    hosting.assert_awaited_once_with("owner-1")
    session.run.assert_awaited_once()
    assert constructor.call_args.kwargs["verify_auth"] is voice.verify_voice_auth
    assert voice._active_sessions == {}
