"""Public invite resolution routes for RIA investor handshakes."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Path
from fastapi.responses import JSONResponse

from api.middleware import require_firebase_auth
from hushh_mcp.services.ria_iam_service import (
    IAMSchemaNotReadyError,
    RIAIAMPolicyError,
    RIAIAMService,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/invites", tags=["RIA Invites"])


def _iam_schema_not_ready_response(exc: Exception | None = None) -> JSONResponse:
    """Return a static 503 response.

    Internal admin commands and exception detail are suppressed to avoid
    leaking server-side implementation details to API clients (CWE-209).
    """
    if exc is not None:
        logger.warning("IAM schema not ready: %s", exc)
    return JSONResponse(
        status_code=503,
        content={
            "error": "Service temporarily unavailable. Please try again later.",
            "code": "IAM_SCHEMA_NOT_READY",
        },
    )


def _public_invite_payload(invite: dict) -> dict:
    """Return the unauthenticated invite payload without target PII."""
    redacted = dict(invite)
    for key in (
        "target_display_name",
        "target_email",
        "target_phone",
        "accepted_by_user_id",
        "accepted_request_id",
    ):
        redacted.pop(key, None)
    return redacted


@router.get("/{invite_token}")
async def get_invite(invite_token: str = Path(..., max_length=512)):
    service = RIAIAMService()
    try:
        return _public_invite_payload(await service.get_ria_invite(invite_token))
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(exc)
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post("/{invite_token}/accept")
async def accept_invite(
    invite_token: str = Path(..., max_length=512),
    firebase_uid: str = Depends(require_firebase_auth),
):
    service = RIAIAMService()
    try:
        return await service.accept_ria_invite(invite_token, firebase_uid)
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(exc)
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
