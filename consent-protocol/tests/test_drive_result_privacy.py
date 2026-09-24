"""Drive provider content must not appear in browser protocol or adapter logs."""

import json
import logging

import pytest
from ag_ui.core import (
    AssistantMessage,
    FunctionCall,
    MessagesSnapshotEvent,
    ToolCall,
    ToolCallArgsEvent,
    ToolCallChunkEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
    ToolMessage,
)

from hushh_mcp.one_adk import agui_turn_timing  # noqa: F401 - installs adapter log filter
from hushh_mcp.one_adk.drive_result_privacy import (
    redact_drive_session_json,
    redact_drive_wire_event,
)


def test_native_confirmation_nested_arguments_and_payload_are_not_durable():
    from google.adk.agents import LlmAgent
    from google.adk.agents.invocation_context import InvocationContext
    from google.adk.events import Event, EventActions
    from google.adk.flows.llm_flows.functions import generate_request_confirmation_event
    from google.adk.sessions import InMemorySessionService, Session
    from google.adk.tools.tool_confirmation import ToolConfirmation
    from google.genai import types

    name = "mcp_" + "a" * 40
    private = "PRIVATE_REVIEW_ARGUMENT"
    session = Session(id="thread", app_name="one", user_id="owner")
    invocation = InvocationContext(
        agent=LlmAgent(name="one", model="gemini-test"),
        session=session,
        session_service=InMemorySessionService(),
        invocation_id="turn",
    )
    call = Event(
        author="one",
        content=types.Content(
            parts=[
                types.Part(
                    function_call=types.FunctionCall(
                        id="call", name=name, args={"recipient": private}
                    ),
                )
            ]
        ),
    )
    response = Event(
        author="one",
        content=types.Content(
            parts=[
                types.Part(
                    function_response=types.FunctionResponse(
                        id="call", name=name, response={"status": "pending"}
                    ),
                )
            ]
        ),
        actions=EventActions(
            requested_tool_confirmations={
                "call": ToolConfirmation(hint=private, payload={"preview": private}),
            }
        ),
    )
    confirmation = generate_request_confirmation_event(invocation, call, response)
    assert confirmation is not None
    confirmation_id = confirmation.get_function_calls()[0].id
    reply = Event(
        author="user",
        content=types.Content(
            parts=[
                types.Part(
                    function_response=types.FunctionResponse(
                        id=confirmation_id,
                        name="adk_request_confirmation",
                        response={"confirmed": True, "payload": private},
                    ),
                )
            ]
        ),
    )
    session.events = [reply, call, response, confirmation]
    serialized = session.model_dump_json(by_alias=True)
    assert private in serialized
    projected = redact_drive_session_json(serialized)
    assert private not in projected
    restored = Session.model_validate_json(projected)
    nested = restored.events[3].get_function_calls()[0]
    assert nested.args["originalFunctionCall"] == {"id": "call", "name": name, "args": {}}
    assert restored.events[2].actions.requested_tool_confirmations["call"].confirmed is False
    # Projection must never strip the live call before the model/review sees it.
    assert session.events[1].get_function_calls()[0].args == {"recipient": private}
    assert session.events[3].get_function_calls()[0].args["originalFunctionCall"]["args"] == {
        "recipient": private
    }


def test_drive_result_and_snapshot_are_redacted_but_other_tools_unchanged():
    secret = "PRIVATE_DRIVE_SENTINEL"
    result = json.dumps({"source": "google_drive_mcp", "result": secret})
    known: set[str] = set()
    start = ToolCallStartEvent(tool_call_id="drive-1", tool_call_name="read_google_drive")
    assert redact_drive_wire_event(start, known) == start
    assert known == {"drive-1"}
    chunk = ToolCallChunkEvent(tool_call_id="drive-1", delta=secret)
    assert redact_drive_wire_event(chunk, known) is None
    args = ToolCallArgsEvent(tool_call_id="drive-1", delta=secret)
    assert redact_drive_wire_event(args, known) is None
    wire_result = ToolCallResultEvent(
        message_id="result-1",
        tool_call_id="drive-1",
        content=result,
        raw_event={"private": secret},
        metadata={"private": secret},
    )
    assert secret not in redact_drive_wire_event(wire_result, known).model_dump_json()
    # The marker also protects results arriving without an observed start event.
    assert secret not in redact_drive_wire_event(wire_result, set()).model_dump_json()

    snapshot = MessagesSnapshotEvent(
        raw_event={"private": secret},
        metadata={"private": secret},
        messages=[
            AssistantMessage(
                id="assistant-1",
                tool_calls=[
                    ToolCall(
                        id="drive-1",
                        function=FunctionCall(name="read_google_drive", arguments=secret),
                    )
                ],
            ),
            ToolMessage(id="m1", tool_call_id="drive-1", content=result, encrypted_value=secret),
            ToolMessage(id="m2", tool_call_id="other", content="ordinary result"),
        ],
    )
    safe = redact_drive_wire_event(snapshot, known)
    assert secret not in safe.model_dump_json()
    assert safe.messages[0].tool_calls[0].function.arguments == "{}"
    assert safe.messages[2].content == "ordinary result"


