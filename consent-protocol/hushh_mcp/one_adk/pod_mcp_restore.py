"""Recover existing native confirmations, never invent calls or replay effects."""

import json

from ag_ui.core import AssistantMessage, FunctionCall, ToolCall

from hushh_mcp.one_adk.drive_result_privacy import _confirmation_view
from hushh_mcp.one_adk.mcp_pending_call import private_pending_call_scope
from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError


async def pending_reviews(owner, session) -> list[dict]:
    """Fresh keyed projection outside transcript/history caches; original expiry remains."""
    pending = session.state.get("pending_tool_calls", [])
    remap = session.state.get("lro_tool_call_id_remap", {})
    if (
        not isinstance(pending, list)
        or not pending
        or len(pending) > 32
        or not isinstance(remap, dict)
        or len(remap) > 128
    ):
        return []
    answered = {
        response.id for event in session.events for response in event.get_function_responses()
    }
    calls = {
        call.id: call
        for event in session.events
        for call in event.get_function_calls()
        if call.name == "adk_request_confirmation" and call.id not in answered
    }
    result = []
    with private_pending_call_scope(owner.mcp_pending):
        for client_id in dict.fromkeys(pending):
            if not isinstance(client_id, str) or not 1 <= len(client_id) <= 256:
                continue
            call = calls.get(remap.get(client_id, client_id))
            if call is None or not isinstance(call.args, dict):
                continue
            view = _confirmation_view(call.args)
            if view is None:
                continue
            original = view.get("originalFunctionCall", {})
            if not original:
                continue
            try:
                found = await owner.mcp_pending.for_call(session, original["id"], original["name"])
            except ActionDirectiveAuthorityError:
                continue
            if found is None:
                continue
            handle, stored = found
            review = stored.get("review") or {}
            reference = {
                "kind": "mcp_call_review",
                "version": 1,
                "connectorId": review["connectorId"],
                "toolName": stored["tool_name"],
                "pendingHandle": handle,
                "directiveId": review["directiveId"],
                "expiresAt": review["expiresAt"],
            }
            view["toolConfirmation"]["payload"] = reference
            result.append({"interruptId": client_id, "reference": reference, "native": view})
    return result


async def restore_resume(owner, input):
    """Use only the pod's sealed native call when a cold browser resumes."""
    if not input.resume:
        return input
    session = await owner.sessions.get_session(
        app_name="hussh_one", user_id=owner.owner, session_id=input.thread_id
    )
    if session is None:
        raise ActionDirectiveAuthorityError("Private conversation unavailable.")
    reviews = {item["interruptId"]: item for item in await pending_reviews(owner, session)}
    requested = [entry.interrupt_id for entry in input.resume]
    if (
        not requested
        or len(set(requested)) != len(requested)
        or any(key not in reviews for key in requested)
    ):
        raise ActionDirectiveAuthorityError("Pending connector call changed or expired.")
    calls = [
        ToolCall(
            id=key,
            type="function",
            function=FunctionCall(
                name="adk_request_confirmation",
                arguments=json.dumps(reviews[key]["native"]),
            ),
        )
        for key in requested
    ]
    # No user messages are replayed. The SDK resumes its persisted invocation;
    # exact confirmation receipts remain required by the existing governed tool.
    return input.model_copy(
        update={
            "messages": [
                AssistantMessage(
                    id=f"recovered-{requested[0]}",
                    role="assistant",
                    tool_calls=calls,
                )
            ]
        }
    )
