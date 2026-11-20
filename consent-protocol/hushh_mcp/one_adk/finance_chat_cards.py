"""Finance chat card offers and display-only history receipts."""

from typing import Any

from google.adk.tools import ToolContext

from hushh_mcp.one_adk.external_read_boundary import STATE_EXECUTION_SURFACE
from hushh_mcp.one_adk.finance_market_tools import normalize_tickers
from hushh_mcp.one_adk.history_projection import _record
from hushh_mcp.one_adk.state_keys import STATE_USER_ID


def show_portfolio_card(section: str, tool_context: ToolContext) -> dict[str, Any]:
    """Offer a portfolio card in typed Chat. Section is holdings, allocation, performance, or sources."""
    if tool_context.state.get(
        STATE_EXECUTION_SURFACE
    ) != "typed_chat" or not tool_context.state.get(STATE_USER_ID):
        return {"status": "unavailable"}
    if section not in {"holdings", "allocation", "performance", "sources"}:
        return {"status": "invalid_section"}
    return {
        "status": "card_offered",
        "structured": {
            "type": "one.finance_portfolio.v1",
            "section": section,
        },
    }


TOP_GAINERS_CARD_TYPE = "one.finance_top_gainers.v1"


def show_market_gainers(tool_context: ToolContext) -> dict[str, Any]:
    """Show the latest U.S. market gainers as a card in signed-in typed Chat."""
    state = tool_context.state
    if state.get(STATE_EXECUTION_SURFACE) != "typed_chat" or not state.get(STATE_USER_ID):
        return {"status": "unavailable"}
    return {"status": "card_offered", "structured": {"type": TOP_GAINERS_CARD_TYPE}}


def show_stock_preview(ticker: str, tool_context: ToolContext) -> dict[str, Any]:
    """Offer the stock analysis review card in signed-in typed Chat. Pass one ticker."""
    state = tool_context.state
    if state.get(STATE_EXECUTION_SURFACE) != "typed_chat" or not state.get(STATE_USER_ID):
        return {"status": "unavailable"}
    symbols = normalize_tickers(ticker, limit=1)
    if not symbols:
        return {"status": "needs_ticker", "message": "Which stock should I preview?"}
    return {
        "status": "preview_offered",
        "structured": {"type": "one.finance_stock_preview.v1", "ticker": symbols[0]},
    }


def _safe_stock_preview_descriptor(part: Any) -> dict[str, Any] | None:
    function_response = getattr(part, "function_response", None)
    if getattr(function_response, "name", None) != "show_stock_preview":
        return None
    response = _record(getattr(function_response, "response", None)) or {}
    structured = _record(response.get("structured")) or {}
    kind = "one.finance_stock_preview.v1"
    ticker = structured.get("ticker")
    if response.get("status") != "preview_offered" or structured.get("type") != kind:
        return None
    if not isinstance(ticker, str) or normalize_tickers(ticker, limit=1) != [ticker]:
        return None
    return {"activityType": kind, "content": {"type": kind, "ticker": ticker}}


def _safe_portfolio_descriptor(part: Any) -> dict[str, Any] | None:
    function_response = getattr(part, "function_response", None)
    if getattr(function_response, "name", None) != "show_portfolio_card":
        return None
    response = _record(getattr(function_response, "response", None)) or {}
    structured = _record(response.get("structured")) or {}
    kind = "one.finance_portfolio.v1"
    section = structured.get("section")
    if response.get("status") != "card_offered" or structured.get("type") != kind:
        return None
    if section not in ("holdings", "allocation", "performance", "sources"):
        return None
    return {"activityType": kind, "content": {"type": kind, "section": section}}


def _safe_gainers_descriptor(part: Any) -> dict[str, Any] | None:
    function_response = getattr(part, "function_response", None)
    if getattr(function_response, "name", None) != "show_market_gainers":
        return None
    response = _record(getattr(function_response, "response", None)) or {}
    structured = _record(response.get("structured")) or {}
    if response.get("status") != "card_offered" or structured.get("type") != TOP_GAINERS_CARD_TYPE:
        return None
    return {
        "activityType": TOP_GAINERS_CARD_TYPE,
        "content": {"type": TOP_GAINERS_CARD_TYPE, "historical": True},
    }


def finance_card_history_descriptor(part: Any) -> dict[str, Any] | None:
    return (
        _safe_stock_preview_descriptor(part)
        or _safe_portfolio_descriptor(part)
        or _safe_gainers_descriptor(part)
    )
