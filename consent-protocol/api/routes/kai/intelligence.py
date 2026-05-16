# api/routes/kai/intelligence.py
"""
Kai Intelligence API Layer — closes #386

Surfaces the Intelligence layer as a first-class API:

  GET  /intelligence/capabilities
       Returns the full capability manifest: agents, risk profiles,
       data providers, limits, and streaming support.  No auth required —
       callers use this to discover what the system can do before committing
       to a more expensive analysis call.

  POST /intelligence/batch
       Concurrent multi-ticker analysis (up to 5 tickers).
       Wraps KaiOrchestrator for each ticker, runs them in parallel via
       asyncio.gather, and tolerates per-ticker failures — a failed ticker
       returns an error object rather than aborting the whole batch.
       Requires VAULT_OWNER token.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator

from api.middleware import require_vault_owner_token
from hushh_mcp.operons.kai.fetchers import RealtimeDataUnavailable

logger = logging.getLogger(__name__)

router = APIRouter()

_BATCH_LIMIT = 5

# ---------------------------------------------------------------------------
# Capability manifest (static — describes the shipped intelligence layer)
# ---------------------------------------------------------------------------

_CAPABILITIES: Dict[str, Any] = {
    "version": "1.0",
    "analysis_modes": ["single", "batch"],
    "agents": [
        {
            "id": "fundamental",
            "description": "Business health, competitive moat, and SEC filing analysis",
            "data_sources": ["edgar", "fmp", "finnhub"],
        },
        {
            "id": "sentiment",
            "description": "Market mood, news analysis, and analyst ratings",
            "data_sources": ["finnhub", "fmp"],
        },
        {
            "id": "valuation",
            "description": "Fair value estimation, P/E multiples, and peer comparisons",
            "data_sources": ["fmp", "yfinance"],
        },
    ],
    "risk_profiles": ["conservative", "balanced", "aggressive"],
    "processing_modes": ["on_device", "hybrid"],
    "data_providers": {
        "primary": "finnhub",
        "fallback_chain": ["finnhub", "fmp", "yfinance"],
        "fundamentals": "edgar",
    },
    "debate": {
        "rounds": 2,
        "consensus_threshold": 0.70,
        "agent_count": 3,
    },
    "batch": {
        "max_tickers": _BATCH_LIMIT,
        "concurrency": "parallel",
        "partial_failure": "tolerated",
    },
    "streaming": {
        "supported": True,
        "protocol": "SSE",
        "endpoint": "/api/kai/analyze/stream",
    },
    "decisions": ["buy", "hold", "reduce"],
}


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class BatchAnalyzeRequest(BaseModel):
    user_id: str = Field(min_length=1, max_length=128)
    tickers: List[str] = Field(
        min_length=1,
        description=f"List of tickers to analyse (max {_BATCH_LIMIT})",
    )
    consent_token: Optional[str] = Field(default=None, max_length=2048)
    risk_profile: Literal["conservative", "balanced", "aggressive"] = "balanced"
    processing_mode: Literal["on_device", "hybrid"] = "hybrid"
    context: Optional[Dict[str, Any]] = None

    @field_validator("tickers")
    @classmethod
    def validate_tickers(cls, v: List[str]) -> List[str]:
        if len(v) > _BATCH_LIMIT:
            raise ValueError(f"Batch limit is {_BATCH_LIMIT} tickers per request")
        cleaned = [t.strip().upper() for t in v if t.strip()]
        if not cleaned:
            raise ValueError("At least one non-empty ticker is required")
        return cleaned


class BatchTickerResult(BaseModel):
    ticker: str
    status: Literal["ok", "error"]
    # Populated on success
    decision_id: Optional[str] = None
    decision: Optional[str] = None
    confidence: Optional[float] = None
    headline: Optional[str] = None
    raw_card: Optional[Dict[str, Any]] = None
    # Populated on failure
    error_code: Optional[str] = None
    error_message: Optional[str] = None


class BatchAnalyzeResponse(BaseModel):
    user_id: str
    risk_profile: str
    processing_mode: str
    results: List[BatchTickerResult]
    total: int
    succeeded: int
    failed: int


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/intelligence/capabilities")
async def intelligence_capabilities() -> Dict[str, Any]:
    """Return the Kai intelligence capability manifest.

    No authentication required — callers use this to discover available
    agents, risk profiles, data providers, and system limits before
    making analysis requests.
    """
    return _CAPABILITIES


@router.post("/intelligence/batch", response_model=BatchAnalyzeResponse)
async def intelligence_batch_analyze(
    request: BatchAnalyzeRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> BatchAnalyzeResponse:
    """Run concurrent multi-ticker analysis (up to 5 tickers per request).

    Each ticker is analysed independently by the full three-agent debate
    pipeline.  Per-ticker failures are tolerated — a failed ticker returns
    an error object rather than aborting the whole batch.

    Requires VAULT_OWNER token.
    """
    from hushh_mcp.agents.kai.orchestrator import KaiOrchestrator

    if token_data["user_id"] != request.user_id:
        logger.warning(
            "[Intelligence] user_id mismatch — token=%s request=%s",
            token_data["user_id"],
            request.user_id,
        )
        raise HTTPException(status_code=403, detail="User ID does not match authenticated token")

    token_to_use = request.consent_token or token_data["token"]

    async def _analyse_one(ticker: str) -> BatchTickerResult:
        try:
            orchestrator = KaiOrchestrator(
                user_id=request.user_id,
                risk_profile=request.risk_profile,
                processing_mode=request.processing_mode,
            )
            card = await orchestrator.analyze(
                ticker=ticker,
                consent_token=token_to_use,
                context=request.context,
            )
            raw_dict = json.loads(orchestrator.decision_generator.to_json(card))
            return BatchTickerResult(
                ticker=ticker,
                status="ok",
                decision_id=card.decision_id,
                decision=card.decision,
                confidence=card.confidence,
                headline=card.headline,
                raw_card=raw_dict,
            )
        except RealtimeDataUnavailable as exc:
            logger.warning("[Intelligence] realtime data unavailable for %s: %s", ticker, exc)
            return BatchTickerResult(
                ticker=ticker,
                status="error",
                error_code="realtime_unavailable",
                error_message="Required market data is temporarily unavailable.",
            )
        except ValueError as exc:
            logger.warning("[Intelligence] invalid ticker %s: %s", ticker, exc)
            return BatchTickerResult(
                ticker=ticker,
                status="error",
                error_code="invalid_ticker",
                error_message="Invalid ticker or analysis parameters.",
            )
        except Exception as exc:
            logger.exception("[Intelligence] unexpected error for ticker %s", ticker)
            return BatchTickerResult(
                ticker=ticker,
                status="error",
                error_code="internal_error",
                error_message="Analysis temporarily unavailable.",
            )

    results: List[BatchTickerResult] = await asyncio.gather(
        *[_analyse_one(t) for t in request.tickers]
    )

    succeeded = sum(1 for r in results if r.status == "ok")
    failed = len(results) - succeeded

    logger.info(
        "[Intelligence] batch complete — tickers=%s succeeded=%d failed=%d",
        request.tickers,
        succeeded,
        failed,
    )

    return BatchAnalyzeResponse(
        user_id=request.user_id,
        risk_profile=request.risk_profile,
        processing_mode=request.processing_mode,
        results=results,
        total=len(results),
        succeeded=succeeded,
        failed=failed,
    )
