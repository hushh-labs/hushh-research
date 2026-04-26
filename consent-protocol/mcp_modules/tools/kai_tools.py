"""
mcp_modules/tools/kai_tools.py

Kai voice-agent tool handlers for the MCP server.

Each handler corresponds to one actionable function inside the Kai mobile app.
The mobile client receives a structured KaiAction payload and routes accordingly.

Canonical action-ID reference (mirrors voice_intent_service._COMMAND_TO_CANONICAL_ACTION_ID):
  nav.kai_home             → open Market / Home tab
  nav.kai_dashboard        → open Portfolio / Dashboard tab
  nav.kai_import           → open Import tab
  nav.analysis_history     → open Analysis History tab
  nav.consents             → open Consents tab
  nav.profile              → open Profile tab
  nav.kai_optimize         → open Optimize tab
  analysis.start           → begin stock analysis (requires symbol slot)
  analysis.resume_active   → resume the currently running analysis
  analysis.cancel_active   → cancel the currently running analysis
  nav.back                 → navigate back one screen
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from mcp.types import TextContent

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_TICKER_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,5}$")

_COMPANY_ALIAS_TO_TICKER: dict[str, str] = {
    "google": "GOOGL",
    "alphabet": "GOOGL",
    "facebook": "META",
    "meta": "META",
    "apple": "AAPL",
    "microsoft": "MSFT",
    "amazon": "AMZN",
    "nvidia": "NVDA",
    "tesla": "TSLA",
    "netflix": "NFLX",
    "amd": "AMD",
    "advanced micro devices": "AMD",
    "samsung": "005930.KS",
    "jpmorgan": "JPM",
    "jp morgan": "JPM",
    "berkshire": "BRK.B",
}

_ANALYSIS_TABS = {"history", "debate", "summary", "transcript"}


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _ok(action_id: str, message: str, **extra: Any) -> list[TextContent]:
    """Build a successful KaiAction response."""
    payload: dict[str, Any] = {
        "status": "success",
        "action_id": action_id,
        "message": message,
    }
    payload.update(extra)
    return [TextContent(type="text", text=json.dumps(payload))]


def _err(message: str, detail: str | None = None) -> list[TextContent]:
    """Build an error response."""
    payload: dict[str, Any] = {"status": "error", "message": message}
    if detail:
        payload["detail"] = detail
    return [TextContent(type="text", text=json.dumps(payload))]


def _resolve_ticker(raw: str | None) -> str | None:
    """
    Resolve a company name or ticker symbol to an uppercase ticker.
    Returns None if the input cannot be resolved.
    """
    if not raw:
        return None
    cleaned = str(raw).strip()
    # Try company alias lookup first (case-insensitive)
    alias_result = _COMPANY_ALIAS_TO_TICKER.get(cleaned.lower())
    if alias_result:
        return alias_result
    # Validate as an uppercase ticker
    upper = cleaned.upper()
    if _TICKER_RE.match(upper):
        return upper
    return None


# ---------------------------------------------------------------------------
# Tool handlers
# ---------------------------------------------------------------------------

async def handle_kai_analyze_stock(args: dict[str, Any]) -> list[TextContent]:
    """
    Trigger a new stock analysis for the given symbol.

    Required slot: symbol (str) — ticker or company name
    Optional slot: analysis_type (str) — "fundamental" | "sentiment" | "valuation"
    """
    raw_symbol = args.get("symbol") or args.get("ticker") or args.get("target")
    ticker = _resolve_ticker(raw_symbol)
    if not ticker:
        return _err(
            f"I couldn't identify a valid ticker from '{raw_symbol}'. "
            "Please provide a stock symbol like AAPL or MSFT.",
        )

    analysis_type = str(args.get("analysis_type") or "full").strip().lower()
    valid_types = {"fundamental", "sentiment", "valuation", "full"}
    if analysis_type not in valid_types:
        analysis_type = "full"

    logger.info("kai_tool.analyze ticker=%s type=%s", ticker, analysis_type)
    return _ok(
        action_id="analysis.start",
        message=f"Starting {analysis_type} analysis for {ticker}.",
        slots={"symbol": ticker, "analysis_type": analysis_type},
        completion_mode="background_start",
    )


async def handle_kai_open_dashboard(args: dict[str, Any]) -> list[TextContent]:
    """Navigate to the Portfolio / Dashboard tab."""
    logger.info("kai_tool.navigate action=nav.kai_dashboard")
    return _ok(
        action_id="nav.kai_dashboard",
        message="Opening your portfolio dashboard.",
        completion_mode="route_settle",
    )


async def handle_kai_open_import(args: dict[str, Any]) -> list[TextContent]:
    """Navigate to the Import / Upload Statement tab."""
    logger.info("kai_tool.navigate action=nav.kai_import")
    return _ok(
        action_id="nav.kai_import",
        message="Opening the import screen.",
        completion_mode="route_settle",
    )


async def handle_kai_open_history(args: dict[str, Any]) -> list[TextContent]:
    """
    Navigate to the Analysis History tab.

    Optional slot: tab (str) — "history" | "debate" | "summary" | "transcript"
    """
    tab = str(args.get("tab") or "history").strip().lower()
    if tab not in _ANALYSIS_TABS:
        tab = "history"

    logger.info("kai_tool.navigate action=nav.analysis_history tab=%s", tab)
    return _ok(
        action_id="nav.analysis_history",
        message=f"Opening analysis history ({tab} tab).",
        slots={"tab": tab},
        completion_mode="route_settle",
    )


async def handle_kai_open_consent(args: dict[str, Any]) -> list[TextContent]:
    """Navigate to the Consents / Privacy tab."""
    logger.info("kai_tool.navigate action=nav.consents")
    return _ok(
        action_id="nav.consents",
        message="Opening your consents.",
        completion_mode="route_settle",
    )


async def handle_kai_open_profile(args: dict[str, Any]) -> list[TextContent]:
    """Navigate to the Profile tab."""
    logger.info("kai_tool.navigate action=nav.profile")
    return _ok(
        action_id="nav.profile",
        message="Opening your profile.",
        completion_mode="route_settle",
    )


async def handle_kai_open_optimize(args: dict[str, Any]) -> list[TextContent]:
    """Navigate to the Optimize tab."""
    logger.info("kai_tool.navigate action=nav.kai_optimize")
    return _ok(
        action_id="nav.kai_optimize",
        message="Opening portfolio optimization.",
        completion_mode="route_settle",
    )


async def handle_kai_open_home(args: dict[str, Any]) -> list[TextContent]:
    """Navigate to the Market / Home tab."""
    logger.info("kai_tool.navigate action=nav.kai_home")
    return _ok(
        action_id="nav.kai_home",
        message="Going to the market overview.",
        completion_mode="route_settle",
    )


async def handle_kai_navigate_back(args: dict[str, Any]) -> list[TextContent]:
    """Navigate back one screen in the Kai app."""
    logger.info("kai_tool.navigate action=nav.back")
    return _ok(
        action_id="nav.back",
        message="Going back.",
        completion_mode="route_settle",
    )


async def handle_kai_resume_active_analysis(args: dict[str, Any]) -> list[TextContent]:
    """Resume the currently running analysis in the background."""
    logger.info("kai_tool.analysis action=analysis.resume_active")
    return _ok(
        action_id="analysis.resume_active",
        message="Resuming your active analysis.",
        completion_mode="route_settle",
    )


async def handle_kai_cancel_active_analysis(args: dict[str, Any]) -> list[TextContent]:
    """Cancel / stop the currently running analysis."""
    logger.info("kai_tool.analysis action=analysis.cancel_active")
    return _ok(
        action_id="analysis.cancel_active",
        message="Cancelling the active analysis.",
        completion_mode="none",
    )
