"""Drive provider content must not appear in browser protocol or adapter logs."""

import json
import logging

import pytest
from ag_ui.core import (
    AssistantMessage,
    FunctionCall,
    MessagesSnapshotEvent,
    RunFinishedEvent,
    ToolCall,
    ToolCallArgsEvent,
    ToolCallChunkEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
    ToolMessage,
)

from hushh_mcp.one_adk import agui_turn_timing  # noqa: F401 - installs adapter log filter
from hushh_mcp.one_adk.drive_result_privacy import (
    ConfirmationWireProjection,
    redact_drive_session_json,
    redact_drive_wire_event,
)


def confirmation_arguments():
    return {
        "originalFunctionCall": {
            "id": "call",
            "name": "mcp_" + "a" * 40,
            "args": {"q": "PRIVATE_SENTINEL"},
        },
        "toolConfirmation": {
            "hint": "PRIVATE_SENTINEL",
            "payload": {
                "kind": "mcp_call_review",
                "version": 1,
                "connectorId": "custom",
                "toolName": "mcp_" + "a" * 40,
                "directiveId": "dir_" + "b" * 32,
                "pendingHandle": "one_secret_ref:" + "c" * 32,
                "expiresAt": "2099-01-01T00:00:00+00:00",
                "extra": "PRIVATE_SENTINEL",
            },
        },
    }


def test_blocked_followup_cannot_copy_private_arguments_to_wire():
    projection = ConfirmationWireProjection()
    projection.project(ToolCallStartEvent(tool_call_id="read", tool_call_name="mcp_" + "a" * 40))
    projection.project(ToolCallStartEvent(tool_call_id="blocked", tool_call_name="send_email"))
    assert (
        projection.project(ToolCallArgsEvent(tool_call_id="blocked", delta='{"body":"PRIVATE"}'))
        == []
    )
    result = projection.project(
        ToolCallResultEvent(
            tool_call_id="blocked",
            message_id="result",
            content='{"status":"blocked","body":"PRIVATE"}',
        )
    )
    assert "PRIVATE" not in result[0].model_dump_json()
    # A safe MCP review remains usable after the first read.
    projection.project(
        ToolCallStartEvent(tool_call_id="confirm", tool_call_name="adk_request_confirmation")
    )
    projection.project(
        ToolCallArgsEvent(tool_call_id="confirm", delta=json.dumps(confirmation_arguments()))
    )
    review = projection.project(ToolCallEndEvent(tool_call_id="confirm"))
    assert "pendingHandle" in review[1].delta
    assert "PRIVATE_SENTINEL" not in review[1].delta
    assert (
        projection.project(
            ToolCallChunkEvent(
                tool_call_id="chunk_only", tool_call_name="send_email", delta="PRIVATE"
            )
        )
        == []
    )
    projection.project(
        ToolCallStartEvent(tool_call_id="unsafe_confirm", tool_call_name="adk_request_confirmation")
    )
    projection.project(
        ToolCallArgsEvent(tool_call_id="unsafe_confirm", delta='{"private":"PRIVATE"}')
    )
    unsafe = projection.project(ToolCallEndEvent(tool_call_id="unsafe_confirm"))
    assert unsafe[1].delta == "{}"


def test_durable_post_read_calls_redacted_without_erasing_earlier_or_next_turn():
    def event(invocation, name, identity, value):
        return {
            "invocationId": invocation,
            "content": {
                "parts": [
                    {"functionCall": {"name": name, "id": identity, "args": {"value": value}}}
                ]
            },
        }

    document = {
        "events": [
            event("turn", "safe_card", "earlier", "KEEP_EARLIER"),
            event("turn", "mcp_" + "a" * 40, "read", "PRIVATE"),
            event("turn", "blocked_action", "blocked", "PRIVATE"),
            event("next", "safe_card", "next", "KEEP_NEXT"),
        ]
    }
    serialized = redact_drive_session_json(json.dumps(document))
    assert "PRIVATE" not in serialized
    assert "KEEP_EARLIER" in serialized and "KEEP_NEXT" in serialized


