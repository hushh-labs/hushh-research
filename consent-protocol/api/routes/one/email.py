"""One mailbox KYC intake and workflow routes."""

from __future__ import annotations

import hmac
import logging
import os
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from api.middleware import require_firebase_auth, verify_user_id_match
from db.db_client import DatabaseExecutionError
from hushh_mcp.services.one_email_kyc_service import (
    OneEmailKycError,
    get_one_email_kyc_service,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one", tags=["One Email KYC"])


class WorkflowUserRequest(BaseModel):
    user_id: str = Field(min_length=1)


class DraftRejectRequest(WorkflowUserRequest):
    reason: str | None = Field(default=None, max_length=500)


_DEPENDENCY_ERROR_PATTERNS = (
    "connection refused",
    "server closed the connection unexpectedly",
    "could not connect to server",
    "timed out",
    "timeout",
    "headers timeout",
    "db operation failed",
    "sqlalchemy.exc.operationalerror",
)


def _iter_exception_chain(exc: BaseException):
    current: BaseException | None = exc
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        yield current
        current = current.__cause__ or current.__context__


def _is_dependency_unavailable_error(exc: Exception) -> bool:
    for current in _iter_exception_chain(exc):
        if isinstance(current, DatabaseExecutionError):
            return True
        if isinstance(current, (ConnectionError, OSError, TimeoutError)):
            return True
        message = str(current).strip().lower()
        if message and any(pattern in message for pattern in _DEPENDENCY_ERROR_PATTERNS):
            return True
    return False


def _to_http_exception(exc: Exception, *, operation: str) -> HTTPException:
    if _is_dependency_unavailable_error(exc):
        return HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "ONE_EMAIL_KYC_TEMPORARILY_UNAVAILABLE",
                "message": "One email KYC is temporarily unavailable. Please try again in a moment.",
                "operation": operation,
                "retryable": True,
            },
        )
    if isinstance(exc, OneEmailKycError):
        detail: dict[str, Any] = {
            "code": exc.code,
            "message": str(exc),
        }
        if exc.payload:
            detail["payload"] = exc.payload
        return HTTPException(status_code=exc.status_code, detail=detail)
    return HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail={
            "code": "ONE_EMAIL_KYC_UNEXPECTED",
            "message": "One email KYC could not complete the request.",
            "operation": operation,
        },
    )


def _service():
    return get_one_email_kyc_service()


def _watch_renew_auth_enabled() -> bool:
    raw = os.getenv("ONE_EMAIL_WATCH_RENEW_AUTH_ENABLED")
    if raw is not None:
        return raw.strip().lower() in {"1", "true", "yes", "on"}
    environment = str(os.getenv("ENVIRONMENT") or "development").strip().lower()
    return environment not in {"development", "dev", "local", "test"}


def _require_watch_renew_auth(request: Request) -> None:
    if not _watch_renew_auth_enabled():
        return
    expected = str(os.getenv("ONE_EMAIL_WATCH_RENEW_TOKEN") or "").strip()
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "ONE_EMAIL_WATCH_RENEW_TOKEN_MISSING",
                "message": "One email watch renewal token is not configured.",
            },
        )
    provided = str(request.headers.get("x-hushh-maintenance-token") or "").strip()
    if not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "ONE_EMAIL_WATCH_RENEW_UNAUTHORIZED",
                "message": "One email watch renewal is not authorized.",
            },
        )


@router.post("/email/webhook")
async def one_email_webhook(request: Request):
    headers = {key.lower(): value for key, value in request.headers.items()}
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "ONE_EMAIL_WEBHOOK_INVALID_JSON", "message": str(exc)},
        ) from exc
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "ONE_EMAIL_WEBHOOK_INVALID_PAYLOAD",
                "message": "Webhook payload must be a JSON object.",
            },
        )
    try:
        return await _service().handle_push_notification(payload, headers=headers)
    except Exception as exc:
        logger.exception("one.email.webhook_failed")
        raise _to_http_exception(exc, operation="webhook") from exc


@router.post("/email/watch/renew")
async def one_email_watch_renew(request: Request):
    _require_watch_renew_auth(request)
    try:
        return await _service().renew_watch()
    except Exception as exc:
        logger.exception("one.email.watch_renew_failed")
        raise _to_http_exception(exc, operation="watch_renew") from exc


@router.get("/kyc/workflows")
async def one_kyc_list_workflows(
    user_id: str,
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, user_id)
    try:
        return await _service().list_workflows(user_id=user_id)
    except Exception as exc:
        logger.exception("one.kyc.list_failed user_id=%s", user_id)
        raise _to_http_exception(exc, operation="list_workflows") from exc


@router.get("/kyc/workflows/{workflow_id}")
async def one_kyc_get_workflow(
    workflow_id: str,
    user_id: str,
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, user_id)
    try:
        return await _service().get_workflow(user_id=user_id, workflow_id=workflow_id)
    except Exception as exc:
        logger.exception("one.kyc.get_failed user_id=%s workflow_id=%s", user_id, workflow_id)
        raise _to_http_exception(exc, operation="get_workflow") from exc


@router.post("/kyc/workflows/{workflow_id}/refresh")
async def one_kyc_refresh_workflow(
    workflow_id: str,
    payload: WorkflowUserRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, payload.user_id)
    try:
        return await _service().refresh_workflow(user_id=payload.user_id, workflow_id=workflow_id)
    except Exception as exc:
        logger.exception(
            "one.kyc.refresh_failed user_id=%s workflow_id=%s",
            payload.user_id,
            workflow_id,
        )
        raise _to_http_exception(exc, operation="refresh_workflow") from exc


@router.post("/kyc/workflows/{workflow_id}/approve-draft")
async def one_kyc_approve_draft(
    workflow_id: str,
    payload: WorkflowUserRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, payload.user_id)
    try:
        return await _service().approve_draft(user_id=payload.user_id, workflow_id=workflow_id)
    except Exception as exc:
        logger.exception(
            "one.kyc.approve_draft_failed user_id=%s workflow_id=%s",
            payload.user_id,
            workflow_id,
        )
        raise _to_http_exception(exc, operation="approve_draft") from exc


@router.post("/kyc/workflows/{workflow_id}/reject-draft")
async def one_kyc_reject_draft(
    workflow_id: str,
    payload: DraftRejectRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, payload.user_id)
    try:
        return await _service().reject_draft(
            user_id=payload.user_id,
            workflow_id=workflow_id,
            reason=payload.reason,
        )
    except Exception as exc:
        logger.exception(
            "one.kyc.reject_draft_failed user_id=%s workflow_id=%s",
            payload.user_id,
            workflow_id,
        )
        raise _to_http_exception(exc, operation="reject_draft") from exc
