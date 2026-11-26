"""Recover existing native confirmations, never invent calls or replay effects."""

import json
from dataclasses import dataclass
from typing import Any

from ag_ui.core import AssistantMessage, FunctionCall, ToolCall
from google.genai import types

from hushh_mcp.one_adk.drive_result_privacy import _confirmation_view
from hushh_mcp.one_adk.mcp_pending_call import private_pending_call_scope
from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError


@dataclass(frozen=True)
class PendingMcpReview:
    interrupt_id: str
    invocation_id: str
    confirmation_id: str
    reference: dict[str, Any]
    native: dict[str, Any]

    def confirmation_message(self, *, confirmed: bool) -> types.Content:
        """Build the ADK reply to this call. The action ledger still admits the effect."""
        if not self.invocation_id or not self.confirmation_id:
            raise ActionDirectiveAuthorityError("Native confirmation identity missing.")
        return types.Content(
            role="user",
            parts=[
                types.Part(
                    function_response=types.FunctionResponse(
                        id=self.confirmation_id,
                        name="adk_request_confirmation",
                        response={"confirmed": confirmed},
                    )
                )
            ],
        )


async def _pending_reviews(owner, session, *, use_native_ids: bool) -> list[PendingMcpReview]:
    pending = []
    remap = {}
    if not use_native_ids:
        pending = session.state.get("pending_tool_calls", [])
        remap = session.state.get("lro_tool_call_id_remap", {})
        if (
            not isinstance(pending, list)
            or not 0 < len(pending) <= 32
            or not isinstance(remap, dict)
            or len(remap) > 128
        ):
            return []
    answered = {
        response.id for event in session.events for response in event.get_function_responses()
    }
    calls = {
        call.id: (event.invocation_id, call)
        for event in session.events
        for call in event.get_function_calls()
        if call.name == "adk_request_confirmation" and call.id and call.id not in answered
    }
    if use_native_ids:
        if not 0 < len(calls) <= 32:
            return []
        pending = list(calls)
    result = []
    client_ids = dict.fromkeys(
        client_id
        for client_id in pending
        if isinstance(client_id, str) and 1 <= len(client_id) <= 256
    )
    with private_pending_call_scope(owner.mcp_pending):
        for client_id in client_ids:
            confirmation_id = remap.get(client_id, client_id)
            if not isinstance(confirmation_id, str):
                continue
            match = calls.get(confirmation_id)
            if match is None:
                continue
            invocation_id, call = match
            if not isinstance(call.args, dict):
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
            result.append(
                PendingMcpReview(client_id, invocation_id, confirmation_id, reference, view)
            )
    return result


async def pending_reviews(owner, session, *, use_native_ids: bool = False) -> list[dict]:
    """Return the existing read-only browser view without native resume authority."""
    return [
        {"interruptId": item.interrupt_id, "reference": item.reference, "native": item.native}
        for item in await _pending_reviews(owner, session, use_native_ids=use_native_ids)
    ]


async def resolve_pending_mcp_reviews(
    owner,
    conversation_id: str,
    requested: list[str],
    *,
    use_native_ids: bool = False,
) -> list[PendingMcpReview]:
    """Resolve continuation identities from the owner's sealed native session."""
    session = await owner.sessions.get_session(
        app_name="hussh_one", user_id=owner.owner, session_id=conversation_id
    )
    if session is None:
        raise ActionDirectiveAuthorityError("Private conversation unavailable.")
    reviews = {
        item.interrupt_id: item
        for item in await _pending_reviews(owner, session, use_native_ids=use_native_ids)
    }
    if (
        not requested
        or len(set(requested)) != len(requested)
        or any(key not in reviews for key in requested)
    ):
        raise ActionDirectiveAuthorityError("Pending connector call changed or expired.")
    return [reviews[key] for key in requested]


async def restore_resume(owner, input):
    """Use only the pod's sealed native call when a cold browser resumes."""
    if not input.resume:
        return input
    requested = [entry.interrupt_id for entry in input.resume]
    reviews = await resolve_pending_mcp_reviews(owner, input.thread_id, requested)
    calls = [
        ToolCall(
            id=review.interrupt_id,
            type="function",
            function=FunctionCall(
                name="adk_request_confirmation",
                arguments=json.dumps(review.native),
            ),
        )
        for review in reviews
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
