"""The owner's own Gmail drafts: list them, open one, send one as it stands.

Gmail's native drafts API through the canonical receipts connection. No local
copy of a draft is kept: a list and an open are turn-local reads, and a send
leaves one metadata row in ``gmail_owner_send_actions`` (HMACs, counts and the
provider ids Gmail returned -- never an address, a subject or a body).

Token choice is the contract here, not a detail:

* A list or an open reads with the ``gmail.readonly`` grant
  (``get_read_access_token``). Reading never needs more.
* A send passes ``assert_send_ready`` first -- the owner's Send switch and the
  ``gmail.send`` grant, exactly as every other delivery path -- and then asks
  for the compose token. Gmail's ``users.drafts.send`` accepts ``gmail.compose``
  or ``gmail.modify`` and refuses ``gmail.send`` alone, so a connection that can
  send fresh mail but never allowed drafts is refused before any request rather
  than failing at Gmail with a 403 that would look like an outage.

Discarding a draft is not here: ``users.drafts.delete`` needs ``gmail.modify``,
a grant this product only asks for explicitly, and deleting by voice is a
separate owner decision.

Draft ids are provider identifiers. They are validated before any request,
never logged, and never handed to a model; callers hold them server side only.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from email.utils import getaddresses
from typing import Any

import httpx
from opentelemetry.instrumentation.utils import suppress_instrumentation

from db.connection import get_pool
from hushh_mcp.services.gmail_delivery_service import GmailDeliveryService
from hushh_mcp.services.gmail_message_text import MessageTextError, cap_utf8, message_text
from hushh_mcp.services.gmail_metadata_reader import _recipient_label, in_listing_order
from hushh_mcp.services.gmail_receipts_service import (
    GmailApiError,
    GmailReceiptsService,
    get_gmail_receipts_service,
)

logger = logging.getLogger(__name__)

_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"
_DRAFT_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,256}\Z")
_PROVIDER_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,256}\Z")
DRAFTS_LIST_MAX = 20
_METADATA_HEADERS = ["Subject", "From", "To", "Date"]
_LIST_FIELDS = "drafts(id,message(id,threadId)),nextPageToken"
_METADATA_FIELDS = "id,message(id,threadId,snippet,internalDate,payload/headers)"
_FULL_FIELDS = "id,message(id,threadId,internalDate,payload)"
# A listing or one metadata row is small; a full draft carries both MIME
# alternatives and every header. Anything larger is refused, never cut.
_LISTING_BUDGET_BYTES = 64 * 1024
_METADATA_BUDGET_BYTES = 64 * 1024
_DRAFT_RAW_MAX_BYTES = 256 * 1024
# Readable text handed to the owner's screen for one draft.
_DRAFT_BODY_BUDGET_BYTES = 32 * 1024
_SUBJECT_MAX_CHARS = 256
_SNIPPET_MAX_CHARS = 200
_MAX_RECIPIENTS = 50
_TIMEOUT = httpx.Timeout(20.0, connect=8.0)
# A whole list or open, fan-out included. A send has no such deadline: its
# ambiguity is handled per request, never by abandoning a POST mid-flight.
_READ_DEADLINE_SECONDS = 25.0
_DRAFT_SEND_KEY_PREFIX = "draft-send:"

DraftsFetch = Callable[[str], Awaitable[dict[str, Any]]]


def _error(code: str, message: str, status_code: int) -> GmailApiError:
    return GmailApiError(message, status_code=status_code, code=code)


def _retryable() -> GmailApiError:
    return _error("GMAIL_PROVIDER_RETRYABLE", "Gmail is temporarily unavailable.", 502)


def _invalid_response() -> GmailApiError:
    return _error("GMAIL_DRAFT_INVALID_RESPONSE", "Gmail returned an unreadable draft.", 502)


def _validate_draft_id(draft_id: Any) -> str:
    if not isinstance(draft_id, str) or not _DRAFT_ID_RE.fullmatch(draft_id):
        raise _error("INVALID_DRAFT_ID", "That draft can't be opened.", 400)
    return draft_id


def _one_line(value: Any, maximum: int) -> str:
    """Whitespace collapsed and bounded. Displayed as text, never interpreted."""
    raw = value if isinstance(value, str) else ""
    return " ".join(raw.split())[:maximum]


def _headers(message: dict[str, Any]) -> dict[str, str]:
    """The first value of each header, keyed lower-case."""
    payload = message.get("payload")
    raw = payload.get("headers") if isinstance(payload, dict) else None
    if raw is None:
        return {}
    if not isinstance(raw, list) or len(raw) > 512:
        raise _invalid_response()
    found: dict[str, str] = {}
    for header in raw:
        if not isinstance(header, dict):
            raise _invalid_response()
        name, value = header.get("name"), header.get("value")
        if not isinstance(name, str) or not isinstance(value, str):
            raise _invalid_response()
        found.setdefault(name.lower(), value)
    return found


def _addresses(value: str) -> list[str]:
    return [address for _name, address in getaddresses([value]) if address][:_MAX_RECIPIENTS]


def _updated_at(message: dict[str, Any]) -> str | None:
    stamp = message.get("internalDate")
    if not isinstance(stamp, str) or not stamp.isascii() or not stamp.isdigit() or len(stamp) > 15:
        return None
    return datetime.fromtimestamp(int(stamp) / 1000, tz=timezone.utc).isoformat()


def _draft_message(payload: dict[str, Any], draft_id: str) -> dict[str, Any]:
    """The draft's message, after checking the draft is the one asked for."""
    message = payload.get("message")
    if payload.get("id") != draft_id or not isinstance(message, dict):
        raise _invalid_response()
    message_id = message.get("id")
    if not isinstance(message_id, str) or not _PROVIDER_ID_RE.fullmatch(message_id):
        raise _invalid_response()
    return message


