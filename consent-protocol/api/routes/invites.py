"""Public invite resolution routes for RIA investor handshakes."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

from api.middleware import require_firebase_auth
from hushh_mcp.services.ria_iam_service import (
    IAMSchemaNotReadyError,
    RIAIAMPolicyError,
    RIAIAMService,
)

router = APIRouter(prefix="/api/invites", tags=["RIA Invites"])


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
async def get_invite(invite_token: str):
    service = RIAIAMService()
    try:
        return await service.get_ria_invite(invite_token)
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post("/{invite_token}/accept")
async def accept_invite(
    invite_token: str,
    firebase_uid: str = Depends(require_firebase_auth),
):
    service = RIAIAMService()
    try:
        return await service.accept_ria_invite(invite_token, firebase_uid)
    except IAMSchemaNotReadyError as exc:
        return _iam_schema_not_ready_response(str(exc))
    except RIAIAMPolicyError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
