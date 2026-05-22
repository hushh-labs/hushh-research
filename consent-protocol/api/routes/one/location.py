"""One Location Agent routes.

Live-location reads are authenticated and ciphertext-only. Public invite routes
are request-only and never return coordinates, ciphertext, or grants.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_vault_owner_token
from db.db_client import DatabaseExecutionError
from hushh_mcp.services.one_location_agent_service import (
    OneLocationAgentError,
    OneLocationAgentService,
    database_error_detail,
    location_error_detail,
)

router = APIRouter(prefix="/api/one", tags=["One Location Agent"])


class _CamelModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class RecipientKeyRequest(_CamelModel):
    key_id: str | None = Field(default=None, alias="keyId", min_length=8, max_length=160)
    public_key_jwk: dict[str, Any] = Field(alias="publicKeyJwk")
    algorithm: str = Field(default="ECDH-P256-AES256-GCM", max_length=80)


class CreateGrantRequest(_CamelModel):
    recipient_user_id: str = Field(alias="recipientUserId", min_length=1, max_length=160)
    recipient_key_id: str | None = Field(default=None, alias="recipientKeyId", max_length=160)
    duration_hours: float = Field(alias="durationHours", gt=0, le=24)
    reason: str | None = Field(default=None, max_length=300)


class StoreEnvelopeRequest(_CamelModel):
    envelope: dict[str, Any]


class CreateAccessRequest(_CamelModel):
    owner_user_id: str = Field(alias="ownerUserId", min_length=1, max_length=160)
    message: str | None = Field(default=None, max_length=500)


class ResolveAccessRequest(_CamelModel):
    duration_hours: float = Field(default=1, alias="durationHours", gt=0, le=24)


class ReferralRequest(_CamelModel):
    referred_user_id: str = Field(alias="referredUserId", min_length=1, max_length=160)
    message: str | None = Field(default=None, max_length=500)


class CreatePublicInviteRequest(_CamelModel):
    duration_hours: float = Field(default=1, alias="durationHours", gt=0, le=24)


class SubmitPublicInviteRequest(_CamelModel):
    visitor_display_name: str = Field(alias="visitorDisplayName", min_length=2, max_length=120)
    phone_number: str = Field(alias="phoneNumber", min_length=8, max_length=32)
    message: str | None = Field(default=None, max_length=500)


def _service() -> OneLocationAgentService:
    return OneLocationAgentService()


def _user_id(token_data: dict[str, Any]) -> str:
    return str(token_data.get("user_id") or "").strip()


def _request_fingerprint_hash(request: Request) -> str | None:
    from hushh_mcp.services.one_location_agent_service import _hash_public_value

    forwarded_for = str(request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    client_host = forwarded_for or (request.client.host if request.client else "")
    user_agent = str(request.headers.get("user-agent") or "")[:160]
    fingerprint_source = "|".join(item for item in (client_host, user_agent) if item)
    return _hash_public_value(fingerprint_source) if fingerprint_source else None


def _handle_error(exc: Exception) -> HTTPException:
    if isinstance(exc, OneLocationAgentError):
        return HTTPException(status_code=exc.status_code, detail=location_error_detail(exc))
    if isinstance(exc, DatabaseExecutionError):
        return HTTPException(status_code=exc.status_code, detail=database_error_detail(exc))
    return HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail={"code": "ONE_LOCATION_API_FAILED", "message": "Location request failed."},
    )


@router.get("/location/state")
async def get_location_state(token_data: dict = Depends(require_vault_owner_token)):
    try:
        return _service().list_state(user_id=_user_id(token_data))
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.get("/location/recipients")
async def list_verified_location_recipients(
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return {
            "recipients": _service().list_verified_recipients(owner_user_id=_user_id(token_data))
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/public-invites")
async def create_public_location_invite(
    payload: CreatePublicInviteRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return _service().create_public_invite(
            owner_user_id=_user_id(token_data),
            duration_hours=payload.duration_hours,
        )
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.get("/location/public-invites/{public_token}")
async def resolve_public_location_invite(public_token: str):
    try:
        return _service().resolve_public_invite(public_token=public_token)
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/public-invites/{public_token}/submit")
async def submit_public_location_invite(
    public_token: str,
    payload: SubmitPublicInviteRequest,
    request: Request,
):
    try:
        return _service().submit_public_invite_request(
            public_token=public_token,
            visitor_display_name=payload.visitor_display_name,
            phone_number=payload.phone_number,
            message=payload.message,
            submitter_fingerprint_hash=_request_fingerprint_hash(request),
        )
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.delete("/location/public-invites/{invite_id}")
async def revoke_public_location_invite(
    invite_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return {
            "invite": _service().revoke_public_invite(
                owner_user_id=_user_id(token_data),
                invite_id=invite_id,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/recipient-keys")
async def register_location_recipient_key(
    payload: RecipientKeyRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return {
            "recipientKey": _service().register_recipient_key(
                user_id=_user_id(token_data),
                key_id=payload.key_id,
                public_key_jwk=payload.public_key_jwk,
                algorithm=payload.algorithm,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/grants")
async def create_location_grant(
    payload: CreateGrantRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return {
            "grant": _service().create_grant(
                owner_user_id=_user_id(token_data),
                recipient_user_id=payload.recipient_user_id,
                recipient_key_id=payload.recipient_key_id,
                duration_hours=payload.duration_hours,
                reason=payload.reason,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/grants/{grant_id}/envelopes")
async def store_location_envelope(
    grant_id: str,
    payload: StoreEnvelopeRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return {
            "envelope": _service().store_encrypted_envelope(
                owner_user_id=_user_id(token_data),
                grant_id=grant_id,
                envelope=payload.envelope,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.get("/location/grants/{grant_id}/envelope")
async def view_latest_location_envelope(
    grant_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return _service().view_latest_envelope(
            recipient_user_id=_user_id(token_data),
            grant_id=grant_id,
        )
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.delete("/location/grants/{grant_id}")
async def revoke_location_grant(
    grant_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return {
            "grant": _service().revoke_grant(
                owner_user_id=_user_id(token_data),
                grant_id=grant_id,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/requests")
async def request_location_access(
    payload: CreateAccessRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return {
            "request": _service().request_access(
                requester_user_id=_user_id(token_data),
                owner_user_id=payload.owner_user_id,
                message=payload.message,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/requests/{request_id}/approve")
async def approve_location_access_request(
    request_id: str,
    payload: ResolveAccessRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return _service().approve_request(
            owner_user_id=_user_id(token_data),
            request_id=request_id,
            duration_hours=payload.duration_hours,
        )
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/requests/{request_id}/deny")
async def deny_location_access_request(
    request_id: str,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return {
            "request": _service().deny_request(
                owner_user_id=_user_id(token_data),
                request_id=request_id,
            )
        }
    except Exception as exc:
        raise _handle_error(exc) from exc


@router.post("/location/grants/{grant_id}/refer")
async def refer_location_access(
    grant_id: str,
    payload: ReferralRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    try:
        return _service().refer_recipient(
            referring_user_id=_user_id(token_data),
            grant_id=grant_id,
            referred_user_id=payload.referred_user_id,
            message=payload.message,
        )
    except Exception as exc:
        raise _handle_error(exc) from exc
