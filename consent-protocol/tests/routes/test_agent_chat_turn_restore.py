"""Leaving a chat and coming back restores the whole turn, display-safe.

The Activity rows and the connect card are rebuilt from the encrypted session
the turn already wrote; nothing new is stored. Every assertion that a value
is absent guards the privacy rule: enums, opaque ids and app labels cross the
history boundary; tool arguments, result bodies and provider text never do.
"""

import json
import re
from pathlib import Path

import pytest
from google.adk.events import Event
from google.adk.sessions import Session
from google.genai import types

from api.routes.one import agent_chat

PRIVATE = "private-value-that-must-not-cross"


def _call(call_id: str, name: str, args: dict | None = None, *, invocation: str = "turn-1"):
    return Event(
        id=f"call-event-{call_id}",
        author="one",
        invocation_id=invocation,
        content=types.Content(
            role="model",
            parts=[
                types.Part(function_call=types.FunctionCall(id=call_id, name=name, args=args or {}))
            ],
        ),
    )


def _response(call_id: str, name: str, response: dict, *, invocation: str = "turn-1"):
    return Event(
        id=f"response-event-{call_id}",
        author="one",
        invocation_id=invocation,
        content=types.Content(
            role="user",
            parts=[
                types.Part(
                    function_response=types.FunctionResponse(
                        id=call_id, name=name, response=response
                    )
                )
            ],
        ),
    )


def _text(event_id: str, text: str, *, author: str = "one", invocation: str = "turn-1"):
    return Event(
        id=event_id,
        author=author,
        invocation_id=invocation,
        content=types.Content(
            role="user" if author == "user" else "model", parts=[types.Part(text=text)]
        ),
    )


async def _history(monkeypatch, events: list[Event]) -> dict:
    session = Session(id="thread", app_name=agent_chat.ONE_APP_NAME, user_id="owner", events=events)

    class SessionStore:
        async def get_session(self, *, app_name, user_id, session_id):
            return session if (user_id, session_id) == ("owner", "thread") else None

    monkeypatch.setattr(agent_chat, "_session_service", SessionStore())
    return await agent_chat.conversation_history("thread", limit=50, token={"user_id": "owner"})


def _calendar_turn() -> list[Event]:
    return [
        _text(
            "user-event", "are we connected to Google calendar if not lets connect", author="user"
        ),
        _call("call-calendar", "discover_workspace_tools", {"provider": "calendar"}),
        _response(
            "call-calendar",
            "discover_workspace_tools",
            {
                "status": "permission_required",
                "provider": "calendar",
                "message": PRIVATE,
                "authorizationUrl": f"https://accounts.example.test/?state={PRIVATE}",
                "grant": {"scopes": [PRIVATE]},
            },
        ),
        _text("answer-event", "We are not connected yet. Use the Connect card above."),
    ]


@pytest.mark.asyncio
async def test_restored_answer_keeps_its_connect_card_and_activity(monkeypatch) -> None:
    history = await _history(monkeypatch, _calendar_turn())

    # One user message and one assistant message: the card is not split into
    # an extra history row, it rides with the answer as it did live.
    assert [message["role"] for message in history["messages"]] == ["user", "assistant"]
    answer = history["messages"][1]
    assert answer["content"] == "We are not connected yet. Use the Connect card above."
    metadata = answer["metadata"]
    assert metadata["structuredExperiences"] == [
        {
            "id": "response-event-call-calendar:call-calendar",
            "activityType": "one.workspace_connector_setup.v1",
            "content": {"provider": "calendar", "status": "connect_required"},
        }
    ]
    assert metadata["turnActivity"] == {
        "activityType": "one.turn_activity.v1",
        "content": {
            "steps": [
                {
                    "id": "call-calendar",
                    "tool": "discover_workspace_tools",
                    "status": "done",
                    "provider": "calendar",
                }
            ]
        },
    }
    assert PRIVATE not in json.dumps(history)


