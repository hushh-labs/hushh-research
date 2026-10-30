"""Which text model runs a person's agent: read the catalog, record their choice.

The catalog is served rather than compiled into the client so a new generation reaches
every surface the moment the backend knows about it, with no frontend release and no
environment variable in the browser.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from api.middleware import require_firebase_auth, require_firebase_auth_read_only
from hushh_mcp.services import private_text_processing_approval_service as private_approval
from hushh_mcp.services.model_preference_service import (
    ModelPreferenceError,
    get_preference,
    set_preference,
)

router = APIRouter(prefix="/api/one/models", tags=["one-models"])


class ModelPreferenceRequest(BaseModel):
    """An empty or absent model clears the choice and follows the deployment default."""

    model_id: str | None = Field(default=None, max_length=128)


@router.get("/preference")
async def read_model_preference(
    user_id: str = Depends(require_firebase_auth_read_only),
) -> dict[str, Any]:
    preference: dict[str, Any] = await get_preference(user_id=user_id)
    return preference


@router.put("/preference")
async def write_model_preference(
    payload: ModelPreferenceRequest,
    user_id: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    try:
        preference: dict[str, Any] = await set_preference(
            user_id=user_id, model_id=payload.model_id
        )
    except ModelPreferenceError as exc:
        raise HTTPException(
            status_code=400, detail={"code": exc.code, "message": str(exc)}
        ) from exc
    return preference


class PrivateTextApprovalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: StrictBool
    expected_generation: UUID | None
    disclosure_version: str | None = Field(default=None, max_length=64)


@router.get("/private-text-approval")
async def read_private_text_approval(
    response: Response,
    include_policy: bool = False,
    include_processing_provider: bool = False,
    user_id: str = Depends(require_firebase_auth_read_only),
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    try:
        approval: dict[str, Any] = await private_approval.get_private_text_approval(
            user_id=user_id,
            **({"include_policy": True} if include_policy else {}),
            **({"include_processing_provider": True} if include_processing_provider else {}),
        )
        return approval
    except private_approval.PrivateTextApprovalError as exc:
        raise HTTPException(
            status_code=exc.status_code, detail={"code": exc.code, "message": str(exc)}
        ) from None


@router.put("/private-text-approval")
async def write_private_text_approval(
    payload: PrivateTextApprovalRequest,
    response: Response,
    include_policy: bool = False,
    include_processing_provider: bool = False,
    user_id: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "private, no-store"
    try:
        approval: dict[str, Any] = await private_approval.set_private_text_approval(
            user_id=user_id,
            enabled=payload.enabled,
            expected_generation=(
                str(payload.expected_generation)
                if payload.expected_generation is not None
                else None
            ),
            disclosure_version=payload.disclosure_version,
            **({"include_policy": True} if include_policy else {}),
            **({"include_processing_provider": True} if include_processing_provider else {}),
        )
        return approval
    except private_approval.PrivateTextApprovalError as exc:
        raise HTTPException(
            status_code=exc.status_code, detail={"code": exc.code, "message": str(exc)}
        ) from None
