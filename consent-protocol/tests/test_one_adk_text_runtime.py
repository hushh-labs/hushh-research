from __future__ import annotations

import asyncio

import pytest
from google.adk.events import Event, EventActions
from google.genai import types as genai_types

from hushh_mcp.one_adk import text_runtime
from hushh_mcp.one_adk.agent_tree import (
    ONE_APP_NAME,
    STATE_CONSENT_TOKEN,
    STATE_PKM_CONTEXT,
    STATE_VOICE_CONTEXT,
)
from hushh_mcp.one_adk.text_runtime import OneTextStreamEvent
from hushh_mcp.services.agent_chat_service import AgentChatMessage


def test_managed_text_runtime_uses_explicit_vertex_contract(monkeypatch):
    monkeypatch.setenv("HUSHH_GENAI_AUTH_MODE", "vertex_adc")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-test")
    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "asia-southeast1")

    model = text_runtime._runtime_model(
        runtime_model="gemini-test",
        runtime_mode="hushh_managed_vertex",
        runtime_credential=None,
    )

    assert model.model == "gemini-test"
    assert model.client_kwargs == {
        "vertexai": True,
        "project": "hushh-test",
        "location": "asia-southeast1",
    }


async def test_text_runtime_replays_history_and_extracts_generated_directive(monkeypatch):
    observed: dict = {}

    class _FakeRunner:
        def __init__(self, *, app_name, agent, session_service):
            assert app_name == ONE_APP_NAME
            observed["agent"] = agent
            self.session_service = session_service

        async def run_async(self, *, user_id, session_id, new_message, run_config):
            session = await self.session_service.get_session(
                app_name=ONE_APP_NAME,
                user_id=user_id,
                session_id=session_id,
            )
            assert session is not None
            observed["state"] = session.state
            observed["history"] = list(session.events)
            observed["message"] = new_message.parts[0].text
            yield Event(
                author="one",
                partial=True,
                content=genai_types.Content(
                    role="model",
                    parts=[genai_types.Part.from_text(text="Opening Location.")],
                ),
            )
            yield Event(
                author="one",
                actions=EventActions(
                    state_delta={
                        "hussh:pending_directive:route.one_location": {
                            "kind": "action",
                            "payload": {"actionId": "route.one_location", "slots": {}},
                        }
                    }
                ),
            )

    monkeypatch.setattr(text_runtime, "Runner", _FakeRunner)
    monkeypatch.setattr(text_runtime, "build_one_text_agent", lambda *, model: ("one", model))
    history = [
        AgentChatMessage(
            id="m1",
            conversation_id="c1",
            user_id="u1",
            role="assistant",
            status="complete",
            content="Where would you like to go?",
            model="gemini",
            created_at=None,
            completed_at=None,
        )
    ]

    opaque_token = "opaque-owner-" + "token"
    events: list[OneTextStreamEvent] = []
    async for event in text_runtime.stream_one_text_turn(
        user_id="u1",
        consent_token=opaque_token,
        conversation_id="c1",
        message="take me to location",
        history=history,
        timezone="America/Los_Angeles",
        screen_context={"screen": "one_home", "available_action_ids": []},
        pkm_context="bounded context",
        runtime_provider="gemini",
        runtime_model="gemini-test",
        runtime_mode="hushh_managed_vertex",
        runtime_credential=None,
    ):
        events.append(event)

    assert [event.kind for event in events] == ["token", "directive"]
    assert events[1].directive is not None
    assert events[1].directive.payload["actionId"] == "route.one_location"
    assert observed["message"] == "take me to location"
    assert observed["history"][0].content.parts[0].text == "Where would you like to go?"
    assert observed["state"][STATE_CONSENT_TOKEN] == opaque_token
    assert observed["state"][STATE_VOICE_CONTEXT]["screen"] == "one_home"
    assert observed["state"][STATE_PKM_CONTEXT] == "bounded context"


def test_text_runtime_rejects_unknown_client_action_directive():
    directive = text_runtime._directive_from_value(
        {
            "kind": "action",
            "payload": {"actionId": "route.not_in_generated_contract"},
        }
    )

    assert directive is None


@pytest.mark.asyncio
async def test_managed_text_runtime_fails_over_only_before_observable_output(monkeypatch):
    class _Unavailable(Exception):
        status_code = 503

    monkeypatch.setattr(
        text_runtime.ManagedGeminiRuntimeBinding,
        "from_environment",
        classmethod(
            lambda cls: type(
                "Binding",
                (),
                {
                    "locations_for_model": lambda self, _model: (
                        "primary",
                        "secondary",
                    )
                },
            )()
        ),
    )
    attempts: list[str | None] = []

    async def _attempt(**kwargs):
        location = kwargs["managed_location"]
        attempts.append(location)
        if location == "primary":
            raise _Unavailable("unavailable")
        yield OneTextStreamEvent(kind="token", text="Recovered")

    monkeypatch.setattr(text_runtime, "_stream_one_text_turn_once", _attempt)
    opaque_token = "opaque-" + "token"
    events = [
        event
        async for event in text_runtime.stream_one_text_turn(
            user_id="u1",
            consent_token=opaque_token,
            conversation_id="c1",
            message="hello",
            history=[],
            timezone=None,
            screen_context={},
            pkm_context=None,
            runtime_provider="gemini",
            runtime_model="gemini-test",
            runtime_mode="hushh_managed_vertex",
            runtime_credential=None,
        )
    ]

    assert [event.text for event in events] == ["Recovered"]
    assert attempts == ["primary", "secondary"]