@pytest.mark.asyncio
async def test_connector_steps_carry_outcome_enums_only(monkeypatch) -> None:
    read_tool = "mcp_" + "a" * 40
    review_tool = "mcp_" + "b" * 40
    cut_tool = "mcp_" + "c" * 40
    history = await _history(
        monkeypatch,
        [
            _text("user-event", "use my connectors", author="user"),
            _call("call-read", read_tool, {"query": PRIVATE}),
            _response(
                "call-read",
                read_tool,
                {
                    "status": "ok",
                    "review": "read_only",
                    "connectorId": "custom_0123abcd",
                    "content": [{"type": "text", "text": PRIVATE}],
                },
            ),
            _call("call-review", review_tool, {"path": PRIVATE}),
            _response("call-review", review_tool, {"status": "review_required"}),
            _call("call-cut", cut_tool, {"path": PRIVATE}),
            _call("call-transfer", "transfer_to_agent", {"agent_name": "agent_email"}),
            _call("call-mail", "ask_email_agent", {"request": PRIVATE}),
            _response(
                "call-mail",
                "ask_email_agent",
                {
                    "structured": {
                        "schema_version": "specialist_read.v1",
                        "connector": "mail",
                        "status": "ok",
                        "sources": [],
                        "truncated": False,
                        "metadata_only": True,
                    },
                    "answer": PRIVATE,
                },
            ),
            _text("answer-event", "Done."),
        ],
    )
    steps = history["messages"][-1]["metadata"]["turnActivity"]["content"]["steps"]
    assert steps == [
        {
            "id": "call-read",
            "tool": read_tool,
            "status": "done",
            "review": "read_only",
            "connectorId": "custom_0123abcd",
        },
        {"id": "call-review", "tool": review_tool, "status": "waiting", "review": "required"},
        {"id": "call-cut", "tool": cut_tool, "status": "interrupted"},
        {"id": "call-mail", "tool": "ask_email_agent", "status": "done", "readStatus": "ok"},
    ]
    assert PRIVATE not in json.dumps(history)
    assert "transfer_to_agent" not in json.dumps(history)


@pytest.mark.asyncio
async def test_roster_tool_turn_restores_its_row_and_its_markdown(monkeypatch) -> None:
    # Measured 2026-09-27: a Calendar turn showed an Activity card live and came
    # back as a bare paragraph, because only 13 of the roster's tools could
    # restore a row. The answer's own markdown is stored exactly as streamed.
    answer = "Here is **tomorrow**:\n\n1. [Standup](https://example.test)\n2. Run `sync`"
    events = [
        _text("user-event", "what is on tomorrow", author="user"),
        _call("call-events", "calendar_events", {"query": PRIVATE}),
        _response("call-events", "calendar_events", {"status": "ok", "events": [PRIVATE]}),
        _text("answer-event", answer),
    ]
    history = await _history(monkeypatch, events)
    restored = history["messages"][-1]
    assert restored["content"] == answer
    assert restored["metadata"]["turnActivity"]["content"]["steps"] == [
        {"id": "call-events", "tool": "calendar_events", "status": "done"}
    ]
    assert PRIVATE not in json.dumps(history)


def _roster_tool_names() -> set[str]:
    from google.adk.tools.agent_tool import AgentTool

    from hushh_mcp.one_adk import agent_tree

    tools = agent_tree._one_roster_tools(specialist_model="test-model", allow_workspace_tools=True)
    names = {
        tool.agent.name
        if isinstance(tool, AgentTool)
        else getattr(tool, "name", None) or getattr(tool, "__name__", "")
        for tool in tools
        if type(tool).__name__ != "RegisteredMcpToolset"  # opaque mcp_<digest> tools
    }
    # Added to the roster only when the CRM product is available.
    return names | {"ask_connected_systems_agent"}


def _browser_presentations() -> dict[str, dict[str, str]]:
    source = (
        Path(__file__).resolve().parents[3] / "hushh-webapp/lib/services/agent-chat-client.ts"
    ).read_text()
    table = source.split("const SERVER_TOOL_PRESENTATION", 1)[1].split("\n};\n", 1)[0]
    entry = re.compile(
        r'^  ([a-z_]+): \{\n    label: "([^"]*)",\n    message: "([^"]*)",\n    activity: "([^"]*)",\n  \},$',
        flags=re.MULTILINE,
    )
    parsed = {
        tool: {"label": label, "message": message, "activity": activity}
        for tool, label, message, activity in entry.findall(table)
    }
    # Every key in the table must parse; a malformed entry must not hide a tool.
    assert len(parsed) == len(re.findall(r"^  [a-z_]+: \{$", table, flags=re.MULTILINE))
    return parsed


