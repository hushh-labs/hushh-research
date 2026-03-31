"""Kai Gmail receipts connector routes."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from api.middleware import require_firebase_auth, verify_user_id_match
from hushh_mcp.services.gmail_receipts_service import GmailApiError, get_gmail_receipts_service

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Kai Gmail"])


class GmailConnectStartRequest(BaseModel):
    user_id: str = Field(min_length=1)
    redirect_uri: str | None = Field(default=None, max_length=1000)
    login_hint: str | None = Field(default=None, max_length=320)
    include_granted_scopes: bool = False


class GmailConnectCompleteRequest(BaseModel):
    user_id: str = Field(min_length=1)
    code: str = Field(min_length=1)
    state: str = Field(min_length=1)
    redirect_uri: str | None = Field(default=None, max_length=1000)


class GmailDisconnectRequest(BaseModel):
    user_id: str = Field(min_length=1)


class GmailSyncRequest(BaseModel):
    user_id: str = Field(min_length=1)


class GmailReconcileRequest(BaseModel):
    user_id: str = Field(min_length=1)


def _service():
    return get_gmail_receipts_service()


def _to_http_exception(exc: Exception) -> HTTPException:
    if isinstance(exc, GmailApiError):
        detail: dict[str, Any] = {
            "code": "GMAIL_CONNECTOR_ERROR",
            "message": str(exc),
        }
        if exc.payload:
            detail["payload"] = exc.payload
        status_code = exc.status_code if exc.status_code >= 400 else 500
        return HTTPException(status_code=status_code, detail=detail)
    return HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail={"code": "GMAIL_CONNECTOR_UNEXPECTED", "message": str(exc)},
    )


@router.post("/gmail/connect/start")
async def gmail_connect_start(
    payload: GmailConnectStartRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, payload.user_id)
    try:
        return await _service().start_connect(
            user_id=payload.user_id,
            redirect_uri=payload.redirect_uri,
            login_hint=payload.login_hint,
            include_granted_scopes=payload.include_granted_scopes,
        )
    except Exception as exc:
        logger.exception("kai.gmail.connect_start_failed user_id=%s", payload.user_id)
        raise _to_http_exception(exc) from exc


@router.post("/gmail/connect/complete")
async def gmail_connect_complete(
    payload: GmailConnectCompleteRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, payload.user_id)
    try:
        return await _service().complete_connect(
            user_id=payload.user_id,
            code=payload.code,
            state=payload.state,
            redirect_uri=payload.redirect_uri,
        )
    except Exception as exc:
        logger.exception("kai.gmail.connect_complete_failed user_id=%s", payload.user_id)
        raise _to_http_exception(exc) from exc


@router.get("/gmail/status/{user_id}")
async def gmail_status(
    user_id: str,
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, user_id)
    try:
        return await _service().get_status(user_id=user_id)
    except Exception as exc:
        logger.exception("kai.gmail.status_failed user_id=%s", user_id)
        raise _to_http_exception(exc) from exc


@router.post("/gmail/disconnect")
async def gmail_disconnect(
    payload: GmailDisconnectRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, payload.user_id)
    try:
        return await _service().disconnect(user_id=payload.user_id)
    except Exception as exc:
        logger.exception("kai.gmail.disconnect_failed user_id=%s", payload.user_id)
        raise _to_http_exception(exc) from exc


@router.post("/gmail/sync")
async def gmail_sync(
    payload: GmailSyncRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, payload.user_id)
    try:
        result = await _service().queue_sync(
            user_id=payload.user_id,
            trigger_source="manual",
        )
        return result
    except Exception as exc:
        logger.exception("kai.gmail.sync_failed user_id=%s", payload.user_id)
        raise _to_http_exception(exc) from exc


@router.post("/gmail/reconcile")
async def gmail_reconcile(
    payload: GmailReconcileRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, payload.user_id)
    try:
        return await _service().reconcile_connection(user_id=payload.user_id)
    except Exception as exc:
        logger.exception("kai.gmail.reconcile_failed user_id=%s", payload.user_id)
        raise _to_http_exception(exc) from exc


@router.get("/gmail/sync/{run_id}")
async def gmail_sync_run(
    run_id: str,
    user_id: str = Query(..., min_length=1),
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, user_id)
    try:
        run = await _service().get_sync_run(run_id=run_id, user_id=user_id)
        if run is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={
                    "code": "GMAIL_SYNC_RUN_NOT_FOUND",
                    "message": "No Gmail sync run found for this user.",
                    "run_id": run_id,
                },
            )
        return {"run": run}
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("kai.gmail.sync_run_failed user_id=%s run_id=%s", user_id, run_id)
        raise _to_http_exception(exc) from exc


@router.get("/gmail/receipts/{user_id}")
async def gmail_receipts(
    user_id: str,
    page: int = Query(1, ge=1),
    per_page: int = Query(25, ge=1, le=100),
    firebase_uid: str = Depends(require_firebase_auth),
):
    verify_user_id_match(firebase_uid, user_id)
    try:
        return await _service().list_receipts(
            user_id=user_id,
            page=page,
            per_page=per_page,
        )
    except Exception as exc:
        logger.exception("kai.gmail.receipts_failed user_id=%s", user_id)
        raise _to_http_exception(exc) from exc


@router.post("/gmail/webhook")
async def gmail_webhook(request: Request):
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "GMAIL_WEBHOOK_INVALID_JSON", "message": str(exc)},
        ) from exc

    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "GMAIL_WEBHOOK_INVALID_PAYLOAD",
                "message": "Webhook payload must be a JSON object.",
            },
        )

    try:
        return await _service().handle_push_notification(payload)
    except Exception as exc:
        logger.exception("kai.gmail.webhook_failed")
        raise _to_http_exception(exc) from exc
