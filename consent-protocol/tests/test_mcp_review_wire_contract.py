"""The browser review card depends on two wire facts the installed bridge did not provide.

D1: the display-safe confirmation ARGS must survive wire redaction even when the
    run's MESSAGES_SNAPSHOT (emitted before the buffered confirmation flushes)
    already marked that call id private.
D2: a run paused on MCP review ends with an AG-UI interrupt outcome, and an
    AG-UI ``resume`` entry becomes the tool result ag_ui_adk actually consumes.
"""

import json

from ag_ui.core import (
    AssistantMessage,
    EventType,
    FunctionCall,
    MessagesSnapshotEvent,
    ResumeEntry,
    RunAgentInput,
    RunFinishedEvent,
    ToolCall,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
    ToolMessage,
    UserMessage,
)

from hushh_mcp.one_adk.agui_turn_timing import (
    resume_as_confirmation_results,
    with_review_interrupts,
)
from hushh_mcp.one_adk.drive_result_privacy import (
    ConfirmationWireProjection,
    governed_call_ids,
    redact_drive_wire_event,
)

MCP = "mcp_" + "a" * 40
CONFIRM = "adk-confirm-1"
PAYLOAD = {
    "kind": "mcp_call_review",
    "version": 1,
    "connectorId": "custom_" + "b" * 32,
    "toolName": MCP,
    "directiveId": "dir_" + "c" * 32,
    "pendingHandle": "one_secret_ref:" + "d" * 32,
    "expiresAt": "2026-09-25T12:00:00+00:00",
}
NATIVE_ARGS = {
    "originalFunctionCall": {"id": "call-1", "name": MCP, "args": {"q": "PRIVATE_ARGUMENT"}},
    "toolConfirmation": {"hint": "Review", "confirmed": False, "payload": PAYLOAD},
}


def _snapshot():
    return MessagesSnapshotEvent(
        messages=[
            UserMessage(id="u1", role="user", content="search docs"),
            AssistantMessage(
                id="a1",
                role="assistant",
                tool_calls=[
                    ToolCall(
                        id="call-1",
                        type="function",
                        function=FunctionCall(name=MCP, arguments="{}"),
                    )
                ],
            ),
            AssistantMessage(
                id="a2",
                role="assistant",
                tool_calls=[
                    ToolCall(
                        id=CONFIRM,
                        type="function",
                        function=FunctionCall(
                            name="adk_request_confirmation", arguments=json.dumps(NATIVE_ARGS)
                        ),
                    )
                ],
            ),
        ]
    )


def _wire(events):
    projection, private_ids, out = ConfirmationWireProjection(), set(), []
    for event in events:
        for projected in projection.project(event):
            kept = redact_drive_wire_event(projected, private_ids)
            if kept is not None:
                out.append(kept)
    return projection, out


def test_safe_confirmation_args_survive_snapshot_ordering():
    # Order observed from the real bridge: START/ARGS buffered, snapshot, then END.
    projection, out = _wire(
        [
            ToolCallStartEvent(tool_call_id=CONFIRM, tool_call_name="adk_request_confirmation"),
            ToolCallArgsEvent(tool_call_id=CONFIRM, delta=json.dumps(NATIVE_ARGS)),
            ToolCallResultEvent(
                message_id="r1", tool_call_id="call-1", content='{"status":"review_required"}'
            ),
            _snapshot(),
            ToolCallEndEvent(tool_call_id=CONFIRM),
        ]
    )
    args = [e for e in out if e.type == EventType.TOOL_CALL_ARGS and e.tool_call_id == CONFIRM]
    assert len(args) == 1
    view = json.loads(args[0].delta)
    assert view["toolConfirmation"]["payload"] == PAYLOAD
    assert view["originalFunctionCall"] == {"id": "call-1", "name": MCP, "args": {}}
    assert "PRIVATE_ARGUMENT" not in args[0].delta
    assert projection.review_call_ids == [CONFIRM]


