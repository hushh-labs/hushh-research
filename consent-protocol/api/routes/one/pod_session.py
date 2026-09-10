"""The app surface of an owner pod: sessions, status and configuration.

These routes carry their own authentication. A challenge and an admission open a
session from a hub-signed binding and a proof of possession; every other route
here takes that session as a bearer. Nothing on this surface reads the hub: the
authority answering is the pod's own (``pod_session_authority``), and its record
is the pod's own log.

Roles are enforced here, once, by the dependency each route declares. An app-role
session runs turns, reads status, writes configuration and revokes subjects. A
device-role session opens the Puppy relay and nothing else; presenting it here is
refused with ``role_mismatch`` and no other information.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

from fastapi import APIRouter, Body, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from api.middlewares.rate_limit import limiter
from hushh_mcp.runtime_settings import pod_mode
from hushh_mcp.services.pod_config import PodConfigError, active_pod_config
from hushh_mcp.services.pod_session_authority import (
    ROLE_APP,
    SCOPE_POD_CONFIG,
    SCOPE_POD_REVOKE,
    SCOPE_POD_STATUS,
    PodSessionAuthority,
    PodSessionRefused,
    active_session_authority,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/pod", tags=["personal-agent"])

_ADMISSION_RATE = "30/minute"


class ChallengeRequest(BaseModel):
    subject_id: str = Field(..., alias="subjectId", min_length=1, max_length=128)
    model_config = ConfigDict(populate_by_name=True)


class AdmitRequest(BaseModel):
    binding: dict[str, Any]
    signature: str = Field(..., min_length=1, max_length=512)
    challenge_id: str = Field(..., alias="challengeId", min_length=1, max_length=128)
    nonce: str = Field(..., min_length=1, max_length=256)
    proof: str = Field(..., min_length=1, max_length=1024)
    epoch: int = Field(..., ge=1)
    model_config = ConfigDict(populate_by_name=True)


class RevokeRequest(BaseModel):
    subject_id: str = Field(..., alias="subjectId", min_length=1, max_length=128)
    at_version: Optional[int] = Field(default=None, alias="atVersion", ge=1)
    reason: str = Field(default="owner_revoked", max_length=64)
    model_config = ConfigDict(populate_by_name=True)


class ConfigRequest(BaseModel):
    changes: dict[str, Any] = Field(default_factory=dict)


def _refuse(exc: PodSessionRefused) -> HTTPException:
    return HTTPException(status_code=exc.status, detail={"code": exc.code, "message": exc.detail})


def authority_or_503() -> PodSessionAuthority:
    if not pod_mode():
        raise HTTPException(status_code=404, detail="not a pod")
    authority = active_session_authority()
    if authority is None:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "LOCAL_AUTHORITY_UNAVAILABLE",
                "message": "local authority unavailable",
            },
        )
    return authority


def bearer(authorization: Optional[str]) -> str:
    raw = str(authorization or "").strip()
    scheme, _, token = raw.partition(" ")
    return token.strip() if scheme.lower() == "bearer" else ""


def verified_session(
    authorization: Optional[str], *, role: str, scope: Optional[str] = None
) -> tuple[PodSessionAuthority, dict[str, Any]]:
    """Verify a bearer session of the given role (and scope) or refuse exactly."""
    authority = authority_or_503()
    try:
        claims = authority.verify_session(bearer(authorization), expected_role=role)
    except PodSessionRefused as exc:
        raise _refuse(exc) from exc
    if scope and scope not in set(claims.get("scopes") or []):
        raise HTTPException(
            status_code=403,
            detail={"code": "scope_not_granted", "message": f"{scope} is not in this binding"},
        )
    return authority, claims


def _session_response(token: str, claims: dict[str, Any]) -> dict[str, Any]:
    return {
        "session": token,
        "sid": claims["sid"],
        "role": claims["role"],
        "scopes": list(claims.get("scopes") or []),
        "epoch": claims["epoch"],
        "expiresAt": int(claims["exp"]) * 1000,
        "version": claims["version"],
    }


# -- admission ------------------------------------------------------------------------


@router.post("/session/challenge")
@limiter.limit(_ADMISSION_RATE)
async def pod_session_challenge(
    request: Request, payload: ChallengeRequest = Body(...)
) -> dict[str, Any]:
    authority = authority_or_503()
    try:
        await authority.require_held()
        challenge = authority.create_challenge(payload.subject_id)
    except PodSessionRefused as exc:
        raise _refuse(exc) from exc
    return {
        "challengeId": challenge["challenge_id"],
        "nonce": challenge["nonce"],
        "epoch": challenge["epoch"],
        "podKeyId": challenge["pod_key_id"],
        "expiresAt": challenge["expires_at_ms"],
        "signingPayload": challenge["signing_payload"],
    }


@router.post("/session/admit")
@limiter.limit(_ADMISSION_RATE)
async def pod_session_admit(request: Request, payload: AdmitRequest = Body(...)) -> dict[str, Any]:
    authority = authority_or_503()
    try:
        token, claims = await authority.admit(
            binding=payload.binding,
            signature=payload.signature,
            challenge_id=payload.challenge_id,
            nonce=payload.nonce,
            proof=payload.proof,
            epoch=payload.epoch,
        )
    except PodSessionRefused as exc:
        logger.info("pod_session.refused code=%s", exc.code)
        raise _refuse(exc) from exc
    return _session_response(token, claims)


@router.post("/session/renew")
async def pod_session_renew(
    authorization: Optional[str] = Header(default=None),
) -> dict[str, Any]:
    authority = authority_or_503()
    try:
        token, claims = await authority.renew(bearer(authorization))
    except PodSessionRefused as exc:
        raise _refuse(exc) from exc
    return _session_response(token, claims)


@router.post("/session/revoke")
async def pod_session_revoke(
    payload: RevokeRequest = Body(...),
    authorization: Optional[str] = Header(default=None),
) -> dict[str, Any]:
    """The owner shows a subject the door, at the pod, with no hub in the path."""
    authority, _claims = verified_session(authorization, role=ROLE_APP, scope=SCOPE_POD_REVOKE)
    try:
        await authority.require_held()
        tombstone = await authority.revoke_subject(
            payload.subject_id, at_version=payload.at_version, reason=payload.reason
        )
    except PodSessionRefused as exc:
        raise _refuse(exc) from exc
    await _close_subject_links(payload.subject_id)
    logger.info("pod_session.revoked at_version=%s", tombstone.at_version)
    return {"revoked": True, "subjectId": tombstone.subject_id, "atVersion": tombstone.at_version}


async def _close_subject_links(subject_id: str) -> None:
    """Drop any live Puppy link for a revoked device. Best effort, never raises."""
    try:
        from hushh_mcp.services.puppy_broker import BROKER  # noqa: PLC0415

        await BROKER.close_subject(subject_id)
    except Exception:  # noqa: BLE001 - the tombstone is the authority; the socket is a courtesy
        logger.debug("pod_session.close_subject_links_failed", exc_info=True)


# -- status and configuration ------------------------------------------------------------


async def _puppy_report(hushh_id: str) -> dict[str, Any]:
    try:
        from hushh_mcp.services.puppy_broker import BROKER  # noqa: PLC0415

        return await BROKER.report(hushh_id)
    except Exception:  # noqa: BLE001 - status must not fail on the broker
        return {"links": []}


@router.get("/status")
async def pod_status(authorization: Optional[str] = Header(default=None)) -> dict[str, Any]:
    """Effective configuration, identity, incarnation, subjects and build. No secrets."""
    authority, _claims = verified_session(authorization, role=ROLE_APP, scope=SCOPE_POD_STATUS)
    fence = await authority.lease.state()
    return {
        "hushhId": authority.hushh_id,
        "config": active_pod_config().as_dict(),
        "podKeyId": authority.pod_key_id,
        "environment": authority.environment,
        "epoch": authority.epoch,
        "incarnation": fence,
        "subjects": authority.subjects_report(),
        "imageTag": (os.getenv("HUSSH_POD_IMAGE_TAG") or "").strip()[:128] or None,
        "revision": (os.getenv("K_REVISION") or "").strip()[:128] or None,
        "puppy": await _puppy_report(authority.hushh_id),
    }


@router.post("/config")
async def pod_config_write(
    payload: ConfigRequest = Body(...),
    authorization: Optional[str] = Header(default=None),
) -> dict[str, Any]:
    """Owner edits to the one configuration record. Unknown fields refuse."""
    authority, _claims = verified_session(authorization, role=ROLE_APP, scope=SCOPE_POD_CONFIG)
    try:
        await authority.require_held()
    except PodSessionRefused as exc:
        raise _refuse(exc) from exc
    from hushh_mcp.services.pod_config import record_pod_config  # noqa: PLC0415
    from hushh_mcp.services.pod_memory_service import _resolve_log  # noqa: PLC0415

    try:
        config = await record_pod_config(
            _resolve_log(), hushh_id=authority.hushh_id, changes=payload.changes
        )
    except PodConfigError as exc:
        raise HTTPException(
            status_code=400, detail={"code": "POD_CONFIG_INVALID", "message": str(exc)}
        ) from exc
    logger.info("pod_config.updated fields=%s", sorted(payload.changes))
    return {"config": config.as_dict()}


__all__ = ["authority_or_503", "bearer", "router", "verified_session"]
