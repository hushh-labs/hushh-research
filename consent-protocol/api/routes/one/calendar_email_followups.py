"""Selected-account Calendar email follow-ups; consent and source checks at every route."""

from __future__ import annotations

import logging
import os
from datetime import UTC, datetime, timedelta
from typing import Literal
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import verify_user_id_match
from hushh_mcp.services.calendar_account_board_service import account_schedule
from hushh_mcp.services.calendar_email_followup_account import (
    SelectedMailAccessError,
    open_selected_mail_grant,
    selected_mail_epoch_digest,
    selected_mail_status,
)
from hushh_mcp.services.calendar_email_followup_crypto import FollowupCryptoError
from hushh_mcp.services.calendar_email_followup_reader import (
    CompleteMailReadError,
    read_complete_message,
)
from hushh_mcp.services.calendar_email_followup_relevance import sanitize_source_body
from hushh_mcp.services.calendar_email_followup_scan import scan_once
from hushh_mcp.services.calendar_email_followup_status import monitor_status
from hushh_mcp.services.calendar_email_followup_store import (
    CalendarEmailFollowupStore,
    FollowupStateError,
)
from hushh_mcp.services.google_connection_service import (
    GoogleConnectionError,
    get_google_connection_service,
)
from hushh_mcp.services.owner_placement_guard import hub_content_firebase, hub_content_owner

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/one/calendar/followups", tags=["One Calendar Follow-ups"])


class _Selection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str = Field(min_length=1, max_length=256)
    account_id: str = Field(min_length=1, max_length=128)


class PreferenceChange(_Selection):
    enabled: bool
    notifications_enabled: bool = False
    historical_start_at: datetime | None = None
    time_zone: str | None = Field(default=None, min_length=1, max_length=128)
    reminder_lead_days: int = Field(default=1, ge=0, le=14)
    reminder_hour: int = Field(default=9, ge=0, le=23)


class ConversationSelection(_Selection):
    conversation_id: UUID


class RequestSelection(_Selection):
    request_id: UUID


class ListSelection(_Selection):
    offset: int = Field(default=0, ge=0, le=100000)


class RequestChange(RequestSelection):
    expected_revision: int = Field(ge=1)
    idempotency_key: UUID
    action: Literal["done", "dismiss", "snooze", "set_reminder"]
    reminder_at: datetime | None = None


class BookingConfirmed(RequestSelection):
    expected_revision: int = Field(ge=1)
    idempotency_key: UUID
    event_id: str = Field(min_length=1, max_length=2048)


class ScanRequest(_Selection):
    # The owner's Retry: run now and give waiting sources a fresh allowance.
    retry: bool = False


class MailConnectStart(_Selection):
    redirect_uri: str | None = Field(default=None, max_length=2048)


class MailConnectComplete(_Selection):
    code: str = Field(min_length=1, max_length=2048)
    state: str = Field(min_length=1, max_length=1024)
    redirect_uri: str | None = Field(default=None, max_length=2048)


def _available() -> None:
    if os.environ.get("CALENDAR_EMAIL_FOLLOWUPS", "").lower() not in {"1", "true", "yes"}:
        raise HTTPException(status_code=503, detail={"code": "FOLLOWUPS_DISABLED"})


def _background_available() -> bool:
    return os.environ.get("CALENDAR_EMAIL_FOLLOWUP_DRAIN_ENABLED", "").lower() in {
        "1",
        "true",
        "yes",
    }


def _owner(user_id: str, firebase_uid: str, owner: dict | None = None) -> None:
    verify_user_id_match(firebase_uid, user_id)
    if owner is not None:
        verify_user_id_match(str(owner.get("user_id") or ""), user_id)


