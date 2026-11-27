"""Direct Gmail REST API v1 tools for One's authenticated typed chat.

Mirrors the Calendar REST pattern (``hushh_mcp/agents/calendar/tools.py``):
typed ADK ``FunctionTool``s on ``agent_one`` so connected Mail turns run in
2 LLM calls with full chat history, ``Soul.md`` entity grounding, parallel
multi-query REST recall, transient in-RAM ``multilingual-e5-small`` re-ranking,
and zero plaintext inbox storage.

Credentials stay inside ``GmailReceiptsService``; provider message/thread IDs
stay in server-owned ``STATE_MAIL_READ_OFFER``; replies seal their routing
headers via ``gmail_reply_source_service`` so untrusted mail text can never
redirect a recipient.
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections import Counter
from datetime import datetime, timezone
from typing import Any

from google.adk.tools.tool_context import ToolContext

from hushh_mcp.adk_bridge.contract import SpecialistReadResult, SpecialistReadSource
from hushh_mcp.services import gmail_reply_source_service as reply_source_service
from hushh_mcp.services.email_delegated_read import (
    _ERRORS as _READ_ERRORS,
)
from hushh_mcp.services.email_delegated_read import (
    _epoch_date_terms,
    _owner_zone,
    current_mail_read_offer,
    make_mail_read_offer,
)
from hushh_mcp.services.gmail_delivery_service import GmailDeliveryError
from hushh_mcp.services.gmail_metadata_reader import (
    MAIL_READ_ERROR_CODES,
    MAX_BODY_MESSAGES,
    GmailMetadataError,
    GmailMetadataReader,
    Mailbox,
)
from hushh_mcp.services.gmail_receipt_scanner import (
    aggregate_receipt_scan,
    collapse_duplicate_deliveries,
    extract_receipt_record,
)
from hushh_mcp.services.gmail_receipts_service import (
    GmailApiError,
    GmailReceiptsService,
    get_gmail_receipts_service,
)
from hushh_mcp.services.gmail_sensitive_content import (
    normalize_sensitive_masking,
    redact_sensitive_mail_items,
)
from hushh_mcp.services.owner_time import (
    ScheduleTimeError,
    format_schedule_echo,
    resolve_send_at,
)

logger = logging.getLogger(__name__)

_STATE_CONVERSATION_ID = "hussh:conversation_id"
_STATE_TIMEZONE = "hussh:timezone"
_STATE_MAIL_READ_OFFER = "hussh:mail_read_offer"
_STATE_PENDING_DIRECTIVE = "hussh:pending_directive"

_ISO_DATE_RE = re.compile(r"^\d{4}[/-]\d{1,2}[/-]\d{1,2}$")
_VALID_MAILBOXES = frozenset({"inbox", "sent", "anywhere"})
_CLEAR_OFFER_STATUSES = frozenset(
    {"connect_required", "reconnect_required", "connection_changed", "source_changed"}
)


async def _admitted_owner(tool_context: ToolContext) -> tuple[str, str] | None:
    from hushh_mcp.one_adk.workspace_mcp_tools import _owner

    user_id = await _owner(tool_context, "gmail")
    if user_id is None:
        return None
    conversation_id = str(tool_context.state.get(_STATE_CONVERSATION_ID) or "").strip() or "chat"
    return user_id, conversation_id


def _make_require_access(tool_context: ToolContext, user_id: str):
    async def require_access() -> None:
        from hushh_mcp.one_adk.workspace_mcp_tools import _owner

        if await _owner(tool_context, "gmail") != user_id:
            raise PermissionError("Mail owner authority is unavailable")

    return require_access


def _loaded_embedding_client() -> Any | None:
    """Return the process-warmed multilingual-e5-small client ONLY if already loaded.

    Never triggers a cold HuggingFace download during a live chat turn.
    """
    try:
        from hushh_mcp.one_adk.action_retrieval import get_embedding_client

        client = get_embedding_client()
        return client if getattr(client, "is_loaded", False) else None
    except Exception:  # noqa: BLE001 - degrades cleanly to REST + lexical RRF
        return None


def _normalize_mailbox(raw: str, *, default: Mailbox = "anywhere") -> Mailbox:
    cleaned = str(raw or "").strip().lower()
    if cleaned in _VALID_MAILBOXES:
        return cleaned  # type: ignore[return-value]
    return default


def _pin_query(
    query: str,
    *,
    zone_name: str,
    after_date: str = "",
    before_date: str = "",
) -> str:
    """Apply owner-timezone epoch pinning so Gmail's PST default never skews local dates."""
    zone = _owner_zone(zone_name)
    parts: list[str] = []
    base = " ".join(str(query or "").split()).strip()
    if base:
        parts.append(base)
    cleaned_after = str(after_date or "").strip()
    if cleaned_after and _ISO_DATE_RE.fullmatch(cleaned_after):
        if "after:" not in base.lower() and "newer:" not in base.lower():
            parts.append(f"after:{cleaned_after.replace('-', '/')}")
    cleaned_before = str(before_date or "").strip()
    if cleaned_before and _ISO_DATE_RE.fullmatch(cleaned_before):
        if "before:" not in base.lower() and "older:" not in base.lower():
            parts.append(f"before:{cleaned_before.replace('-', '/')}")
    combined = " ".join(parts).strip()
    if not combined:
        return ""
    return _epoch_date_terms(combined, zone)


def _build_structured(
    *,
    status: str,
    items: list[dict[str, Any]],
    truncated: bool,
    metadata_only: bool,
) -> dict[str, Any]:
    sources: list[SpecialistReadSource] = []
    # Browser parseConnectorReadReceipt strictly enforces constant label="Mail"
    # and kind matching metadata_only across all structured sources; rich live
    # sender/subject metadata travels separately in live_sources (never durable).
    source_kind = "metadata" if metadata_only else "message"
    for item in items[:25]:
        ref = str(item.get("source_ref") or "").strip()
        if not ref:
            continue
        sources.append(
            SpecialistReadSource(
                source_ref=ref,
                label="Mail",
                kind=source_kind,
            )
        )
    mapped_status = status if status in MAIL_READ_ERROR_CODES or status == "ok" else "unavailable"
    return SpecialistReadResult(
        connector="mail",
        status=mapped_status,  # type: ignore[arg-type]
        sources=sources,
        truncated=bool(truncated),
        metadata_only=bool(metadata_only),
    ).model_dump(mode="json")


