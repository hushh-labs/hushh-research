# api/routes/kai/analyze.py
"""
Kai Analysis Endpoint (Non-Streaming)

Performs 3-agent investment analysis and returns complete DecisionCard.

SECURITY: This endpoint requires VAULT_OWNER token for all data access.
No Firebase Auth fallback - consistent with Consent-First Architecture.
"""

import json
import logging
from typing import Any, Dict, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from api.middleware import require_vault_owner_token
from hushh_mcp.operons.kai.fetchers import RealtimeDataUnavailable

logger = logging.getLogger(__name__)

router = APIRouter()


# ============================================================================
# MODELS
# ============================================================================


class AnalyzeRequest(BaseModel):
    user_id: str = Field(min_length=1, max_length=128)
    ticker: str = Field(min_length=1, max_length=20)
    consent_token: Optional[str] = Field(default=None, max_length=2048)
    # Client provides context explicitly (Stateless)
    risk_profile: Literal["conservative", "balanced", "aggressive"] = "balanced"
    processing_mode: Literal["on_device", "hybrid"] = "hybrid"
    context: Optional[Dict[str, Any]] = None  # Decrypted user profile context; validated by service


class AnalyzeResponse(BaseModel):
    """
    Plaintext decision returned to Client.
    Client MUST encrypt this before storing.
    """

    decision_id: str
    ticker: str
    decision: Literal["buy", "hold", "reduce"]
    confidence: float
    headline: str
    processing_mode: str
    created_at: str
    # Full data for client to encrypt
    raw_card: Dict


# ============================================================================
# ENDPOINTS
# ============================================================================


@router.post("/analyze", response_model=AnalyzeResponse)
async def analyze_ticker(
    request: AnalyzeRequest,
    token_data: dict = Depends(require_vault_owner_token),
):
    """
    Step 1: Perform 3-agent investment analysis.

    Return PLAINTEXT result.
    Client provides `risk_profile` directly (Stateless).

    SECURITY: VAULT_OWNER token required. No Firebase Auth fallback.

    Args:
        request: API request with user_id, ticker, consent_token
        token_data: Vault owner token data from middleware (user_id, agent_id, scope)

    Raises:
        HTTPException 401 if VAULT_OWNER token is missing or invalid
        HTTPException 403 if user_id mismatch detected
    """
    from hushh_mcp.agents.kai.orchestrator import KaiOrchestrator

    # Security: Verify token matches requested user
    if token_data["user_id"] != request.user_id:
        logger.warning(
            "[Kai] User ID mismatch - token=%s, request=%s",
            token_data["user_id"],
            request.user_id,
        )
        raise HTTPException(status_code=403, detail="User ID does not match authenticated user")

    try:
        # Initialize orchestrator with Client-provided context
        orchestrator = KaiOrchestrator(
            user_id=request.user_id,
            risk_profile=request.risk_profile,
            processing_mode=request.processing_mode,
        )

        # Get token from middleware (already validated)
        token_to_use = request.consent_token or token_data["token"]

        # Run analysis (Generates Plaintext)
        decision_card = await orchestrator.analyze(
            ticker=request.ticker, consent_token=token_to_use, context=request.context
        )

        # Convert to dictionary for response
        raw_card = orchestrator.decision_generator.to_json(decision_card)
        raw_dict = json.loads(raw_card)

        logger.info("[Kai] Generated analysis for %s (%s)", request.ticker, request.risk_profile)

        return AnalyzeResponse(
            decision_id=decision_card.decision_id,
            ticker=decision_card.ticker,
            decision=decision_card.decision,
            confidence=decision_card.confidence,
            headline=decision_card.headline,
            processing_mode=decision_card.processing_mode,
            created_at=decision_card.timestamp.isoformat(),
            raw_card=raw_dict,  # Plaintext
        )

    except ValueError as e:
        logger.error("[Kai] Analysis failed: %s", e)
        raise HTTPException(
            status_code=400, detail="Invalid analysis request. Check ticker and parameters."
        )
    except RealtimeDataUnavailable as e:
        logger.error("[Kai] Realtime dependency unavailable: %s", e.detail)
        raise HTTPException(
            status_code=503,
            detail={
                "code": e.code,
                "message": "Required realtime market inputs are unavailable.",
                "dependency": e.source,
                "retryable": e.retryable,
            },
        )
    except Exception:
        logger.exception("[Kai] Unexpected error during analysis")
        raise HTTPException(status_code=500, detail="Analysis is temporarily unavailable.")
