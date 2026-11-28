"""Vault-gated owner-approved Gmail delivery routes.

These endpoints are separate from One's platform-mailbox KYC workflow.  They
use the user's existing Gmail receipts connection and never accept OAuth tokens
or a sender address from the caller.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timezone
from typing import Any, Literal, cast

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_firebase_auth, require_vault_owner_token
from hushh_mcp.one_voice.config import voice_mail_reads_enabled, voice_mail_reply_enabled
from hushh_mcp.services.actor_identity_service import ActorIdentityService
from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.email_delegated_read import mail_latency
from hushh_mcp.services.gmail_delivery_service import (
    GmailDeliveryError,
    create_reviewed_gmail_draft,
    get_gmail_delivery_service,
    get_owner_send_action,
    normalize_draft,
    reconcile_owner_send_action,
)
from hushh_mcp.services.gmail_mailbox_actions import get_gmail_mailbox_actions
from hushh_mcp.services.gmail_personal_information_request_service import (
    get_personal_gmail_information_request_service,
)
from hushh_mcp.services.gmail_receipts_service import GmailApiError, get_gmail_receipts_service
from hushh_mcp.services.gmail_reply_source_service import (
    MAX_SOURCE_REF_CHARS,
    SOURCE_REF_PATTERN,
    inspect_reply_source_surface,
    resolve_source_bound_reply,
)
from hushh_mcp.services.gmail_scheduled_drain import drain_scheduled_mail
from hushh_mcp.services.gmail_sensitive_content import (
    EPHEMERAL_REF_PATTERN,
    reveal_ephemeral_code,
)
from hushh_mcp.services.owner_placement_guard import hub_content_owner
from hushh_mcp.services.owner_time import (
    ScheduleTimeError,
    format_schedule_echo,
    resolve_send_at,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one", tags=["One Gmail Delivery"])


async def _owner_display_name(user_id: str) -> str:
    """Best-effort account label for a draft; absence must never block compose."""

    try:
        identity = (await ActorIdentityService().get_many([user_id])).get(user_id) or {}
        try:
            return str(
                ActorIdentityService.validate_display_name(str(identity.get("display_name") or ""))
            )
        except ValueError:
            from hushh_mcp.services.gmail_receipts_service import get_gmail_receipts_service

            await get_gmail_receipts_service().refresh_owner_identity_profile(user_id=user_id)
            refreshed = (await ActorIdentityService().get_many([user_id])).get(user_id) or {}
            return str(
                ActorIdentityService.validate_display_name(str(refreshed.get("display_name") or ""))
            )
    except Exception:  # noqa: BLE001 - drafting remains available if the cache is unavailable
        return ""


class EmailDraftRequest(BaseModel):
    instruction: str = Field(min_length=1, max_length=12_000)


class EmailEnvelope(BaseModel):
    # The compact draft card submits comma-separated strings; API consumers may
    # also use structured lists.  Service normalization remains the authority.
    to: str | list[str] = Field(default_factory=list)
    cc: str | list[str] = Field(default_factory=list)
    bcc: str | list[str] = Field(default_factory=list)
    subject: str = Field(default="", max_length=256)
    body: str = Field(default="", max_length=50_000)
    # This optional representation is independently sanitized by the Gmail
    # owner delivery service before it becomes part of the reviewed envelope.
    html_body: str | None = Field(default=None, max_length=50_000)
    draft_ref: str | None = Field(default=None, min_length=1, max_length=128)
    revision: int | None = Field(default=None, ge=1)


class DriveAttachmentRef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    file_id: str = Field(min_length=1, max_length=256)
    revision: str | None = Field(default=None, min_length=1, max_length=256)
    sha256: str | None = Field(default=None, min_length=64, max_length=64)


class EmailPrepareRequest(EmailEnvelope):
    model_config = ConfigDict(extra="forbid")

    idempotency_key: str = Field(min_length=16, max_length=256)
    intent: Literal["send", "save_draft"] = "send"
    drive_attachment: DriveAttachmentRef | None = None
    source_workflow_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9-]+$",
    )
    # An opaque reply binding minted by the server for one offered message. Its
    # recipient, subject and thread are re-derived from Gmail on every use.
    source_mail_ref: str | None = Field(
        default=None, min_length=20, max_length=MAX_SOURCE_REF_CHARS, pattern=SOURCE_REF_PATTERN
    )


class MailboxProposalExecuteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    proposal_id: str = Field(min_length=8, max_length=256, pattern=r"^gmod_[A-Za-z0-9_-]+$")


class EmailSaveDraftRequest(EmailEnvelope):
    model_config = ConfigDict(extra="forbid")

    action_id: str | None = Field(default=None, min_length=1, max_length=128)
    sender_token: str | None = Field(default=None, min_length=32, max_length=32768)
    source_mail_ref: str | None = Field(
        default=None, min_length=20, max_length=MAX_SOURCE_REF_CHARS, pattern=SOURCE_REF_PATTERN
    )


class EmailRevealEphemeralRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reveal_ref: str = Field(min_length=10, max_length=256, pattern=EPHEMERAL_REF_PATTERN)


class EmailScheduleRequest(EmailEnvelope):
    model_config = ConfigDict(extra="forbid")

    send_at: str = Field(min_length=8, max_length=64)
    timezone: str | None = Field(default=None, max_length=64)
    recipient_display: str | None = Field(default=None, max_length=200)
    source_mail_ref: str | None = Field(
        default=None, min_length=20, max_length=MAX_SOURCE_REF_CHARS, pattern=SOURCE_REF_PATTERN
    )


class EmailSendRequest(EmailEnvelope):
    model_config = ConfigDict(extra="forbid")

    action_id: str = Field(min_length=1, max_length=128)
    attachment_token: str | None = Field(default=None, min_length=32, max_length=2048)
    sender_token: str | None = Field(default=None, min_length=32, max_length=32768)
    source_workflow_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9-]+$",
    )
    source_mail_ref: str | None = Field(
        default=None, min_length=20, max_length=MAX_SOURCE_REF_CHARS, pattern=SOURCE_REF_PATTERN
    )


def _owner_user_id(*, firebase_uid: str, token_data: dict[str, Any]) -> str:
    owner_user_id = str(token_data.get("user_id") or "").strip()
    if not owner_user_id or owner_user_id != firebase_uid:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "GMAIL_DELIVERY_USER_MISMATCH",
                "message": "Gmail delivery requires the current vault owner.",
            },
        )
    return owner_user_id


def _as_http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, GmailDeliveryError):
        return HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": exc.message},
        )
    if isinstance(exc, GmailApiError):
        return HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code or "GMAIL_SEND_NOT_READY", "message": str(exc)},
        )
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={
            "code": "GMAIL_DELIVERY_UNAVAILABLE",
            "message": "Gmail delivery is temporarily unavailable. Please try again.",
        },
    )


def _reply_enabled() -> bool:
    """A reply re-reads the original email, so both voice mail switches gate it."""
    return voice_mail_reply_enabled() and voice_mail_reads_enabled()


async def _reply_access() -> None:
    """Re-checked by the source read around its provider hop."""
    if not _reply_enabled():
        raise PermissionError("Mail replies are disabled")


def _typed_chat_reply_access(user_id: str):
    async def _check() -> None:
        if not connector_feature_enabled("gmail_chat_reads", user_id):
            raise PermissionError("Typed-chat mail replies are disabled")

    return _check


def _reply_surface(source_mail_ref: str, *, user_id: str) -> str:
    """Return authenticated ref surface, failing closed to 'voice' on unsealed/tampered refs."""
    try:
        return str(inspect_reply_source_surface(source_mail_ref, owner_user_id=user_id))
    except (GmailDeliveryError, ValueError):
        return "voice"


async def _resolve_delivery_payload(
    *,
    user_id: str,
    payload: EmailEnvelope,
    source_workflow_id: str | None,
    source_mail_ref: str | None = None,
) -> tuple[dict[str, Any], Any | None]:
    """Use the normal delivery boundary while preserving a Gmail source binding.

    Three modes, never blended: a fresh compose (the caller's envelope, which the
    service normalizes), a personal-information-request reply (its workflow
    source), and a reply to an offered message (its ``source_mail_ref``). Both
    reply modes take only the body from the caller; recipient, subject and
    thread come from the source on every prepare and every send.
    """

    if source_workflow_id and source_mail_ref:
        raise GmailDeliveryError(
            "SOURCE_BINDING_CONFLICT",
            "A reply can have only one original email.",
            status_code=422,
        )
    if not source_workflow_id and not source_mail_ref:
        if isinstance(payload, EmailPrepareRequest):
            excluded = {"idempotency_key", "intent", "source_workflow_id", "source_mail_ref"}
        elif isinstance(payload, EmailSaveDraftRequest):
            excluded = {"action_id", "sender_token", "source_mail_ref"}
        elif isinstance(payload, EmailScheduleRequest):
            excluded = {"send_at", "timezone", "recipient_display", "source_mail_ref"}
        else:
            excluded = {"action_id", "source_workflow_id", "source_mail_ref"}
        return payload.model_dump(exclude=excluded, exclude_none=True), None
    if isinstance(payload, EmailPrepareRequest) and payload.drive_attachment is not None:
        raise GmailDeliveryError(
            "SOURCE_BOUND_ATTACHMENT_UNSUPPORTED",
            "A reply in the original thread cannot include a Drive attachment.",
            status_code=422,
        )
    if source_workflow_id:
        return cast(
            tuple[dict[str, Any], Any | None],
            await get_personal_gmail_information_request_service().resolve_reply_delivery(
                user_id=user_id,
                workflow_id=source_workflow_id,
                body=payload.body,
                html_body=payload.html_body,
            ),
        )
    if isinstance(payload, EmailSendRequest) and payload.attachment_token is not None:
        # Refused, not silently dropped: a reply carries no attachment, and an
        # attachment the person reviewed must never quietly go missing.
        raise GmailDeliveryError(
            "SOURCE_BOUND_ATTACHMENT_UNSUPPORTED",
            "A reply in the original thread cannot include a Drive attachment.",
            status_code=422,
        )
    surface = _reply_surface(str(source_mail_ref), user_id=user_id)
    if surface == "typed_chat":
        if not connector_feature_enabled("gmail_chat_reads", user_id):
            raise GmailDeliveryError(
                "MAIL_REPLY_UNAVAILABLE",
                "Replying from One is switched off.",
                status_code=403,
            )
        require_access = _typed_chat_reply_access(user_id)
    else:
        if not _reply_enabled():
            raise GmailDeliveryError(
                "MAIL_REPLY_UNAVAILABLE",
                "Replying from One is switched off.",
                status_code=403,
            )
        require_access = _reply_access
    return cast(
        tuple[dict[str, Any], Any | None],
        await resolve_source_bound_reply(
            gmail=get_gmail_receipts_service(),
            user_id=user_id,
            source_mail_ref=str(source_mail_ref),
            body=payload.body,
            html_body=payload.html_body,
            require_access=require_access,
        ),
    )


@router.post("/email/draft")
async def gmail_email_draft(
    payload: EmailDraftRequest,
    firebase_uid: str = Depends(require_firebase_auth),
    token_data: dict[str, Any] = Depends(hub_content_owner),
) -> dict[str, Any]:
    user_id = _owner_user_id(
        firebase_uid=firebase_uid,
        token_data=token_data,
    )
    try:
        return cast(
            dict[str, Any],
            await get_gmail_delivery_service().draft_from_instruction(
                instruction=payload.instruction,
                user_id=user_id,
                consent_token=str(token_data.get("token") or ""),
                owner_display_name=await _owner_display_name(user_id),
            ),
        )
    except Exception as exc:
        logger.warning("one.gmail_delivery.draft_failed error=%s", type(exc).__name__)
        raise _as_http_error(exc) from exc


@router.post("/email/prepare")
async def gmail_email_prepare(
    payload: EmailPrepareRequest,
    firebase_uid: str = Depends(require_firebase_auth),
    token_data: dict[str, Any] = Depends(hub_content_owner),
) -> dict[str, Any]:
    user_id = _owner_user_id(
        firebase_uid=firebase_uid,
        token_data=token_data,
    )
    try:
        draft_payload, reply_context = await _resolve_delivery_payload(
            user_id=user_id,
            payload=payload,
            source_workflow_id=payload.source_workflow_id,
            source_mail_ref=payload.source_mail_ref,
        )
        if payload.draft_ref is not None or payload.revision is not None:
            draft_payload.update(draft_ref=payload.draft_ref, revision=payload.revision)
        with mail_latency("deliver_prep", logger):
            prepare_kwargs: dict[str, Any] = {
                "user_id": user_id,
                "draft_payload": draft_payload,
                "idempotency_key": payload.idempotency_key,
                "reply_context": reply_context,
            }
            if payload.intent != "send":
                prepare_kwargs["intent"] = payload.intent
            prepared = cast(
                dict[str, Any],
                await get_gmail_delivery_service().prepare(**prepare_kwargs),
            )
        if reply_context is None:
            return prepared
        normalized = normalize_draft(draft_payload)
        preview: dict[str, Any] = {
            "to": list(normalized.to),
            "cc": list(normalized.cc),
            "bcc": list(normalized.bcc),
            "subject": normalized.subject,
        }
        if payload.source_workflow_id:
            # Unchanged for the information-request card. A general reply's
            # thread stays server-side: the browser never needs it to send.
            preview["gmail_thread_id"] = reply_context.thread_id
        return {**prepared, "preview": preview}
    except Exception as exc:
        logger.warning("one.gmail_delivery.prepare_failed error=%s", type(exc).__name__)
        raise _as_http_error(exc) from exc


@router.post("/email/draft/save")
async def gmail_save_draft(
    payload: EmailSaveDraftRequest,
    firebase_uid: str = Depends(require_firebase_auth),
    token_data: dict[str, Any] = Depends(hub_content_owner),
) -> dict[str, str]:
    owner = _owner_user_id(firebase_uid=firebase_uid, token_data=token_data)
    try:
        if payload.action_id or payload.source_mail_ref:
            draft_payload, reply_context = await _resolve_delivery_payload(
                user_id=owner,
                payload=payload,
                source_workflow_id=None,
                source_mail_ref=payload.source_mail_ref,
            )
            if payload.draft_ref is not None or payload.revision is not None:
                draft_payload.update(draft_ref=payload.draft_ref, revision=payload.revision)
            if payload.sender_token is not None:
                draft_payload["sender_token"] = payload.sender_token
            if payload.action_id:
                result = await get_gmail_delivery_service().execute_save_draft(
                    user_id=owner,
                    action_id=payload.action_id,
                    draft_payload=draft_payload,
                    reply_context=reply_context,
                )
            else:
                result = await create_reviewed_gmail_draft(
                    user_id=owner,
                    draft_payload=draft_payload,
                    reply_context=reply_context,
                )
        else:
            result = await create_reviewed_gmail_draft(
                user_id=owner,
                draft_payload=payload.model_dump(
                    exclude={"action_id", "sender_token", "source_mail_ref"},
                    exclude_none=True,
                ),
            )
        status_value = result.get("status")
        draft_id = result.get("draft_id")
        if (
            status_value != "saved"
            or not isinstance(draft_id, str)
            or not 1 <= len(draft_id) <= 256
        ):
            raise GmailApiError("Gmail draft outcome is unknown", status_code=502)
        return {"status": status_value, "draft_id": draft_id}
    except Exception as exc:
        logger.warning("one.gmail_delivery.save_draft_failed error=%s", type(exc).__name__)
        raise _as_http_error(exc) from None


@router.post("/email/reveal-ephemeral")
async def gmail_reveal_ephemeral(
    payload: EmailRevealEphemeralRequest,
    response: Response,
    firebase_uid: str = Depends(require_firebase_auth),
    token_data: dict[str, Any] = Depends(hub_content_owner),
) -> dict[str, Any]:
    """Single-consume RAM-only OTP reveal for the current vault owner."""
    owner = _owner_user_id(firebase_uid=firebase_uid, token_data=token_data)
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Pragma"] = "no-cache"
    revealed = await asyncio.to_thread(
        reveal_ephemeral_code,
        reveal_ref=payload.reveal_ref,
        owner_user_id=owner,
    )
    if revealed is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "EPHEMERAL_CODE_UNAVAILABLE",
                "message": "This verification code expired or was already revealed.",
            },
        )
    return dict(revealed)


@router.post("/email/schedule")
async def gmail_schedule_email(
    payload: EmailScheduleRequest,
    response: Response,
    firebase_uid: str = Depends(require_firebase_auth),
    token_data: dict[str, Any] = Depends(hub_content_owner),
) -> dict[str, Any]:
    """Schedule a reviewed email or threaded reply to send at a future time."""
    owner = _owner_user_id(firebase_uid=firebase_uid, token_data=token_data)
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Pragma"] = "no-cache"
    now = datetime.now(timezone.utc)
    try:
        send_at_utc = resolve_send_at(payload.send_at, owner_zone=payload.timezone, now=now)
    except ScheduleTimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": exc.code.upper(), "message": exc.message},
        ) from None
    try:
        draft_payload, reply_context = await _resolve_delivery_payload(
            user_id=owner,
            payload=payload,
            source_workflow_id=None,
            source_mail_ref=payload.source_mail_ref,
        )
        draft = normalize_draft(draft_payload)
        service = get_gmail_delivery_service()
        sender_sub = await service.current_sender_sub(user_id=owner)
        if not sender_sub:
            raise GmailDeliveryError(
                "GMAIL_SEND_NOT_READY",
                "Connect Gmail with send permission before scheduling an email.",
                status_code=409,
            )
        reply_ctx_dict = (
            {
                "thread_id": reply_context.thread_id,
                "in_reply_to": reply_context.in_reply_to,
                "references": reply_context.references,
            }
            if reply_context is not None
            else None
        )
        recipient_display = str(payload.recipient_display or "").strip() or (
            draft.to[0] if len(draft.to) == 1 else f"{draft.to[0]} (+{len(draft.to) - 1} more)"
        )
        scheduled = await service.schedule_send(
            user_id=owner,
            payload={
                "to": list(draft.to),
                "cc": list(draft.cc),
                "bcc": list(draft.bcc),
                "subject": draft.subject,
                "body": draft.body,
                "html_body": draft.html_body,
                "recipient_kind": "explicit_address",
                "recipient_user_id": "",
                "sender_sub": sender_sub,
                "reply_context": reply_ctx_dict,
            },
            send_at=send_at_utc,
            recipient_display=recipient_display,
        )
        send_at_val = scheduled.get("send_at")
        send_at_iso = (
            send_at_val.isoformat()
            if isinstance(send_at_val, datetime)
            else send_at_utc.isoformat()
        )
        return {
            "action_id": scheduled["action_id"],
            "state": scheduled["state"],
            "send_at": send_at_iso,
            "send_at_display": format_schedule_echo(send_at_utc, payload.timezone, now=now),
            "recipient_display": recipient_display,
            "subject": draft.subject,
            "created": bool(scheduled.get("created")),
        }
    except Exception as exc:
        logger.warning("one.gmail_delivery.schedule_failed error=%s", type(exc).__name__)
        raise _as_http_error(exc) from exc


@router.get("/email/scheduled")
async def gmail_list_scheduled(
    response: Response,
    limit: int = 10,
    firebase_uid: str = Depends(require_firebase_auth),
    token_data: dict[str, Any] = Depends(hub_content_owner),
) -> dict[str, Any]:
    """List pending scheduled sends for the current vault owner, opportunistically draining due items."""
    owner = _owner_user_id(firebase_uid=firebase_uid, token_data=token_data)
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Pragma"] = "no-cache"
    bounded = max(1, min(int(limit), 25))
    try:
        # Opportunistically flush any due scheduled sends for this owner so UI
        # polling reflects delivery immediately even on cold/idle instances.
        try:
            await drain_scheduled_mail(
                limit=5,
                deadline_seconds=8.0,
                owner_user_id=owner,
            )
        except Exception as drain_exc:  # noqa: BLE001
            logger.warning(
                "one.gmail_delivery.opportunistic_drain_skipped error=%s",
                type(drain_exc).__name__,
            )
        rows = await get_gmail_delivery_service().list_scheduled_sends(user_id=owner, limit=bounded)
        items = [
            {
                "action_id": str(row.get("action_id") or ""),
                "recipient_display": str(row.get("recipient_display") or ""),
                "subject": str(row.get("subject") or ""),
                "send_at": (
                    row["send_at"].isoformat()
                    if isinstance(row.get("send_at"), datetime)
                    else str(row.get("send_at") or "")
                ),
                "created_at": (
                    row["created_at"].isoformat()
                    if isinstance(row.get("created_at"), datetime)
                    else str(row.get("created_at") or "")
                ),
            }
            for row in rows
        ]
        return {"items": items}
    except Exception as exc:
        logger.warning("one.gmail_delivery.list_scheduled_failed error=%s", type(exc).__name__)
        raise _as_http_error(exc) from exc


@router.post("/email/scheduled/{action_id}/cancel")
async def gmail_cancel_scheduled(
    action_id: str,
    response: Response,
    firebase_uid: str = Depends(require_firebase_auth),
    token_data: dict[str, Any] = Depends(hub_content_owner),
) -> dict[str, Any]:
    """Cancel a pending scheduled send belonging to the current vault owner."""
    owner = _owner_user_id(firebase_uid=firebase_uid, token_data=token_data)
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Pragma"] = "no-cache"
    if not re.fullmatch(r"[A-Za-z0-9-]{1,128}", action_id):
        raise HTTPException(status_code=404, detail={"code": "ACTION_NOT_FOUND"})
    try:
        result = await get_gmail_delivery_service().cancel_scheduled_send(
            user_id=owner, action_id=action_id
        )
        if result.get("state") is None:
            raise HTTPException(status_code=404, detail={"code": "ACTION_NOT_FOUND"})
        sent_at = result.get("sent_at")
        return {
            "action_id": action_id,
            "cancelled": bool(result.get("cancelled")),
            "state": result.get("state"),
            "sent_at": sent_at.isoformat() if isinstance(sent_at, datetime) else sent_at,
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("one.gmail_delivery.cancel_scheduled_failed error=%s", type(exc).__name__)
        raise _as_http_error(exc) from exc


@router.post("/email/mailbox/execute")
async def gmail_mailbox_execute(
    payload: MailboxProposalExecuteRequest,
    firebase_uid: str = Depends(require_firebase_auth),
    token_data: dict[str, Any] = Depends(hub_content_owner),
) -> dict[str, Any]:
    """Apply the exact reviewed mailbox change the owner confirmed in chat."""
    owner = _owner_user_id(firebase_uid=firebase_uid, token_data=token_data)
    try:
        result: dict[str, Any] = await get_gmail_mailbox_actions().execute(
            user_id=owner, proposal_id=payload.proposal_id
        )
        return result
    except Exception as exc:
        logger.warning("one.gmail_mailbox.execute_failed error=%s", type(exc).__name__)
        raise _as_http_error(exc) from None


@router.post("/email/send")
async def gmail_email_send(
    payload: EmailSendRequest,
    firebase_uid: str = Depends(require_firebase_auth),
    token_data: dict[str, Any] = Depends(hub_content_owner),
) -> dict[str, Any]:
    user_id = _owner_user_id(
        firebase_uid=firebase_uid,
        token_data=token_data,
    )
    try:
        draft_payload, reply_context = await _resolve_delivery_payload(
            user_id=user_id,
            payload=payload,
            source_workflow_id=payload.source_workflow_id,
            source_mail_ref=payload.source_mail_ref,
        )
        if payload.sender_token is not None:
            draft_payload["sender_token"] = payload.sender_token
        if payload.draft_ref is not None or payload.revision is not None:
            draft_payload.update(draft_ref=payload.draft_ref, revision=payload.revision)
        with mail_latency("deliver", logger) as span:
            result = cast(
                dict[str, Any],
                await get_gmail_delivery_service().execute(
                    user_id=user_id,
                    action_id=payload.action_id,
                    draft_payload=draft_payload,
                    reply_context=reply_context,
                ),
            )
            if result.get("outcome_unknown"):
                # Ambiguous provider answer: never logged as a delivered send.
                span.status = "unknown"
        if payload.source_workflow_id:
            return cast(
                dict[str, Any],
                await get_personal_gmail_information_request_service().record_reply_delivery(
                    user_id=user_id,
                    workflow_id=payload.source_workflow_id,
                    result=result,
                ),
            )
        return result
    except Exception as exc:
        logger.warning("one.gmail_delivery.send_failed error=%s", type(exc).__name__)
        raise _as_http_error(exc) from exc


def _send_action_status_payload(
    *, action_id: str, row: dict[str, Any] | None, response: Response
) -> dict[str, Any]:
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "ACTION_NOT_FOUND"})
    state = str(row.get("state") or "")
    if state not in {
        "prepared",
        "sending",
        "sent",
        "failed",
        "outcome_unknown",
        "expired",
        "cancelled",
    }:
        raise HTTPException(status_code=503, detail={"code": "GMAIL_DELIVERY_UNAVAILABLE"})
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Pragma"] = "no-cache"
    return {
        "action_id": action_id,
        "state": state,
        "outcome_unknown": state == "outcome_unknown",
    }


@router.get("/email/send/status/{action_id}")
async def gmail_email_send_status(
    action_id: str,
    response: Response,
    firebase_uid: str = Depends(require_firebase_auth),
    token_data: dict[str, Any] = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    """Read one owner's durable send result without exposing mail or provider ids.

    A lost HTTP response is reconciled against the same action. In particular,
    ``sending`` and ``outcome_unknown`` never authorize a fresh send.
    """
    user_id = _owner_user_id(firebase_uid=firebase_uid, token_data=token_data)
    if not re.fullmatch(r"[A-Za-z0-9-]{1,128}", action_id):
        raise HTTPException(status_code=404, detail={"code": "ACTION_NOT_FOUND"})
    try:
        row = await get_owner_send_action(user_id=user_id, action_id=action_id)
    except Exception as exc:
        logger.warning("one.gmail_delivery.status_failed error=%s", type(exc).__name__)
        raise _as_http_error(exc) from exc
    return _send_action_status_payload(action_id=action_id, row=row, response=response)


@router.post("/email/send/status/{action_id}")
async def gmail_email_reconcile_send_status(
    action_id: str,
    response: Response,
    firebase_uid: str = Depends(require_firebase_auth),
    token_data: dict[str, Any] = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    """Settle an interrupted immediate attempt after its execution grace period."""
    user_id = _owner_user_id(firebase_uid=firebase_uid, token_data=token_data)
    if not re.fullmatch(r"[A-Za-z0-9-]{1,128}", action_id):
        raise HTTPException(status_code=404, detail={"code": "ACTION_NOT_FOUND"})
    try:
        row = await reconcile_owner_send_action(user_id=user_id, action_id=action_id)
    except Exception as exc:
        logger.warning("one.gmail_delivery.status_reconcile_failed error=%s", type(exc).__name__)
        raise _as_http_error(exc) from exc
    return _send_action_status_payload(action_id=action_id, row=row, response=response)
