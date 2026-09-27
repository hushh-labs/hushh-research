"""One chat history is sealed with the person's chat key, never the platform key.

Contract for the chat-history BYOK change: the browser derives the chat key from
the unlocked vault key and sends it per request; the server holds it for that
request only; every reader of the chat tables refuses without it; rows sealed
with the platform key before the cutover are invisible; and the key never
reaches a log line or the AG-UI stream.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import time
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from ag_ui.core import EventType, StateSnapshotEvent, TextMessageContentEvent
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from google.adk.sessions import Session

from hushh_mcp.types import EncryptedPayload
from hushh_mcp.vault.encrypt import decrypt_data

ROOT = Path(__file__).resolve().parents[1]
PLATFORM_KEY = "01" * 32
PERSON_KEY = bytes.fromhex("5a" * 32)
WIRE_KEY = "hck1." + PERSON_KEY.hex()


def _payload(row: dict[str, str]) -> EncryptedPayload:
    return EncryptedPayload(
        ciphertext=row["ciphertext"],
        iv=row["iv"],
        tag=row["tag"],
        encoding="base64",
        algorithm="aes-256-gcm",
    )


# ── Negative control ──────────────────────────────────────────────────────────


def test_negative_control_platform_key_cannot_open_a_new_session_row(monkeypatch) -> None:
    """Fails on the pre-BYOK code, where every session was sealed with VAULT_DATA_KEY."""
    monkeypatch.setenv("VAULT_DATA_KEY", PLATFORM_KEY)
    from hushh_mcp.one_adk.encrypted_session_service import EncryptedAdkSessionService

    try:
        from tests.helpers.chat_keys import bound_request_chat_key

        binding = bound_request_chat_key("owner-1", PERSON_KEY)
    except ImportError:  # the pre-BYOK tree has no request key at all
        binding = nullcontext()
    session = Session(id="thread-1", app_name="hussh_one", user_id="owner-1", state={"a": 1})
    with binding:
        encoded = EncryptedAdkSessionService()._encode(session)

    stripped = dict(encoded, ciphertext=encoded["ciphertext"].split(":", 1)[-1])
    with pytest.raises((ValueError, RuntimeError)):
        decrypt_data(_payload(stripped), PLATFORM_KEY)
    with pytest.raises((ValueError, RuntimeError)):
        decrypt_data(_payload(encoded), PLATFORM_KEY)


# ── Key derivation and cipher ─────────────────────────────────────────────────


def test_chat_key_derivation_vector_matches_the_browser() -> None:
    """Same vector as hushh-webapp/__tests__/vault/one-chat-key.test.ts."""
    from hushh_mcp.services.chat_key import CHAT_KEY_LABEL

    derived = HKDF(
        algorithm=hashes.SHA256(), length=32, salt=None, info=CHAT_KEY_LABEL.encode()
    ).derive(bytes.fromhex("0f" * 32))
    assert CHAT_KEY_LABEL == "hussh-one-chat-v1"
    assert derived.hex() == "0a3419cafc7896f9384d95ec76704bb30b272e913e80702075270f69a2feae8b"


def test_round_trip_with_the_person_key_and_refusal_without_it() -> None:
    from hushh_mcp.services.chat_key import (
        CHAT_CIPHERTEXT_PREFIX,
        ChatCipher,
        ChatKeyMismatchError,
        ChatKeyUnavailableError,
        chat_aad,
    )
    from tests.helpers.chat_keys import OTHER_CHAT_KEY, bound_request_chat_key

    cipher = ChatCipher()
    aad = chat_aad("agent_chat_messages", "content", "message-1")
    with bound_request_chat_key("owner-1", PERSON_KEY):
        sealed = cipher.seal("private words", owner_id="owner-1", aad=aad)
        row = {
            "content_ciphertext": sealed.ciphertext,
            "content_iv": sealed.iv,
            "content_tag": sealed.tag,
        }
        assert sealed.ciphertext.startswith(CHAT_CIPHERTEXT_PREFIX)
        assert "private words" not in sealed.ciphertext
        assert cipher.open(row, "content", owner_id="owner-1", aad=aad) == "private words"
        # Bound to its row: the same ciphertext cannot be replayed into another one.
        with pytest.raises(ChatKeyMismatchError):
            cipher.open(
                row,
                "content",
                owner_id="owner-1",
                aad=chat_aad("agent_chat_messages", "content", "message-2"),
            )
        # Bound to its owner: another person's request cannot use this key.
        with pytest.raises(ChatKeyUnavailableError):
            cipher.open(row, "content", owner_id="owner-2", aad=aad)
    with bound_request_chat_key("owner-1", OTHER_CHAT_KEY):
        with pytest.raises(ChatKeyMismatchError):
            cipher.open(row, "content", owner_id="owner-1", aad=aad)
    with pytest.raises(ChatKeyUnavailableError):
        cipher.open(row, "content", owner_id="owner-1", aad=aad)
    with pytest.raises(ChatKeyUnavailableError):
        cipher.seal("x", owner_id="owner-1", aad=aad)


def test_legacy_platform_key_rows_are_never_opened(monkeypatch) -> None:
    from hushh_mcp.services.chat_key import ChatCipher, LegacyChatCiphertextError
    from hushh_mcp.vault.encrypt import encrypt_data
    from tests.helpers.chat_keys import bound_request_chat_key

    legacy = encrypt_data("old history", PLATFORM_KEY)
    row = {"title_ciphertext": legacy.ciphertext, "title_iv": legacy.iv, "title_tag": legacy.tag}
    with bound_request_chat_key("owner-1", PERSON_KEY):
        with pytest.raises(LegacyChatCiphertextError):
            ChatCipher().open(row, "title", owner_id="owner-1", aad="any")


def test_platform_task_cipher_and_chat_cipher_cannot_be_swapped() -> None:
    from hushh_mcp.services.capability_run_service import PlatformTaskCipher
    from hushh_mcp.services.chat_key import ChatCipher, LegacyChatCiphertextError
    from tests.helpers.chat_keys import bound_request_chat_key

    task = PlatformTaskCipher(PLATFORM_KEY)
    task_sealed = task.seal('{"name":"Home"}')
    task_row = {
        "slots_ciphertext": task_sealed.ciphertext,
        "slots_iv": task_sealed.iv,
        "slots_tag": task_sealed.tag,
    }
    assert task.open(task_row, "slots") == '{"name":"Home"}'
    with bound_request_chat_key("owner-1", PERSON_KEY):
        with pytest.raises(LegacyChatCiphertextError):
            ChatCipher().open(task_row, "slots", owner_id="owner-1", aad="x")
        chat_sealed = ChatCipher().seal("chat", owner_id="owner-1", aad="x")
    with pytest.raises(ValueError):
        task.open(
            {
                "slots_ciphertext": chat_sealed.ciphertext,
                "slots_iv": chat_sealed.iv,
                "slots_tag": chat_sealed.tag,
            },
            "slots",
        )


# ── Request lifetime and owner binding ────────────────────────────────────────


def test_request_key_is_owner_bound_released_and_capped() -> None:
    from hushh_mcp.services.chat_key import (
        ChatKeyUnavailableError,
        RequestChatKey,
        bind_request_chat_key,
        request_has_chat_key,
        retain_request_chat_key,
    )

    holder = RequestChatKey(PERSON_KEY)
    with bind_request_chat_key(holder):
        assert not request_has_chat_key("owner-1")  # no owner bound yet
        holder.bind_owner("owner-1")
        assert request_has_chat_key("owner-1")
        with pytest.raises(ChatKeyUnavailableError):
            holder.bind_owner("owner-2")
    assert not holder.bound  # the mismatch wiped it

    holder = RequestChatKey(PERSON_KEY)
    holder.bind_owner("owner-1")
    with bind_request_chat_key(holder):
        retained = retain_request_chat_key()
        retained.__enter__()
    # The HTTP exchange ended, but the background run still holds a reference.
    assert holder.key_for("owner-1") == PERSON_KEY
    retained.__exit__(None, None, None)
    assert holder.key_for("owner-1") is None

    capped = RequestChatKey(PERSON_KEY, max_seconds=0.01)
    capped.bind_owner("owner-1")
    time.sleep(0.02)
    assert capped.key_for("owner-1") is None


async def test_background_task_copies_the_holder_and_loses_it_when_released() -> None:
    from hushh_mcp.services.chat_key import (
        RequestChatKey,
        bind_request_chat_key,
        request_has_chat_key,
    )

    holder = RequestChatKey(PERSON_KEY)
    holder.bind_owner("owner-1")
    release = asyncio.Event()
    seen: list[bool] = []

    async def lingering() -> None:
        seen.append(request_has_chat_key("owner-1"))
        await release.wait()
        seen.append(request_has_chat_key("owner-1"))

    with bind_request_chat_key(holder):
        task = asyncio.create_task(lingering())
        await asyncio.sleep(0)
    release.set()
    await task
    assert seen == [True, False]


# ── Middleware, routes and refusal ────────────────────────────────────────────


def _app(observed: dict):
    from api.middlewares.chat_key import (
        ChatKeyMiddleware,
        chat_key_error_handler,
        require_vault_owner_chat_key,
    )
    from hushh_mcp.services.chat_key import (
        CHAT_KEY_ERRORS,
        ChatCipher,
        bind_request_chat_key_owner,
    )

    async def fake_owner() -> dict:
        owner = "owner-1"
        bind_request_chat_key_owner(owner)
        return {"user_id": owner}

    app = FastAPI()
    for error in CHAT_KEY_ERRORS:
        app.add_exception_handler(error, chat_key_error_handler)

    from api.middleware import require_vault_owner_token

    app.dependency_overrides[require_vault_owner_token] = fake_owner

    @app.get("/history")
    async def history(_token: dict = Depends(require_vault_owner_chat_key)) -> dict:
        sealed = ChatCipher().seal("x", owner_id="owner-1", aad="a")
        return {"sealed": sealed.ciphertext.startswith("hussh-chat-v1:")}

    @app.get("/unguarded")
    async def unguarded(_token: dict = Depends(require_vault_owner_token)) -> dict:
        ChatCipher().seal("x", owner_id="owner-1", aad="a")
        return {}

    @app.middleware("http")
    async def capture(request, call_next):  # noqa: ANN001
        observed["headers"] = dict(request.headers)
        return await call_next(request)

    app.add_middleware(ChatKeyMiddleware)
    return app


def test_chat_route_refuses_without_a_valid_key_and_strips_the_header() -> None:
    observed: dict = {}
    client = TestClient(_app(observed))

    assert client.get("/history").status_code == 403
    malformed = client.get("/history", headers={"X-Hussh-Chat-Key": "hck1.zz"})
    assert malformed.status_code == 400
    assert "zz" not in malformed.text
    wrong_version = client.get("/history", headers={"X-Hussh-Chat-Key": "hck9." + "a" * 64})
    assert wrong_version.status_code == 400

    ok = client.get("/history", headers={"X-Hussh-Chat-Key": WIRE_KEY})
    assert ok.status_code == 200 and ok.json() == {"sealed": True}
    # No layer behind the middleware can read the key.
    assert "x-hussh-chat-key" not in observed["headers"]
    assert PERSON_KEY.hex() not in str(observed)

    # A route that forgot the explicit dependency still refuses (global handler).
    refused = client.get("/unguarded")
    assert refused.status_code == 403
    assert refused.json()["code"] == "CHAT_KEY_REQUIRED"


def test_refusals_log_code_route_and_key_state_but_never_the_key(caplog) -> None:
    """UAT 2026-09-27: 51 chat-key 403s logged no code, so REQUIRED vs MISMATCH was a guess."""
    from api.middleware import require_vault_owner_token
    from api.middlewares.chat_key import (
        ChatKeyMiddleware,
        chat_key_error_handler,
        require_vault_owner_chat_key,
    )
    from hushh_mcp.services.chat_key import (
        CHAT_KEY_ERRORS,
        ChatKeyMismatchError,
        bind_request_chat_key_owner,
    )

    async def fake_owner() -> dict:
        bind_request_chat_key_owner("owner-1")
        return {"user_id": "owner-1"}

    app = FastAPI()
    for error in CHAT_KEY_ERRORS:
        app.add_exception_handler(error, chat_key_error_handler)
    app.dependency_overrides[require_vault_owner_token] = fake_owner

    @app.get("/conversations/{user_id}")
    async def conversations(user_id: str, _t: dict = Depends(require_vault_owner_chat_key)) -> dict:
        raise ChatKeyMismatchError("Chat history did not open with this vault.")

    app.add_middleware(ChatKeyMiddleware)
    client = TestClient(app)
    caplog.set_level(logging.WARNING, logger="api.middlewares.chat_key")

    missing = client.get("/conversations/uid-private-123")
    assert missing.status_code == 403 and missing.json()["detail"]["code"] == "CHAT_KEY_REQUIRED"
    wrong = client.get("/conversations/uid-private-123", headers={"X-Hussh-Chat-Key": WIRE_KEY})
    assert wrong.json()["code"] == "CHAT_KEY_MISMATCH"

    lines = [
        record.getMessage() for record in caplog.records if "chat_key.refused" in record.message
    ]
    assert lines == [
        "chat_key.refused code=CHAT_KEY_REQUIRED method=GET route=/conversations/{user_id} "
        "key_state=absent",
        "chat_key.refused code=CHAT_KEY_MISMATCH method=GET route=/conversations/{user_id} "
        "key_state=bound",
    ]
    rendered = "\n".join(record.getMessage() for record in caplog.records)
    for private_marker in ("uid-private-123", "owner-1", PERSON_KEY.hex(), WIRE_KEY):
        assert private_marker not in rendered


def test_owner_mismatch_between_key_and_token_is_refused() -> None:
    from api.middlewares.chat_key import ChatKeyMiddleware, chat_key_error_handler
    from hushh_mcp.services.chat_key import CHAT_KEY_ERRORS, bind_request_chat_key_owner

    app = FastAPI()
    for error in CHAT_KEY_ERRORS:
        app.add_exception_handler(error, chat_key_error_handler)

    @app.get("/two-owners")
    async def two_owners() -> dict:
        bind_request_chat_key_owner("owner-1")
        bind_request_chat_key_owner("owner-2")
        return {}

    app.add_middleware(ChatKeyMiddleware)
    response = TestClient(app).get("/two-owners", headers={"X-Hussh-Chat-Key": WIRE_KEY})
    assert response.status_code == 403


def test_every_history_route_requires_the_chat_key_and_delete_does_not() -> None:
    from api.middlewares.chat_key import require_vault_owner_chat_key
    from api.routes.one import agent_chat

    def dependency_calls(path: str, method: str) -> set:
        for route in agent_chat.router.routes:
            if getattr(route, "path", None) == path and method in getattr(route, "methods", ()):
                return {dependency.call for dependency in route.dependant.dependencies}
        raise AssertionError(f"route missing: {method} {path}")

    for path, method in (
        ("/api/one/agent-chat/conversations/{user_id}", "GET"),
        ("/api/one/agent-chat/history/{conversation_id}", "GET"),
        ("/api/one/agent-chat/conversations/{conversation_id}", "PATCH"),
        ("/api/one/agent-chat/history/{conversation_id}/information-requests", "POST"),
    ):
        assert require_vault_owner_chat_key in dependency_calls(path, method), path
    assert require_vault_owner_chat_key not in dependency_calls(
        "/api/one/agent-chat/conversations/{conversation_id}", "DELETE"
    )


async def test_agent_turn_is_refused_before_streaming_without_a_key(monkeypatch) -> None:
    from fastapi import HTTPException
    from starlette.requests import Request

    from api.routes.one import agent_chat
    from tests.helpers.chat_keys import bound_request_chat_key
    from tests.test_agui_turn_timing import _input

    monkeypatch.setattr(
        agent_chat,
        "require_vault_owner_token",
        AsyncMock(return_value={"user_id": "owner-1", "token": "synthetic"}),
    )
    request = Request({"type": "http", "headers": [(b"authorization", b"Bearer synthetic")]})
    with pytest.raises(HTTPException) as refused:
        await agent_chat._extract_state(request, _input())
    assert refused.value.status_code == 403

    # A thread id held by a platform-key conversation is refused, not overwritten.
    monkeypatch.setattr(
        agent_chat._session_service, "is_legacy_session", AsyncMock(return_value=True)
    )
    with bound_request_chat_key("owner-1", PERSON_KEY):
        with pytest.raises(HTTPException) as retired:
            await agent_chat._extract_state(request, _input())
    assert retired.value.status_code == 409


def test_durable_agent_never_runs_the_idle_session_sweeper() -> None:
    from api.routes.one import agent_chat

    manager = agent_chat._agent._session_manager
    assert isinstance(manager, agent_chat._DurableSessionManager)
    assert manager._delete_session_on_cleanup is False
    assert manager._save_session_to_memory_on_cleanup is False
    manager._start_cleanup_task()
    assert manager._cleanup_task is None


# ── Every reader ──────────────────────────────────────────────────────────────


class _RecordingDb:
    def __init__(self, rows=None):  # noqa: ANN001
        self.rows = rows or []
        self.calls: list[tuple[str, dict]] = []

    def execute_raw(self, sql: str, params: dict):  # noqa: ANN001
        self.calls.append((" ".join(sql.split()), dict(params)))
        return SimpleNamespace(data=list(self.rows))


async def test_adk_session_readers_filter_legacy_rows_and_need_the_key(monkeypatch) -> None:
    from hushh_mcp.one_adk import encrypted_session_service as module
    from hushh_mcp.services.chat_key import CHAT_CIPHERTEXT_LIKE, ChatKeyUnavailableError
    from tests.helpers.chat_keys import bound_request_chat_key

    db = _RecordingDb()
    monkeypatch.setattr(module, "get_db", lambda: db)
    service = module.EncryptedAdkSessionService()
    assert await service.get_session(app_name="hussh_one", user_id="o", session_id="t") is None
    await service.list_sessions(app_name="hussh_one", user_id="o")
    assert (
        await service.delete_owned_session(app_name="hussh_one", user_id="o", session_id="t")
        is False
    )
    for sql, params in db.calls:
        assert "payload_ciphertext LIKE :chat_marker" in sql
        assert params["chat_marker"] == CHAT_CIPHERTEXT_LIKE
    with pytest.raises(ChatKeyUnavailableError):
        await service.create_session(app_name="hussh_one", user_id="o", session_id="t")

    # One row that will not open is skipped, never shown as a placeholder; when
    # nothing opens the whole read is refused.
    session = Session(id="t", app_name="hussh_one", user_id="o", state={})
    with bound_request_chat_key("o", PERSON_KEY):
        good = service._encode(session)
    rows = [
        {"session_id": "t", "revision": 1, **{f"payload_{k}": v for k, v in good.items()}},
        {
            "session_id": "u",
            "revision": 1,
            **{f"payload_{k}": v for k, v in good.items()},
        },
    ]
    db.rows = rows
    with bound_request_chat_key("o", PERSON_KEY):
        listed = await service.list_sessions(app_name="hussh_one", user_id="o")
    assert [item.id for item in listed.sessions] == ["t"]


async def test_command_checkpoints_are_person_sealed_and_legacy_filtered() -> None:
    from hushh_mcp.services.chat_key import CHAT_CIPHERTEXT_LIKE, ChatKeyUnavailableError
    from hushh_mcp.services.command_checkpoints import CommandCheckpointStore
    from tests.helpers.chat_keys import bound_request_chat_key

    db = _RecordingDb()
    store = CommandCheckpointStore(db=db)
    state = {"status": "ready", "plan_digest": "d" * 64, "next_step": 0}
    with pytest.raises(ChatKeyUnavailableError):
        await store.create("owner-1", "cmd-1", state)
    db.rows = [{"revision": 1}]
    with bound_request_chat_key("owner-1", PERSON_KEY):
        await store.create("owner-1", "cmd-1", state)
        db.rows = []
        assert await store.get("owner-1", "cmd-1") is None
        assert await store.list("owner-1") == []
    insert = next(params for sql, params in db.calls if "INSERT INTO one_adk_sessions" in sql)
    assert insert["ciphertext"].startswith("hussh-chat-v1:")
    for sql, params in db.calls:
        if sql.startswith("SELECT"):
            assert "payload_ciphertext LIKE :chat_marker" in sql
            assert params["chat_marker"] == CHAT_CIPHERTEXT_LIKE


async def test_specialist_history_is_person_sealed_legacy_filtered_and_owner_checked() -> None:
    from hushh_mcp.services.agent_chat_service import AgentChatService
    from hushh_mcp.services.chat_key import CHAT_CIPHERTEXT_LIKE, ChatKeyUnavailableError
    from tests.helpers.chat_keys import bound_request_chat_key

    db = _RecordingDb()
    service = AgentChatService(db=db, model="gemini-3.5-flash")
    with pytest.raises(ChatKeyUnavailableError):
        await service.add_message(
            conversation_id="00000000-0000-4000-8000-000000000001",
            user_id="owner-1",
            role="user",
            content="hi",
            status="complete",
        )
    with bound_request_chat_key("owner-1", PERSON_KEY):
        with pytest.raises(LookupError):
            # The conversation is not this owner's person-key thread.
            await service.add_message(
                conversation_id="00000000-0000-4000-8000-000000000001",
                user_id="owner-1",
                role="user",
                content="hi",
                status="complete",
            )
        await service.get_recent_messages("c", user_id="owner-1")
        await service.list_conversations("owner-1")
        await service.get_conversation("c", user_id="owner-1")
    insert_sql, insert = db.calls[0]
    assert insert["content_ciphertext"].startswith("hussh-chat-v1:")
    assert "conversations.title_ciphertext LIKE :chat_marker" in insert_sql
    for sql, params in db.calls[1:]:
        assert "LIKE :chat_marker" in sql
        assert params["chat_marker"] == CHAT_CIPHERTEXT_LIKE


def test_prepare_turn_seals_title_and_message_and_excludes_legacy_rows() -> None:
    sql = (ROOT / "hushh_mcp/services/agent_chat_service.py").read_text()
    start = sql.index("async def prepare_turn")
    body = sql[start : sql.index("async def add_message")]
    assert "AND title_ciphertext LIKE :chat_marker" in body
    assert "AND messages.content_ciphertext LIKE :chat_marker" in body
    assert "_seal_title(" in body and "_seal_message(" in body


def test_no_chat_store_can_reach_the_platform_key() -> None:
    for relative in (
        "hushh_mcp/services/agent_chat_service.py",
        "hushh_mcp/one_adk/encrypted_session_service.py",
        "hushh_mcp/services/command_checkpoints.py",
        "hushh_mcp/services/chat_key.py",
    ):
        source = (ROOT / relative).read_text()
        for forbidden in ("vault_data_key", "encrypt_data(", "decrypt_data("):
            assert forbidden not in source, (relative, forbidden)
    from hushh_mcp.services.agent_chat_service import AgentChatService

    for removed in ("vault_key_hex", "_encrypt_text", "_decrypt_text"):
        assert not hasattr(AgentChatService, removed), removed


async def test_mcp_review_refuses_instead_of_reporting_an_outage() -> None:
    from api.routes.external_connectors import _mcp_review_response
    from hushh_mcp.services.chat_key import ChatKeyUnavailableError

    async def needs_history(**_kwargs):  # noqa: ANN003
        raise ChatKeyUnavailableError("Unlock your vault to open chat history.")

    with pytest.raises(ChatKeyUnavailableError):
        await _mcp_review_response(needs_history)


def test_row_decoders_never_substitute_placeholder_history() -> None:
    from hushh_mcp.services.agent_chat_service import AgentChatService
    from hushh_mcp.services.chat_key import ChatKeyMismatchError
    from tests.helpers.chat_keys import OTHER_CHAT_KEY, bound_request_chat_key

    service = AgentChatService(model="gemini-3.5-flash")
    with bound_request_chat_key("owner-1", PERSON_KEY):
        title = service._seal_title("Real title", user_id="owner-1", conversation_id="c1")
    row = {
        "id": "c1",
        "user_id": "owner-1",
        "title_ciphertext": title.ciphertext,
        "title_iv": title.iv,
        "title_tag": title.tag,
    }
    with bound_request_chat_key("owner-1", OTHER_CHAT_KEY):
        with pytest.raises(ChatKeyMismatchError):
            service._conversation_from_row(row)


# ── Redaction ─────────────────────────────────────────────────────────────────


def test_log_filter_redacts_the_chat_key_in_every_shape() -> None:
    from mcp_modules.log_redaction import SensitiveLogFilter, redact_log_value

    record = logging.LogRecord("api", logging.WARNING, __file__, 1, "header %s", (WIRE_KEY,), None)
    SensitiveLogFilter().filter(record)
    rendered = record.getMessage()
    assert PERSON_KEY.hex() not in rendered
    inline = logging.LogRecord("api", logging.INFO, __file__, 1, f"got {WIRE_KEY}", (), None)
    SensitiveLogFilter().filter(inline)
    assert PERSON_KEY.hex() not in inline.getMessage()
    assert redact_log_value({"x-hussh-chat-key": "anything"}) == {"x-hussh-chat-key": "[REDACTED]"}
    assert redact_log_value({"chatKey": "anything"}) == {"chatKey": "[REDACTED]"}


def test_stream_guard_detects_the_key_in_any_encoding() -> None:
    from hushh_mcp.one_adk.agui_turn_timing import event_carries_chat_key
    from hushh_mcp.services.chat_key import RequestChatKey

    markers = RequestChatKey(PERSON_KEY).markers()
    for leaked in (
        PERSON_KEY.hex(),
        PERSON_KEY.hex().upper(),
        base64.b64encode(PERSON_KEY).decode().rstrip("="),
        base64.urlsafe_b64encode(PERSON_KEY).decode().rstrip("="),
    ):
        event = StateSnapshotEvent(type=EventType.STATE_SNAPSHOT, snapshot={"x": leaked})
        assert event_carries_chat_key(event, markers)
    clean = TextMessageContentEvent(
        type=EventType.TEXT_MESSAGE_CONTENT, message_id="m", delta="hello"
    )
    assert not event_carries_chat_key(clean, markers)
    assert not event_carries_chat_key(clean, ())


async def test_agent_run_ends_with_an_error_rather_than_stream_the_key(monkeypatch) -> None:
    from ag_ui_adk import ADKAgent

    from hushh_mcp.one_adk import agui_turn_timing
    from hushh_mcp.one_adk.agui_turn_timing import HEAD_UNLABELED, TimedADKAgent
    from tests.helpers.chat_keys import bound_request_chat_key
    from tests.test_agui_turn_timing import _input

    async def leaking_run(self, input):  # noqa: ANN001
        yield StateSnapshotEvent(type=EventType.STATE_SNAPSHOT, snapshot={"k": PERSON_KEY.hex()})
        yield TextMessageContentEvent(
            type=EventType.TEXT_MESSAGE_CONTENT, message_id="m", delta="after"
        )

    monkeypatch.setattr(ADKAgent, "run", leaking_run)
    monkeypatch.setattr(agui_turn_timing, "public_event", lambda event, **_: event)
    agent = TimedADKAgent.__new__(TimedADKAgent)
    agent.head = HEAD_UNLABELED
    monkeypatch.setattr(agent, "_release_execution", AsyncMock(), raising=False)
    events = []
    with bound_request_chat_key("owner-1", PERSON_KEY):
        async for event in agent.run(_input()):
            events.append(event)
    assert [getattr(event, "code", None) for event in events] == ["CHAT_KEY_REQUIRED"]
    assert all(PERSON_KEY.hex() not in event.model_dump_json() for event in events)


# ── Review follow-ups ─────────────────────────────────────────────────────────


def test_chat_key_middleware_is_the_outermost_application_middleware() -> None:
    from api.middlewares.chat_key import ChatKeyMiddleware
    from server import app

    # Anything registered after it would sit outside and could read the header.
    assert app.user_middleware[0].cls is ChatKeyMiddleware


def test_a_marked_record_missing_its_nonce_or_tag_is_refused_not_empty() -> None:
    from hushh_mcp.services.chat_key import ChatCipher, ChatKeyMismatchError
    from tests.helpers.chat_keys import bound_request_chat_key

    with bound_request_chat_key("owner-1", PERSON_KEY):
        sealed = ChatCipher().seal("x", owner_id="owner-1", aad="a")
        with pytest.raises(ChatKeyMismatchError):
            ChatCipher().open(
                {"content_ciphertext": sealed.ciphertext, "content_iv": sealed.iv},
                "content",
                owner_id="owner-1",
                aad="a",
            )


@pytest.mark.parametrize("module_name", ["information_chat", "location_chat", "email_chat"])
def test_specialist_chat_routes_refuse_with_the_chat_key_error(module_name: str) -> None:
    import importlib

    module = importlib.import_module(f"api.routes.one.{module_name}")
    source = Path(module.__file__).read_text()
    assert "except CHAT_KEY_ERRORS:" in source
    assert source.index("except CHAT_KEY_ERRORS:") < source.index("except Exception:")


async def test_stream_maps_a_stringified_key_error_to_the_recovery_message(monkeypatch) -> None:
    from ag_ui.core import RunErrorEvent
    from ag_ui_adk import ADKAgent

    from hushh_mcp.one_adk.agui_turn_timing import HEAD_ONE, TimedADKAgent
    from hushh_mcp.services.chat_key import (
        CHAT_KEY_RECOVERY_MESSAGE,
        CHAT_KEY_REQUIRED_CODE,
    )
    from tests.test_agui_turn_timing import _input

    async def failing_background_run(self, input):  # noqa: ANN001
        # What ag_ui_adk emits when its background task raises the key error.
        yield RunErrorEvent(
            message="Chat history did not open with this vault.",
            code="BACKGROUND_EXECUTION_ERROR",
        )

    monkeypatch.setattr(ADKAgent, "run", failing_background_run)
    agent = TimedADKAgent.__new__(TimedADKAgent)
    agent.head = HEAD_ONE
    monkeypatch.setattr(agent, "_release_execution", AsyncMock(), raising=False)
    events = [event async for event in agent.run(_input())]
    errors = [event for event in events if getattr(event, "code", None)]
    assert [(event.code, event.message) for event in errors] == [
        (CHAT_KEY_REQUIRED_CODE, CHAT_KEY_RECOVERY_MESSAGE)
    ]


def test_only_the_chat_stores_touch_chat_ciphertext_columns() -> None:
    """Migration 249 replays on every deploy and deletes any unmarked chat row.

    A new writer that bypassed ChatCipher would therefore be wiped silently on the
    next deploy. Keep every write to these columns inside the three chat stores.
    """
    import re as _re

    allowed = {
        "hushh_mcp/one_adk/encrypted_session_service.py",
        "hushh_mcp/services/agent_chat_service.py",
        "hushh_mcp/services/command_checkpoints.py",
    }
    tables = _re.compile(r"one_adk_sessions|agent_chat_messages|agent_chat_conversations")
    columns = _re.compile(r"\b(payload|content|title|metadata)_ciphertext\b")
    offenders = []
    for folder in ("hushh_mcp", "api", "mcp_modules", "scripts"):
        for path in (ROOT / folder).rglob("*.py"):
            relative = path.relative_to(ROOT).as_posix()
            if relative in allowed:
                continue
            source = path.read_text(errors="ignore")
            if tables.search(source) and columns.search(source):
                offenders.append(relative)
    assert offenders == []
