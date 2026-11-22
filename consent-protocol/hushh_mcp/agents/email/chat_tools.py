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

import logging
import re
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
from hushh_mcp.services.gmail_receipts_service import GmailApiError, get_gmail_receipts_service

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


def _error_payload(code: str, tool_context: ToolContext) -> dict[str, Any]:
    if code in _CLEAR_OFFER_STATUSES:
        tool_context.state[_STATE_MAIL_READ_OFFER] = None
    mapped_status = code if code in MAIL_READ_ERROR_CODES else "unavailable"
    message = _READ_ERRORS.get(code, "I couldn't check your mail just now. Please try again.")
    return {
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


async def gmail_search_mail(
    intent: str,
    tool_context: ToolContext,
    queries: list[str] | None = None,
    mailbox: str = "anywhere",
    after_date: str = "",
    before_date: str = "",
    limit: int = 12,
    read_top_bodies: int = 3,
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

    reader = GmailMetadataReader(
        gmail=get_gmail_receipts_service(),
        user_id=user_id,
        require_access=_make_require_access(tool_context, user_id),
    )
    try:
        result = await reader.search_hybrid(
            intent=str(intent or "").strip()[:500],
            queries=tuple(pinned_queries),
            mailbox=target_mailbox,
            limit=bounded_limit,
            read_top_bodies=bounded_bodies,
            embedding_client=_loaded_embedding_client(),
        )
    except GmailMetadataError as exc:
        return _error_payload(exc.code, tool_context)
    except GmailApiError as exc:
        code = "connect_required" if exc.code == "GMAIL_NOT_CONNECTED" else "reconnect_required"
        return _error_payload(code, tool_context)
    except PermissionError:
        return {"status": "unavailable", "message": "Mail chat reads are not available here."}
    except Exception:  # noqa: BLE001 - provider errors never leak into transcript
        logger.exception("one_adk.gmail_search_mail_failed reason=unexpected")
        return _error_payload("retryable", tool_context)

    items = list(result.get("untrusted_external_content") or [])
    if not items:
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

    _remember_mail_offer(
        tool_context,
        reader=reader,
        owner_id=user_id,
        conversation_id=conversation_id,
        mailbox=target_mailbox,
    )
    return {
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


async def gmail_read_thread(
    tool_context: ToolContext,
    ordinals: list[int] | None = None,
    query: str = "",
    whole_thread: bool = True,
    mailbox: str = "anywhere",
    limit: int = 2,
) -> dict[str, Any]:
    """Read full chronological email thread(s) or specific offered messages.

    Use ``ordinals`` (e.g. ``[2]`` for "the second one" or ``mail:2``) whenever
    referring to messages already returned in this conversation — the server
    resolves exact provider IDs securely from ``STATE_MAIL_READ_OFFER``.
    Use ``query`` when starting a direct thread read without a prior list.
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
        )
        try:
            use_threads = bool(whole_thread and resolved_threads and len(resolved_threads) > 0)
            result = await reader.read_threads(
                thread_ids=tuple(resolved_threads) if use_threads else (),
                message_ids=() if use_threads else tuple(resolved_messages),
                mailbox=offer.mailbox,
                whole_thread=bool(whole_thread),
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

        items = list(result.get("untrusted_external_content") or [])
        _remember_mail_offer(
            tool_context,
            reader=reader,
            owner_id=user_id,
            conversation_id=conversation_id,
            mailbox=offer.mailbox,
            selected_ordinal=clean_ordinals[0] if len(clean_ordinals) == 1 else None,
        )
        return {
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

    cleaned_query = str(query or "").strip()
    try:
        pinned = _pin_query(cleaned_query, zone_name=tz_name) if cleaned_query else ""
    except GmailMetadataError as exc:
        return _error_payload(exc.code, tool_context)

    search_reader = GmailMetadataReader(
        gmail=get_gmail_receipts_service(),
        user_id=user_id,
        require_access=_make_require_access(tool_context, user_id),
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
    )
    try:
        use_threads = bool(whole_thread and located_threads)
        result = await thread_reader.read_threads(
            thread_ids=tuple(located_threads) if use_threads else (),
            message_ids=() if use_threads else tuple(located_msgs),
            mailbox=target_mailbox if pinned else "inbox",
            whole_thread=bool(whole_thread),
        )
    except GmailMetadataError as exc:
        return _error_payload(exc.code, tool_context)
    except Exception:  # noqa: BLE001
        logger.exception("one_adk.gmail_read_thread_hydrate_failed reason=unexpected")
        return _error_payload("retryable", tool_context)

    items = list(result.get("untrusted_external_content") or [])
    _remember_mail_offer(
        tool_context,
        reader=thread_reader,
        owner_id=user_id,
        conversation_id=conversation_id,
        mailbox=target_mailbox if pinned else "inbox",
    )
    return {
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


async def gmail_list_needs_reply(
    tool_context: ToolContext,
    limit: int = 10,
) -> dict[str, Any]:
    """List recent inbound Gmail conversations that likely need the owner's reply.

    This is a bounded heuristic over recent primary inbox threads (not proof of
    obligation). Mints ``STATE_MAIL_READ_OFFER`` so the owner can immediately
    say "read the second one" or "reply to the first one".
    """
    owner = await _admitted_owner(tool_context)
    if owner is None:
        return {"status": "unavailable", "message": "Mail chat reads are not available here."}
    user_id, conversation_id = owner
    bounded_limit = limit if type(limit) is int and 1 <= limit <= 25 else 10

    reader = GmailMetadataReader(
        gmail=get_gmail_receipts_service(),
        user_id=user_id,
        require_access=_make_require_access(tool_context, user_id),
    )
    try:
        result = await reader.read("list_needs_reply", {"limit": bounded_limit, "mailbox": "inbox"})
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
) -> dict[str, Any]:
    """Open a source-bound editable reply draft to an email shown in this chat.

    Security boundary: accepts ONLY ``ordinal`` (1-based position from the
    latest Mail list/read in this conversation) and ``body``. Recipient
    (``Reply-To`` / ``From``), ``Re:`` subject, ``threadId``, ``In-Reply-To``,
    and ``References`` are re-read and cryptographically sealed server-side via
    ``gmail_reply_source_service`` so untrusted email text can NEVER retarget a
    reply to another address. Nothing sends until the owner taps Send reply.
    """
    owner = await _admitted_owner(tool_context)
    if owner is None:
        return {"status": "unavailable", "message": "Mail replies are available in chat only."}
    user_id, conversation_id = owner
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

    try:
        source = await reply_source_service.read_reply_source(
            gmail=get_gmail_receipts_service(),
            user_id=user_id,
            message_id=message_id,
            expected_account=offer.account,
            require_access=_make_require_access(tool_context, user_id),
        )
        sealed_ref = reply_source_service.seal_reply_source_ref(source, owner_user_id=user_id)
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

    tool_context.state[f"{_STATE_PENDING_DIRECTIVE}:gmail_reply_draft"] = {
        "kind": "prompt",
        "payload": {
            "kind": "gmail_reply_draft",
            "source_mail_ref": sealed_ref,
        },
    }
    return {
        "status": "draft_opened",
        "source_mail_ref": sealed_ref,
        "to": source.recipient_email,
        "recipient_display": source.recipient_display,
        "subject": source.subject,
        "prefilled": True,
        "message": (
            f"An editable reply to {source.recipient_display} ({source.subject}) is open. "
            "It will not send until the person reviews it and presses Send reply."
        ),
    }


GMAIL_CHAT_READ_TOOLS = [
    gmail_search_mail,
    gmail_read_thread,
    gmail_list_needs_reply,
]
GMAIL_CHAT_TOOLS = [
    *GMAIL_CHAT_READ_TOOLS,
    open_gmail_reply_draft,
]