# ADK's confirmation envelope for a reviewed connector call. The browser names
# it live; history restores the reviewed call's own row instead.
_LIVE_ONLY_TOOLS = {"adk_request_confirmation"}
_GENERIC_LABELS = {"", "Agent step", "Connected tool", "Action", "Working on your request"}


def test_every_tool_one_can_call_has_a_specific_name_live_and_restored() -> None:
    # Measured 2026-09-27: 46 roster tools rendered as "Agent step · Completing
    # a step for your request." and vanished on reload. A tool added to the
    # roster without a name, live or restored, fails here.
    roster = _roster_tool_names()
    presentations = _browser_presentations()
    assert roster - agent_chat._ACTIVITY_TOOLS == set()
    assert set(presentations) == agent_chat._ACTIVITY_TOOLS | _LIVE_ONLY_TOOLS
    for tool, presentation in presentations.items():
        assert presentation["label"] not in _GENERIC_LABELS, tool
        assert presentation["message"] and presentation["activity"], tool
        assert presentation["activity"] not in _GENERIC_LABELS, tool


@pytest.mark.asyncio
async def test_card_only_turn_keeps_its_card_and_activity(monkeypatch) -> None:
    events = _calendar_turn()[:-1]
    history = await _history(monkeypatch, events)
    assistant = [message for message in history["messages"] if message["role"] == "assistant"]
    assert len(assistant) == 1
    assert assistant[0]["content"] == ""
    assert assistant[0]["metadata"]["structuredExperiences"][0]["content"] == {
        "provider": "calendar",
        "status": "connect_required",
    }
    assert assistant[0]["metadata"]["turnActivity"]["content"]["steps"][0]["tool"] == (
        "discover_workspace_tools"
    )


@pytest.mark.asyncio
async def test_activity_stays_with_its_own_turn(monkeypatch) -> None:
    first = _calendar_turn()
    second = [
        _text("user-2", "thanks", author="user", invocation="turn-2"),
        _text("answer-2", "You're welcome.", invocation="turn-2"),
    ]
    history = await _history(monkeypatch, first + second)
    last = history["messages"][-1]
    assert last["content"] == "You're welcome."
    assert last["metadata"] is None


def test_setup_card_rejects_mismatched_or_unknown_providers() -> None:
    response = _response(
        "call-x", "discover_workspace_tools", {"status": "permission_required", "provider": "drive"}
    )
    assert (
        agent_chat._safe_workspace_connector_setup_descriptor(
            response, call_providers={"call-x": "calendar"}
        )
        is None
    )
    unknown = _response(
        "call-y",
        "discover_workspace_tools",
        {"status": "permission_required", "provider": "outlook"},
    )
    assert agent_chat._safe_workspace_connector_setup_descriptor(unknown) is None
    blocked = _response(
        "call-z", "discover_workspace_tools", {"status": "blocked", "provider": "drive"}
    )
    assert agent_chat._safe_workspace_connector_setup_descriptor(blocked) is None
    from_args = _response("call-w", "read_workspace_tool", {"status": "permission_required"})
    assert agent_chat._safe_workspace_connector_setup_descriptor(
        from_args, call_providers={"call-w": "gmail"}
    ) == {
        "activityType": "one.workspace_connector_setup.v1",
        "content": {"provider": "gmail", "status": "connect_required"},
    }


def test_private_connector_card_keeps_only_validated_names() -> None:
    valid = _response(
        "call-c",
        "inspect_private_connectors",
        {
            "status": "setup_available",
            "provider": "custom",
            "saved": [
                {
                    "id": "custom_" + "e" * 32,
                    "name": "Synthetic app",
                    "status": "saved",
                    "url": PRIVATE,
                }
            ],
        },
    )
    descriptor = agent_chat._safe_workspace_connector_setup_descriptor(valid)
    assert descriptor == {
        "activityType": "one.workspace_connector_setup.v1",
        "content": {
            "provider": "custom",
            "status": "manage_available",
            "saved": [{"id": "custom_" + "e" * 32, "name": "Synthetic app", "status": "saved"}],
        },
    }
    smuggled = _response(
        "call-d",
        "inspect_private_connectors",
        {
            "status": "setup_available",
            "provider": "custom",
            "saved": [{"id": "not-a-connector-id", "name": PRIVATE, "status": "saved"}],
        },
    )
    assert PRIVATE not in json.dumps(
        agent_chat._safe_workspace_connector_setup_descriptor(smuggled)
    )
