"""Owner-authorized public-profile discovery and terminal PKM handoff routes."""

from __future__ import annotations

from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes.one.location import _user_id
from hushh_mcp.services.public_profile_discovery_service import (
    CONSENT_VERSION,
    ProfileDiscoveryError,
    PublicProfileDiscoveryService,
)

router = APIRouter(prefix="/api/one/profile-discovery", tags=["One Profile Discovery"])


class DiscoveryStartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    consent: bool
    consent_version: str = Field(alias="consentVersion", min_length=1, max_length=80)
    external_phone_consent: bool = Field(default=False, alias="externalPhoneConsent")
    name: str | None = Field(default=None, min_length=1, max_length=160)
    email: str | None = Field(default=None, max_length=254)
    profile_url: str | None = Field(default=None, alias="profileUrl", max_length=500)
    employer: str | None = Field(default=None, max_length=120)
    city: str | None = Field(default=None, max_length=120)


class DiscoveryAnchorsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    name: str | None = Field(default=None, min_length=1, max_length=160)
    email: str | None = Field(default=None, max_length=254)
    profile_url: str | None = Field(default=None, alias="profileUrl", max_length=500)
    employer: str | None = Field(default=None, max_length=120)
    city: str | None = Field(default=None, max_length=120)


class DiscoveryClaimRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    profile_revision: int = Field(alias="profileRevision", ge=1)
    idempotency_key: UUID = Field(alias="idempotencyKey")
    reject_all: bool = Field(default=False, alias="rejectAll")
    accepted_count: int = Field(default=0, alias="acceptedCount", ge=0, le=100)


class ClaimCard(BaseModel):
    model_config = ConfigDict(extra="forbid")
    card_id: str = Field(min_length=1, max_length=200)
    domain: str = Field(min_length=1, max_length=100)


class PrepareClaimRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    profile_revision: int = Field(alias="profileRevision", ge=1)
    operation_key: UUID = Field(alias="operationKey")
    cards: list[ClaimCard] = Field(min_length=1, max_length=100)


class EncryptedDiscoveryDraftRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    profile_revision: int = Field(alias="profileRevision", ge=1)
    ciphertext: str = Field(min_length=1, max_length=262144)
    iv: str = Field(min_length=16, max_length=32)
    tag: str = Field(min_length=20, max_length=32)
    algorithm: Literal["aes-256-gcm"]


def _service() -> PublicProfileDiscoveryService:
    return PublicProfileDiscoveryService()


def _status_only(job: dict[str, Any] | None) -> dict[str, Any] | None:
    """Pre-vault surfaces receive lifecycle metadata, never review contents."""
    if job is None:
        return None
    return {key: value for key, value in job.items() if key not in {"profile", "encrypted_draft"}}


def _raise_service_error(exc: Exception) -> None:
    if isinstance(exc, ProfileDiscoveryError):
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": str(exc)},
        ) from exc
    raise HTTPException(
        status_code=503,
        detail={
            "code": "PROFILE_DISCOVERY_UNAVAILABLE",
            "message": "Profile discovery is temporarily unavailable.",
        },
        headers={"Retry-After": "5"},
    ) from exc


@router.get("")
async def get_profile_discovery(firebase_uid: str = Depends(require_firebase_auth)):
    try:
        return {"job": _status_only(await _service().status(user_id=firebase_uid))}
    except Exception as exc:  # noqa: BLE001
        _raise_service_error(exc)


@router.post("/start")
async def start_profile_discovery(
    payload: DiscoveryStartRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    if payload.consent_version != CONSENT_VERSION or payload.consent is not True:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "CONSENT_REQUIRED",
                "message": "Explicit public-web discovery consent is required.",
            },
        )
    try:
        return {
            "job": _status_only(
                await _service().start(
                    user_id=firebase_uid,
                    consent=payload.consent,
                    consent_version=payload.consent_version,
                    external_phone_consent=payload.external_phone_consent,
                    name=payload.name,
                    email=payload.email,
                    profile_url=payload.profile_url,
                    employer=payload.employer,
                    city=payload.city,
                )
            )
        }
    except Exception as exc:  # noqa: BLE001
        _raise_service_error(exc)


@router.post("/anchors")
async def submit_profile_anchors(
    payload: DiscoveryAnchorsRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    try:
        return {
            "job": _status_only(
                await _service().submit_anchors(
                    user_id=firebase_uid,
                    name=payload.name,
                    email=payload.email,
                    profile_url=payload.profile_url,
                    employer=payload.employer,
                    city=payload.city,
                )
            )
        }
    except Exception as exc:  # noqa: BLE001
        _raise_service_error(exc)


@router.post("/claim")
async def complete_profile_claim(
    payload: DiscoveryClaimRequest,
    token_data: dict[str, Any] = Depends(require_vault_owner_token),
):
    try:
        return {
            "job": await _service().complete_claim(
                user_id=_user_id(token_data),
                revision=payload.profile_revision,
                idempotency_key=payload.idempotency_key,
                reject_all=payload.reject_all,
                accepted_count=payload.accepted_count,
            )
        }
    except Exception as exc:  # noqa: BLE001
        _raise_service_error(exc)


@router.get("/review")
async def get_profile_review(token_data: dict[str, Any] = Depends(require_vault_owner_token)):
    try:
        return {"job": await _service().status(user_id=_user_id(token_data))}
    except Exception as exc:  # noqa: BLE001
        _raise_service_error(exc)


@router.post("/draft")
async def save_encrypted_profile_draft(
    payload: EncryptedDiscoveryDraftRequest,
    token_data: dict[str, Any] = Depends(require_vault_owner_token),
):
    try:
        return {
            "job": await _service().save_encrypted_draft(
                user_id=_user_id(token_data),
                revision=payload.profile_revision,
                ciphertext=payload.ciphertext,
                iv=payload.iv,
                tag=payload.tag,
                algorithm=payload.algorithm,
            )
        }
    except Exception as exc:  # noqa: BLE001
        _raise_service_error(exc)


@router.post("/cancel")
async def cancel_profile_discovery(firebase_uid: str = Depends(require_firebase_auth)):
    try:
        return {"job": _status_only(await _service().cancel(user_id=firebase_uid))}
    except Exception as exc:  # noqa: BLE001
        _raise_service_error(exc)


@router.post("/claim/prepare")
async def prepare_profile_claim(
    payload: PrepareClaimRequest, token_data: dict[str, Any] = Depends(require_vault_owner_token)
):
    try:
        return await _service().prepare_claim(
            user_id=_user_id(token_data),
            revision=payload.profile_revision,
            operation_key=payload.operation_key,
            cards=[card.model_dump() for card in payload.cards],
        )
    except Exception as exc:  # noqa: BLE001
        _raise_service_error(exc)
