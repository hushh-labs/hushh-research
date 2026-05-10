# api/routes/kai/debate.py
"""
Kai Debate Endpoint — SSE Streaming Investment Debate.

Provides a Server-Sent Events endpoint for the multi-agent investment
debate between Bull (Renaissance) and Bear (Fundamental) agents.

ADDITIVE: This is a new route that does not modify any existing Kai endpoints.
"""

import json
import logging

from fastapi import APIRouter, Request
from sse_starlette.sse import EventSourceResponse

from hushh_mcp.agents.kai.debate_agent import InvestmentDebateEngine

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/debate/stream")
async def debate_stream(request: Request, ticker: str = "AAPL"):
    """
    SSE endpoint for investment debate streaming.

    Query params:
        ticker: Stock ticker symbol (default: AAPL)
        user_id: Optional user ID for PKM context
        consent_token: Optional consent token
    """
    user_id = request.query_params.get("user_id")
    consent_token = request.query_params.get("consent_token")

    engine = InvestmentDebateEngine()

    async def event_generator():
        try:
            async for event in engine.run_debate(
                ticker=ticker,
                user_id=user_id,
                consent_token=consent_token,
            ):
                if await request.is_disconnected():
                    break
                yield {
                    "event": event["event"],
                    "data": json.dumps(event["data"]),
                }
        except Exception as e:
            logger.error("[Debate SSE] Error during debate: %s", e)
            yield {
                "event": "error",
                "data": json.dumps({"message": str(e)}),
            }

    return EventSourceResponse(event_generator())
