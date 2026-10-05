"""Vault-gated owner-approved Gmail delivery routes.

These endpoints are separate from One's platform-mailbox KYC workflow.  They
use the user's existing Gmail receipts connection and never accept OAuth tokens
or a sender address from the caller.
"""

from __future__ import annotations

import logging
from typing import Any, cast

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_firebase_auth, require_vault_owner_token
from hushh_mcp.one_voice.config import voice_mail_reads_enabled, voice_mail_reply_enabled
from hushh_mcp.services.actor_identity_service import ActorIdentityService
from hushh_mcp.services.email_delegated_read import mail_latency
from hushh_mcp.services.gmail_delivery_service import (
    GmailDeliveryError,
    create_reviewed_gmail_draft,
    get_gmail_delivery_service,
    normalize_draft,
)
from hushh_mcp.services.gmail_mailbox_actions import get_gmail_mailbox_actions
from hushh_mcp.services.gmail_personal_information_request_service import (
    get_personal_gmail_information_request_service,
)
from hushh_mcp.services.gmail_receipts_service import GmailApiError, get_gmail_receipts_service
from hushh_mcp.services.gmail_reply_source_service import (
    MAX_SOURCE_REF_CHARS,
    SOURCE_REF_PATTERN,
    resolve_source_bound_reply,
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


class DriveAttachmentRef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    file_id: str = Field(min_length=1, max_length=256)
    revision: str | None = Field(default=None, min_length=1, max_length=256)
    sha256: str | None = Field(default=None, min_length=64, max_length=64)


class EmailPrepareRequest(EmailEnvelope):
    model_config = ConfigDict(extra="forbid")

    idempotency_key: str = Field(min_length=16, max_length=256)
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


class EmailSendRequest(EmailEnvelope):
    model_config = ConfigDict(extra="forbid")

    action_id: str = Field(min_length=1, max_length=128)
    attachment_token: str | None = Field(default=None, min_length=32, max_length=2048)
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
        excluded = (
            {"idempotency_key", "source_workflow_id", "source_mail_ref"}
            if isinstance(payload, EmailPrepareRequest)
            else {"action_id", "source_workflow_id", "source_mail_ref"}
        )
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
    if not _reply_enabled():
        raise GmailDeliveryError(
            "MAIL_REPLY_UNAVAILABLE",
            "Replying from One is switched off.",
            status_code=403,
        )
    return cast(
        tuple[dict[str, Any], Any | None],
        await resolve_source_bound_reply(
            gmail=get_gmail_receipts_service(),
            user_id=user_id,
            source_mail_ref=str(source_mail_ref),
            body=payload.body,
            html_body=payload.html_body,
            require_access=_reply_access,
        ),
    )


@router.post("/email/draft")
async def gmail_email_draft(
    payload: EmailDraftRequest,
    firebase_uid: str = Depends(require_firebase_auth),
    token_data: dict[str, Any] = Depends(require_vault_owner_token),
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
    token_data: dict[str, Any] = Depends(require_vault_owner_token),
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
        with mail_latency("deliver_prep", logger):
            prepared = cast(
                dict[str, Any],
                await get_gmail_delivery_service().prepare(
                    user_id=user_id,
                    draft_payload=draft_payload,
                    idempotency_key=payload.idempotency_key,
                    reply_context=reply_context,
                ),
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
    token_data: dict[str, Any] = Depends(require_vault_owner_token),
) -> dict[str, str]:
    owner = _owner_user_id(firebase_uid=firebase_uid, token_data=token_data)
    try:
        result = await create_reviewed_gmail_draft(
            user_id=owner, draft_payload=payload.model_dump(exclude_none=True)
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


@router.post("/email/mailbox/execute")
async def gmail_mailbox_execute(
    payload: MailboxProposalExecuteRequest,
    firebase_uid: str = Depends(require_firebase_auth),
    token_data: dict[str, Any] = Depends(require_vault_owner_token),
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
    token_data: dict[str, Any] = Depends(require_vault_owner_token),
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