def test_snapshot_blocks_post_read_arguments_but_preserves_next_user_turn():
    from ag_ui.core import UserMessage

    def assistant(identity, name, value):
        return AssistantMessage(
            id=identity,
            tool_calls=[
                ToolCall(
                    id=identity,
                    function=FunctionCall(name=name, arguments=json.dumps({"value": value})),
                )
            ],
        )

    event = MessagesSnapshotEvent(
        messages=[
            assistant("early", "safe_card", "KEEP_EARLIER"),
            assistant("read", "mcp_" + "a" * 40, "PRIVATE"),
            assistant("blocked", "send_email", "PRIVATE"),
            UserMessage(id="user", content="A fresh instruction"),
            assistant("next", "safe_card", "KEEP_NEXT"),
        ]
    )
    serialized = redact_drive_wire_event(event, set()).model_dump_json()
    assert "PRIVATE" not in serialized
    assert "KEEP_EARLIER" in serialized and "KEEP_NEXT" in serialized


@pytest.mark.parametrize("split", [1, 40, 100])
def test_fragmented_native_confirmation_only_exposes_typed_review_reference(split):
    projection = ConfirmationWireProjection()
    original = json.dumps(confirmation_arguments())
    assert (
        projection.project(
            ToolCallStartEvent(tool_call_id="confirm", tool_call_name="adk_request_confirmation")
        )
        == []
    )
    assert (
        projection.project(ToolCallArgsEvent(tool_call_id="confirm", delta=original[:split])) == []
    )
    assert (
        projection.project(ToolCallArgsEvent(tool_call_id="confirm", delta=original[split:])) == []
    )
    events = projection.project(ToolCallEndEvent(tool_call_id="confirm"))
    assert len(events) == 3
    assert "PRIVATE_SENTINEL" not in str([item.model_dump() for item in events])
    payload = json.loads(events[1].delta)["toolConfirmation"]["payload"]
    assert payload["kind"] == "mcp_call_review"
    assert payload["pendingHandle"] == "one_secret_ref:" + "c" * 32
    assert "extra" not in payload
    reply = projection.project(
        ToolCallResultEvent(
            message_id="reply",
            tool_call_id="confirm",
            content='{"payload":"PRIVATE_SENTINEL"}',
        )
    )
    assert "PRIVATE_SENTINEL" not in reply[0].model_dump_json()


def test_confirmation_snapshot_redacts_nested_private_arguments():
    snapshot = MessagesSnapshotEvent(
        messages=[
            ToolMessage(
                id="reply", tool_call_id="confirm", content='{"payload":"PRIVATE_SENTINEL"}'
            ),
            AssistantMessage(
                id="message",
                tool_calls=[
                    ToolCall(
                        id="confirm",
                        function=FunctionCall(
                            name="adk_request_confirmation",
                            arguments=json.dumps(confirmation_arguments()),
                        ),
                    ),
                ],
            ),
        ]
    )
    safe = redact_drive_wire_event(snapshot, set())
    assert "PRIVATE_SENTINEL" not in safe.model_dump_json()
    assert "PRIVATE_SENTINEL" in snapshot.model_dump_json()


def test_incomplete_confirmation_never_reports_successful_finish():
    projection = ConfirmationWireProjection()
    projection.project(
        ToolCallStartEvent(tool_call_id="confirm", tool_call_name="adk_request_confirmation")
    )
    with pytest.raises(ValueError, match="incomplete"):
        projection.project(RunFinishedEvent(thread_id="thread", run_id="run"))


@pytest.mark.parametrize("delta", ["invalid-json", "x" * 64_001])
def test_invalid_confirmation_fails_without_exposing_input(delta):
    projection = ConfirmationWireProjection()
    projection.project(
        ToolCallStartEvent(tool_call_id="confirm", tool_call_name="adk_request_confirmation")
    )
    with pytest.raises(ValueError) as error:
        projection.project(ToolCallArgsEvent(tool_call_id="confirm", delta=delta))
        projection.project(ToolCallEndEvent(tool_call_id="confirm"))
    assert delta not in str(error.value)


