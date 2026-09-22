"""Shared callback completion for existing Google service-grant attempts."""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_firebase_auth, verify_user_id_match
from hushh_mcp.services.google_connection_service import (
    GoogleConnectionError,
    get_google_connection_service,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/one/google", tags=["One Google"])


class GoogleConnectComplete(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str = Field(min_length=1, max_length=256)
    code: str = Field(min_length=1, max_length=2048)
    state: str = Field(min_length=1, max_length=1024)
    redirect_uri: str | None = Field(default=None, max_length=2048)


@router.post("/connect/complete")
async def complete_connect(
    payload: GoogleConnectComplete, owner: str = Depends(require_firebase_auth)
):
    verify_user_id_match(owner, payload.user_id)
    try:
        return await get_google_connection_service().complete(
            user_id=owner, code=payload.code, state=payload.state, redirect_uri=payload.redirect_uri
        )
    except GoogleConnectionError as error:
        raise HTTPException(
            status_code=error.status_code,
            detail={"code": "GOOGLE_CONNECTION_ERROR", "message": str(error)},
        ) from None
    except Exception:
        logger.warning("one.google.completion_unavailable")
        raise HTTPException(
            status_code=503,
            detail={
                "code": "GOOGLE_CONNECTION_UNAVAILABLE",
                "message": "Google connection could not be completed. Please try again.",
            },
        ) from None