def _http(exc: Exception) -> HTTPException:
    if isinstance(exc, (SelectedMailAccessError, CompleteMailReadError, FollowupStateError)):
        code = exc.code
        status = (
            403
            if code in {"selected_mail_permission_required", "calendar_account_unavailable"}
            else 409
            if code in {"mail_grant_changed", "monitor_changed", "request_changed"}
            else 404
            if code in {"conversation_unavailable", "request_unavailable"}
            else 503
        )
        return HTTPException(status_code=status, detail={"code": code})
    if isinstance(exc, GoogleConnectionError):
        return HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.reason_code or "GOOGLE_CONNECTION_ERROR", "message": str(exc)},
        )
    if isinstance(exc, FollowupCryptoError):
        return HTTPException(status_code=503, detail={"code": exc.args[0]})
    logger.warning("calendar_followups.unavailable error_type=%s", type(exc).__name__)
    return HTTPException(status_code=503, detail={"code": "FOLLOWUPS_UNAVAILABLE"})


async def _current_monitor(user_id: str, account_id: str):
    store = CalendarEmailFollowupStore()
    monitor = await store.monitor(user_id=user_id, account_id=account_id)
    if not monitor:
        raise FollowupStateError("monitoring_off")
    grant = await open_selected_mail_grant(user_id=user_id, account_id=account_id)
    if grant.epoch_digest != monitor.grant_epoch_digest:
        raise SelectedMailAccessError("mail_grant_changed")
    return store, monitor, grant


async def _require_current(store, monitor, grant) -> None:
    await grant.require_current()
    await store.require_monitor_current(monitor)


@router.post("/status")
async def status(payload: _Selection, firebase_uid: str = Depends(hub_content_firebase)):
    _available()
    _owner(payload.user_id, firebase_uid)
    try:
        mail_connected = await selected_mail_status(
            user_id=firebase_uid, account_id=payload.account_id
        )
        monitor = await CalendarEmailFollowupStore().monitor(
            user_id=firebase_uid, account_id=payload.account_id
        )
        # Whether the stored monitor still matches the live grant. When it does
        # not (a reconnect elsewhere), the client can silently rebind it instead
        # of asking the owner to connect mail again.
        epoch = (
            await selected_mail_epoch_digest(user_id=firebase_uid, account_id=payload.account_id)
            if mail_connected
            else None
        )
        return {
            "account_id": payload.account_id,
            "mail_connected": mail_connected,
            **monitor_status(
                monitor, current_epoch=epoch, background_available=_background_available()
            ),
        }
    except Exception as exc:
        raise _http(exc) from None


@router.post("/preferences")
async def preferences(
    payload: PreferenceChange,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase),
    owner: dict = Depends(hub_content_owner),
):
    _available()
    _owner(payload.user_id, firebase_uid, owner)
    response.headers["Cache-Control"] = "private, no-store"
    try:
        if payload.enabled and payload.notifications_enabled and not _background_available():
            raise FollowupStateError("background_reminders_unavailable")
        if payload.enabled and (
            payload.historical_start_at is None
            or payload.time_zone is None
            or payload.historical_start_at.tzinfo is None
            or payload.historical_start_at < datetime.now(UTC) - timedelta(days=366)
        ):
            raise FollowupStateError("invalid_historical_period")
        grant = (
            await open_selected_mail_grant(user_id=firebase_uid, account_id=payload.account_id)
            if payload.enabled
            else None
        )
        monitor = await CalendarEmailFollowupStore().configure(
            user_id=firebase_uid,
            account_id=payload.account_id,
            enabled=payload.enabled,
            grant_epoch_digest=grant.epoch_digest if grant else "0" * 64,
            provider_subject_sha256=grant.provider_subject_sha256 if grant else "0" * 64,
            mail_generation=grant.mail_generation
            if grant
            else "00000000-0000-0000-0000-000000000000",
            calendar_connected_at=grant.calendar_connected_at if grant else datetime.now(UTC),
            calendar_grant_revision=grant.calendar_grant_revision if grant else None,
            historical_start_at=payload.historical_start_at or datetime.now(UTC),
            time_zone=payload.time_zone or "UTC",
            notifications_enabled=payload.notifications_enabled,
            reminder_lead_days=payload.reminder_lead_days,
            reminder_hour=payload.reminder_hour,
        )
        return {
            "account_id": payload.account_id,
            "monitoring_enabled": bool(monitor),
            "scan_state": monitor.scan_state if monitor else "off",
        }
    except Exception as exc:
        raise _http(exc) from None


