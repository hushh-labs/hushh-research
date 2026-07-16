from __future__ import annotations

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
