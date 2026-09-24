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
