from __future__ import annotations

import logging
import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator

from api.middleware import require_firebase_auth
from hushh_mcp.services.insight_feedback_service import (
    InsightFeedbackDuplicateError,
    InsightFeedbackPersistenceError,
    get_insight_feedback_service,
)

router = APIRouter(prefix="/api/feedback", tags=["Feedback"])
logger = logging.getLogger(__name__)

_STOCK_PATTERN = re.compile(r"^[A-Z][A-Z0-9.\-]{0,14}$")


class InsightFeedbackRequest(BaseModel):
    stock: str = Field(..., min_length=1, max_length=15)
    insight: str = Field(..., min_length=1, max_length=2000)
    confidence: float = Field(..., ge=0.0, le=100.0)
    rating: Literal["up", "down"]

    @field_validator("stock")
    @classmethod
    def validate_stock(cls, value: str) -> str:
        normalized = str(value or "").strip().upper()
        if not _STOCK_PATTERN.fullmatch(normalized):
            raise ValueError("stock must be a valid ticker-like symbol")
        return normalized

    @field_validator("insight")
    @classmethod
    def validate_insight(cls, value: str) -> str:
        normalized = str(value or "").strip()
        if not normalized:
            raise ValueError("insight must not be empty")
        return normalized

    @field_validator("confidence")
    @classmethod
    def normalize_confidence(cls, value: float) -> float:
        normalized = float(value)
        if normalized > 1.0:
            normalized = normalized / 100.0
        if normalized < 0.0 or normalized > 1.0:
            raise ValueError("confidence must be between 0 and 1, or 0 and 100")
        return round(normalized, 4)


class InsightFeedbackAggregates(BaseModel):
    thumbs_up_count: int
    thumbs_down_count: int
    total_count: int


class InsightFeedbackResponse(BaseModel):
    success: bool = True
    message: str
    aggregates: InsightFeedbackAggregates


@router.post("", response_model=InsightFeedbackResponse, status_code=status.HTTP_201_CREATED)
async def submit_insight_feedback(
    payload: InsightFeedbackRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    service = get_insight_feedback_service()

    try:
        result = service.create_feedback(
            user_id=firebase_uid,
            stock=payload.stock,
            insight=payload.insight,
            confidence=payload.confidence,
            rating=payload.rating,
        )
    except InsightFeedbackDuplicateError as exc:
        logger.info("Duplicate feedback request rejected for user=%s stock=%s", firebase_uid, payload.stock)
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except InsightFeedbackPersistenceError as exc:
        logger.exception(
            "Insight feedback persistence failed for user=%s stock=%s",
            firebase_uid,
            payload.stock,
        )
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    return InsightFeedbackResponse(**result)
