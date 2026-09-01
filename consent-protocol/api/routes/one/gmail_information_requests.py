"""Owner-controlled personal Gmail information-request monitoring routes."""

from __future__ import annotations

import os
from typing import Any, cast

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.concurrency import run_in_threadpool
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2 import id_token as google_id_token
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_firebase_auth, require_vault_owner_token, verify_user_id_match
from hushh_mcp.services.gmail_personal_information_request_service import (
    PersonalGmailInformationRequestError,
    get_personal_gmail_information_request_service,
)
from hushh_mcp.services.gmail_receipts_service import GmailApiError

router = APIRouter(prefix="/api/one/email/information-requests", tags=["Email Agent"])


class MonitoringPreferenceRequest(BaseModel):
    user_id: str = Field(min_length=1, max_length=128)
    enabled: bool


class ScanRequest(BaseModel):
    max_results: int = Field(default=12, ge=1, le=25)


class EnabledScanRequest(BaseModel):
    max_users: int = Field(default=20, ge=1, le=50)


class PrepareReplyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    body: str = Field(min_length=1, max_length=50_000)
    html_body: str | None = Field(default=None, max_length=50_000)
    idempotency_key: str = Field(min_length=16, max_length=256)


class SendReplyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    body: str = Field(min_length=1, max_length=50_000)
    html_body: str | None = Field(default=None, max_length=50_000)
    action_id: str = Field(min_length=1, max_length=128)


def _service():
    return get_personal_gmail_information_request_service()


def _owner_user_id(*, firebase_uid: str, token_data: dict[str, Any]) -> str:
    user_id = str(token_data.get("user_id") or "").strip()
    if not user_id or user_id != firebase_uid:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "PERSONAL_GMAIL_INFORMATION_REQUEST_OWNER_REQUIRED",
                "message": "Personal Gmail monitoring requires the current vault owner.",
            },
        )
    return user_id


def _monitor_auth_enabled() -> bool:
    raw = os.getenv("GMAIL_PERSONAL_INFORMATION_REQUEST_MONITOR_AUTH_ENABLED")
    if raw is not None:
        return raw.strip().lower() in {"1", "true", "yes", "on"}
    environment = str(os.getenv("ENVIRONMENT") or os.getenv("HUSHH_DEPLOY_ENV") or "development")
    return environment.strip().lower() not in {"development", "dev", "local", "test"}


async def _require_monitor_auth(request: Request) -> None:
    if not _monitor_auth_enabled():
        return
    audience = str(os.getenv("GMAIL_PERSONAL_INFORMATION_REQUEST_MONITOR_AUDIENCE") or "").strip()
    service_account = (
        str(os.getenv("GMAIL_PERSONAL_INFORMATION_REQUEST_MONITOR_SERVICE_ACCOUNT_EMAIL") or "")
        .strip()
        .lower()
    )
    if not audience or not service_account:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "PERSONAL_GMAIL_INFORMATION_REQUEST_MONITOR_OIDC_MISSING",
                "message": "Personal Gmail monitoring is not configured.",
            },
        )
    authorization = str(request.headers.get("authorization") or "").strip()
    token = authorization.removeprefix("Bearer ").strip()
    if not authorization.startswith("Bearer ") or not token or len(token) > 8192:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "PERSONAL_GMAIL_INFORMATION_REQUEST_MONITOR_UNAUTHORIZED",
                "message": "Personal Gmail monitoring is not authorized.",
            },
        )
    try:
        claims = await run_in_threadpool(
            google_id_token.verify_oauth2_token,
            token,
            GoogleAuthRequest(),
            audience,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "PERSONAL_GMAIL_INFORMATION_REQUEST_MONITOR_UNAUTHORIZED",
                "message": "Personal Gmail monitoring is not authorized.",
            },
        ) from exc
    email = str(claims.get("email") or "").strip().lower()
    if email != service_account or claims.get("email_verified") is not True:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "PERSONAL_GMAIL_INFORMATION_REQUEST_MONITOR_UNAUTHORIZED",
                "message": "Personal Gmail monitoring is not authorized.",
            },
        )


def _as_http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, PersonalGmailInformationRequestError):
        return HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": str(exc)},
        )
    if isinstance(exc, GmailApiError):
        return HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code or "GMAIL_UNAVAILABLE", "message": str(exc)},
        )
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={
            "code": "PERSONAL_GMAIL_INFORMATION_REQUEST_UNAVAILABLE",
            "message": "Personal Gmail monitoring is temporarily unavailable. Please try again.",
        },
    )


