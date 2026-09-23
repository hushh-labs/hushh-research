"""Read-only Drive connection management; no file or onward-sharing authority.

The existing shared Google owner binds credentials and attempts. File reads
remain behind the Drive MCP service and a separate authenticated invocation.
"""

from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_firebase_auth, verify_user_id_match
from hushh_mcp.services.google_connection_service import (
    GoogleConnectionError,
    get_google_connection_service,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/one/drive", tags=["One Drive"])


class DriveOwnerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str = Field(min_length=1, max_length=256)


class DriveConnectStart(DriveOwnerRequest):
    access_level: Literal["read"] = "read"
    redirect_uri: str | None = Field(default=None, max_length=2048)


class DriveConnectComplete(DriveOwnerRequest):
    code: str = Field(min_length=1, max_length=2048)
    state: str = Field(min_length=1, max_length=1024)
    redirect_uri: str | None = Field(default=None, max_length=2048)


class DriveNativeStart(BaseModel):
    model_config = ConfigDict(extra="forbid")
    access_level: Literal["read"] = "read"


class DriveNativeComplete(DriveOwnerRequest):
    access_level: Literal["read"] = "read"
    server_auth_code: str = Field(min_length=1, max_length=2048)
    state: str = Field(min_length=1, max_length=1024)


def _http(error: Exception) -> HTTPException:
    if isinstance(error, GoogleConnectionError):
        return HTTPException(
            status_code=error.status_code,
            detail={"code": "GOOGLE_DRIVE_ERROR", "message": str(error)},
        )
    # Provider bodies, credentials and SQL parameters must not enter logs.
    logger.warning("one.drive.unavailable")
    return HTTPException(
        status_code=503,
        detail={"code": "GOOGLE_DRIVE_UNAVAILABLE", "message": "Drive is temporarily unavailable."},
    )


@router.post("/connect/start")
async def start_connect(payload: DriveConnectStart, owner: str = Depends(require_firebase_auth)):
    verify_user_id_match(owner, payload.user_id)
    try:
        return await get_google_connection_service().start(
            user_id=owner,
            service="drive",
            access_level="read",
            redirect_uri=payload.redirect_uri,
            login_hint=None,
        )
    except Exception as error:
        raise _http(error) from None


@router.post("/connect/complete")
async def complete_connect(
    payload: DriveConnectComplete, owner: str = Depends(require_firebase_auth)
):
    verify_user_id_match(owner, payload.user_id)
    try:
        return await get_google_connection_service().complete(
            user_id=owner,
            code=payload.code,
            state=payload.state,
            redirect_uri=payload.redirect_uri,
            expected_service="drive",
        )
    except Exception as error:
        raise _http(error) from None


@router.post("/connect/native/start")
async def start_native_connect(
    payload: DriveNativeStart, owner: str = Depends(require_firebase_auth)
):
    try:
        return await get_google_connection_service().start_native(
            user_id=owner, service="drive", access_level="read"
        )
    except Exception as error:
        raise _http(error) from None


@router.post("/connect/native/complete")
async def complete_native_connect(
    payload: DriveNativeComplete, owner: str = Depends(require_firebase_auth)
):
    verify_user_id_match(owner, payload.user_id)
    try:
        return await get_google_connection_service().complete_native(
            user_id=owner,
            service="drive",
            access_level="read",
            server_auth_code=payload.server_auth_code,
            state=payload.state,
        )
    except Exception as error:
        raise _http(error) from None


@router.get("/status/{user_id}")
async def status(user_id: str, owner: str = Depends(require_firebase_auth)):
    verify_user_id_match(owner, user_id)
    try:
        return await get_google_connection_service().status(user_id=owner, service="drive")
    except Exception as error:
        raise _http(error) from None


@router.post("/disconnect")
async def disconnect(payload: DriveOwnerRequest, owner: str = Depends(require_firebase_auth)):
    verify_user_id_match(owner, payload.user_id)
    try:
        return await get_google_connection_service().disconnect_service(
            user_id=owner, service="drive"
        )
    except Exception as error:
        raise _http(error) from None
