# api/routes/agents.py
"""
Agent chat endpoints for Kai Financial agent.

Note: Food & Dining and Professional Profile agents have been deprecated
in favor of the dynamic world model architecture.

Canonical attach points
-----------------------
api.routes.agents.validate_token_endpoint -> POST /api/validate-token
api.routes.agents.kai_chat                -> POST /api/agents/kai/chat
"""

import logging

from fastapi import APIRouter, HTTPException

from api.models import ChatRequest, ChatResponse, ValidateTokenRequest
from hushh_mcp.agents.kai.agent import get_kai_agent

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
    """
    from hushh_mcp.consent.token import validate_token

    try:
        # Validate signature and expiration
        valid, reason, token_obj = validate_token(request.token)

        if not valid:
            # SECURITY: Return generic message, log detailed reason server-side
            logger.warning("agents.validate_token.failed: %s", reason)
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
        # SECURITY: Never expose exception details to client (CodeQL fix)
        logger.error("agents.validate_token.error: %s", e)
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
    logger.info("agents.kai_chat user=%s msg=%.50r", request.userId, request.message)

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
        # SECURITY: Never expose internal exception details to the client.
        # str(e) from a Gemini/DB call can leak model IDs, internal endpoints,
        # API key fragments, table/column names, or file paths with user IDs.
        logger.error("kai_chat.error user=%s: %s", request.userId, e)
        raise HTTPException(status_code=500, detail="Internal error processing chat")


@router.get("/agents/kai/info")
async def kai_info():
    """Get Kai Financial agent manifest info."""
    return get_kai_agent().get_agent_info()