async def _current_account(gmail: GmailReceiptsService, user_id: str) -> str:
    row = await asyncio.to_thread(gmail._fetch_connection_row, user_id=user_id)
    account = str((row or {}).get("google_sub") or "")
    if not account:
        raise _error("GMAIL_NOT_CONNECTED", "Gmail is not connected for this user", 409)
    return account


def _require_account(current: str, expected: str) -> None:
    # Draft ids resolved in one mailbox mean nothing in another. A reconnect to
    # a different Google account refuses rather than reading or sending there.
    if expected and current != expected:
        raise _error(
            "GMAIL_ACCOUNT_CHANGED", "That draft belongs to a different Mail connection.", 409
        )


async def _get(
    client: httpx.AsyncClient,
    token: str,
    path: str,
    params: dict[str, Any],
    *,
    budget: int,
    too_large: GmailApiError | None = None,
) -> dict[str, Any]:
    # HTTPX URL spans would otherwise retain provider draft ids.
    with suppress_instrumentation():
        try:
            async with client.stream(
                "GET",
                _BASE + path,
                params=params,
                headers={"Authorization": f"Bearer {token}", "Accept-Encoding": "identity"},
            ) as response:
                if response.status_code in {401, 403}:
                    raise _error("GMAIL_PERMISSION_DENIED", "Gmail didn't allow that.", 403)
                if response.status_code == 404:
                    raise _error("GMAIL_DRAFT_NOT_FOUND", "That draft is no longer in Gmail.", 404)
                if response.status_code != 200:
                    raise _retryable()
                # Raw bytes are budgeted; a compressed body would escape that.
                if response.headers.get("content-encoding", "identity").lower() != "identity":
                    raise _invalid_response()
                content = bytearray()
                async for chunk in response.aiter_raw():
                    content.extend(chunk)
                    if len(content) > budget:
                        raise too_large or _invalid_response()
        except (TimeoutError, httpx.HTTPError):
            raise _retryable() from None
    try:
        payload = json.loads(content)
    except (ValueError, UnicodeError):
        raise _invalid_response() from None
    if not isinstance(payload, dict):
        raise _invalid_response()
    return payload


def _client(transport: httpx.AsyncBaseTransport | None) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=transport, timeout=_TIMEOUT, follow_redirects=False)


