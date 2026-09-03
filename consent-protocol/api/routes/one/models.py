"""Which text model runs a person's agent: read the catalog, record their choice.

The catalog is served rather than compiled into the client so a new generation reaches
every surface the moment the backend knows about it, with no frontend release and no
environment variable in the browser.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from api.middleware import require_firebase_auth
from hushh_mcp.services.model_preference_service import (
    ModelPreferenceError,
    get_preference,
    set_preference,
)

router = APIRouter(prefix="/models", tags=["one-models"])


class ModelPreferenceRequest(BaseModel):
    """An empty or absent model clears the choice and follows the deployment default."""

    model_id: str | None = Field(default=None, max_length=128)


@router.get("/preference")
async def read_model_preference(user_id: str = Depends(require_firebase_auth)) -> dict[str, Any]:
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