@router.post("/list")
async def list_followups(
    payload: ListSelection,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase),
    owner: dict = Depends(hub_content_owner),
):
    _available()
    _owner(payload.user_id, firebase_uid, owner)
    response.headers["Cache-Control"] = "private, no-store"
    try:
        store, monitor, grant = await _current_monitor(firebase_uid, payload.account_id)
        result = await store.list_conversations(monitor, limit=50, offset=payload.offset)
        await _require_current(store, monitor, grant)
        return result
    except Exception as exc:
        raise _http(exc) from None


@router.post("/detail")
async def detail_followup(
    payload: ConversationSelection,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase),
    owner: dict = Depends(hub_content_owner),
):
    _available()
    _owner(payload.user_id, firebase_uid, owner)
    response.headers["Cache-Control"] = "private, no-store"
    try:
        store, monitor, grant = await _current_monitor(firebase_uid, payload.account_id)
        result = await store.detail(monitor, str(payload.conversation_id))
        await _require_current(store, monitor, grant)
        return result
    except Exception as exc:
        raise _http(exc) from None


@router.post("/resolve")
async def resolve_followup(
    payload: RequestSelection,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase),
    owner: dict = Depends(hub_content_owner),
):
    _available()
    _owner(payload.user_id, firebase_uid, owner)
    response.headers["Cache-Control"] = "private, no-store"
    try:
        store, monitor, grant = await _current_monitor(firebase_uid, payload.account_id)
        conversation_id = await store.conversation_for_request(monitor, str(payload.request_id))
        await _require_current(store, monitor, grant)
        return {"account_id": payload.account_id, "conversation_id": conversation_id}
    except Exception as exc:
        raise _http(exc) from None


@router.post("/source")
async def source_message(
    payload: RequestSelection,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase),
    owner: dict = Depends(hub_content_owner),
):
    _available()
    _owner(payload.user_id, firebase_uid, owner)
    response.headers["Cache-Control"] = "private, no-store"
    try:
        store, monitor, grant = await _current_monitor(firebase_uid, payload.account_id)
        message_id = await store.source_message_id(monitor, str(payload.request_id))
        async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
            message = await read_complete_message(
                client=client,
                token=grant.token,
                message_id=message_id,
                require_current=lambda: _require_current(store, monitor, grant),
            )
        await _require_current(store, monitor, grant)
        return {
            "request_id": str(payload.request_id),
            "account_id": payload.account_id,
            "subject": message.subject,
            "sender": message.sender,
            # Links and image markers are removed; the original stays in Gmail.
            "body": sanitize_source_body(message.body),
            "gmail_message_id": message_id,
            "internal_date_ms": message.internal_date_ms,
        }
    except Exception as exc:
        raise _http(exc) from None


@router.post("/source/link")
async def source_link(
    payload: RequestSelection,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase),
    owner: dict = Depends(hub_content_owner),
):
    """The Gmail message reference for one request, without reading the message."""
    _available()
    _owner(payload.user_id, firebase_uid, owner)
    response.headers["Cache-Control"] = "private, no-store"
    try:
        store, monitor, grant = await _current_monitor(firebase_uid, payload.account_id)
        message_id = await store.source_message_id(monitor, str(payload.request_id))
        await _require_current(store, monitor, grant)
        return {
            "request_id": str(payload.request_id),
            "account_id": payload.account_id,
            "gmail_message_id": message_id,
        }
    except Exception as exc:
        raise _http(exc) from None


