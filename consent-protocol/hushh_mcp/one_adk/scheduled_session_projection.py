"""Explicit private task-session projection for the pinned native ADK flow."""

from __future__ import annotations

import json

from google.adk.events import Event
from google.adk.sessions import Session

from hushh_mcp.one_adk.drive_result_privacy import redact_drive_session_json
from hushh_mcp.one_adk.external_read_projection import durable_external_read_projection
from hushh_mcp.services.pod_scheduled_contracts import ScheduleRefused

_STATE = frozenset({"hussh:user_id", "hussh:conversation_id", "hussh:timezone"})
_EVENT = frozenset(
    {
        "invocation_id",
        "author",
        "id",
        "timestamp",
        "node_info",
        "long_running_tool_ids",
        "branch",
        "isolation_scope",
        "content",
        "partial",
        "turn_complete",
        "finish_reason",
        "interrupted",
        "actions",
    }
)
_ACTIONS = frozenset(
    {
        "skip_summarization",
        "state_delta",
        "transfer_to_agent",
        "escalate",
        "requested_tool_confirmations",
        "end_of_agent",
        "agent_state",
    }
)
_PART = frozenset({"text", "thought", "thought_signature", "function_call", "function_response"})


def _validate_event(event: Event, invocation: str) -> None:
    if event.invocation_id != invocation:
        raise ScheduleRefused("SCHEDULE_SESSION_INVOCATION_CHANGED")
    if event.actions.requested_auth_configs:
        raise ScheduleRefused("SCHEDULE_NATIVE_LOGIN_REQUIRES_OWNER")
    # These SDK controls carry arbitrary state or change history. Qualify a typed
    # adapter before using them in an unattended recoverable task.
    if event.output is not None or any(
        (
            event.actions.compaction,
            event.actions.render_ui_widgets,
            event.actions.set_model_response is not None,
            event.actions.artifact_delta,
            event.actions.rewind_before_invocation_id,
            event.actions.route is not None,
        )
    ):
        raise ScheduleRefused("SCHEDULE_CHECKPOINT_CONTROL_UNSUPPORTED")
    if event.actions.agent_state not in (None, {}):
        raise ScheduleRefused("SCHEDULE_CHECKPOINT_AGENT_STATE_UNSUPPORTED")
    for part in (event.content.parts or []) if event.content else []:
        if any(
            getattr(part, name) is not None for name in type(part).model_fields if name not in _PART
        ):
            raise ScheduleRefused("SCHEDULE_CHECKPOINT_MEDIA_UNSUPPORTED")
        if part.function_response and part.function_response.parts:
            raise ScheduleRefused("SCHEDULE_CHECKPOINT_MEDIA_UNSUPPORTED")
        if part.function_call and part.function_call.partial_args:
            raise ScheduleRefused("SCHEDULE_CHECKPOINT_PARTIAL_CALL_UNSUPPORTED")


def task_session_projection(session: Session, invocation: str) -> dict:
    projected = durable_external_read_projection(session).model_copy(deep=True)
    projected.state = {key: value for key, value in projected.state.items() if key in _STATE}
    for event in projected.events:
        _validate_event(event, invocation)
        event.actions.state_delta = {
            key: value for key, value in event.actions.state_delta.items() if key in _STATE
        }
    document = projected.model_dump(mode="json", by_alias=True, exclude={"events"})
    document["events"] = []
    for event in projected.events:
        value = event.model_dump(mode="json", by_alias=True, include=set(_EVENT))
        value["actions"] = event.actions.model_dump(
            mode="json", by_alias=True, include=set(_ACTIONS)
        )
        document["events"].append(value)
    try:
        result = json.loads(redact_drive_session_json(json.dumps(document, allow_nan=False)))
        if not isinstance(result, dict):
            raise ValueError
        return result
    except (ValueError, TypeError):
        raise ScheduleRefused("SCHEDULE_SESSION_CHECKPOINT_INVALID") from None


def pending_confirmations(document: dict, pending: dict, invocation: str) -> dict[str, str]:
    try:
        session = Session.model_validate(document)
    except (ValueError, TypeError):
        raise ScheduleRefused("SCHEDULE_SESSION_CHECKPOINT_INVALID") from None
    if any(event.invocation_id != invocation for event in session.events):
        raise ScheduleRefused("SCHEDULE_NATIVE_CONFIRMATION_CHANGED")
    confirmations: dict[str, str] = {}
    for handle, value in pending.items():
        if any(
            not isinstance(value.get(key), str) or not value[key]
            for key in ("call_id", "tool_name")
        ):
            raise ScheduleRefused("SCHEDULE_NATIVE_CONFIRMATION_CHANGED")
        direct, nested, marked, responses = [], [], [], []
        for event in session.events:
            for call in event.get_function_calls():
                if call.id == value["call_id"] and call.name == value["tool_name"]:
                    direct.append(event)
                original = (call.args or {}).get("originalFunctionCall")
                if (
                    call.name == "adk_request_confirmation"
                    and isinstance(original, dict)
                    and original.get("id") == value["call_id"]
                    and original.get("name") == value["tool_name"]
                ):
                    nested.append(event)
                    if not isinstance(call.id, str) or not call.id:
                        raise ScheduleRefused("SCHEDULE_NATIVE_CONFIRMATION_CHANGED")
                    confirmations[handle] = call.id
            matches = [
                response
                for response in event.get_function_responses()
                if response.id == value["call_id"] and response.name == value["tool_name"]
            ]
            responses.extend(matches)
            if matches and value["call_id"] in event.actions.requested_tool_confirmations:
                marked.append(event)
        if (
            len(direct) != 1
            or len(nested) != 1
            or len(marked) != 1
            or len(responses) != 1
            or any(event.invocation_id != invocation for event in direct + nested + marked)
        ):
            raise ScheduleRefused("SCHEDULE_NATIVE_CONFIRMATION_CHANGED")
    if not confirmations:
        raise ScheduleRefused("SCHEDULE_NATIVE_CONFIRMATION_MISSING")
    return confirmations
