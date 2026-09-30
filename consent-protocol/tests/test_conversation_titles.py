from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from google.adk.events import Event
from google.adk.sessions import Session
from google.genai import types
from pydantic import ValidationError

from hushh_mcp.one_adk import conversation_titles as titles
from hushh_mcp.one_adk.encrypted_session_service import EncryptedAdkSessionService
from tests.helpers.chat_keys import static_chat_cipher


@pytest.fixture(autouse=True)
def reset_title_backoff():
    titles._retry_after.clear()
    yield
    titles._retry_after.clear()


def session(state=None):
    return Session(
        id="chat",
        app_name="hussh_one",
        user_id="owner",
        state=state or {},
        last_update_time=123,
        events=[
            Event(
                author="user",
                content=types.Content(
                    parts=[
                        types.Part(text="im a guy from tech and im a biology student"),
                        types.Part(text="hidden thought", thought=True),
                    ]
                ),
            ),
            Event(
                author="one",
                content=types.Content(
                    parts=[
                        types.Part(text="private shared answer"),
                    ]
                ),
            ),
        ],
    )


def test_opening_excludes_thoughts_and_assistant_information():
    assert titles.opening_prompt(session()) == "im a guy from tech and im a biology student"


@pytest.mark.parametrize("title", ["Incomplete...", "Incomplete…", "x" * 33, "two\nlines", " "])
def test_rejects_overflow_and_ellipsis_instead_of_rewriting(title):
    with pytest.raises(ValidationError):
        titles.ConversationTitle(ref="c0", title=title)


@pytest.mark.asyncio
async def test_generates_once_and_preserves_manual_titles(monkeypatch):
    automatic = session()
    manual = session({titles.MANUAL_TITLE: "My custom title"})
    model = AsyncMock(
        return_value=titles.ConversationTitles(
            items=[titles.ConversationTitle(ref="c0", title="Tech and biology background")]
        )
    )
    monkeypatch.setattr(titles, "generate_titles", model)
    saved = session({titles.GENERATED_TITLE: "Tech and biology background"})
    store = SimpleNamespace(set_title=AsyncMock(return_value=saved))
    for _ in range(2):
        await titles.ensure_conversation_titles(
            sessions=[automatic, manual],
            service=store,
            owner="owner",
            token="test-token",  # noqa: S106 - synthetic authorization fixture
        )
    assert automatic.state[titles.GENERATED_TITLE] == "Tech and biology background"
    assert manual.state == {titles.MANUAL_TITLE: "My custom title"}
    assert model.await_count == store.set_title.await_count == 1
    assert "private shared answer" not in str(model.call_args)


@pytest.mark.asyncio
async def test_model_failure_leaves_history_untouched(monkeypatch):
    chat = session()
    monkeypatch.setattr(titles, "generate_titles", AsyncMock(side_effect=TimeoutError))
    store = SimpleNamespace(set_title=AsyncMock())
    await titles.ensure_conversation_titles(
        sessions=[chat],
        service=store,
        owner="owner",
        token="test-token",  # noqa: S106 - synthetic authorization fixture
    )
    await titles.ensure_conversation_titles(
        sessions=[chat],
        service=store,
        owner="owner",
        token="test-token",  # noqa: S106
    )
    titles.generate_titles.assert_awaited_once()
    store.set_title.assert_not_called()
    assert chat.state == {} and len(chat.events) == 2


@pytest.mark.asyncio
async def test_rejects_unknown_refs_and_wrong_owner(monkeypatch):
    model = AsyncMock(
        return_value=titles.ConversationTitles(
            items=[titles.ConversationTitle(ref="unknown", title="A title")]
        )
    )
    monkeypatch.setattr(titles, "generate_titles", model)
    store = SimpleNamespace(set_title=AsyncMock())
    await titles.ensure_conversation_titles(
        sessions=[session()],
        service=store,
        owner="different",
        token="test-token",  # noqa: S106 - synthetic authorization fixture
    )
    model.assert_not_called()
    await titles.ensure_conversation_titles(
        sessions=[session()],
        service=store,
        owner="owner",
        token="test-token",  # noqa: S106 - synthetic authorization fixture
    )
    store.set_title.assert_not_called()


@pytest.mark.asyncio
async def test_generated_title_is_encrypted_and_does_not_reorder_history(monkeypatch):
    chat = session()
    service = EncryptedAdkSessionService(static_chat_cipher())
    service._set_revision(chat, 3)
    monkeypatch.setattr(service, "get_session", AsyncMock(return_value=chat))
    execute = AsyncMock(return_value=SimpleNamespace(data=[{"revision": 4}]))
    monkeypatch.setattr(service, "_execute", execute)
    saved = await service.set_title(
        app_name=chat.app_name,
        user_id=chat.user_id,
        session_id=chat.id,
        title="Tech and biology",
        generated=True,
    )
    assert saved.last_update_time == 123 and len(saved.events) == 2
    sql, params = execute.call_args.args
    assert "Tech and biology" not in str(params)
    assert params["generated"] is True and params["revision"] == 3
    assert "CASE WHEN :generated THEN updated_at" in sql
    decoded = service._decode(
        {f"payload_{key}": params[key] for key in ("ciphertext", "iv", "tag", "algorithm")},
        app_name=chat.app_name,
        user_id=chat.user_id,
        session_id=chat.id,
    )
    assert decoded.state[titles.GENERATED_TITLE] == "Tech and biology"


@pytest.mark.asyncio
async def test_concurrent_rename_wins_without_retrying_stale_write(monkeypatch):
    chat = session()
    renamed = session({titles.MANUAL_TITLE: "My title"})
    service = EncryptedAdkSessionService(static_chat_cipher())
    service._set_revision(chat, 3)
    monkeypatch.setattr(service, "get_session", AsyncMock(side_effect=[chat, renamed]))
    execute = AsyncMock(return_value=SimpleNamespace(data=[]))
    monkeypatch.setattr(service, "_execute", execute)
    saved = await service.set_title(
        app_name=chat.app_name,
        user_id=chat.user_id,
        session_id=chat.id,
        title="Auto title",
        generated=True,
    )
    assert saved.state == {titles.MANUAL_TITLE: "My title"}
    assert execute.await_count == 1


@pytest.mark.asyncio
async def test_pod_generated_title_keeps_history_order_after_recovery(tmp_path):
    from hushh_mcp.one_adk.pod_adk_session_repository import (
        PodAdkSessionProjection,
        PodAdkSessionRepository,
    )
    from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog

    log = PodCommitLog(LocalObjectStore(str(tmp_path / "log")), b"k" * 32, owner_id="HA1fixture")

    async def require_access():
        return None

    def service():
        return EncryptedAdkSessionService(
            static_chat_cipher(),
            repository=PodAdkSessionRepository(
                projection=PodAdkSessionProjection(
                    owner_id="owner", hushh_id="HA1fixture", log=log
                ),
                require_access=require_access,
            ),
        )

    writer = service()
    for session_id in ("older", "newer"):
        await writer.create_session(app_name="hussh_one", user_id="owner", session_id=session_id)
    before = await writer.get_session(app_name="hussh_one", user_id="owner", session_id="older")
    await writer.set_title(
        app_name="hussh_one",
        user_id="owner",
        session_id="older",
        title="First conversation",
        generated=True,
    )

    recovered = service()
    listed = await recovered.list_sessions(app_name="hussh_one", user_id="owner")
    assert [item.id for item in listed.sessions] == ["newer", "older"]
    assert listed.sessions[1].state[titles.GENERATED_TITLE] == "First conversation"
    assert listed.sessions[1].last_update_time == before.last_update_time
