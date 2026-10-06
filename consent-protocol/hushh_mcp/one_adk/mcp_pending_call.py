"""Pending-call recovery for native ADK confirmation, shared by every instance.

This is not approval or authority; the action ledger still authorizes every
dispatch. A review is issued by one request and decided by later ones, and the
backend runs as several instances, so the bounded arguments cannot live in one
process's memory: a different instance would find nothing and refuse a valid
approval. They are sealed with the owner's chat key, the key that already seals
the conversation, and kept in Postgres only until the review expires. Without
that key, or after expiry, nothing opens and the person is asked to review
again. An empty-argument replay is never possible.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets
from contextlib import asynccontextmanager
from contextvars import ContextVar
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from typing import Any

from google.adk.sessions import Session

from db.db_client import DatabaseExecutionError, get_db
from hushh_mcp.one_adk.request_secrets import resolve_request_secret
from hushh_mcp.services.action_directive_ledger import ActionDirectiveAuthorityError
from hushh_mcp.services.chat_key import (
    ChatCipher,
    ChatKeyMismatchError,
    ChatKeyUnavailableError,
    LegacyChatCiphertextError,
    chat_aad,
)

logger = logging.getLogger(__name__)

_CURRENT_HANDLE: ContextVar[str | None] = ContextVar("mcp_pending_handle", default=None)

_HANDLE_PREFIX = "one_secret_ref:"
_HANDLE_PATTERN = re.compile(r"one_secret_ref:[A-Za-z0-9_-]{32}")
# A review is useless once its directive has expired, so the record lives exactly as
# long. (A grace past the directive's expiry bought nothing: the ledger refuses an
# expired directive however long the record is kept.) The cap keeps a missing or
# far-future expiry bounded.
_MAX_LIFETIME = timedelta(minutes=20)
_EXPIRED = "Connector review expired. Review again."


def review_refusal(reason: str, message: str) -> ActionDirectiveAuthorityError:
    """Build the usual refusal and log why, so a bare 409 can be told apart.

    `reason` is a fixed code from this codebase, never derived from a handle,
    argument, token, email or provider text. The status, body and the checks
    that raise are unchanged; the code is only a log field and an attribute.
    """
    # Dotted, not snake_case: the log redactor masks any 24-128 character token of
    # letters, digits, `_` and `-` as a possible identifier, which would hide the very
    # reason this line exists to give. The attribute below keeps the code unchanged.
    logger.warning("one.mcp_review_refused reason=%s", reason.replace("_", "."))
    error = ActionDirectiveAuthorityError(message)
    error.reason = reason
    return error


class PendingCallStorageError(ActionDirectiveAuthorityError):
    """The pending call could not be sealed or stored; nothing was dispatched."""


def _aad(owner: str, thread: str, handle: str) -> str:
    binding: str = chat_aad("one_mcp_pending_calls", "payload", f"{owner}/{thread}/{handle}")
    return binding


def _expires_at(review: dict | None) -> datetime:
    now = datetime.now(timezone.utc)
    cap = now + _MAX_LIFETIME
    try:
        # A naive timestamp is rejected rather than read as local time.
        issued_until = datetime.fromisoformat(str((review or {}).get("expiresAt")))
        if issued_until.tzinfo is None:
            return cap
        return min(cap, issued_until)
    except ValueError:
        return cap


async def _execute(sql: str, params: dict[str, Any]):
    try:
        return await asyncio.to_thread(get_db().execute_raw, sql, params)
    except DatabaseExecutionError as exc:
        # The exception details can carry the SQL and every bound value.
        logger.error(
            "mcp_pending_call.storage_failed code=%s operation=%s",
            str(getattr(exc, "code", "DATABASE_EXECUTION_ERROR")).lower().replace("_", "."),
            getattr(exc, "operation", "unknown"),
        )
        raise PendingCallStorageError("Connector review is temporarily unavailable.") from None


async def discard_pending_call(*, owner: str, thread: str, handle: str) -> None:
    """Remove a record whose call has run. Best effort: it expires and is swept anyway."""
    if not isinstance(handle, str) or _HANDLE_PATTERN.fullmatch(handle) is None:
        return
    try:
        await _execute(
            """DELETE FROM one_mcp_pending_calls
               WHERE user_id = :user AND session_id = :session AND handle = :handle""",
            {"user": owner, "session": thread, "handle": handle},
        )
    except PendingCallStorageError:
        pass  # already logged with a code only


@asynccontextmanager
async def pending_resume_scope(approval_reference: Any):
    handle = None
    approval: Any = None
    if approval_reference:
        if not isinstance(approval_reference, str) or not approval_reference.startswith(
            _HANDLE_PREFIX
        ):
            raise review_refusal("approval_reference_invalid", _EXPIRED)
        try:
            approval = json.loads(resolve_request_secret(approval_reference))
        except (TypeError, ValueError):
            # Held in this request's memory only; absent means the request itself
            # lost it, never another instance (the pending call is shared storage).
            raise review_refusal("approval_reference_missing", _EXPIRED) from None
        if not isinstance(approval, dict):
            raise review_refusal("approval_reference_invalid", _EXPIRED)
        handle = approval.get("pendingHandle")
    owner = approval.get("owner") if approval_reference and isinstance(approval, dict) else None
    thread = approval.get("thread") if approval_reference and isinstance(approval, dict) else None
    token = _CURRENT_HANDLE.set(handle)
    try:
        yield
        # The resumed turn completed. Every session read inside it needed the record,
        # so it can only go now; a turn that failed or was cancelled leaves it to its
        # own expiry and the retention sweep.
        if handle and owner and thread:
            await discard_pending_call(owner=owner, thread=thread, handle=handle)
    finally:
        _CURRENT_HANDLE.reset(token)


async def restore_current_pending_call(session: Session) -> Session:
    handle = _CURRENT_HANDLE.get()
    return await restore_pending_call(session, handle) if handle else session


async def capture_pending_call(
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
    handle = _HANDLE_PREFIX + secrets.token_urlsafe(24)
    try:
        sealed = ChatCipher().seal(
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
            ),
            owner_id=owner,
            aad=_aad(owner, thread, handle),
        )
    except (ChatKeyUnavailableError, ChatKeyMismatchError):
        raise PendingCallStorageError("Unlock before reviewing a connector call.") from None
    # Purging this owner's lapsed rows rides on the insert: no scheduler to run
    # and no extra round trip.
    await _execute(
        """WITH purged AS (
             DELETE FROM one_mcp_pending_calls WHERE user_id = :user AND expires_at <= NOW()
             RETURNING 1)
           INSERT INTO one_mcp_pending_calls
             (user_id, session_id, handle, payload_ciphertext, payload_iv, payload_tag,
              payload_algorithm, expires_at)
           VALUES (:user, :session, :handle, :ciphertext, :iv, :tag, :algorithm,
                   CAST(:expires AS TIMESTAMPTZ))""",
        {
            "user": owner,
            "session": thread,
            "handle": handle,
            "ciphertext": sealed.ciphertext,
            "iv": sealed.iv,
            "tag": sealed.tag,
            "algorithm": sealed.algorithm,
            "expires": _expires_at(review).isoformat(),
        },
    )
    return handle


async def pending_call_details(session: Session, handle: str) -> dict:
    """Open a stored record under the authenticated session's identity."""
    if not isinstance(handle, str) or _HANDLE_PATTERN.fullmatch(handle) is None:
        raise review_refusal("pending_handle_invalid", _EXPIRED)
    result = await _execute(
        """SELECT payload_ciphertext, payload_iv, payload_tag
           FROM one_mcp_pending_calls
           WHERE user_id = :user AND session_id = :session AND handle = :handle
             AND expires_at > NOW()
           LIMIT 1""",
        {"user": session.user_id, "session": session.id, "handle": handle},
    )
    if not result.data:
        # Past its lifetime, or not this owner's or conversation's.
        raise review_refusal("pending_handle_missing", _EXPIRED)
    try:
        pending = json.loads(
            ChatCipher().open(
                dict(result.data[0]),
                "payload",
                owner_id=session.user_id,
                aad=_aad(session.user_id, session.id, handle),
            )
        )
    except ChatKeyUnavailableError:
        # A locked vault is not an expired review: let the chat-key refusal reach the
        # person ("unlock and try again") instead of telling them to start over.
        raise
    except (ChatKeyMismatchError, LegacyChatCiphertextError, ValueError):
        # A different key than the one that sealed it, or a record that does not open.
        raise review_refusal("pending_record_unreadable", _EXPIRED) from None
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
        raise review_refusal("binding_mismatch", "Connector review context changed.")
    return pending


async def restore_pending_call(session: Session, handle: str) -> Session:
    """Restore both ADK argument copies on a private live copy, not history.

    Identity is not authority: current schema/connection and one-use ledger
    checks remain mandatory inside the governed tool.
    """
    pending = await pending_call_details(session, handle)
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
        raise review_refusal(
            "pending_call_not_in_session", "Pending connector call changed. Review again."
        )
    # Never silently overwrite a different live call. Durable redaction uses
    # {}; already-restored copies must agree exactly with the captured request.
    arguments = pending["arguments"]
    if any(value not in ({}, arguments) for value in (direct[0].args, nested[0].get("args"))):
        raise review_refusal("pending_arguments_changed", "Pending connector arguments changed.")
    direct[0].args = deepcopy(arguments)
    nested[0]["args"] = deepcopy(arguments)
    return projected
