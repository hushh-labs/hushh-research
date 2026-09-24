"""Transient pending-call recovery for native ADK confirmation.

This is not approval or persistence. The existing request-secret store retains
bounded arguments briefly; the action ledger still authorizes every dispatch.
Lost process memory requires a fresh review, never an empty-argument replay.
"""

from __future__ import annotations

import json
import re
from contextlib import asynccontextmanager
from contextvars import ContextVar
from copy import deepcopy
from typing import Any

from google.adk.sessions import Session

from hushh_mcp.one_adk.request_secrets import resolve_request_secret, store_request_secret
from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError

_CURRENT_HANDLE: ContextVar[str | None] = ContextVar("mcp_pending_handle", default=None)


@asynccontextmanager
async def pending_resume_scope(approval_reference: Any):
    handle = None
    if approval_reference:
        if not isinstance(approval_reference, str) or not approval_reference.startswith(
            "one_secret_ref:"
        ):
            raise ActionDirectiveAuthorityError("Connector review expired. Review again.")
        try:
            approval = json.loads(resolve_request_secret(approval_reference))
        except (TypeError, ValueError):
            raise ActionDirectiveAuthorityError("Connector review expired. Review again.") from None
        if not isinstance(approval, dict):
            raise ActionDirectiveAuthorityError("Connector review expired. Review again.")
        handle = approval.get("pendingHandle")
    token = _CURRENT_HANDLE.set(handle)
    try:
        yield
    finally:
        _CURRENT_HANDLE.reset(token)


def restore_current_pending_call(session: Session) -> Session:
    handle = _CURRENT_HANDLE.get()
    return restore_pending_call(session, handle) if handle else session


def capture_pending_call(
    context: Any, *, tool_name: str, arguments: dict, review: dict | None = None
) -> str:
    owner = context.user_id
    thread = context.state.get("hussh:conversation_id")
    call_id = context.function_call_id
    if (
        not owner
        or owner != context.state.get("hussh:user_id")
        or not isinstance(thread, str)
        or not thread
        or not isinstance(call_id, str)
        or not call_id
        or len(call_id) > 256
        or not isinstance(tool_name, str)
        or re.fullmatch(r"mcp_[0-9a-f]{40}", tool_name) is None
        or not isinstance(arguments, dict)
    ):
        raise ActionDirectiveAuthorityError("Connector review context is unavailable.")
    try:
        encoded = json.dumps(arguments, allow_nan=False)
        if len(encoded.encode()) > 32_000:
            raise ValueError
    except (TypeError, ValueError):
        raise ActionDirectiveAuthorityError("Connector review arguments are invalid.") from None
    return store_request_secret(
        json.dumps(
            {
                "kind": "mcp_pending_call",
                "owner": owner,
                "thread": thread,
                "call_id": call_id,
                "tool_name": tool_name,
                "arguments": arguments,
                "review": review,
            }
        )
    )


def pending_call_details(session: Session, handle: str) -> dict:
    """Resolve a transient record under the authenticated session's identity."""
    if not isinstance(handle, str) or not handle.startswith("one_secret_ref:"):
        raise ActionDirectiveAuthorityError("Connector review expired. Review again.")
    try:
        pending = json.loads(resolve_request_secret(handle))
    except (TypeError, ValueError):
        raise ActionDirectiveAuthorityError("Connector review expired. Review again.") from None
    if (
        not isinstance(pending, dict)
        or pending.get("kind") != "mcp_pending_call"
        or pending.get("owner") != session.user_id
        or pending.get("thread") != session.id
        or session.app_name != "hussh_one"
        or not isinstance(pending.get("call_id"), str)
        or not isinstance(pending.get("tool_name"), str)
        or not isinstance(pending.get("arguments"), dict)
    ):
        raise ActionDirectiveAuthorityError("Connector review context changed.")
    return pending


def restore_pending_call(session: Session, handle: str) -> Session:
    """Restore both ADK argument copies on a private live copy, not history.

    Identity is not authority: current schema/connection and one-use ledger
    checks remain mandatory inside the governed tool.
    """
    pending = pending_call_details(session, handle)
    direct = []
    nested = []
    projected = session.model_copy(deep=True)
    for event in projected.events:
        for call in event.get_function_calls():
            if call.id == pending["call_id"] and call.name == pending["tool_name"]:
                direct.append(call)
            if call.name != "adk_request_confirmation" or not isinstance(call.args, dict):
                continue
            original = call.args.get("originalFunctionCall")
            if (
                isinstance(original, dict)
                and original.get("id") == pending["call_id"]
                and original.get("name") == pending["tool_name"]
            ):
                nested.append(original)
    if len(direct) != 1 or len(nested) != 1:
        raise ActionDirectiveAuthorityError("Pending connector call changed. Review again.")
    # Never silently overwrite a different live call. Durable redaction uses
    # {}; already-restored copies must agree exactly with the captured request.
    arguments = pending["arguments"]
    if any(value not in ({}, arguments) for value in (direct[0].args, nested[0].get("args"))):
        raise ActionDirectiveAuthorityError("Pending connector arguments changed.")
    direct[0].args = deepcopy(arguments)
    nested[0]["args"] = deepcopy(arguments)
    return projected