def test_raw_private_confirmation_args_are_still_dropped():
    private = {CONFIRM}
    raw = ToolCallArgsEvent(tool_call_id=CONFIRM, delta=json.dumps(NATIVE_ARGS))
    assert redact_drive_wire_event(raw, private) is None
    assert (
        redact_drive_wire_event(ToolCallArgsEvent(tool_call_id=CONFIRM, delta="{}"), private)
        is None
    )
    assert (
        redact_drive_wire_event(ToolCallArgsEvent(tool_call_id=CONFIRM, delta="not json"), private)
        is None
    )


def test_review_pause_is_an_interrupt_and_other_runs_are_unchanged():
    finished = RunFinishedEvent(thread_id="t", run_id="r")
    marked = with_review_interrupts(finished, [CONFIRM, CONFIRM])
    assert marked.outcome.type == "interrupt"
    assert [(i.id, i.tool_call_id) for i in marked.outcome.interrupts] == [(CONFIRM, CONFIRM)]
    assert with_review_interrupts(finished, []) is finished
    start = ToolCallStartEvent(tool_call_id="x", tool_call_name=MCP)
    assert with_review_interrupts(start, [CONFIRM]) is start


def _run(resume, extra_messages=()):
    messages = [*_snapshot().messages, *extra_messages]
    return RunAgentInput(
        thread_id="t",
        run_id="r2",
        state={},
        messages=messages,
        tools=[],
        context=[],
        forwarded_props={},
        resume=resume,
    )


def test_resume_becomes_boolean_tool_result_for_pending_confirmation_only():
    admitted = resume_as_confirmation_results(
        _run(
            [
                ResumeEntry(
                    interrupt_id=CONFIRM, status="resolved", payload={"confirmed": True, "x": "y"}
                ),
                ResumeEntry(interrupt_id="call-1", status="resolved", payload={"confirmed": True}),
                ResumeEntry(interrupt_id="forged", status="resolved", payload={"confirmed": True}),
            ]
        )
    )
    assert admitted.resume is None
    added = admitted.messages[len(_snapshot().messages) :]
    assert [(m.role, m.tool_call_id, json.loads(m.content)) for m in added] == [
        ("tool", CONFIRM, {"confirmed": True})
    ]


def test_cancelled_or_non_boolean_resume_is_a_decline_and_answered_calls_are_ignored():
    for entry in (
        ResumeEntry(interrupt_id=CONFIRM, status="cancelled", payload={"confirmed": True}),
        ResumeEntry(interrupt_id=CONFIRM, status="resolved", payload={"confirmed": "yes"}),
    ):
        added = resume_as_confirmation_results(_run([entry])).messages[-1]
        assert json.loads(added.content) == {"confirmed": False}
    answered = ToolMessage(
        id="m", role="tool", tool_call_id=CONFIRM, content='{"confirmed": false}'
    )
    unchanged = resume_as_confirmation_results(
        _run(
            [ResumeEntry(interrupt_id=CONFIRM, status="resolved", payload={"confirmed": True})],
            [answered],
        )
    )
    assert unchanged.messages[-1] is answered or unchanged.messages[-1].id == "m"
    no_resume = _run(None)
    assert resume_as_confirmation_results(no_resume) is no_resume


def test_review_pending_outcome_is_distinct_from_failure_on_the_wire():
    private = {"call-1"}
    pending = redact_drive_wire_event(
        ToolCallResultEvent(
            message_id="r", tool_call_id="call-1", content='{"status": "review_required"}'
        ),
        private,
    )
    failed = redact_drive_wire_event(
        ToolCallResultEvent(
            message_id="r2",
            tool_call_id="call-1",
            content='{"status": "blocked", "error": "MCP_APPROVAL_INVALID"}',
        ),
        private,
    )
    assert json.loads(pending.content)["status"] == "review_required"
    assert json.loads(failed.content) == {
        "status": "blocked",
        "private_result": "not_retained",
        "truncated": False,
    }


def test_resumed_run_redacts_the_approved_result_without_a_tool_start():
    private = governed_call_ids(_snapshot().messages)
    assert private == {"call-1"}
    raw = ToolCallResultEvent(
        message_id="r",
        tool_call_id="call-1",
        content=json.dumps({"status": "ok", "isError": False, "result": {"x": "PROVIDER_TEXT"}}),
    )
    projected = redact_drive_wire_event(raw, private)
    assert "PROVIDER_TEXT" not in projected.content
    assert json.loads(projected.content)["status"] == "ok"
