from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_vault_owner_token
from db.db_client import DatabaseExecutionError
from hushh_mcp.services.kai_location_service import (
    KaiLocationError,
    KaiLocationService,
    database_error_detail,
    location_error_detail,
)

router = APIRouter(tags=["Kai Location"])


class _CamelModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class LocationContactCreateRequest(_CamelModel):
    display_name: str = Field(alias="displayName", min_length=1, max_length=120)
    tier: Literal["family", "friend"]
    auto_approve: bool = Field(default=False, alias="autoApprove")


class LocationContactUpdateRequest(_CamelModel):
    display_name: str | None = Field(default=None, alias="displayName", max_length=120)
    auto_approve: bool | None = Field(default=None, alias="autoApprove")


class LocationShareCreateRequest(_CamelModel):
    contact_id: str = Field(alias="contactId")
    point: dict[str, Any]
    duration_hours: float = Field(default=24, alias="durationHours", gt=0, le=24)
    live_mode: bool = Field(default=True, alias="liveMode")


class LocationAccessRequestCreateRequest(_CamelModel):
    token: str = Field(min_length=8)
    requester_label: str | None = Field(default=None, alias="requesterLabel", max_length=120)
    requester_message: str | None = Field(default=None, alias="requesterMessage", max_length=500)


class LocationUpdateRequest(_CamelModel):
    point: dict[str, Any]


def _service() -> KaiLocationService:
    return KaiLocationService()


def _handle_error(exc: Exception) -> HTTPException:
    if isinstance(exc, KaiLocationError):
        return HTTPException(status_code=exc.status_code, detail=location_error_detail(exc))
    if isinstance(exc, DatabaseExecutionError):
        return HTTPException(status_code=exc.status_code, detail=database_error_detail(exc))
    return HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail={"code": "LOCATION_API_FAILED", "message": "Location request failed."},
    )


def _owner_user_id(token_data: dict[str, Any]) -> str:
    return str(token_data.get("user_id") or "").strip()


def _extract_bearer_token(authorization: str | None) -> str:
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "LOCATION_UPDATE_TOKEN_MISSING", "message": "Missing Authorization header."},
        )
    stripped = authorization.strip()
    if not stripped.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "LOCATION_UPDATE_TOKEN_INVALID", "message": "Expected Bearer location update token."},
        )
    token = stripped[7:].strip()
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "LOCATION_UPDATE_TOKEN_MISSING", "message": "Missing location update token."},
        )
    return token


@router.get("/location/state")
async def get_location_state(
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return _service().list_owner_state(owner_user_id=_owner_user_id(token_data))
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/contacts")
async def create_location_contact(
    payload: LocationContactCreateRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return {
            "contact": _service().create_contact(
                owner_user_id=_owner_user_id(token_data),
                display_name=payload.display_name,
                tier=payload.tier,
                auto_approve=payload.auto_approve,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.patch("/location/contacts/{contact_id}")
async def update_location_contact(
    contact_id: str,
    payload: LocationContactUpdateRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return {
            "contact": _service().update_contact(
                owner_user_id=_owner_user_id(token_data),
                contact_id=contact_id,
                display_name=payload.display_name,
                auto_approve=payload.auto_approve,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.delete("/location/contacts/{contact_id}")
async def revoke_location_contact(
    contact_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return {
            "contact": _service().revoke_contact(
                owner_user_id=_owner_user_id(token_data),
                contact_id=contact_id,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/shares")
async def create_location_share(
    payload: LocationShareCreateRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return _service().create_share(
            owner_user_id=_owner_user_id(token_data),
            contact_id=payload.contact_id,
            point=payload.point,
            duration_hours=payload.duration_hours,
            live_mode=payload.live_mode,
        )
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.delete("/location/shares/{share_id}")
async def revoke_location_share(
    share_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return {
            "share": _service().revoke_share(
                owner_user_id=_owner_user_id(token_data),
                share_id=share_id,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/shares/stop-active")
async def stop_active_location_shares(
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return _service().stop_active_shares(owner_user_id=_owner_user_id(token_data))
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/access-requests/{request_id}/approve")
async def approve_location_access_request(
    request_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return _service().approve_access_request(
            owner_user_id=_owner_user_id(token_data),
            request_id=request_id,
        )
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/access-requests/{request_id}/deny")
async def deny_location_access_request(
    request_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return {
            "accessRequest": _service().deny_access_request(
                owner_user_id=_owner_user_id(token_data),
                request_id=request_id,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/update-sessions")
async def issue_location_update_session(
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return _service().issue_update_session(owner_user_id=_owner_user_id(token_data))
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/updates")
async def update_location_with_scoped_token(
    payload: LocationUpdateRequest,
    authorization: str | None = Header(default=None),
):
    try:
        return _service().update_with_session(
            session_token=_extract_bearer_token(authorization),
            point=payload.point,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.get("/location/shared")
async def resolve_shared_location(token: str):
    try:
        return _service().resolve_public_share(token=token)
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/shared/access-request")
async def request_shared_location_access(
    payload: LocationAccessRequestCreateRequest,
    request: Request,
):
    try:
        return _service().request_access(
            token=payload.token,
            requester_label=payload.requester_label,
            requester_message=payload.requester_message,
            metadata={
                "user_agent": request.headers.get("user-agent"),
                "source": "public_shared_location_page",
            },
        )
    except Exception as exc:
        raise _handle_error(exc) from exc
