"""The immutable compatibility image refuses work before effects and can read BYOK rows."""

import runpy

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from api.middlewares.chat_key import ChatKeyMiddleware
from hushh_mcp.services import chat_history_rollout as rollout
from tests.helpers.chat_keys import static_chat_cipher


def test_bridge_image_defaults_to_hold():
    assert runpy.run_path(rollout.__file__)["CHAT_HISTORY_WRITES_ENABLED"] is False


@pytest.mark.parametrize(
    "method,path",
    [
        ("POST", "/api/one/agent-chat"),
        ("PATCH", "/api/one/agent-chat/conversations/synthetic/"),
        ("POST", "/api/one/action-proposals/synthetic/confirm"),
        ("DELETE", "/api/one/action-proposals/synthetic"),
        ("POST", "/api/one/email/chat"),
        ("POST", "/api/one/location/chat"),
        ("POST", "/api/one/information/chat"),
        ("POST", "/api/connectors/synthetic/mcp/review"),
        ("POST", "/api/connectors/synthetic/mcp/confirm/"),
    ],
)
def test_bridge_refuses_before_any_handler(monkeypatch, method, path):
    monkeypatch.setattr(rollout, "CHAT_HISTORY_WRITES_ENABLED", False)
    app = FastAPI()
    app.add_middleware(ChatKeyMiddleware)
    calls = []

    @app.api_route("/{path:path}", methods=["POST", "PATCH", "DELETE"])
    async def downstream(request: Request):
        calls.append(request.url.path)
        return {}

    result = TestClient(app).request(method, path)
    assert result.status_code == 503
    assert result.json()["code"] == "CHAT_HISTORY_UPGRADING"
    assert result.headers["cache-control"] == "no-store"
    assert result.headers["retry-after"] == "60"
    assert not calls


@pytest.mark.parametrize(
    "method,path",
    [
        ("GET", "/api/one/agent-chat/history/synthetic"),
        ("OPTIONS", "/api/one/agent-chat"),
        ("POST", "/api/one/agent-chat-other"),
        ("POST", "/api/one/pod/heartbeat"),
        ("POST", "/api/one/pod/upgrade/status"),
        ("POST", "/api/one/adk/relay-session"),
        ("POST", "/api/connectors/synthetic/mcp/catalog"),
    ],
)
def test_bridge_preserves_other_authorities(monkeypatch, method, path):
    monkeypatch.setattr(rollout, "CHAT_HISTORY_WRITES_ENABLED", False)
    assert not rollout.holds_chat_history_request(method, path)


def test_store_backstop_refuses_writes_but_reads_existing_owner_ciphertext(monkeypatch):
    cipher = static_chat_cipher()
    sealed = cipher.seal("synthetic retained text", owner_id="owner", aad="fixture")
    monkeypatch.setattr(rollout, "CHAT_HISTORY_WRITES_ENABLED", False)
    row = {f"body_{key}": getattr(sealed, key) for key in ("ciphertext", "iv", "tag")}
    assert cipher.open(row, "body", owner_id="owner", aad="fixture") == "synthetic retained text"
    with pytest.raises(rollout.ChatHistoryUpdatingError):
        cipher.seal("must not be written", owner_id="owner", aad="fixture")


@pytest.mark.asyncio
@pytest.mark.parametrize("stringified", [False, True])
async def test_history_upgrade_hold_does_not_ask_for_another_unlock(monkeypatch, stringified):
    from ag_ui.core import RunErrorEvent
    from ag_ui_adk import ADKAgent

    from hushh_mcp.services.chat_history_rollout import (
        CHAT_HISTORY_UPGRADING_MESSAGE,
        ChatHistoryUpdatingError,
    )
    from tests.test_agui_turn_timing import _agent, _drain

    async def held_run(self, input):
        if stringified:
            yield RunErrorEvent(message=CHAT_HISTORY_UPGRADING_MESSAGE, code="AGENT_ERROR")
        else:
            raise ChatHistoryUpdatingError(CHAT_HISTORY_UPGRADING_MESSAGE)

    monkeypatch.setattr(ADKAgent, "run", held_run)
    events = await _drain(_agent())
    assert events[-1].code == "CHAT_HISTORY_UPGRADING"
    assert events[-1].message == CHAT_HISTORY_UPGRADING_MESSAGE
