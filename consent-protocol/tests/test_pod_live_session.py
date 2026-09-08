"""Private Live session identity and transcription-backed memory handoff."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from google.adk.events import Event
from google.adk.sessions import Session
from google.genai import types

from api.routes.one import pod_live_session as module
from hushh_mcp.one_adk.agent_tree import ONE_APP_NAME, STATE_DATA_DOOR_GRANTS, STATE_USER_ID


@pytest.fixture
def private(monkeypatch):
    monkeypatch.setenv("HUSSH_ID", "pod-owner")
    monkeypatch.setattr(module, "_resolve_log", lambda: AsyncMock())
    monkeypatch.setattr(module, "_require_enabled", lambda: None)
    monkeypatch.setattr(
        module, "_validate_consent", AsyncMock(return_value={"user_id": "firebase-owner"})
    )
    return module.PodLiveSession(
        "firebase-owner",
        "pod-owner",
        "voice_test",
        "synthetic-secret",
        {"email": "synthetic-email-read"},
    )


def session(events, owner="pod-owner"):
    return Session(id="voice_test", app_name=ONE_APP_NAME, user_id=owner, events=events)


def transcribed_events():
    return [
        Event(
            author="user", input_transcription=types.Transcription(text="Remember synthetic fact.")
        ),
        Event(
            author="one",
            output_transcription=types.Transcription(text="I heard the synthetic fact."),
        ),
        Event(
            author="one", partial=True, output_transcription=types.Transcription(text="unfinished")
        ),
        Event(author="one", turn_complete=True),
    ]


@pytest.mark.asyncio
async def test_final_transcripts_reach_existing_memory_once_with_pod_identity(private):
    original = session(transcribed_events())
    runner = SimpleNamespace(session_service=AsyncMock(), memory_service=AsyncMock())
    runner.session_service.get_session.return_value = original
    assert await module.persist_live_session(runner, private)
    runner.memory_service.add_session_to_memory.assert_awaited_once()
    projected = runner.memory_service.add_session_to_memory.call_args.args[0]
    assert projected.user_id == "pod-owner"
    assert [event.content.parts[0].text for event in projected.events] == [
        "Remember synthetic fact.",
        "I heard the synthetic fact.",
    ]
    assert [event.author for event in projected.events] == ["user", "model"]
    assert original.events[0].content is None
    assert len(original.events) == 4
    assert "synthetic-secret" not in repr(private)


@pytest.mark.asyncio
@pytest.mark.parametrize("owner", ["foreign", ""])
async def test_changed_consent_owner_prevents_memory_access(private, monkeypatch, owner):
    monkeypatch.setattr(module, "_validate_consent", AsyncMock(return_value={"user_id": owner}))
    runner = SimpleNamespace(session_service=AsyncMock(), memory_service=AsyncMock())
    assert not await module.persist_live_session(runner, private)
    runner.session_service.get_session.assert_not_called()
    runner.memory_service.add_session_to_memory.assert_not_called()


@pytest.mark.asyncio
async def test_storage_failure_is_not_reported_as_saved_or_logged_verbatim(private, caplog):
    runner = SimpleNamespace(session_service=AsyncMock(), memory_service=AsyncMock())
    runner.session_service.get_session.return_value = session(transcribed_events())
    runner.memory_service.add_session_to_memory.side_effect = RuntimeError(
        "synthetic-private-provider-detail"
    )
    assert not await module.persist_live_session(runner, private)
    assert "synthetic-private-provider-detail" not in caplog.text
    assert "RuntimeError" in caplog.text
    runner.memory_service.add_session_to_memory.assert_awaited_once()


@pytest.mark.asyncio
async def test_wrong_session_owner_never_reaches_memory(private):
    runner = SimpleNamespace(session_service=AsyncMock(), memory_service=AsyncMock())
    runner.session_service.get_session.return_value = session(transcribed_events(), owner="foreign")
    assert not await module.persist_live_session(runner, private)
    runner.memory_service.add_session_to_memory.assert_not_called()


@pytest.mark.asyncio
async def test_private_runtime_builds_separate_tool_and_memory_identity(private, monkeypatch):
    from api.routes.one import adk_live

    class StopBeforeProvider(RuntimeError):
        pass

    create = AsyncMock(side_effect=StopBeforeProvider())
    factory = Mock(
        return_value=SimpleNamespace(session_service=SimpleNamespace(create_session=create))
    )
    monkeypatch.setattr(adk_live, "build_one_live_runner", factory)
    monkeypatch.setattr(
        adk_live,
        "_receive_runtime_bootstrap",
        AsyncMock(return_value=("managed", None, "developer_api", None, None, None, None)),
    )
    with pytest.raises(StopBeforeProvider):
        await adk_live.run_one_live_session(
            AsyncMock(),
            uid=private.user_id,
            persona_tier="signed_locked",
            directive_store=object(),
            pod_session=private,
        )
    assert factory.call_args.kwargs["public_intro_only"] is False
    assert create.call_args.kwargs["user_id"] == private.hushh_id
    assert create.call_args.kwargs["session_id"] == private.session_id
    assert create.call_args.kwargs["state"][STATE_USER_ID] == private.user_id
    assert create.call_args.kwargs["state"][STATE_DATA_DOOR_GRANTS] == {
        "email": "synthetic-email-read"
    }


@pytest.mark.asyncio
async def test_owner_conflict_refuses_before_bootstrap(private, monkeypatch):
    from api.routes.one import adk_live

    monkeypatch.setenv("HUSSH_ID", "foreign-pod")
    bootstrap = AsyncMock()
    monkeypatch.setattr(adk_live, "_receive_runtime_bootstrap", bootstrap)
    socket = AsyncMock()
    await adk_live.run_one_live_session(
        socket,
        uid=private.user_id,
        persona_tier="signed_locked",
        directive_store=object(),
        pod_session=private,
    )
    bootstrap.assert_not_called()
    socket.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_erasure_fence_refuses_before_bootstrap(private, monkeypatch):
    from api.routes.one import adk_live
    from hushh_mcp.services.pod_commit_log import PodLogFenced

    log = AsyncMock()
    log.require_open.side_effect = PodLogFenced("synthetic fence")
    monkeypatch.setattr(module, "_resolve_log", lambda: log)
    bootstrap = AsyncMock()
    monkeypatch.setattr(adk_live, "_receive_runtime_bootstrap", bootstrap)
    await adk_live.run_one_live_session(
        AsyncMock(),
        uid=private.user_id,
        persona_tier="signed_locked",
        directive_store=object(),
        pod_session=private,
    )
    bootstrap.assert_not_called()


def test_memory_projection_discards_audio_and_session_authority():
    original = session(
        [
            Event(
                author="user",
                content=types.Content(
                    role="user",
                    parts=[
                        types.Part(text="synthetic remembered text"),
                        types.Part(
                            inline_data=types.Blob(data=b"synthetic-audio", mime_type="audio/pcm")
                        ),
                    ],
                ),
            )
        ]
    )
    original.state["consent_token"] = "synthetic-secret"
    projected = module.memory_session(original)
    assert projected.state == {}
    assert len(projected.events[0].content.parts) == 1
    assert projected.events[0].content.parts[0].text == "synthetic remembered text"
    assert len(original.events[0].content.parts) == 2


@pytest.mark.asyncio
async def test_pod_entrypoint_revocation_stops_live_work(private, monkeypatch):
    import asyncio

    from fastapi import HTTPException

    from api.routes.one import adk_live, pod_turn, relay_auth

    monkeypatch.setattr(pod_turn, "_require_enabled", lambda: None)
    monkeypatch.setattr(relay_auth, "one_voice_enabled", lambda: True)
    validator = AsyncMock(
        side_effect=[
            {"user_id": private.user_id},
            {"user_id": private.user_id},
            HTTPException(status_code=403, detail="revoked"),
        ]
    )
    monkeypatch.setattr(pod_turn, "_validate_consent", validator)
    monkeypatch.setattr(module, "_validate_consent", validator)
    cancelled = asyncio.Event()
    captured = {}

    async def live(socket, **kwargs):
        captured.update(kwargs)
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    monkeypatch.setattr(adk_live, "run_one_live_session", live)
    socket = AsyncMock()
    socket.headers = {
        "x-consent-token": "synthetic-secret",
        "x-hussh-voice-session": "voice_" + "a" * 32,
    }
    socket.receive_text.side_effect = lambda: None

    async def receive():
        await asyncio.Event().wait()

    socket.receive_text.side_effect = receive
    await asyncio.wait_for(pod_turn.pod_live_route(socket), 3)
    assert cancelled.is_set()
    assert captured["uid"] == private.user_id
    assert captured["pod_session"].hushh_id == private.hushh_id
    socket.accept.assert_awaited_once()
    socket.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_pod_entrypoint_denial_does_not_accept_or_read(private, monkeypatch):
    from fastapi import HTTPException

    from api.routes.one import pod_turn, relay_auth

    monkeypatch.setattr(pod_turn, "_require_enabled", lambda: None)
    monkeypatch.setattr(relay_auth, "one_voice_enabled", lambda: True)
    monkeypatch.setattr(
        pod_turn, "_validate_consent", AsyncMock(side_effect=HTTPException(status_code=403))
    )
    socket = AsyncMock()
    socket.headers = {
        "x-consent-token": "synthetic-secret",
        "x-hussh-voice-session": "voice_" + "a" * 32,
    }
    await pod_turn.pod_live_route(socket)
    socket.accept.assert_not_called()
    socket.receive_text.assert_not_called()
    socket.close.assert_awaited_once()
