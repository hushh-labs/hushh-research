# api/routes/kai/__init__.py
"""
Agent Kai API Routes — Modular Package

This package organizes Kai routes into logical modules:
- chat.py: Conversational chat endpoint with auto-learning
- portfolio.py: Portfolio import and analysis
- plaid.py: Read-only brokerage connectivity, OAuth resume, refresh, and source selection
- analyze.py: Non-streaming analysis endpoint
- stream.py: SSE streaming analysis endpoint
- decisions.py: Decision history (reads from domain_summaries; legacy CRUD returns 410)
- consent.py: Kai-specific consent grants
- support.py: Profile support and bug-report messaging via Gmail API

All sub-routers are aggregated into `kai_router` for backward compatibility.
"""

from fastapi import APIRouter

from .analyze import router as analyze_router
from .chat import router as chat_router
from .consent import router as consent_router
from .decisions import router as decisions_router
from .gmail import router as gmail_router
from .health import router as health_router
from .losers import router as losers_router
from .market_insights import router as market_insights_router
from .plaid import router as plaid_router
from .portfolio import router as portfolio_router
from .stream import router as stream_router
from .support import router as support_router

# Create the main Kai router with prefix
kai_router = APIRouter(prefix="/api/kai", tags=["kai"])

# NOTE: Keep these paths listed for route-contract verification.
# The verify-route-contracts script checks for literal strings in this file.
KAI_ROUTE_CONTRACT_PATHS = [
    "/health",
    "/chat",
    "/chat/history/{conversation_id}",
    "/chat/conversations/{user_id}",
    "/chat/initial-state/{user_id}",
    "/consent/grant",
    "/analyze",
    "/analyze/stream",
    "/analyze/run/start",
    "/analyze/run/active",
    "/analyze/run/{run_id}/stream",
    "/analyze/run/{run_id}/cancel",
    "/portfolio/import",
    "/portfolio/import/stream",
    "/portfolio/import/run/start",
    "/portfolio/import/run/active",
    "/portfolio/import/run/{run_id}/stream",
    "/portfolio/import/run/{run_id}/cancel",
    "/portfolio/summary/{user_id}",
    "/plaid/status/{user_id}",
    "/plaid/link-token",
    "/plaid/link-token/update",
    "/plaid/oauth/resume",
    "/plaid/exchange-public-token",
    "/plaid/refresh",
    "/plaid/refresh/{run_id}",
    "/plaid/refresh/{run_id}/cancel",
    "/plaid/source",
    "/plaid/webhook",
    "/gmail/connect/start",
    "/gmail/connect/complete",
    "/gmail/status/{user_id}",
    "/gmail/disconnect",
    "/gmail/sync",
    "/gmail/reconcile",
    "/gmail/sync/{run_id}",
    "/gmail/receipts/{user_id}",
    "/gmail/webhook",
    "/support/message",
    "/dashboard/profile-picks/{user_id}",
    "/portfolio/analyze-losers",
    "/portfolio/analyze-losers/stream",
    "/market/insights/baseline/{user_id}",
    "/market/insights/{user_id}",
    "/stock-preview/{user_id}",
]

# Include all sub-routers (no prefix since main router has /api/kai)
kai_router.include_router(health_router)
kai_router.include_router(chat_router)
kai_router.include_router(portfolio_router)
kai_router.include_router(plaid_router)
kai_router.include_router(gmail_router)
kai_router.include_router(consent_router)
kai_router.include_router(analyze_router)
kai_router.include_router(stream_router)
kai_router.include_router(decisions_router)
kai_router.include_router(losers_router)
kai_router.include_router(market_insights_router)
kai_router.include_router(support_router)

# Export for server.py
router = kai_router