@pytest.mark.asyncio
async def test_managed_text_runtime_never_replays_after_tool_boundary(monkeypatch):
    class _Unavailable(Exception):
        status_code = 503

    monkeypatch.setattr(
        text_runtime.ManagedGeminiRuntimeBinding,
        "from_environment",
        classmethod(
            lambda cls: type(
                "Binding",
                (),
                {
                    "locations_for_model": lambda self, _model: (
                        "primary",
                        "secondary",
                    )
                },
            )()
        ),
    )
    attempts: list[str | None] = []

    async def _attempt(**kwargs):
        attempts.append(kwargs["managed_location"])
        yield OneTextStreamEvent(kind="boundary")
        raise _Unavailable("failed after tool call")

    monkeypatch.setattr(text_runtime, "_stream_one_text_turn_once", _attempt)
    opaque_token = "opaque-" + "token"
    with pytest.raises(_Unavailable):
        async for _ in text_runtime.stream_one_text_turn(
            user_id="u1",
            consent_token=opaque_token,
            conversation_id="c1",
            message="hello",
            history=[],
            timezone=None,
            screen_context={},
            pkm_context=None,
            runtime_provider="gemini",
            runtime_model="gemini-test",
            runtime_mode="hushh_managed_vertex",
            runtime_credential=None,
        ):
            pass

    assert attempts == ["primary"]


async def test_text_runtime_emits_non_partial_final_memory_summary(monkeypatch):
    class _FakeRunner:
        def __init__(self, *, app_name, agent, session_service):
            self.session_service = session_service

        async def run_async(self, **kwargs):  # noqa: ANN003
            yield Event(
                author="one",
                partial=False,
                content=genai_types.Content(
                    role="model",
                    parts=[genai_types.Part.from_text(text="You prefer concise summaries.")],
                ),
            )

    monkeypatch.setattr(text_runtime, "Runner", _FakeRunner)
    monkeypatch.setattr(text_runtime, "build_one_text_agent", lambda *, model: ("one", model))
    opaque_token = "opaque-" + "token"

    events = [
        event
        async for event in text_runtime.stream_one_text_turn(
            user_id="u1",
            consent_token=opaque_token,
            conversation_id="c1",
            message="list down a summary of my memory",
            history=[],
            timezone="America/Los_Angeles",
            screen_context={"screen": "one_home"},
            pkm_context="Writing preference: concise summaries.",
            runtime_provider="gemini",
            runtime_model="gemini-3.5-flash",
            runtime_mode="hushh_managed_vertex",
            runtime_credential=None,
        )
    ]

    assert [event.text for event in events] == ["You prefer concise summaries."]


@pytest.mark.asyncio
async def test_bounded_adk_events_times_out_stalled_first_event(monkeypatch):
    async def stalled():
        await asyncio.sleep(0.05)
        yield object()

    monkeypatch.setattr(text_runtime, "_FIRST_EVENT_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(text_runtime, "_TOTAL_TURN_TIMEOUT_SECONDS", 0.1)

    with pytest.raises(asyncio.TimeoutError):
        async for _ in text_runtime._bounded_adk_events(stalled()):
            pass


@pytest.mark.asyncio
async def test_bounded_adk_events_times_out_stalled_followup(monkeypatch):
    first = object()

    async def stalled():
        yield first
        await asyncio.sleep(0.05)
        yield object()

    monkeypatch.setattr(text_runtime, "_BETWEEN_EVENT_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(text_runtime, "_TOTAL_TURN_TIMEOUT_SECONDS", 0.1)

    observed = []
    with pytest.raises(asyncio.TimeoutError):
        async for event in text_runtime._bounded_adk_events(stalled()):
            observed.append(event)

    assert observed == [first]


async def test_text_runtime_rejects_silent_model_completion(monkeypatch):
    class _FakeRunner:
        def __init__(self, *, app_name, agent, session_service):
            self.session_service = session_service

        async def run_async(self, **kwargs):  # noqa: ANN003
            if False:
                yield None

    monkeypatch.setattr(text_runtime, "Runner", _FakeRunner)
    monkeypatch.setattr(text_runtime, "build_one_text_agent", lambda *, model: ("one", model))
    opaque_token = "opaque-" + "token"

    with pytest.raises(text_runtime.OneTextEmptyResponseError):
        async for _ in text_runtime.stream_one_text_turn(
            user_id="u1",
            consent_token=opaque_token,
            conversation_id="c1",
            message="list down a summary of my memory",
            history=[],
            timezone=None,
            screen_context={"screen": "one_home"},
            pkm_context="Writing preference: concise summaries.",
            runtime_provider="gemini",
            runtime_model="gemini-3.5-flash",
            runtime_mode="hushh_managed_vertex",
            runtime_credential=None,
        ):
            pass