def _live_source_cards(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Bounded display metadata for the live turn's ConnectorReadReceipt UI.

    Durable session projection (``redacted_read_receipt``) drops this field
    before encrypting ``one_adk_sessions`` so provider metadata stays live-only.
    """
    cards: list[dict[str, Any]] = []
    for ordinal, item in enumerate(items[:15], 1):
        cards.append(
            {
                "ordinal": ordinal,
                "source_ref": str(item.get("source_ref") or f"mail:{ordinal}"),
                "sender": str(item.get("sender") or "Unknown sender")[:120],
                "subject": str(item.get("subject") or "(no subject)")[:180],
                "received_at": item.get("received_at"),
                "unread": bool(item.get("unread", False)),
                "has_body": "body" in item,
                "attachments": list(item.get("attachments") or [])[:4],
            }
        )
    return cards


def _remember_mail_offer(
    tool_context: ToolContext,
    *,
    reader: GmailMetadataReader,
    owner_id: str,
    conversation_id: str,
    mailbox: Mailbox,
    selected_ordinal: int | None = None,
) -> None:
    msg_ids = list(reader.offered_message_ids())
    thread_ids = list(reader.offered_thread_ids())
    if not msg_ids or not reader.account:
        return
    raw_offer: dict[str, Any] = {
        "account": reader.account,
        "mailbox": mailbox,
        "message_ids": msg_ids,
        "selected_ordinal": selected_ordinal,
    }
    if thread_ids and len(thread_ids) == len(msg_ids):
        raw_offer["thread_ids"] = thread_ids
    offer = make_mail_read_offer(raw_offer, owner_id=owner_id, conversation_id=conversation_id)
    if offer is not None:
        tool_context.state[_STATE_MAIL_READ_OFFER] = offer


def _emit_gmail_read_connect_directive(
    tool_context: ToolContext, *, is_reauth: bool = False
) -> None:
    if (
        tool_context.state.get("temp:one_execution_surface") == "typed_chat"
        and "hussh:pending_directive:gmail_mailbox" not in tool_context.state
    ):
        tool_context.state["hussh:pending_directive:gmail_mailbox"] = {
            "kind": "action",
            "delegateAgentId": "agent_email",
            "payload": {
                "type": "gmail.connect",
                "purpose": "read",
                "summary": (
                    "Reconnect Gmail to check your inbox."
                    if is_reauth
                    else "Connect Gmail to check your inbox."
                ),
                "confirmLabel": "Reconnect Gmail" if is_reauth else "Connect Gmail",
            },
        }


class _AdditionalHubGmailAccount(GmailReceiptsService):
    """Read-only Gmail adapter over an additional Google account grant (`gmail_read_enabled`)."""

    def __init__(self, *, account_id: str, account_email: str, scope_csv: str) -> None:
        super().__init__()
        self._account_id = account_id
        self._account_email = account_email
        self._scope_csv = scope_csv

    def is_configured(self) -> bool:
        return True

    def _fetch_connection_row(self, *, user_id: str) -> dict[str, Any] | None:
        del user_id
        return {
            "status": "connected",
            "revoked": False,
            "google_sub": f"additional:{self._account_id}",
            "google_email": self._account_email,
            "scope_csv": self._scope_csv or "https://www.googleapis.com/auth/gmail.readonly",
            "credential_id": f"additional:{self._account_id}",
            "generation": 1,
        }

    @staticmethod
    def _refresh_observation(row: dict[str, Any]) -> dict[str, Any]:
        return {
            "observed_credential_id": row.get("credential_id"),
            "observed_generation": "g1",
        }

    async def _ensure_access_token(
        self, *, user_id: str, force_refresh: bool = False
    ) -> tuple[str, dict[str, Any]]:
        from hushh_mcp.services.google_connection_service import (
            GoogleConnectionError,
            get_google_connection_service,
        )

        row = self._fetch_connection_row(user_id=user_id)
        if row is None:
            raise GmailMetadataError("connect_required")
        try:
            token = await get_google_connection_service().access_token(
                user_id=user_id,
                service="gmail",
                access_level="read",
                account_id=self._account_id,
                force_refresh=force_refresh,
            )
        except GoogleConnectionError as exc:
            if exc.status_code == 401:
                raise GmailMetadataError("reconnect_required") from None
            raise GmailMetadataError("connect_required") from None
        return token, row


async def _additional_gmail_accounts(user_id: str) -> list[dict[str, Any]]:
    try:
        from hushh_mcp.services.google_connection_service import get_google_connection_service

        status = await get_google_connection_service().calendar_accounts_status(
            user_id=user_id, include_pictures=False
        )
    except Exception:  # noqa: BLE001
        return []
    out: list[dict[str, Any]] = []
    for item in status.get("accounts", []):
        if (
            isinstance(item, dict)
            and item.get("account_id")
            and item.get("account_id") != "default"
            and item.get("connected") is True
            and item.get("gmail_read_enabled") is True
        ):
            out.append(item)
    return out


def _error_payload(code: str, tool_context: ToolContext) -> dict[str, Any]:
    if code in _CLEAR_OFFER_STATUSES:
        tool_context.state[_STATE_MAIL_READ_OFFER] = None
    mapped_status = code if code in MAIL_READ_ERROR_CODES else "unavailable"
    message = _READ_ERRORS.get(code, "I couldn't check your mail just now. Please try again.")
    payload: dict[str, Any] = {
        "status": mapped_status,
        "reason": code,
        "message": message,
        "structured": _build_structured(
            status=mapped_status,
            items=[],
            truncated=False,
            metadata_only=True,
        ),
    }
    if mapped_status in {"connect_required", "reconnect_required"}:
        _emit_gmail_read_connect_directive(
            tool_context, is_reauth=(mapped_status == "reconnect_required")
        )
        payload["next_step"] = (
            "The app is showing a Gmail permission control. Ask the person to approve it."
        )
    return payload


def resolve_owner_gmail_address(user_id: str) -> str | None:
    """Return the owner's connected Gmail address (for explicit to_self drafts), or None."""
    cleaned = str(user_id or "").strip()
    if not cleaned:
        return None
    try:
        row = get_gmail_receipts_service()._fetch_connection_row(user_id=cleaned)
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(row, dict):
        return None
    if row.get("status") != "connected" or row.get("revoked") is not False:
        return None
    addr = str(row.get("google_email") or "").strip()
    return addr if "@" in addr else None


async def gmail_search_mail(
    intent: str,
    tool_context: ToolContext,
    queries: list[str] | None = None,
    mailbox: str = "anywhere",
    after_date: str = "",
    before_date: str = "",
    limit: int = 12,
    read_top_bodies: int = 3,
    include_spam: bool = False,
    sensitive_masking: str = "none",
) -> dict[str, Any]:
    """Search or list the owner's Gmail directly over REST with hybrid semantic re-ranking.

    Use this directly (never call list_app_actions first) for mail lookups:
    recent emails, unread mail, sent mail, searching by sender/topic/concept,
    finding a specific ticket/PNR/OTP/confirmation email, or summarizing what
    recent emails say. Spending, receipts, invoices, and bills still use One's
    receipt functions unless the person explicitly asks for emails mentioning a
    receipt or invoice.

    Args:
        intent: Natural-language description of what the owner is looking for
            (used for in-RAM multilingual semantic re-ranking of candidates).
        queries: Optional list of 1 to 3 complementary Gmail REST ``q`` strings
            run in parallel and fused via RRF:
            - query 1: high-precision operators (e.g. ``from:ravi subject:contract``
              or names resolved from ``CONSENTED TURN INFORMATION``)
            - query 2: ``OR`` synonym net (e.g. ``(flight OR PNR OR IndiGo OR boarding)``)
            - query 3: broad recent-window recall fallback (e.g.
              ``in:inbox category:primary newer_than:14d``) for conceptual
              questions like "any investor replies?" or "anything urgent?"
            Leave empty (``[]``) to fetch the newest mail in ``mailbox``.
        mailbox: ``"anywhere"`` (default for search, covers archived/sent/inbox),
            ``"inbox"`` (for recent/unread inbox checks), or ``"sent"``.
        after_date: Optional inclusive local start date ``YYYY-MM-DD`` pinned
            to owner timezone midnight (avoids Gmail's Pacific Time bug).
        before_date: Optional exclusive local end date ``YYYY-MM-DD``.
        limit: Number of ranked messages to return (1 to 25, default 12).
        read_top_bodies: Number of top-ranked messages whose full sanitized
            body text is returned immediately in this call (0 to 5, default 3).
        include_spam: Set True ONLY when the owner explicitly asks to check
            their Spam folder (metadata-only; bodies are never hydrated from Spam).
        sensitive_masking: Pass ``"otp"`` when searching for verification/OTP
            codes or ``"credentials"`` when checking password/security emails so
            sensitive codes are masked before entering chat history and shown
            via a 1-tap ephemeral reveal card.
    """
    owner = await _admitted_owner(tool_context)
    if owner is None:
        return {"status": "unavailable", "message": "Mail chat reads are not available here."}
    user_id, conversation_id = owner
    tz_name = str(tool_context.state.get(_STATE_TIMEZONE) or "UTC").strip() or "UTC"
    target_mailbox = _normalize_mailbox(mailbox, default="inbox" if not queries else "anywhere")
    bounded_limit = limit if type(limit) is int and 1 <= limit <= 25 else 12
    bounded_bodies = (
        read_top_bodies
        if type(read_top_bodies) is int and 0 <= read_top_bodies <= MAX_BODY_MESSAGES
        else 3
    )

    pinned_queries: list[str] = []
    raw_queries = queries if isinstance(queries, list) else []
    try:
        for raw_q in raw_queries[:3]:
            if not isinstance(raw_q, str):
                continue
            pinned = _pin_query(
                raw_q,
                zone_name=tz_name,
                after_date=after_date,
                before_date=before_date,
            )
            if pinned and pinned not in pinned_queries:
                pinned_queries.append(pinned)
        if not pinned_queries and (after_date or before_date):
            date_only = _pin_query(
                "", zone_name=tz_name, after_date=after_date, before_date=before_date
            )
            if date_only:
                pinned_queries.append(date_only)
    except GmailMetadataError as exc:
        return _error_payload(exc.code, tool_context)

    primary_svc = get_gmail_receipts_service()
    reader = GmailMetadataReader(
        gmail=primary_svc,
        user_id=user_id,
        require_access=_make_require_access(tool_context, user_id),
        timezone_name=tz_name,
    )
    extra_accounts = await _additional_gmail_accounts(user_id)
    primary_error_code: str | None = None
    try:
        result = await reader.search_hybrid(
            intent=str(intent or "").strip()[:500],
            queries=tuple(pinned_queries),
            mailbox=target_mailbox,
            limit=bounded_limit,
            read_top_bodies=bounded_bodies,
            include_spam=bool(include_spam),
            embedding_client=_loaded_embedding_client(),
        )
    except GmailMetadataError as exc:
        if not extra_accounts:
            return _error_payload(exc.code, tool_context)
        primary_error_code = exc.code
        result = {"untrusted_external_content": [], "coverage": {}}
    except GmailApiError as exc:
        code = "connect_required" if exc.code == "GMAIL_NOT_CONNECTED" else "reconnect_required"
        if not extra_accounts:
            return _error_payload(code, tool_context)
        primary_error_code = code
        result = {"untrusted_external_content": [], "coverage": {}}
    except PermissionError:
        return {"status": "unavailable", "message": "Mail chat reads are not available here."}
    except Exception:  # noqa: BLE001 - provider errors never leak into transcript
        logger.exception("one_adk.gmail_search_mail_failed reason=unexpected")
        if not extra_accounts:
            return _error_payload("retryable", tool_context)
        primary_error_code = "retryable"
        result = {"untrusted_external_content": [], "coverage": {}}

    items = list(result.get("untrusted_external_content") or [])
    if items and extra_accounts:
        try:
            primary_email = str(
                (primary_svc.get_status(user_id=user_id) or {}).get("google_email") or ""
            ).strip()
        except Exception:
            primary_email = ""
        if primary_email:
            for item in items:
                if isinstance(item, dict) and "account_email" not in item:
                    item["account_email"] = primary_email

    if extra_accounts:
        extra_tasks = []
        for acct in extra_accounts:
            acct_email = str(acct.get("google_email") or "").strip()
            acct_reader = GmailMetadataReader(
                gmail=_AdditionalHubGmailAccount(
                    account_id=str(acct["account_id"]),
                    account_email=acct_email,
                    scope_csv=str(acct.get("scope_csv") or ""),
                ),
                user_id=user_id,
                require_access=_make_require_access(tool_context, user_id),
                timezone_name=tz_name,
            )
            extra_tasks.append((acct_email, acct_reader))

        extra_results = await asyncio.gather(
            *(
                r.search_hybrid(
                    intent=str(intent or "").strip()[:500],
                    queries=tuple(pinned_queries),
                    mailbox=target_mailbox,
                    limit=bounded_limit,
                    read_top_bodies=bounded_bodies,
                    embedding_client=_loaded_embedding_client(),
                )
                for _, r in extra_tasks
            ),
            return_exceptions=True,
        )
        any_extra_succeeded = False
        for (acct_email, _), extra_res in zip(extra_tasks, extra_results, strict=True):
            if isinstance(extra_res, dict):
                any_extra_succeeded = True
                for item in extra_res.get("untrusted_external_content") or []:
                    if isinstance(item, dict):
                        tagged = dict(item)
                        if acct_email:
                            tagged["account_email"] = acct_email
                        items.append(tagged)
        if primary_error_code and not any_extra_succeeded:
            return _error_payload(primary_error_code, tool_context)
        if len(items) > bounded_limit:
            items.sort(key=lambda x: int(x.get("internal_date_ms") or 0), reverse=True)
            items = items[:bounded_limit]
    raw_items = items
    if not raw_items:
        return {
            "status": "no_match",
            "mailbox": target_mailbox,
            "items": [],
            "coverage": result.get("coverage", {}),
            "recovery_hint": (
                "No emails matched those Gmail queries. You may broaden keywords with OR "
                "synonyms, drop strict sender/date filters, switch mailbox to 'anywhere', "
                "or include a recent-window query like 'newer_than:30d' and retry once."
            ),
            "structured": _build_structured(
                status="ok",
                items=[],
                truncated=False,
                metadata_only=True,
            ),
        }

    items, reveal_experience, _ = redact_sensitive_mail_items(
        raw_items,
        owner_user_id=user_id,
        conversation_id=conversation_id,
        sensitive_masking=normalize_sensitive_masking(sensitive_masking),
    )

    _remember_mail_offer(
        tool_context,
        reader=reader,
        owner_id=user_id,
        conversation_id=conversation_id,
        mailbox=target_mailbox,
    )
    response_payload: dict[str, Any] = {
        "status": "ok",
        "mailbox": target_mailbox,
        "semantic_reranked": bool(result.get("semantic_reranked")),
        "untrusted_external_content": items,
        "coverage": result.get("coverage", {}),
        "live_sources": _live_source_cards(items),
        "structured": _build_structured(
            status="ok",
            items=items,
            truncated=bool(result.get("truncated")),
            metadata_only=bool(result.get("metadata_only")),
        ),
    }
    if reveal_experience is not None:
        response_payload["sensitive_code_reveal"] = reveal_experience
    return response_payload


async def gmail_read_thread(
    tool_context: ToolContext,
    ordinals: list[int] | None = None,
    query: str = "",
    whole_thread: bool = True,
    mailbox: str = "anywhere",
    limit: int = 2,
    include_headers: bool = False,
    sensitive_masking: str = "none",
) -> dict[str, Any]:
    """Read full chronological email thread(s) or specific offered messages.

    Use ``ordinals`` (e.g. ``[2]`` for "the second one" or ``mail:2``) whenever
    referring to messages already returned in this conversation — the server
    resolves exact provider IDs securely from ``STATE_MAIL_READ_OFFER``.
    Use ``query`` when starting a direct thread read without a prior list.
    Pass ``include_headers=True`` to inspect full email metadata, attachment
    sizes/MIME types, ``List-Unsubscribe``, SPF/DKIM/DMARC authentication,
    Reply-To/Return-Path fraud checks, and TLS/S-MIME encryption headers.
    """
    owner = await _admitted_owner(tool_context)
    if owner is None:
        return {"status": "unavailable", "message": "Mail chat reads are not available here."}
    user_id, conversation_id = owner
    tz_name = str(tool_context.state.get(_STATE_TIMEZONE) or "UTC").strip() or "UTC"
    target_mailbox = _normalize_mailbox(mailbox, default="anywhere")
    bounded_limit = limit if type(limit) is int and 1 <= limit <= MAX_BODY_MESSAGES else 2

    clean_ordinals: list[int] = []
    if isinstance(ordinals, list):
        for value in ordinals[:MAX_BODY_MESSAGES]:
            if type(value) is int and 1 <= value <= 25 and value not in clean_ordinals:
                clean_ordinals.append(value)

    if clean_ordinals:
        offer = current_mail_read_offer(
            tool_context.state.get(_STATE_MAIL_READ_OFFER),
            owner_id=user_id,
            conversation_id=conversation_id,
        )
        if offer is None:
            return {
                "status": "source_changed",
                "message": (
                    "That previous mail list expired or is no longer active. "
                    "Search mail again first."
                ),
            }
        resolved_threads: list[str] = []
        resolved_messages: list[str] = []
        for ordinal in clean_ordinals:
            msg_id = offer.message_id_at(ordinal)
            if not msg_id:
                return {
                    "status": "invalid_argument",
                    "message": (
                        f"Only {len(offer.message_ids)} email(s) were shown. "
                        "Choose a position from that list."
                    ),
                }
            if msg_id not in resolved_messages:
                resolved_messages.append(msg_id)
            tid = offer.thread_id_at(ordinal)
            if tid and tid not in resolved_threads:
                resolved_threads.append(tid)

        reader = GmailMetadataReader(
            gmail=get_gmail_receipts_service(),
            user_id=user_id,
            require_access=_make_require_access(tool_context, user_id),
            expect_account=offer.account,
            timezone_name=tz_name,
        )
        try:
            use_threads = bool(whole_thread and resolved_threads and len(resolved_threads) > 0)
            result = await reader.read_threads(
                thread_ids=tuple(resolved_threads) if use_threads else (),
                message_ids=() if use_threads else tuple(resolved_messages),
                mailbox=offer.mailbox,
                whole_thread=bool(whole_thread),
                include_headers=bool(include_headers),
            )
        except GmailMetadataError as exc:
            return _error_payload(exc.code, tool_context)
        except GmailApiError as exc:
            code = "connect_required" if exc.code == "GMAIL_NOT_CONNECTED" else "reconnect_required"
            return _error_payload(code, tool_context)
        except PermissionError:
            return {"status": "unavailable", "message": "Mail chat reads are not available here."}
        except Exception:  # noqa: BLE001
            logger.exception("one_adk.gmail_read_thread_failed reason=unexpected")
            return _error_payload("retryable", tool_context)

        raw_items = list(result.get("untrusted_external_content") or [])
        items, reveal_experience, _ = redact_sensitive_mail_items(
            raw_items,
            owner_user_id=user_id,
            conversation_id=conversation_id,
            sensitive_masking=normalize_sensitive_masking(sensitive_masking),
        )
        _remember_mail_offer(
            tool_context,
            reader=reader,
            owner_id=user_id,
            conversation_id=conversation_id,
            mailbox=offer.mailbox,
            selected_ordinal=clean_ordinals[0] if len(clean_ordinals) == 1 else None,
        )
        out_payload: dict[str, Any] = {
            "status": "ok",
            "mailbox": offer.mailbox,
            "untrusted_external_content": items,
            "coverage": result.get("coverage", {}),
            "live_sources": _live_source_cards(items),
            "structured": _build_structured(
                status="ok",
                items=items,
                truncated=bool(result.get("truncated")),
                metadata_only=False,
            ),
        }
        if reveal_experience is not None:
            out_payload["sensitive_code_reveal"] = reveal_experience
        return out_payload

    cleaned_query = str(query or "").strip()
    try:
        pinned = _pin_query(cleaned_query, zone_name=tz_name) if cleaned_query else ""
    except GmailMetadataError as exc:
        return _error_payload(exc.code, tool_context)

    search_reader = GmailMetadataReader(
        gmail=get_gmail_receipts_service(),
        user_id=user_id,
        require_access=_make_require_access(tool_context, user_id),
        timezone_name=tz_name,
    )
    try:
        located = await search_reader.search_hybrid(
            intent=cleaned_query[:500],
            queries=(pinned,) if pinned else (),
            mailbox=target_mailbox if pinned else "inbox",
            limit=bounded_limit,
            read_top_bodies=0,
            max_candidates=15,
            embedding_client=_loaded_embedding_client(),
        )
    except GmailMetadataError as exc:
        return _error_payload(exc.code, tool_context)
    except GmailApiError as exc:
        code = "connect_required" if exc.code == "GMAIL_NOT_CONNECTED" else "reconnect_required"
        return _error_payload(code, tool_context)
    except PermissionError:
        return {"status": "unavailable", "message": "Mail chat reads are not available here."}
    except Exception:  # noqa: BLE001
        logger.exception("one_adk.gmail_read_thread_search_failed reason=unexpected")
        return _error_payload("retryable", tool_context)

    located_threads = list(dict.fromkeys(search_reader.offered_thread_ids()))[:bounded_limit]
    located_msgs = list(search_reader.offered_message_ids())[:bounded_limit]
    if not located_msgs:
        return {
            "status": "no_match",
            "mailbox": target_mailbox,
            "items": [],
            "coverage": located.get("coverage", {}),
            "recovery_hint": (
                "No email threads matched that query. Try gmail_search_mail with broader OR "
                "keywords or a recent time window."
            ),
            "structured": _build_structured(
                status="ok", items=[], truncated=False, metadata_only=True
            ),
        }

    thread_reader = GmailMetadataReader(
        gmail=get_gmail_receipts_service(),
        user_id=user_id,
        require_access=_make_require_access(tool_context, user_id),
        expect_account=search_reader.account,
        timezone_name=tz_name,
    )
    try:
        use_threads = bool(whole_thread and located_threads)
        result = await thread_reader.read_threads(
            thread_ids=tuple(located_threads) if use_threads else (),
            message_ids=() if use_threads else tuple(located_msgs),
            mailbox=target_mailbox if pinned else "inbox",
            whole_thread=bool(whole_thread),
            include_headers=bool(include_headers),
        )
    except GmailMetadataError as exc:
        return _error_payload(exc.code, tool_context)
    except Exception:  # noqa: BLE001
        logger.exception("one_adk.gmail_read_thread_hydrate_failed reason=unexpected")
        return _error_payload("retryable", tool_context)

    raw_items = list(result.get("untrusted_external_content") or [])
    items, reveal_experience, _ = redact_sensitive_mail_items(
        raw_items,
        owner_user_id=user_id,
        conversation_id=conversation_id,
        sensitive_masking=normalize_sensitive_masking(sensitive_masking),
    )
    _remember_mail_offer(
        tool_context,
        reader=thread_reader,
        owner_id=user_id,
        conversation_id=conversation_id,
        mailbox=target_mailbox if pinned else "inbox",
    )
    out_payload = {
        "status": "ok",
        "mailbox": target_mailbox if pinned else "inbox",
        "untrusted_external_content": items,
        "coverage": result.get("coverage", {}),
        "live_sources": _live_source_cards(items),
        "structured": _build_structured(
            status="ok",
            items=items,
            truncated=bool(result.get("truncated")),
            metadata_only=False,
        ),
    }
    if reveal_experience is not None:
        out_payload["sensitive_code_reveal"] = reveal_experience
    return out_payload


_DEFAULT_RECEIPT_QUERY = (
    "(receipt OR invoice OR bill OR payment OR paid OR refund OR order OR "
    "transaction OR charged OR debited OR subscription OR booking OR statement) "
    "-in:spam -in:trash"
)
_INVOICE_FOCUSED_QUERY = (
    '(invoice OR bill OR "amount due" OR "payment due" OR overdue OR unpaid OR '
    '"balance due" OR "pay now" OR "payment failed" OR statement) -in:spam -in:trash'
)
_ORDER_FOCUSED_QUERY = (
    "(order OR shipped OR delivered OR tracking OR purchase OR receipt OR refund OR booking) "
    "-in:spam -in:trash"
)


async def gmail_scan_receipts(
    tool_context: ToolContext,
    query: str = "",
    focus: str = "all",
    merchant: str = "",
    after_date: str = "",
    before_date: str = "",
    newer_than: str = "",
    max_pages: int = 6,
    max_messages: int = 250,
    only_with_attachments: bool = False,
) -> dict[str, Any]:
    """Auto-paginating multi-page Gmail REST scanner for receipts, invoices & spend.

    Automatically scans multiple pages (up to 6 pages / 250 matching messages) in
    one turn without stopping at page 1 or asking the user to paginate manually.
    Computes exact currency-separated Decimal totals server-side, separates paid
    spend vs refunds vs pending/unpaid invoices vs inward credits, collapses
    duplicate notifications, groups by merchant/month/category, and never exposes
    raw provider message IDs.

    Args:
        query: Optional custom Gmail filter terms (leave empty for comprehensive
            receipt/invoice/bill/payment/order/refund coverage).
        focus: ``"all"`` (default — receipts + invoices + spending + refunds),
            ``"invoices"`` (pending/due/paid invoices & bills), or ``"orders"``.
        merchant: Optional merchant/sender filter (e.g. ``"Amazon"``, ``"Uber"``).
        after_date: Inclusive owner-local start date ``YYYY-MM-DD``.
        before_date: Exclusive owner-local end date ``YYYY-MM-DD``.
        newer_than: Optional Gmail relative window such as ``"30d"``, ``"6m"``,
            ``"1y"``, ``"7d"`` (ignored if ``after_date`` is provided).
        max_pages: Maximum Gmail pages to auto-fetch (1 to 8, default 6).
        max_messages: Maximum matching messages to scan (10 to 300, default 250).
        only_with_attachments: Set True only if user asked exclusively for
            receipts/invoices with attachments (e.g. PDFs).
    """
    owner = await _admitted_owner(tool_context)
    if owner is None:
        return {"status": "unavailable", "message": "Mail chat reads are not available here."}
    user_id, conversation_id = owner
    tz_name = str(tool_context.state.get(_STATE_TIMEZONE) or "UTC").strip() or "UTC"

    base_parts: list[str] = []
    cleaned_q = str(query or "").strip()
    if cleaned_q:
        base_parts.append(cleaned_q)
    else:
        f = str(focus or "all").strip().lower()
        if f == "invoices":
            base_parts.append(_INVOICE_FOCUSED_QUERY)
        elif f == "orders":
            base_parts.append(_ORDER_FOCUSED_QUERY)
        else:
            base_parts.append(_DEFAULT_RECEIPT_QUERY)

    cleaned_merchant = str(merchant or "").strip()
    if cleaned_merchant:
        safe_m = cleaned_merchant.replace('"', "").strip()
        if " " in safe_m:
            base_parts.append(f'"{safe_m}"')
        else:
            base_parts.append(safe_m)

    if only_with_attachments:
        base_parts.append("has:attachment")

    cleaned_newer = str(newer_than or "").strip()
    if (
        cleaned_newer
        and not after_date
        and re.fullmatch(r"\d{1,3}[dmy]", cleaned_newer, re.IGNORECASE)
    ):
        base_parts.append(f"newer_than:{cleaned_newer.lower()}")

    try:
        pinned_query = _pin_query(
            " ".join(base_parts),
            zone_name=tz_name,
            after_date=after_date,
            before_date=before_date,
        )
    except GmailMetadataError as exc:
        return _error_payload(exc.code, tool_context)

    def needs_hydration(item: dict[str, Any]) -> bool:
        probe = extract_receipt_record(item, ordinal=1, timezone_name=tz_name)
        return bool(probe and probe.get("needs_body_hydration"))

    reader = GmailMetadataReader(
        gmail=get_gmail_receipts_service(),
        user_id=user_id,
        require_access=_make_require_access(tool_context, user_id),
        timezone_name=tz_name,
    )
    try:
        scanned = await reader.scan_messages_multipage(
            query=pinned_query,
            mailbox="anywhere",
            max_pages=max_pages,
            max_messages=max_messages,
            hydrate_selector=needs_hydration,
            max_body_hydrations=35,
        )
    except GmailMetadataError as exc:
        return _error_payload(exc.code, tool_context)
    except GmailApiError as exc:
        code = "connect_required" if exc.code == "GMAIL_NOT_CONNECTED" else "reconnect_required"
        return _error_payload(code, tool_context)
    except PermissionError:
        return {"status": "unavailable", "message": "Mail chat reads are not available here."}
    except Exception:  # noqa: BLE001
        logger.exception("one_adk.gmail_scan_receipts_failed reason=unexpected")
        return _error_payload("retryable", tool_context)

    raw_messages = list(scanned.get("messages") or [])
    raw_msg_ids = list(scanned.get("message_ids") or [])
    raw_thread_ids = list(scanned.get("thread_ids") or [])

    # Collapse duplicate alias/mailing-list deliveries before extracting receipts
    kept_idx, delivery_dups = collapse_duplicate_deliveries(raw_messages)
    dedup_msgs = [raw_messages[i] for i in kept_idx]
    dedup_mids = [raw_msg_ids[i] for i in kept_idx] if len(raw_msg_ids) == len(raw_messages) else []
    dedup_tids = (
        [raw_thread_ids[i] for i in kept_idx] if len(raw_thread_ids) == len(raw_messages) else []
    )

    extracted_records: list[dict[str, Any]] = []
    matched_mids: list[str] = []
    matched_tids: list[str] = []
    for idx, msg in enumerate(dedup_msgs):
        ordinal = len(extracted_records) + 1
        rec = extract_receipt_record(msg, ordinal=ordinal, timezone_name=tz_name)
        if rec is None:
            continue
        extracted_records.append(rec)
        if idx < len(dedup_mids):
            matched_mids.append(dedup_mids[idx])
        if idx < len(dedup_tids):
            matched_tids.append(dedup_tids[idx])

    # Re-pin the offer to the matched receipt/invoice emails (top 25) so user can
    # immediately say "read #2", "open PDF on #4", "forward #1", or "label #1..5 Receipts".
    if matched_mids:
        reader._offered_message_ids = tuple(matched_mids[:25])
        reader._offered_thread_ids = tuple(matched_tids[:25])
        _remember_mail_offer(
            tool_context,
            reader=reader,
            owner_id=user_id,
            conversation_id=conversation_id,
            mailbox="anywhere",
        )

    summary = aggregate_receipt_scan(extracted_records)
    # Keep tool output comfortably bounded while preserving exact server-computed totals
    compact_items = [
        {
            k: v
            for k, v in item.items()
            if k not in {"needs_body_hydration", "amount_quote"} and v not in (None, [], "")
        }
        for item in summary["items"][:60]
    ]
    live_cards = _live_source_cards(
        [
            {
                "subject": r.get("subject") or "",
                "sender": r.get("merchant") or r.get("sender") or "",
                "received_at": r.get("received_at"),
                "unread": False,
                "attachments": [
                    a["filename"] if isinstance(a, dict) else str(a)
                    for a in (r.get("attachments") or [])
                ],
            }
            for r in summary["items"][:12]
        ]
    )
    all_scanned = bool(scanned.get("all_matches_scanned"))
    return {
        "status": "ok" if extracted_records else "no_match",
        "owner_timezone": tz_name,
        "scan_coverage": {
            "pages_scanned": scanned.get("pages_scanned", 0),
            "messages_scanned": scanned.get("loaded_count", 0),
            "messages_listed": scanned.get("listed_count", 0),
            "failed_to_load": scanned.get("failed_count", 0),
            "estimated_total_matches": scanned.get("estimated_total", 0),
            "all_matches_scanned": all_scanned,
            "has_more_pages": bool(scanned.get("has_more_pages")),
            "bodies_hydrated": scanned.get("bodies_hydrated", 0),
            "duplicate_deliveries_collapsed": delivery_dups,
        },
        "totals_by_currency": summary["totals_by_currency"],
        "counts": {
            "receipts_and_refunds": summary["receipt_count"],
            "paid": summary["paid_count"],
            "refunds": summary["refund_count"],
            "pending_invoices": summary["pending_invoice_count"],
            "inward_credits_excluded": summary["inward_credit_count"],
            "duplicate_transactions_collapsed": summary["duplicate_transactions_collapsed"],
            "shown_items": len(compact_items),
            "total_financial_items": len(summary["items"]),
        },
        "pending_invoices": summary["pending_invoices"],
        "inward_credits_excluded": summary["inward_credits"],
        "by_merchant": summary["by_merchant"],
        "by_month": summary["by_month"],
        "by_category": summary["by_category"],
        "duplicates": summary["duplicates"],
        "unresolved_pdf_attachments": summary["unresolved_attachments"],
        "items": compact_items,
        "live_sources": live_cards,
        "structured": _build_structured(
            status="ok",
            items=[
                {
                    "subject": r.get("subject") or "",
                    "sender": r.get("merchant") or r.get("sender") or "",
                    "received_at": r.get("received_at"),
                }
                for r in summary["items"][:12]
            ],
            truncated=not all_scanned,
            metadata_only=scanned.get("bodies_hydrated", 0) == 0,
        ),
    }


async def gmail_read_attachment(
    ordinal: int,
    tool_context: ToolContext,
    filename: str = "",
    attachment_index: int = 1,
) -> dict[str, Any]:
    """Scan and parse a PDF or CSV attachment on an email already shown in this chat.

    Uses the server-side ``STATE_MAIL_READ_OFFER`` ordinal (never raw provider
    IDs), scans bytes via ClamAV, and extracts text via the isolated parser.
    """
    owner = await _admitted_owner(tool_context)
    if owner is None:
        return {"status": "unavailable", "message": "Mail attachment reads are not available here."}
    user_id, conversation_id = owner
    if type(ordinal) is not int or not 1 <= ordinal <= 25:
        return {
            "status": "invalid_argument",
            "message": "Choose the email position (1..25) from the latest list shown in this chat.",
        }
    offer = current_mail_read_offer(
        tool_context.state.get(_STATE_MAIL_READ_OFFER),
        owner_id=user_id,
        conversation_id=conversation_id,
    )
    if offer is None:
        return {
            "status": "source_changed",
            "message": "That email list expired. Search for the email again first.",
        }
    message_id = offer.message_id_at(ordinal)
    if not message_id:
        return {
            "status": "invalid_argument",
            "message": f"Only {len(offer.message_ids)} email(s) were shown.",
        }

    reader = GmailMetadataReader(
        gmail=get_gmail_receipts_service(),
        user_id=user_id,
        require_access=_make_require_access(tool_context, user_id),
        expect_account=offer.account,
    )
    try:
        downloaded = await reader.get_attachment_bytes(
            message_id=message_id,
            filename=str(filename or "").strip(),
            attachment_index=attachment_index if type(attachment_index) is int else 1,
        )
    except GmailMetadataError as exc:
        return _error_payload(exc.code, tool_context)
    except Exception:  # noqa: BLE001
        logger.exception("one_adk.gmail_read_attachment_download_failed reason=unexpected")
        return _error_payload("retryable", tool_context)

    if downloaded.get("status") != "ok":
        return downloaded

    mime = str(downloaded.get("mime_type") or "").lower()
    fname = str(downloaded.get("filename") or "")
    if mime == "application/octet-stream":
        if fname.lower().endswith(".pdf"):
            mime = "application/pdf"
        elif fname.lower().endswith(".csv"):
            mime = "text/csv"
    if mime not in {"application/pdf", "text/csv", "application/csv"}:
        return {
            "status": "unsupported",
            "filename": fname,
            "mime_type": mime,
            "size_bytes": downloaded.get("size_bytes"),
            "message": "Only PDF and CSV attachments can be read directly right now.",
            "attachments": downloaded.get("attachments", []),
        }

    content = downloaded["content"]
    parse_mime = "text/csv" if mime == "application/csv" else mime
    try:
        async with asyncio.timeout(15):
            from hushh_mcp.services.mail_attachment_parser import parse_mail_attachment

            parsed = await parse_mail_attachment(content, parse_mime)
    except TimeoutError:
        return {
            "status": "unresolved",
            "filename": fname,
            "message": "Attachment parsing timed out.",
        }
    except Exception:  # noqa: BLE001
        logger.exception("one_adk.gmail_read_attachment_parse_failed reason=unexpected")
        return {
            "status": "unresolved",
            "filename": fname,
            "message": "This PDF/CSV could not be parsed cleanly (it may be scanned, encrypted, or malformed).",
        }

    text = "\n\n".join(getattr(parsed, "pages", []) or [])
    truncated = bool(getattr(parsed, "truncated", False) or len(text) > 16000)
    return {
        "status": "ok",
        "source_ref": f"mail:{ordinal}",
        "filename": fname,
        "mime_type": mime,
        "size_bytes": downloaded.get("size_bytes"),
        "text": text[:16000],
        "truncated": truncated,
        "attachments": downloaded.get("attachments", []),
        "structured": _build_structured(
            status="ok",
            items=[{"subject": fname, "sender": "Attachment", "received_at": None}],
            truncated=truncated,
            metadata_only=False,
        ),
    }


async def gmail_mailbox_insights(
    tool_context: ToolContext,
    mode: str = "status",
    start_history_id: str = "",
    newer_than: str = "30d",
    limit: int = 20,
) -> dict[str, Any]:
    """Instant Gmail connection status, sync history, unreplied sent & sender stats.

    Modes:
    - ``"status"``: Exact connection state, connected email, granted permissions
      (Read, Send, Drafts/Compose, Organize/Modify, Settings), watch status,
      plus live mailbox profile totals & current ``historyId``.
    - ``"counts"``: Exact unread counts (total unread messages/threads, inbox
      unread messages/threads, and unread messages received today in the
      owner's local timezone).
    - ``"history"``: Current ``historyId`` and (when ``start_history_id`` is
      provided or saved) incremental mailbox changes (``messagesAdded``,
      ``messagesDeleted``, ``labelsAdded``, ``labelsRemoved``).
    - ``"unreplied_sent"``: Recent emails the owner sent that have no reply yet
      from the recipient ("who hasn't replied to me?").
    - ``"sender_stats"``: Top senders, storage/size estimate, and detected
      newsletters/subscriptions (via ``List-Unsubscribe`` header) over recent mail.
    """
    owner = await _admitted_owner(tool_context)
    if owner is None:
        return {"status": "unavailable", "message": "Mail insights are not available here."}
    user_id, conversation_id = owner
    tz_name = str(tool_context.state.get(_STATE_TIMEZONE) or "UTC").strip() or "UTC"
    cleaned_mode = str(mode or "status").strip().lower()
    gmail = get_gmail_receipts_service()

    if cleaned_mode == "counts":
        reader = GmailMetadataReader(
            gmail=gmail,
            user_id=user_id,
            require_access=_make_require_access(tool_context, user_id),
            timezone_name=tz_name,
        )
        try:
            counts = await reader.mailbox_counts()
        except GmailMetadataError as exc:
            return _error_payload(exc.code, tool_context)
        except GmailApiError as exc:
            code = "connect_required" if exc.code == "GMAIL_NOT_CONNECTED" else "reconnect_required"
            return _error_payload(code, tool_context)
        except PermissionError:
            return {"status": "unavailable", "message": "Mail insights are not available here."}
        except Exception:  # noqa: BLE001
            logger.exception("one_adk.gmail_mailbox_insights_counts_failed")
            return _error_payload("retryable", tool_context)
        return {
            **counts,
            "mode": "counts",
            "structured": _build_structured(
                status="ok",
                items=[],
                truncated=False,
                metadata_only=True,
            ),
        }

    if cleaned_mode == "status":
        try:
            status_payload = await gmail.get_status(user_id=user_id)
        except Exception:  # noqa: BLE001
            logger.exception("one_adk.gmail_mailbox_insights_status_failed")
            return _error_payload("retryable", tool_context)
        connected = status_payload.get("connected") is True
        extra_accounts = await _additional_gmail_accounts(user_id)
        connected_accounts: list[dict[str, Any]] = []
        if connected:
            connected_accounts.append(
                {
                    "account_id": "default",
                    "google_email": status_payload.get("google_email"),
                    "primary": True,
                }
            )
        for acct in extra_accounts:
            connected_accounts.append(
                {
                    "account_id": acct.get("account_id"),
                    "google_email": acct.get("google_email"),
                    "primary": False,
                }
            )
        any_connected = connected or bool(extra_accounts)
        if not any_connected:
            _emit_gmail_read_connect_directive(
                tool_context,
                is_reauth=(status_payload.get("connection_state") == "needs_reauth"),
            )
        out: dict[str, Any] = {
            "status": "ok",
            "mode": "status",
            "connected": any_connected,
            "connection_state": status_payload.get("connection_state"),
            "google_email": status_payload.get("google_email")
            if connected
            else (extra_accounts[0].get("google_email") if extra_accounts else None),
            "accounts": connected_accounts,
            "permissions": {
                "read": any_connected,
                "send": bool(status_payload.get("send_permission_granted")),
                "compose_drafts": bool(status_payload.get("compose_permission_granted")),
                "modify_organize": bool(status_payload.get("modify_permission_granted")),
                "settings_filters_signatures_vacation": bool(
                    status_payload.get("settings_permission_granted")
                ),
            },
            "watch": {
                "status": status_payload.get("watch_status"),
                "expires_at": status_payload.get("watch_expires_at"),
            },
            "last_sync_at": status_payload.get("last_sync_at"),
            "last_sync_status": status_payload.get("last_sync_status"),
        }
        if connected:
            try:
                reader = GmailMetadataReader(
                    gmail=gmail,
                    user_id=user_id,
                    require_access=_make_require_access(tool_context, user_id),
                    timezone_name=tz_name,
                )
                profile = await reader.get_profile_and_history()
                out["profile"] = {
                    "messages_total": profile.get("messages_total"),
                    "threads_total": profile.get("threads_total"),
                    "history_id": profile.get("history_id"),
                }
            except Exception:  # noqa: BLE001
                pass
        return out

    if cleaned_mode == "history":
        reader = GmailMetadataReader(
            gmail=gmail,
            user_id=user_id,
            require_access=_make_require_access(tool_context, user_id),
            timezone_name=tz_name,
        )
        try:
            status_payload = await gmail.get_status(user_id=user_id)
            hist = await reader.get_profile_and_history(
                start_history_id=str(start_history_id or "").strip() or None,
                max_results=max(1, min(int(limit), 100)),
            )
        except GmailMetadataError as exc:
            return _error_payload(exc.code, tool_context)
        except Exception:  # noqa: BLE001
            logger.exception("one_adk.gmail_mailbox_insights_history_failed")
            return _error_payload("retryable", tool_context)
        hist["mode"] = "history"
        hist["last_sync_at"] = status_payload.get("last_sync_at")
        hist["watch_status"] = status_payload.get("watch_status")
        hist["watch_expires_at"] = status_payload.get("watch_expires_at")
        return hist

    if cleaned_mode == "unreplied_sent":
        window = str(newer_than or "30d").strip().lower()
        if not re.fullmatch(r"\d{1,3}[dmy]", window):
            window = "30d"
        reader = GmailMetadataReader(
            gmail=gmail,
            user_id=user_id,
            require_access=_make_require_access(tool_context, user_id),
            timezone_name=tz_name,
        )
        try:
            scanned = await reader.scan_messages_multipage(
                query=f"in:sent newer_than:{window} -in:drafts",
                mailbox="sent",
                max_pages=2,
                max_messages=60,
                max_body_hydrations=0,
            )
        except GmailMetadataError as exc:
            return _error_payload(exc.code, tool_context)
        except Exception:  # noqa: BLE001
            return _error_payload("retryable", tool_context)

        # Group by thread: a single-message thread in Sent has no reply yet
        msgs = list(scanned.get("messages") or [])
        tids = list(scanned.get("thread_ids") or [])
        mids = list(scanned.get("message_ids") or [])
        thread_counts = Counter(tids)
        unreplied: list[dict[str, Any]] = []
        offer_mids: list[str] = []
        offer_tids: list[str] = []
        bounded = max(1, min(int(limit), 20))
        for msg, mid, tid in zip(msgs, mids, tids, strict=False):
            if thread_counts[tid] == 1 and len(unreplied) < bounded:
                offer_mids.append(mid)
                offer_tids.append(tid)
                unreplied.append(
                    {
                        "source_ref": f"mail:{len(unreplied) + 1}",
                        "recipient": msg.get("recipient") or "Unknown recipient",
                        "subject": msg.get("subject"),
                        "sent_at_local": msg.get("received_at_local") or msg.get("received_at"),
                        "snippet": msg.get("snippet", ""),
                    }
                )
        if offer_mids:
            reader._offered_message_ids = tuple(offer_mids)
            reader._offered_thread_ids = tuple(offer_tids)
            _remember_mail_offer(
                tool_context,
                reader=reader,
                owner_id=user_id,
                conversation_id=conversation_id,
                mailbox="sent",
            )
        return {
            "status": "ok",
            "mode": "unreplied_sent",
            "window": window,
            "sent_checked": len(msgs),
            "unreplied_count": len(unreplied),
            "items": unreplied,
            "structured": _build_structured(
                status="ok",
                items=[
                    {
                        "subject": u["subject"],
                        "sender": u["recipient"],
                        "received_at": u["sent_at_local"],
                    }
                    for u in unreplied[:10]
                ],
                truncated=bool(scanned.get("has_more_pages")),
                metadata_only=True,
            ),
        }

    # Default / "sender_stats": top senders, newsletters & size breakdown
    window = str(newer_than or "30d").strip().lower()
    if not re.fullmatch(r"\d{1,3}[dmy]", window):
        window = "30d"
    reader = GmailMetadataReader(
        gmail=gmail,
        user_id=user_id,
        require_access=_make_require_access(tool_context, user_id),
        timezone_name=tz_name,
    )
    try:
        scanned = await reader.scan_messages_multipage(
            query=f"newer_than:{window} -in:spam -in:trash",
            mailbox="anywhere",
            max_pages=3,
            max_messages=150,
            max_body_hydrations=0,
        )
    except GmailMetadataError as exc:
        return _error_payload(exc.code, tool_context)
    except Exception:  # noqa: BLE001
        return _error_payload("retryable", tool_context)

    msgs = list(scanned.get("messages") or [])
    sender_counts: Counter[str] = Counter()
    sender_bytes: Counter[str] = Counter()
    newsletter_counts: Counter[str] = Counter()
    unread_count = 0
    total_bytes = 0
    for msg in msgs:
        s = str(msg.get("sender") or "Unknown sender")
        sz = int(msg.get("size_bytes") or 0)
        sender_counts[s] += 1
        sender_bytes[s] += sz
        total_bytes += sz
        if msg.get("unread"):
            unread_count += 1
        if msg.get("has_list_unsubscribe"):
            newsletter_counts[s] += 1

    return {
        "status": "ok",
        "mode": "sender_stats",
        "window": window,
        "messages_analyzed": len(msgs),
        "unread_in_window": unread_count,
        "total_size_mb": round(total_bytes / (1024 * 1024), 2),
        "has_more_pages": bool(scanned.get("has_more_pages")),
        "top_senders": [
            {
                "sender": s,
                "count": c,
                "size_mb": round(sender_bytes[s] / (1024 * 1024), 2),
            }
            for s, c in sender_counts.most_common(15)
        ],
        "newsletters_detected": [
            {"sender": s, "count": c} for s, c in newsletter_counts.most_common(15)
        ],
        "structured": _build_structured(
            status="ok", items=[], truncated=bool(scanned.get("has_more_pages")), metadata_only=True
        ),
    }


async def gmail_list_needs_reply(
    tool_context: ToolContext,
    limit: int = 10,
    min_age_days: int = 0,
) -> dict[str, Any]:
    """List recent inbound Gmail conversations that likely need the owner's reply.

    This is a bounded heuristic over recent primary inbox threads (not proof of
    obligation). Pass ``min_age_days`` (e.g. ``3``) to filter to threads waiting
    at least that many days. Mints ``STATE_MAIL_READ_OFFER`` so the owner can
    immediately say "read the second one" or "reply to the first one".
    """
    owner = await _admitted_owner(tool_context)
    if owner is None:
        return {"status": "unavailable", "message": "Mail chat reads are not available here."}
    user_id, conversation_id = owner
    tz_name = str(tool_context.state.get(_STATE_TIMEZONE) or "UTC").strip() or "UTC"
    bounded_limit = limit if type(limit) is int and 1 <= limit <= 25 else 10
    bounded_age = min_age_days if type(min_age_days) is int and 0 <= min_age_days <= 30 else 0

    reader = GmailMetadataReader(
        gmail=get_gmail_receipts_service(),
        user_id=user_id,
        require_access=_make_require_access(tool_context, user_id),
        timezone_name=tz_name,
    )
    read_args: dict[str, Any] = {"limit": bounded_limit, "mailbox": "inbox"}
    if bounded_age > 0:
        read_args["min_age_days"] = bounded_age
    try:
        result = await reader.read("list_needs_reply", read_args)
    except GmailMetadataError as exc:
        return _error_payload(exc.code, tool_context)
    except GmailApiError as exc:
        code = "connect_required" if exc.code == "GMAIL_NOT_CONNECTED" else "reconnect_required"
        return _error_payload(code, tool_context)
    except PermissionError:
        return {"status": "unavailable", "message": "Mail chat reads are not available here."}
    except Exception:  # noqa: BLE001
        logger.exception("one_adk.gmail_list_needs_reply_failed reason=unexpected")
        return _error_payload("retryable", tool_context)

    items = list(result.get("untrusted_external_content") or [])
    _remember_mail_offer(
        tool_context,
        reader=reader,
        owner_id=user_id,
        conversation_id=conversation_id,
        mailbox="inbox",
    )
    return {
        "status": "ok",
        "mailbox": "inbox",
        "untrusted_external_content": items,
        "coverage": result.get("coverage", {}),
        "live_sources": _live_source_cards(items),
        "structured": _build_structured(
            status="ok",
            items=items,
            truncated=bool(result.get("truncated")),
            metadata_only=True,
        ),
    }


async def open_gmail_reply_draft(
    ordinal: int,
    body: str,
    tool_context: ToolContext,
    reply_all: bool = False,
    follow_up: bool = False,
    primary_action: str = "send",
    scheduled_send_at: str = "",
) -> dict[str, Any]:
    """Open a source-bound editable reply, reply-all, or Sent follow-up draft to an email shown in chat.

    Security boundary: accepts ONLY ``ordinal`` (1-based position from the
    latest Mail list/read in this conversation), ``body``, ``reply_all``,
    ``follow_up``, ``primary_action`` (``"send"`` | ``"save_draft"`` |
    ``"schedule"``), and optional ``scheduled_send_at`` (owner local ISO-8601).
    Recipient (``Reply-To`` / ``From``, or ``To`` when ``follow_up=True`` on a
    Sent email), Reply-All ``Cc``, ``Re:`` subject, ``threadId``,
    ``In-Reply-To``, and ``References`` are re-read and cryptographically sealed
    server-side via ``gmail_reply_source_service`` so untrusted email text can
    NEVER retarget a reply to another address. Nothing sends until the owner
    taps Send, Save draft, or Schedule.
    """
    owner = await _admitted_owner(tool_context)
    if owner is None:
        return {"status": "unavailable", "message": "Mail replies are available in chat only."}
    user_id, conversation_id = owner
    tz_name = str(tool_context.state.get(_STATE_TIMEZONE) or "UTC").strip() or "UTC"
    if type(ordinal) is not int or not 1 <= ordinal <= 25:
        return {
            "status": "invalid_argument",
            "message": "Choose the email's position from the list shown in this chat.",
        }
    draft_body = str(body or "").strip()
    if not draft_body:
        return {"status": "missing_reply", "message": "Write the reply message before opening it."}
    if len(draft_body) > 12_000:
        return {
            "status": "invalid_reply",
            "message": "Keep the reply within the supported size and try again.",
        }

    action_mode = str(primary_action or "send").strip().lower()
    if action_mode not in {"send", "save_draft", "schedule"}:
        action_mode = "send"
    cleaned_schedule = str(scheduled_send_at or "").strip()
    scheduled_iso = ""
    scheduled_display = ""
    if cleaned_schedule:
        now_utc = datetime.now(timezone.utc)
        try:
            send_at_utc = resolve_send_at(cleaned_schedule, owner_zone=tz_name, now=now_utc)
        except ScheduleTimeError as exc:
            return {"status": "invalid_schedule_time", "message": exc.message}
        scheduled_iso = send_at_utc.isoformat()
        scheduled_display = format_schedule_echo(send_at_utc, tz_name, now=now_utc)
        action_mode = "schedule"

    offer = current_mail_read_offer(
        tool_context.state.get(_STATE_MAIL_READ_OFFER),
        owner_id=user_id,
        conversation_id=conversation_id,
    )
    if offer is None:
        return {
            "status": "source_changed",
            "message": "That email list expired. Search for the email again before replying.",
        }
    message_id = offer.message_id_at(ordinal)
    if not message_id:
        return {
            "status": "invalid_argument",
            "message": (
                f"Only {len(offer.message_ids)} email(s) were shown. "
                "Pick one from that list to reply to."
            ),
        }

    reply_mode: reply_source_service.ReplyMode = (
        "reply_all" if reply_all else ("follow_up" if follow_up else "reply")
    )
    try:
        try:
            source = await reply_source_service.read_reply_source(
                gmail=get_gmail_receipts_service(),
                user_id=user_id,
                message_id=message_id,
                expected_account=offer.account,
                require_access=_make_require_access(tool_context, user_id),
                mode=reply_mode,
            )
        except GmailDeliveryError as first_exc:
            if reply_mode == "reply" and first_exc.code == reply_source_service.TARGET_IS_OWNER:
                source = await reply_source_service.read_reply_source(
                    gmail=get_gmail_receipts_service(),
                    user_id=user_id,
                    message_id=message_id,
                    expected_account=offer.account,
                    require_access=_make_require_access(tool_context, user_id),
                    mode="follow_up",
                )
                reply_mode = "follow_up"
            else:
                raise
        sealed_ref = reply_source_service.seal_reply_source_ref(
            source,
            owner_user_id=user_id,
            surface="typed_chat",
        )
    except GmailDeliveryError as exc:
        return {
            "status": "unavailable",
            "code": exc.code,
            "message": exc.message,
        }
    except Exception:  # noqa: BLE001
        logger.exception("one_adk.open_gmail_reply_draft_failed reason=unexpected")
        return {
            "status": "unavailable",
            "message": "I couldn't verify that email's reply details just now. Try again.",
        }

    cc_list = list(source.cc_list[:20])
    payload: dict[str, Any] = {
        "kind": "gmail_reply_draft",
        "source_mail_ref": sealed_ref,
    }
    if cc_list:
        payload["cc"] = ", ".join(cc_list)
    if action_mode != "send":
        payload["primary_action"] = action_mode
    if scheduled_iso:
        payload["scheduled_send_at"] = scheduled_iso
        payload["scheduled_send_display"] = scheduled_display
    tool_context.state[f"{_STATE_PENDING_DIRECTIVE}:gmail_reply_draft"] = {
        "kind": "prompt",
        "payload": payload,
    }
    mode_label = (
        "reply-all"
        if reply_mode == "reply_all"
        else ("follow-up" if reply_mode == "follow_up" else "reply")
    )
    if action_mode == "save_draft":
        action_note = "It will not send or save until the person reviews it and presses Save draft."
    elif action_mode == "schedule" and scheduled_display:
        action_note = (
            f"It is ready to schedule for {scheduled_display}, and will not schedule or "
            "send until the person reviews it and presses Schedule."
        )
    else:
        action_note = "It will not send until the person reviews it and presses Send reply."
    result_out: dict[str, Any] = {
        "status": "draft_opened",
        "source_mail_ref": sealed_ref,
        "to": source.recipient_email,
        "recipient_display": source.recipient_display,
        "subject": source.subject,
        "prefilled": True,
        "message": (
            f"An editable {mode_label} to {source.recipient_display} "
            f"({source.subject}) is open. {action_note}"
        ),
    }
    if cc_list:
        result_out["cc"] = ", ".join(cc_list)
    if action_mode != "send":
        result_out["primary_action"] = action_mode
    if scheduled_iso:
        result_out["scheduled_send_at"] = scheduled_iso
        result_out["scheduled_send_display"] = scheduled_display
    return result_out


async def open_gmail_forward_draft(
    ordinal: int,
    to: str,
    tool_context: ToolContext,
    note: str = "",
    cc: str = "",
) -> dict[str, Any]:
    """Open an editable forward draft for an email already shown in this chat.

    Fetches the verified original message server-side from ``STATE_MAIL_READ_OFFER``,
    prepends the owner's optional ``note``, formats a standard ``Fwd:`` subject
    and quoted original block, and opens the editable Mail draft card. Nothing
    sends until the owner reviews and taps Send. Notes any original attachments
    that cannot be re-attached automatically.
    """
    owner = await _admitted_owner(tool_context)
    if owner is None:
        return {"status": "unavailable", "message": "Mail forwarding is available in chat only."}
    user_id, conversation_id = owner
    tz_name = str(tool_context.state.get(_STATE_TIMEZONE) or "UTC").strip() or "UTC"
    if type(ordinal) is not int or not 1 <= ordinal <= 25:
        return {
            "status": "invalid_argument",
            "message": "Choose the email's position from the latest list shown in this chat.",
        }
    recipient = str(to or "").strip()
    if not recipient or "@" not in recipient:
        return {
            "status": "recipient_address_required",
            "message": "Provide the recipient's email address to forward this email.",
        }
    offer = current_mail_read_offer(
        tool_context.state.get(_STATE_MAIL_READ_OFFER),
        owner_id=user_id,
        conversation_id=conversation_id,
    )
    if offer is None:
        return {
            "status": "source_changed",
            "message": "That email list expired. Search for the email again before forwarding.",
        }
    message_id = offer.message_id_at(ordinal)
    if not message_id:
        return {
            "status": "invalid_argument",
            "message": f"Only {len(offer.message_ids)} email(s) were shown.",
        }

    reader = GmailMetadataReader(
        gmail=get_gmail_receipts_service(),
        user_id=user_id,
        require_access=_make_require_access(tool_context, user_id),
        expect_account=offer.account,
        timezone_name=tz_name,
    )
    try:
        read = await reader.read_threads(
            message_ids=(message_id,),
            mailbox=offer.mailbox,
            whole_thread=False,
        )
    except GmailMetadataError as exc:
        return _error_payload(exc.code, tool_context)
    except Exception:  # noqa: BLE001
        logger.exception("one_adk.open_gmail_forward_draft_failed reason=unexpected")
        return _error_payload("retryable", tool_context)

    items = list(read.get("untrusted_external_content") or [])
    if not items:
        return {"status": "source_changed", "message": "Could not load the email to forward."}
    orig = items[0]
    orig_subject = str(orig.get("subject") or "(no subject)").strip()
    fwd_subject = (
        orig_subject if orig_subject.lower().startswith("fwd:") else f"Fwd: {orig_subject}"
    )[:240]
    orig_when = orig.get("received_at_local") or orig.get("received_at") or ""
    fwd_block = (
        f"---------- Forwarded message ---------\n"
        f"From: {orig.get('sender') or 'Unknown sender'}\n"
        f"Date: {orig_when}\n"
        f"Subject: {orig_subject}\n\n"
        f"{str(orig.get('body') or '')[:8000]}"
    )
    full_body = f"{note.strip()}\n\n{fwd_block}".strip() if str(note or "").strip() else fwd_block
    envelope = {
        "to": recipient,
        "cc": str(cc or "").strip(),
        "bcc": "",
        "subject": fwd_subject,
        "body": full_body[:12_000],
    }
    tool_context.state[f"{_STATE_PENDING_DIRECTIVE}:gmail_email_draft"] = {
        "kind": "prompt",
        "payload": {
            "kind": "gmail_email_draft",
            "envelope": envelope,
        },
    }
    attachments = orig.get("attachments") or []
    att_note = (
        f" Note: original attachments ({', '.join(attachments)}) are not re-attached automatically."
        if attachments
        else ""
    )
    return {
        "status": "draft_opened",
        "envelope": {"to": recipient, "cc": envelope["cc"], "subject": fwd_subject},
        "attachments_omitted": list(attachments),
        "message": (
            f"An editable forwarded draft to {recipient} ({fwd_subject}) is open. "
            f"Nothing sends until the person reviews it and taps Send.{att_note}"
        ),
    }


GMAIL_CHAT_READ_TOOLS = [
    gmail_search_mail,
    gmail_scan_receipts,
    gmail_read_thread,
    gmail_read_attachment,
    gmail_list_needs_reply,
    gmail_mailbox_insights,
]
GMAIL_CHAT_TOOLS = [
    *GMAIL_CHAT_READ_TOOLS,
    open_gmail_reply_draft,
    open_gmail_forward_draft,
]
