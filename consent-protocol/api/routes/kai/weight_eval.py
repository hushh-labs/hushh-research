"""Kai weight-eval observability routes."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from api.middleware import require_vault_owner_token
from hushh_mcp.services.kai_weight_eval_service import get_kai_weight_eval_service

router = APIRouter()


class KaiWeightEvalArtifactsResponse(BaseModel):
    user_id: str
    runs: list[dict] = Field(default_factory=list)
    promotions: list[dict] = Field(default_factory=list)
    artifact_count: int = 0


@router.get("/weight-eval/artifacts", response_model=KaiWeightEvalArtifactsResponse)
async def get_weight_eval_artifacts(
    user_id: str = Query(..., min_length=1),
    limit: int = Query(default=20, ge=1, le=200),
    token_data: dict = Depends(require_vault_owner_token),
):
    if token_data.get("user_id") != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token user_id does not match request user_id",
        )

    service = get_kai_weight_eval_service()
    payload = await service.fetch_recent_weight_eval_artifacts(user_id=user_id, limit=limit)
    return KaiWeightEvalArtifactsResponse(**payload)
