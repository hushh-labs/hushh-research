"""
Public invite resolution routes for RIA investor handshakes.

Canonical attach point (PII strip fix):
    api.routes.invites.get_invite -> GET /api/invites/{invite_token}
    The unauthenticated GET endpoint must not return target PII (email,
    phone, display_name).  RIAIAMService.get_ria_invite() now accepts
    include_target_pii=False by default so those fields are omitted from
    the public response.  The authenticated accept path does not expose
    those fields either - they are only accessed server-side.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Path
from fastapi.responses import JSONResponse

from api.middleware import require_firebase_auth
from hushh_mcp.services.ria_iam_service import (
    IAMSchemaNotReadyError,
    RIAIAMPolicyError,
    RIAIAMService,
)

router = APIRouter(prefix="/api/invites", tags=["RIA Invites"])

# Invite tokens are base64url or UUID strings.  Restrict to safe chars
# for defense-in-depth even though the service layer uses parameterized
# queries.
_INVITE_TOKEN_PATTERN = r"^[a-zA-Z0-9_\-]+$"  # noqa: S105


def _iam_schema_not_ready_response(message: str | None = None) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={
            "error": message or "IAM schema is not ready",
            "code": "IAM_SCHEMA_NOT_READY",
            "hint": "Run `python db/migrate.py --iam` and `python db/verify/verify_iam_schema.py`.",
        },
    )


@router.get("/{invite_token}")
async def get_invite(
    invite_token: str = Path(..., max_length=512, pattern=_INVITE_TOKEN_PATTERN),
):
    """
    Resolve an RIA invite by token.

    PRIVACY: target PII (email, phone, display_name) is stripped from the
    response.  This endpoint is unauthenticated so any holder of the invite
    URL must not be able to read the invitee's personal contact details.
    """
    service = RIAIAMService()
    try:
        # include_target_pii=False (default) - strips email/phone/display_name
        return await service.get_ria_invite(invite_token, include_target_pii=False)
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post("/{invite_token}/accept")
async def accept_invite(
    invite_token: str = Path(..., max_length=512, pattern=_INVITE_TOKEN_PATTERN),
    firebase_uid: str = Depends(require_firebase_auth),
):
    service = RIAIAMService()
    try:
        return await service.accept_ria_invite(invite_token, firebase_uid)
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
