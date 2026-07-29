# api/routes/agents.py
"""
Agent chat endpoints for Kai Financial agent.

Note: Food & Dining and Professional Profile agents have been deprecated
in favor of the dynamic world model architecture.
"""

import logging

from fastapi import APIRouter, HTTPException

from api.models import ChatRequest, ChatResponse, ValidateTokenRequest
from hushh_mcp.agents.kai.agent import get_kai_agent
from hushh_mcp.consent.token import validate_token_with_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["Agents"])


# ============================================================================
# TOKEN VALIDATION
# ============================================================================


@router.post("/validate-token")
async def validate_token_endpoint(request: ValidateTokenRequest):
    """
    Validate a consent token.
    Used by frontend to verify tokens before performing privileged actions.

    SECURITY: Uses validate_token_with_db so that tokens revoked on any Cloud
    Run instance are rejected here too.  The weaker in-memory-only
    validate_token does not check DB-backed revocation and would return
    {"valid": True} for a token that was revoked on a different instance.
    """
    try:
        # validate_token_with_db checks both the HMAC signature / expiry and
        # the DB-backed revocation table, ensuring cross-instance consistency.
        valid, reason, token_obj = await validate_token_with_db(request.token)

        if not valid:
            # SECURITY: return generic message; log detailed reason server-side
            logger.warning("Token validation failed: %s", reason)
            return {"valid": False, "reason": "Token validation failed"}

        if token_obj is None:
            logger.error("Token validation succeeded but token payload was missing")
            return {"valid": False, "reason": "Token validation failed"}

        return {
            "valid": True,
            "user_id": str(token_obj.user_id),
            "agent_id": str(token_obj.agent_id),
            "scope": token_obj.scope.value,
        }
    except Exception as e:
        # SECURITY: never expose exception details to client
        logger.error("Token validation error: %s", e)
        return {"valid": False, "reason": "Token validation failed"}


# ============================================================================
# KAI FINANCIAL AGENT
# ============================================================================


@router.post("/agents/kai/chat", response_model=ChatResponse)
async def kai_chat(request: ChatRequest):
    """
    Handle Kai Financial agent chat messages.

    This endpoint manages the agentic flow for:
    - Fundamental Analysis
    - Sentiment Analysis
    - Valuation Analysis

    Orchestrates multi-agent investment analysis (fundamental, sentiment, valuation).
    """
    logger.info("Kai Agent: user=%.8s..., msg='%.50s...'", request.userId, request.message)

    try:
        result = get_kai_agent().handle_message(
            message=request.message,
            user_id=request.userId,
            # session_state=request.sessionState # Kai likely manages state in context/memory
        )

        # Kai's ADK agent returns 'is_complete' when tools are done.

        return ChatResponse(
            response=result.get("response", ""),
            sessionState=None,  # Kai uses internal ADK memory
            needsConsent=False,  # Handled via tools if needed in future
            isComplete=result.get("is_complete", True),
            # UI hints (Optional for Kai)
            ui_type=None,
            options=[],
        )
    except Exception as e:
        logger.error("kai_chat.error user=%s error=%s", request.userId, e)
        raise HTTPException(status_code=500, detail="Agent is temporarily unavailable.")


@router.get("/agents/kai/info")
async def kai_info():
    """Get Kai Financial agent manifest info."""
    return get_kai_agent().get_agent_info()