def test_non_mcp_confirmation_preserves_existing_contract():
    projection = ConfirmationWireProjection()
    args = {"originalFunctionCall": {"id": "other", "name": "existing_action", "args": {"x": 1}}}
    projection.project(
        ToolCallStartEvent(tool_call_id="confirm", tool_call_name="adk_request_confirmation")
    )
    projection.project(ToolCallArgsEvent(tool_call_id="confirm", delta=json.dumps(args)))
    events = projection.project(ToolCallEndEvent(tool_call_id="confirm"))
    assert json.loads(events[1].delta) == args


async def test_native_confirmation_nested_arguments_and_payload_are_not_durable(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from google.adk.agents import LlmAgent
    from google.adk.agents.invocation_context import InvocationContext
    from google.adk.events import Event, EventActions
    from google.adk.flows.llm_flows.functions import generate_request_confirmation_event
    from google.adk.flows.llm_flows.request_confirmation import _resolve_confirmation_targets
    from google.adk.sessions import InMemorySessionService, Session
    from google.adk.tools.tool_confirmation import ToolConfirmation
    from google.genai import types

    from hushh_mcp.one_adk.encrypted_session_service import EncryptedAdkSessionService
    from hushh_mcp.one_adk.mcp_pending_call import (
        capture_pending_call,
        pending_resume_scope,
        restore_pending_call,
    )
    from hushh_mcp.one_adk.request_secrets import store_request_secret

    name = "mcp_" + "a" * 40
    private = "PRIVATE_REVIEW_ARGUMENT"
    session = Session(id="thread", app_name="hussh_one", user_id="owner")
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
    # The installed ADK can still identify the exact pending call from this
    # skeleton. Restoring private arguments belongs at the governed execution
    # boundary, not by replacing stored conversation events. This SDK check is
    # deliberately NOT app approval: the exact-call ledger must still pass.
    resumed_context = InvocationContext(
        agent=invocation.agent,
        session=restored,
        session_service=InMemorySessionService(),
        invocation_id="resume",
    )
    confirmations, calls = await _resolve_confirmation_targets(
        resumed_context,
        restored.events,
        {confirmation_id},
        {confirmation_id: ToolConfirmation(confirmed=True)},
        {name: SimpleNamespace(check_require_confirmation=AsyncMock(return_value=True))},
    )
    assert set(confirmations) == {"call"}
    assert calls["call"].name == name
    assert calls["call"].args == {}
    handle = capture_pending_call(
        SimpleNamespace(
            user_id="owner",
            function_call_id="call",
            state={
                "hussh:user_id": "owner",
                "hussh:conversation_id": "thread",
            },
        ),
        tool_name=name,
        arguments={"recipient": private},
    )
    live = restore_pending_call(restored, handle)
    resumed_context.session = live
    _, recovered = await _resolve_confirmation_targets(
        resumed_context,
        live.events,
        {confirmation_id},
        {confirmation_id: ToolConfirmation(confirmed=True)},
        {name: SimpleNamespace(check_require_confirmation=AsyncMock(return_value=True))},
    )
    assert recovered["call"].args == {"recipient": private}
    assert restored.events[1].get_function_calls()[0].args == {}
    assert private not in redact_drive_session_json(live.model_dump_json(by_alias=True))
    service = EncryptedAdkSessionService()
    encoded = service._encode(restored)
    row = {f"payload_{key}": value for key, value in encoded.items()}
    row["revision"] = 1
    monkeypatch.setattr(service, "_execute", AsyncMock(return_value=SimpleNamespace(data=[row])))
    reference = store_request_secret(json.dumps({"pendingHandle": handle}))
    async with pending_resume_scope(reference):
        recovered_session = await service.get_session(
            app_name="hussh_one",
            user_id="owner",
            session_id="thread",
        )
        assert recovered_session.events[1].get_function_calls()[0].args == {"recipient": private}
    outside = await service.get_session(app_name="hussh_one", user_id="owner", session_id="thread")
    assert outside.events[1].get_function_calls()[0].args == {}
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


def test_owner_encrypted_history_keeps_outcomes_not_connector_payloads():
    name = "mcp_" + "a" * 40
    document = {
        "events": [
            {
                "invocationId": "turn",
                "content": {
                    "parts": [
                        {
                            "functionCall": {
                                "id": "read",
                                "name": name,
                                "args": {"q": "PRIVATE_ARGUMENT"},
                            }
                        },
                        {
                            "functionResponse": {
                                "id": "read",
                                "name": name,
                                "response": {
                                    "status": "ok",
                                    "isError": False,
                                    "result": {
                                        "content": [
                                            {"type": "text", "text": "OWNER_CONNECTOR_INFORMATION"}
                                        ]
                                    },
                                    "approvalReceipt": "DO_NOT_RETAIN_AUTHORITY",
                                },
                            }
                        },
                        {
                            "functionResponse": {
                                "id": "failed",
                                "name": name,
                                "response": {
                                    "status": "blocked",
                                    "result": "DO_NOT_RETAIN_ERROR_BODY",
                                },
                            }
                        },
                    ]
                },
            }
        ]
    }
    retained = redact_drive_session_json(json.dumps(document))
    assert "OWNER_CONNECTOR_INFORMATION" not in retained
    assert "PRIVATE_ARGUMENT" not in retained
    assert "DO_NOT_RETAIN" not in retained
    response = json.loads(retained)["events"][0]["content"]["parts"][1]["functionResponse"]
    assert response["response"]["status"] == "ok"
    assert response["response"]["private_result"] == "not_retained"
    # Projection must not remove information needed by the authorized live turn.
    assert "OWNER_CONNECTOR_INFORMATION" in json.dumps(document)


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


@pytest.mark.parametrize(
    ("content", "expected_extra"),
    [
        (
            {
                "status": "ok",
                "result": {"private": "PRIVATE_SENTINEL"},
                "review": "read_only",
                "connectorId": "custom_" + "a" * 32,
            },
            {"review": "read_only", "connectorId": "custom_" + "a" * 32},
        ),
        (
            {
                "status": "ok",
                "result": "PRIVATE_SENTINEL",
                "review": "approved",
                "connectorId": "custom_" + "a" * 32,
            },
            {"review": "approved", "connectorId": "custom_" + "a" * 32},
        ),
        (
            {"status": "ok", "review": "no_credential", "connectorId": "custom_" + "a" * 32},
            {"review": "no_credential", "connectorId": "custom_" + "a" * 32},
        ),
        # Anything not exactly one of the public shapes is dropped, never echoed.
        ({"status": "ok", "review": "not_required"}, {}),
        (
            {"status": "ok", "review": "PRIVATE_SENTINEL", "connectorId": "PRIVATE SENTINEL"},
            {},
        ),
        ({"status": "ok", "review": ["approved"], "connectorId": 7}, {}),
        (
            {"status": ["ok"], "connectorId": "custom_" + "a" * 32},
            {"connectorId": "custom_" + "a" * 32},
        ),
        (
            {"error": "MCP_PROVIDER_ERROR", "connectorId": "custom_" + "a" * 32},
            {"connectorId": "custom_" + "a" * 32},
        ),
    ],
)
def test_connector_step_label_fields_are_the_only_additions(content, expected_extra):
    event = ToolCallResultEvent(
        message_id="result-mcp", tool_call_id="mcp-call", content=json.dumps(content)
    )
    safe = json.loads(redact_drive_wire_event(event, {"mcp-call"}).content)
    status = content.get("status")
    status = status if isinstance(status, str) else "unavailable"
    assert safe == {
        "status": status,
        "private_result": "not_retained",
        "truncated": False,
        **expected_extra,
    }
    assert "PRIVATE" not in json.dumps(safe)