@router.post("/request")
async def change_request(
    payload: RequestChange,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase),
    owner: dict = Depends(hub_content_owner),
):
    _available()
    _owner(payload.user_id, firebase_uid, owner)
    response.headers["Cache-Control"] = "private, no-store"
    try:
        store, monitor, grant = await _current_monitor(firebase_uid, payload.account_id)
        result = await store.mutate_request(
            monitor,
            request_id=str(payload.request_id),
            expected_revision=payload.expected_revision,
            idempotency_key=str(payload.idempotency_key),
            action=payload.action,
            reminder_at=payload.reminder_at,
        )
        await _require_current(store, monitor, grant)
        return result
    except Exception as exc:
        raise _http(exc) from None


@router.post("/booking/confirm")
async def confirm_booking(
    payload: BookingConfirmed,
    response: Response,
    firebase_uid: str = Depends(hub_content_firebase),
    owner: dict = Depends(hub_content_owner),
):
    _available()
    _owner(payload.user_id, firebase_uid, owner)
    response.headers["Cache-Control"] = "private, no-store"
    try:
        store, monitor, grant = await _current_monitor(firebase_uid, payload.account_id)
        event_result = await account_schedule(payload.account_id).calendar.get_event(
            user_id=firebase_uid,
            calendar_id="primary",
            event_id=payload.event_id,
        )
        event = event_result.get("event") or {}
        if event.get("id") != payload.event_id or event.get("status") == "cancelled":
            raise FollowupStateError("invalid_booking_event")
        await _require_current(store, monitor, grant)
        result = await store.record_booking(
            monitor,
            request_id=str(payload.request_id),
            expected_revision=payload.expected_revision,
            idempotency_key=str(payload.idempotency_key),
            event_id=payload.event_id,
        )
        await _require_current(store, monitor, grant)
        return result
    except Exception as exc:
        raise _http(exc) from None


@router.post("/scan")
async def refresh_followups(
    payload: ScanRequest,
    firebase_uid: str = Depends(hub_content_firebase),
    owner: dict = Depends(hub_content_owner),
):
    _available()
    _owner(payload.user_id, firebase_uid, owner)
    try:
        # Without Retry this honors the monitor's own schedule, so opening
        # Insights repeatedly never repeats work: a recently verified or backing
        # off account answers "not_due" without contacting Gmail.
        return await scan_once(
            user_id=firebase_uid, account_id=payload.account_id, force=payload.retry
        )
    except Exception as exc:
        raise _http(exc) from None


@router.post("/mail/connect/start")
async def start_selected_mail(
    payload: MailConnectStart,
    firebase_uid: str = Depends(hub_content_firebase),
):
    _available()
    _owner(payload.user_id, firebase_uid)
    if payload.account_id == "default":
        raise HTTPException(status_code=422, detail={"code": "USE_PRIMARY_GMAIL_CONNECTION"})
    try:
        google = get_google_connection_service()
        selected = await google._calendar_account(firebase_uid, payload.account_id)
        if not selected or selected.get("status") != "connected":
            raise SelectedMailAccessError("calendar_account_unavailable")
        return await google.start(
            user_id=firebase_uid,
            service="gmail",
            access_level="read",
            redirect_uri=payload.redirect_uri,
            login_hint=selected.get("provider_email"),
            calendar_additional=True,
            calendar_account_id=payload.account_id,
        )
    except Exception as exc:
        raise _http(exc) from None


@router.post("/mail/connect/complete")
async def complete_selected_mail(
    payload: MailConnectComplete,
    firebase_uid: str = Depends(hub_content_firebase),
):
    _available()
    _owner(payload.user_id, firebase_uid)
    if payload.account_id == "default":
        raise HTTPException(status_code=422, detail={"code": "USE_PRIMARY_GMAIL_CONNECTION"})
    try:
        result = await get_google_connection_service().complete(
            user_id=firebase_uid,
            code=payload.code,
            state=payload.state,
            redirect_uri=payload.redirect_uri,
            expected_service="gmail",
            require_calendar_additional=True,
            expected_calendar_account_id=payload.account_id,
        )
        if result.get("completed_account_id") != payload.account_id:
            raise SelectedMailAccessError("mail_grant_changed")
        return result
    except Exception as exc:
        raise _http(exc) from None
