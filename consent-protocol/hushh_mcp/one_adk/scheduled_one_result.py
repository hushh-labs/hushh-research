"""Validate native root task completion; model prose cannot settle effects."""

from __future__ import annotations

import re
from copy import deepcopy

from google.adk.sessions import Session

from hushh_mcp.services.pod_scheduled_checkpoint import ScheduledOneResult
from hushh_mcp.services.pod_scheduled_contracts import ScheduleRefused


def native_task_outputs(session: Session) -> dict[str, dict]:
    result: dict[str, dict] = {}
    for event in session.events:
        if event.output is None:
            continue
        try:
            output = ScheduledOneResult.model_validate(event.output).model_dump()
        except (ValueError, TypeError):
            raise ScheduleRefused("SCHEDULE_CHECKPOINT_CONTROL_UNSUPPORTED") from None
        if event.author != "one" or not re.fullmatch(r"one@[1-9][0-9]*", event.node_info.path):
            raise ScheduleRefused("SCHEDULE_TASK_OUTPUT_REFUSED")
        responses = [
            response
            for response in event.get_function_responses()
            if response.name == "finish_task"
            and response.id
            and response.response == {"result": "Task completed."}
        ]
        if len(responses) != 1:
            raise ScheduleRefused("SCHEDULE_TASK_OUTPUT_REFUSED")
        call_id = responses[0].id
        if not call_id:
            raise ScheduleRefused("SCHEDULE_TASK_OUTPUT_REFUSED")
        calls = [
            (prior, call)
            for prior in session.events[: session.events.index(event)]
            for call in prior.get_function_calls()
            if call.id == call_id and call.name == "finish_task"
        ]
        if len(calls) != 1:
            raise ScheduleRefused("SCHEDULE_TASK_OUTPUT_REFUSED")
        prior, call = calls[0]
        if (prior.author, prior.node_info.path, prior.invocation_id, call.args) != (
            "one",
            event.node_info.path,
            event.invocation_id,
            output,
        ) or call_id in result:
            raise ScheduleRefused("SCHEDULE_TASK_OUTPUT_REFUSED")
        result[call_id] = {"event_id": event.id, "output": output}
    if len(result) > 1:
        raise ScheduleRefused("SCHEDULE_TASK_OUTPUT_REFUSED")
    return result


def retain_native_task_output(document: dict, validated: dict[str, dict]) -> None:
    # The generic connector redactor removes downstream args/results. Restore
    # only the schema-checked native terminal association, never another tool.
    for event in document["events"]:
        for part in (event.get("content") or {}).get("parts") or []:
            call, response = part.get("functionCall") or {}, part.get("functionResponse") or {}
            terminal = (
                validated.get(str(call.get("id") or ""))
                if call.get("name") == "finish_task"
                else None
            )
            if terminal:
                call["args"] = deepcopy(terminal["output"])
            terminal = (
                validated.get(str(response.get("id") or ""))
                if response.get("name") == "finish_task"
                else None
            )
            if terminal and terminal["event_id"] == event["id"]:
                response["response"] = {"result": "Task completed."}
                event["output"] = deepcopy(terminal["output"])


def require_settled_pending(session: dict, pending: dict) -> None:
    """The native terminal cannot supersede an outstanding confirmation."""
    parsed = Session.model_validate(session)
    for value in pending.values():
        settled = [
            event
            for event in parsed.events
            if any(
                response.id == value["call_id"] and response.name == value["tool_name"]
                for response in event.get_function_responses()
            )
            and value["call_id"] not in event.actions.requested_tool_confirmations
        ]
        if len(settled) != 1:
            raise ScheduleRefused("SCHEDULE_TASK_REVIEW_PENDING")