def _list_row(payload: dict[str, Any], draft_id: str) -> dict[str, Any]:
    message = _draft_message(payload, draft_id)
    headers = _headers(message)
    to_header = headers.get("to", "")
    thread_id = message.get("threadId")
    return {
        "draft_id": draft_id,
        "to_label": _recipient_label(to_header) if to_header.strip() else "Unknown recipient",
        "subject": _one_line(headers.get("subject"), _SUBJECT_MAX_CHARS),
        "snippet": _one_line(message.get("snippet"), _SNIPPET_MAX_CHARS),
        "updated_at_iso": _updated_at(message),
        "thread_id": thread_id if isinstance(thread_id, str) else None,
    }


async def list_gmail_drafts(
    *,
    user_id: str,
    max_results: int = DRAFTS_LIST_MAX,
    gmail: GmailReceiptsService | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """Up to twenty drafts in Gmail's listing order: headers and a snippet, no bodies.

    Returns ``{"account", "drafts": [...], "has_more"}``. ``account`` is the
    Google account the ids were listed in, so a caller can refuse to apply them
    to another one later.
    """
    service = gmail or get_gmail_receipts_service()
    limit = max(1, min(DRAFTS_LIST_MAX, int(max_results)))
    token = await service.get_read_access_token(user_id=user_id)
    account = await _current_account(service, user_id)
    try:
        async with asyncio.timeout(_READ_DEADLINE_SECONDS):
            listing, drafts = await _list_page(client_transport=transport, token=token, limit=limit)
    except TimeoutError:
        raise _retryable() from None
    return {
        "account": account,
        "drafts": drafts,
        "has_more": isinstance(listing.get("nextPageToken"), str),
    }


async def _list_page(
    *, client_transport: httpx.AsyncBaseTransport | None, token: str, limit: int
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    async with _client(client_transport) as client:
        listing = await _get(
            client,
            token,
            "/drafts",
            {"maxResults": limit, "fields": _LIST_FIELDS},
            budget=_LISTING_BUDGET_BYTES,
        )
        entries = listing.get("drafts", [])
        if not isinstance(entries, list) or len(entries) > limit:
            raise _invalid_response()
        ids: list[str] = []
        for entry in entries:
            draft_id = entry.get("id") if isinstance(entry, dict) else None
            if not isinstance(draft_id, str) or not _DRAFT_ID_RE.fullmatch(draft_id):
                raise _invalid_response()
            if draft_id not in ids:
                ids.append(draft_id)

        async def fetch(draft_id: str) -> dict[str, Any]:
            payload = await _get(
                client,
                token,
                f"/drafts/{draft_id}",
                {
                    "format": "metadata",
                    "metadataHeaders": _METADATA_HEADERS,
                    "fields": _METADATA_FIELDS,
                },
                budget=_METADATA_BUDGET_BYTES,
            )
            return _list_row(payload, draft_id)

        # Bounded fan-out; the first failure cancels the rest, so a draft that
        # could not be read is never shown as one that does not exist.
        drafts = await in_listing_order(ids, fetch)
    return listing, drafts


async def get_gmail_draft(
    *,
    user_id: str,
    draft_id: str,
    expect_account: str = "",
    gmail: GmailReceiptsService | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """One draft in full, for the owner's screen. Read with the readonly grant.

    ``message_id`` changes whenever the draft is edited in Gmail, so a caller can
    tell the draft the owner approved from the one Gmail holds now.
    """
    draft_id = _validate_draft_id(draft_id)
    service = gmail or get_gmail_receipts_service()
    token = await service.get_read_access_token(user_id=user_id)
    _require_account(await _current_account(service, user_id), expect_account)
    try:
        async with asyncio.timeout(_READ_DEADLINE_SECONDS), _client(transport) as client:
            payload = await _get(
                client,
                token,
                f"/drafts/{draft_id}",
                {"format": "full", "fields": _FULL_FIELDS},
                budget=_DRAFT_RAW_MAX_BYTES,
                too_large=_error(
                    "GMAIL_DRAFT_TOO_LARGE", "That draft is too large to open here.", 502
                ),
            )
    except TimeoutError:
        raise _retryable() from None
    message = _draft_message(payload, draft_id)
    headers = _headers(message)
    try:
        body = message_text(message.get("payload"))
    except MessageTextError:
        raise _error("DRAFT_UNREADABLE", "That draft can't be read here.", 502) from None
    body_text, truncated = cap_utf8(body, _DRAFT_BODY_BUDGET_BYTES)
    to_header = headers.get("to", "")
    to_list = _addresses(to_header)
    cc_list = _addresses(headers.get("cc", ""))
    # The owner's own Bcc, for their screen: a send reaches these people too.
    bcc_list = _addresses(headers.get("bcc", ""))
    thread_id = message.get("threadId")
    return {
        "draft_id": draft_id,
        "message_id": str(message["id"]),
        "thread_id": thread_id if isinstance(thread_id, str) else None,
        "to_label": _recipient_label(to_header) if to_header.strip() else "Unknown recipient",
        "to_list": to_list,
        "cc_list": cc_list,
        "bcc_list": bcc_list,
        "recipient_count": len(to_list) + len(cc_list) + len(bcc_list),
        "subject": _one_line(headers.get("subject"), _SUBJECT_MAX_CHARS),
        "body_text": body_text,
        "body_truncated": truncated,
        "updated_at_iso": _updated_at(message),
    }


async def assert_draft_send_ready(
    *, user_id: str, gmail: GmailReceiptsService | None = None
) -> str:
    """The send gate every delivery uses, then the grant drafts.send needs.

    Returns the access token, so a caller that goes on to send uses the token
    this check produced rather than a second, unchecked one.
    """
    service = gmail or get_gmail_receipts_service()
    await service.assert_send_ready(user_id=user_id)
    token: str = await service.get_compose_access_token(user_id=user_id)
    return token


async def _claim_send(
    *,
    delivery: GmailDeliveryService,
    user_id: str,
    account: str,
    draft_id: str,
    recipient_count: int,
) -> tuple[str, str | None]:
    """Record the attempt before Gmail is asked, so a second ask cannot resend.

    Returns ``(action_id, prior_state)``. ``prior_state`` is None for a fresh
    claim or a retry of a refused attempt (nothing was sent), and otherwise the
    state of the earlier attempt this one must not repeat.
    """
    envelope_hmac = delivery._hmac(f"{user_id}:{account}:{draft_id}", purpose="draft_send")
    idempotency_hmac = delivery._idempotency_hmac(_DRAFT_SEND_KEY_PREFIX + draft_id)
    count = max(1, min(_MAX_RECIPIENTS, recipient_count))
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            claimed = await conn.fetchrow(
                """
                INSERT INTO gmail_owner_send_actions (
                    action_id, user_id, envelope_hmac, idempotency_hmac,
                    recipient_count, state, expires_at, sending_at
                ) VALUES ($1, $2, $3, $4, $5, 'sending', NOW(), NOW())
                ON CONFLICT (user_id, idempotency_hmac) DO NOTHING
                RETURNING action_id
                """,
                str(uuid.uuid4()),
                user_id,
                envelope_hmac,
                idempotency_hmac,
                count,
            )
            if claimed is not None:
                return str(claimed["action_id"]), None
            existing = await conn.fetchrow(
                """
                SELECT action_id, state
                FROM gmail_owner_send_actions
                WHERE user_id = $1 AND idempotency_hmac = $2
                FOR UPDATE
                """,
                user_id,
                idempotency_hmac,
            )
            if existing is None:
                raise _retryable()
            action_id, state = str(existing["action_id"]), str(existing["state"])
            if state != "failed":
                return action_id, state
            # Gmail refused the earlier attempt, so nothing went out: the owner
            # may ask again, and this row records the new attempt.
            await conn.execute(
                """
                UPDATE gmail_owner_send_actions
                SET state = 'sending', sending_at = NOW(), safe_error_code = NULL,
                    recipient_count = $3, updated_at = NOW()
                WHERE action_id = $1 AND user_id = $2 AND state = 'failed'
                """,
                action_id,
                user_id,
                count,
            )
            return action_id, None


async def send_gmail_draft(
    *,
    user_id: str,
    draft_id: str,
    expect_account: str = "",
    recipient_count: int = 1,
    gmail: GmailReceiptsService | None = None,
    delivery: GmailDeliveryService | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """Send one existing draft as Gmail holds it. Returns ``{"state", "action_id"}``.

    ``state`` is ``sent``, ``outcome_unknown`` (this call asked Gmail and got no
    verdict) or ``previous_unconfirmed`` (an earlier call is in flight or ended
    without a verdict, so Gmail was not asked again). An unknown outcome is never
    retried here or by a later call: Gmail may have delivered it, and a second
    send would be a duplicate the owner never approved. A definite refusal --
    including a request that never left this host -- raises ``GmailApiError``
    and records that nothing was sent, so the owner may ask again.
    """
    draft_id = _validate_draft_id(draft_id)
    service = gmail or get_gmail_receipts_service()
    token = await assert_draft_send_ready(user_id=user_id, gmail=service)
    account = await _current_account(service, user_id)
    _require_account(account, expect_account)
    ledger = delivery or GmailDeliveryService(gmail_service=service)
    action_id, prior = await _claim_send(
        delivery=ledger,
        user_id=user_id,
        account=account,
        draft_id=draft_id,
        recipient_count=recipient_count,
    )
    if prior == "sent":
        raise _error("GMAIL_DRAFT_ALREADY_SENT", "That draft was already sent.", 409)
    if prior is not None:
        # An earlier attempt is in flight or ended without a verdict. Gmail is
        # not asked again, and the caller can say so rather than report this
        # turn's own ask as unconfirmed.
        return {"state": "previous_unconfirmed", "action_id": action_id}

    async def unknown(error_code: str) -> dict[str, Any]:
        await ledger._set_outcome_unknown(action_id=action_id, error_code=error_code)
        return {"state": "outcome_unknown", "action_id": action_id}

    try:
        with suppress_instrumentation():
            async with _client(transport) as client:
                response = await client.post(
                    f"{_BASE}/drafts/send",
                    headers={"Authorization": f"Bearer {token}"},
                    json={"id": draft_id},
                )
    except (httpx.ConnectError, httpx.ConnectTimeout):
        # No connection was made (a fresh client, so no pooled one), so the
        # request never left this host: nothing was sent. Before the timeout
        # clause below, because ConnectTimeout is also a TimeoutException.
        await ledger._set_terminal(
            action_id=action_id, state="failed", error_code="provider_connect"
        )
        logger.info("gmail.drafts.send_not_connected")
        raise _retryable() from None
    except (TimeoutError, httpx.TimeoutException):
        return await unknown("provider_timeout")
    except httpx.TransportError:
        # The POST may have reached Gmail before the connection failed.
        return await unknown("provider_transport")
    if response.status_code >= 500:
        return await unknown("provider_5xx")
    if response.status_code >= 400:
        # Gmail refused the request: nothing was sent.
        not_found = response.status_code == 404
        await ledger._set_terminal(
            action_id=action_id,
            state="failed",
            error_code="draft_not_found" if not_found else "draft_send_refused",
        )
        logger.info("gmail.drafts.send_refused status=%s", response.status_code)
        if not_found:
            raise _error("GMAIL_DRAFT_NOT_FOUND", "That draft was already sent or deleted.", 404)
        if response.status_code in {401, 403}:
            raise _error("GMAIL_PERMISSION_DENIED", "Gmail didn't allow that.", 403)
        raise _retryable()
    try:
        payload = response.json() if response.content else {}
    except ValueError:
        payload = {}
    message_id = payload.get("id") if isinstance(payload, dict) else None
    thread_id = payload.get("threadId") if isinstance(payload, dict) else None
    if not isinstance(message_id, str) or not _PROVIDER_ID_RE.fullmatch(message_id):
        return await unknown("missing_message_id")
    try:
        await ledger._set_terminal(
            action_id=action_id,
            state="sent",
            message_id=message_id,
            thread_id=thread_id if isinstance(thread_id, str) else None,
        )
    except Exception:  # noqa: BLE001 - delivered; the ledger must not claim otherwise
        return await unknown("terminal_persist_failed")
    return {"state": "sent", "action_id": action_id}


__all__ = [
    "DRAFTS_LIST_MAX",
    "assert_draft_send_ready",
    "get_gmail_draft",
    "list_gmail_drafts",
    "send_gmail_draft",
]
