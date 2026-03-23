# api/routes/kai/decisions.py
"""
Kai Decision Endpoints — reads decision projections from PKM mutation events.

Legacy summary parsing is retained only as a fallback for older records.
Write operations remain client-side via POST /api/pkm/store-domain.
"""

import logging
from typing import Dict, List

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from api.middleware import require_vault_owner_token
from hushh_mcp.services.personal_knowledge_model_service import get_pkm_service

logger = logging.getLogger(__name__)

router = APIRouter()


# ============================================================================
# MODELS
# ============================================================================


class DecisionHistoryResponse(BaseModel):
    decisions: List[Dict]
    total: int


# ============================================================================
# ENDPOINTS
# ============================================================================


@router.get("/decisions/{user_id}", response_model=DecisionHistoryResponse)
async def get_decision_history(
    user_id: str,
    limit: int = Query(default=50, le=100),
    offset: int = Query(default=0, ge=0),
    token_data: dict = Depends(require_vault_owner_token),
):
    """
    Get decision history from mutation events, with legacy summary fallback.
    REQUIRES: VAULT_OWNER consent token.
    """
    if token_data.get("user_id") != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token user_id does not match request user_id",
        )

    pkm_service = get_pkm_service()
    decisions: list[dict] = await pkm_service.get_recent_decision_records(
        user_id,
        limit=limit + offset,
    )
    if not decisions:
        index = await pkm_service.get_index_v2(user_id)
        domain_summaries = index.domain_summaries if index and index.domain_summaries else {}
        financial_summary = (
            domain_summaries.get("financial")
            if isinstance(domain_summaries.get("financial"), dict)
            else {}
        )
        decisions = pkm_service._extract_decision_records(financial_summary)

    # Pagination
    total = len(decisions)
    decisions = decisions[offset : offset + limit]

    return DecisionHistoryResponse(decisions=decisions, total=total)


@router.post("/decision/store", status_code=status.HTTP_410_GONE)
async def store_decision_gone():
    """
    GONE — use POST /api/pkm/store-domain with domain='financial'.
    """
    raise HTTPException(
        status_code=410,
        detail="Gone. Use POST /api/pkm/store-domain with domain='financial'.",
    )


@router.get("/decision/{decision_id}", status_code=status.HTTP_410_GONE)
async def get_decision_detail_gone(decision_id: int):
    """
    GONE — individual decision lookup is no longer supported.
    Use GET /api/kai/decisions/{user_id} to list all decisions.
    """
    raise HTTPException(
        status_code=410,
        detail="Gone. Use GET /api/kai/decisions/{user_id} instead.",
    )


@router.delete("/decision/{decision_id}", status_code=status.HTTP_410_GONE)
async def delete_decision_gone(decision_id: int):
    """
    GONE — use POST /api/pkm/store-domain to overwrite decisions.
    """
    raise HTTPException(
        status_code=410,
        detail="Gone. Use POST /api/pkm/store-domain with domain='financial'.",
    )