def test_selected_file_status_names_and_arguments_never_reach_browser_or_storage():
    secret = "PRIVATE_FILENAME.pdf"
    tool_name = "inspect_selected_drive_files"
    result = json.dumps(
        {"source": "google_drive_selected_status", "status": "ok", "matches": [{"name": secret}]}
    )
    known: set[str] = set()
    redact_drive_wire_event(
        ToolCallStartEvent(tool_call_id="selected-1", tool_call_name=tool_name), known
    )
    assert (
        redact_drive_wire_event(ToolCallArgsEvent(tool_call_id="selected-1", delta=secret), known)
        is None
    )
    safe = redact_drive_wire_event(
        ToolCallResultEvent(message_id="result", tool_call_id="selected-1", content=result), known
    )
    assert secret not in safe.model_dump_json()
    assert json.loads(safe.content)["status"] == "ok"
    serialized = json.dumps(
        {
            "events": [
                {
                    "content": {
                        "parts": [
                            {"functionCall": {"name": tool_name, "args": {"file_name": secret}}},
                            {
                                "functionResponse": {
                                    "name": tool_name,
                                    "response": json.loads(result),
                                }
                            },
                        ]
                    }
                }
            ]
        }
    )
    stored = redact_drive_session_json(serialized)
    assert secret not in stored
    assert (
        json.loads(stored)["events"][0]["content"]["parts"][1]["functionResponse"]["response"][
            "status"
        ]
        == "ok"
    )


def test_adapter_event_preview_log_never_contains_provider_content(caplog):
    secret = "PRIVATE_DRIVE_SENTINEL"
    bridge = logging.getLogger("ag_ui_adk.adk_agent")
    with caplog.at_level(logging.INFO, logger=bridge.name):
        bridge.info("[ADK_EVENT] author=one, content=%s", secret)
    assert secret not in caplog.text


def test_failed_read_keeps_only_safe_outcome():
    known = {"drive-failed"}
    event = ToolCallResultEvent(
        message_id="result-2",
        tool_call_id="drive-failed",
        content='{"status":"blocked","message":"PRIVATE_DRIVE_SENTINEL"}',
    )
    safe = redact_drive_wire_event(event, known)
    assert json.loads(safe.content) == {
        "status": "blocked",
        "private_result": "not_retained",
        "truncated": False,
    }
    assert "PRIVATE_DRIVE_SENTINEL" not in safe.model_dump_json()


@pytest.mark.parametrize("provider", ["drive", "gmail", "calendar"])
def test_missing_workspace_grant_retains_only_provider_for_connect_card(provider):
    secret = "PRIVATE_PROVIDER_SENTINEL"
    known = {"workspace-call"}
    event = ToolCallResultEvent(
        message_id="result-connect",
        tool_call_id="workspace-call",
        content=json.dumps(
            {
                "status": "permission_required",
                "provider": provider,
                "message": secret,
            }
        ),
    )
    safe = redact_drive_wire_event(event, known)
    assert json.loads(safe.content) == {
        "status": "permission_required",
        "private_result": "not_retained",
        "truncated": False,
        "provider": provider,
    }
    assert secret not in safe.model_dump_json()


def test_untrusted_workspace_provider_is_not_projected():
    event = ToolCallResultEvent(
        message_id="result-untrusted",
        tool_call_id="workspace-call",
        content=json.dumps(
            {
                "status": "permission_required",
                "provider": "attacker-controlled-provider",
            }
        ),
    )
    safe = redact_drive_wire_event(event, {"workspace-call"})
    assert "provider" not in json.loads(safe.content)


def test_dynamic_mcp_snapshot_before_call_and_storage_are_private():
    name = "mcp_" + "a" * 40
    private = "SYNTHETIC_PRIVATE_CONNECTOR_VALUE"
    snapshot = MessagesSnapshotEvent(
        messages=[
            ToolMessage(id="result", tool_call_id="dynamic-1", content=private),
            AssistantMessage(
                id="call",
                tool_calls=[
                    ToolCall(id="dynamic-1", function=FunctionCall(name=name, arguments=private))
                ],
            ),
        ]
    )
    safe = redact_drive_wire_event(snapshot, set())
    assert private not in safe.model_dump_json()
    assert private in snapshot.model_dump_json()  # live model event is unchanged
    document = {
        "events": [
            {
                "content": {
                    "parts": [
                        {"functionCall": {"name": name, "args": {"secret": private}}},
                        {"functionResponse": {"name": name, "response": {"result": private}}},
                    ]
                }
            }
        ]
    }
    assert private not in redact_drive_session_json(json.dumps(document))


def test_dynamic_mcp_start_metadata_and_argument_chunks_are_private():
    name = "mcp_" + "b" * 40
    private = "SYNTHETIC_PRIVATE_CONNECTOR_VALUE"
    known = set()
    start = ToolCallStartEvent(
        tool_call_id="dynamic",
        tool_call_name=name,
        metadata={"secret": private},
        raw_event={"secret": private},
    )
    assert private not in redact_drive_wire_event(start, known).model_dump_json()
    assert (
        redact_drive_wire_event(ToolCallArgsEvent(tool_call_id="dynamic", delta=private), known)
        is None
    )
    ordinary = ToolCallStartEvent(tool_call_id="other", tool_call_name="mcp_help")
    assert redact_drive_wire_event(ordinary, known) is ordinary


@pytest.mark.parametrize("status", ["ok", "blocked", "unavailable"])
def test_storage_keeps_safe_outcome_and_truncation(status):
    document = {
        "events": [
            {
                "content": {
                    "parts": [
                        {
                            "functionResponse": {
                                "name": "read_google_drive",
                                "response": {
                                    "status": status,
                                    "result": "PRIVATE_DRIVE_SENTINEL",
                                    "truncated": True,
                                },
                            }
                        }
                    ]
                }
            }
        ]
    }
    stored = redact_drive_session_json(json.dumps(document))
    assert "PRIVATE_DRIVE_SENTINEL" not in stored
    outcome = json.loads(stored)["events"][0]["content"]["parts"][0]["functionResponse"]
    assert outcome["response"] == {
        "status": status,
        "private_result": "not_retained",
        "truncated": True,
    }