@router.get("/preference")
async def get_monitoring_preference(
    user_id: str,
    firebase_uid: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    verify_user_id_match(firebase_uid, user_id)
    try:
        return cast(dict[str, Any], await _service().get_preference(user_id=user_id))
    except Exception as exc:  # noqa: BLE001 - HTTP boundary sanitizes provider/database details
        raise _as_http_error(exc) from exc


@router.patch("/preference")
async def set_monitoring_preference(
    payload: MonitoringPreferenceRequest,
    firebase_uid: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    verify_user_id_match(firebase_uid, payload.user_id)
    try:
        return cast(
            dict[str, Any],
            await _service().set_preference(user_id=payload.user_id, enabled=payload.enabled),
        )
    except Exception as exc:  # noqa: BLE001 - HTTP boundary sanitizes provider/database details
        raise _as_http_error(exc) from exc


@router.get("")
async def list_information_requests(
    limit: int = 25,
    offset: int = 0,
    firebase_uid: str = Depends(require_firebase_auth),
    token_data: dict[str, Any] = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    user_id = _owner_user_id(firebase_uid=firebase_uid, token_data=token_data)
    try:
        return cast(
            dict[str, Any],
            await _service().list_workflows(user_id=user_id, limit=limit, offset=offset),
        )
    except Exception as exc:  # noqa: BLE001 - HTTP boundary sanitizes provider/database details
        raise _as_http_error(exc) from exc


@router.post("/scan")
async def scan_information_requests(
    payload: ScanRequest,
    firebase_uid: str = Depends(require_firebase_auth),
    token_data: dict[str, Any] = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    user_id = _owner_user_id(firebase_uid=firebase_uid, token_data=token_data)
    try:
        return cast(
            dict[str, Any],
            await _service().scan_recent(user_id=user_id, max_results=payload.max_results),
        )
    except Exception as exc:  # noqa: BLE001 - HTTP boundary sanitizes provider/database details
        raise _as_http_error(exc) from exc


@router.post("/{workflow_id}/prepare-reply")
async def prepare_information_request_reply(
    workflow_id: str,
    payload: PrepareReplyRequest,
    firebase_uid: str = Depends(require_firebase_auth),
    token_data: dict[str, Any] = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    user_id = _owner_user_id(firebase_uid=firebase_uid, token_data=token_data)
    try:
        return cast(
            dict[str, Any],
            await _service().prepare_reply(
                user_id=user_id,
                workflow_id=workflow_id,
                body=payload.body,
                html_body=payload.html_body,
                idempotency_key=payload.idempotency_key,
            ),
        )
    except Exception as exc:  # noqa: BLE001 - HTTP boundary sanitizes provider/database details
        raise _as_http_error(exc) from exc


@router.post("/{workflow_id}/send-reply")
async def send_information_request_reply(
    workflow_id: str,
    payload: SendReplyRequest,
    firebase_uid: str = Depends(require_firebase_auth),
    token_data: dict[str, Any] = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    user_id = _owner_user_id(firebase_uid=firebase_uid, token_data=token_data)
    try:
        return cast(
            dict[str, Any],
            await _service().send_reply(
                user_id=user_id,
                workflow_id=workflow_id,
                action_id=payload.action_id,
                body=payload.body,
                html_body=payload.html_body,
            ),
        )
    except Exception as exc:  # noqa: BLE001 - HTTP boundary sanitizes provider/database details
        raise _as_http_error(exc) from exc


@router.post("/{workflow_id}/ignore")
async def ignore_information_request(
    workflow_id: str,
    firebase_uid: str = Depends(require_firebase_auth),
    token_data: dict[str, Any] = Depends(require_vault_owner_token),
) -> dict[str, Any]:
    user_id = _owner_user_id(firebase_uid=firebase_uid, token_data=token_data)
    try:
        return cast(
            dict[str, Any],
            await _service().ignore_workflow(user_id=user_id, workflow_id=workflow_id),
        )
    except Exception as exc:  # noqa: BLE001 - HTTP boundary sanitizes provider/database details
        raise _as_http_error(exc) from exc


@router.post("/scan-enabled")
async def scan_enabled_information_request_monitors(
    payload: EnabledScanRequest,
    request: Request,
) -> dict[str, int]:
    await _require_monitor_auth(request)
    try:
        return cast(
            dict[str, int], await _service().scan_enabled_users(max_users=payload.max_users)
        )
    except Exception as exc:  # noqa: BLE001 - HTTP boundary sanitizes provider/database details
        raise _as_http_error(exc) from exc


__all__ = ["router"]
