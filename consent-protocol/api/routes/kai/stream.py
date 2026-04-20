# api/routes/kai/stream.py
"""
Kai SSE Streaming — Real-time Debate Analysis

Streams agent analysis and debate rounds to the frontend via Server-Sent Events.
Enables real-time visualization of the multi-agent debate process.
"""

import asyncio
import contextvars
import json
import logging
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, AsyncGenerator, Dict, Optional

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from api.middlewares.observability import get_request_id
from api.routes.kai._streaming import (
    STOCK_ANALYZE_TIMEOUT_SECONDS,
    CanonicalSSEStream,
)
from api.routes.kai.run_manager import KaiAnalyzeRunManager
from hushh_mcp.agents.kai.debate_engine import DebateEngine
from hushh_mcp.agents.kai.fundamental_agent import FundamentalAgent, FundamentalInsight
from hushh_mcp.agents.kai.sentiment_agent import SentimentAgent, SentimentInsight
from hushh_mcp.agents.kai.valuation_agent import ValuationAgent, ValuationInsight
from hushh_mcp.consent.token import validate_token
from hushh_mcp.constants import ConsentScope
from hushh_mcp.operons.kai.llm import (
    get_gemini_unavailable_reason,
    is_gemini_ready,
    stream_gemini_response,
    synthesize_debate_recommendation_card,
)
from hushh_mcp.services.consent_db import ConsentDBService
from hushh_mcp.services.personal_knowledge_model_service import get_pkm_service
from hushh_mcp.services.renaissance_service import get_renaissance_service
from hushh_mcp.services.ria_iam_service import RIAIAMService
from hushh_mcp.services.symbol_master_service import get_symbol_master_service

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Kai Streaming"])
_TICKER_SYMBOL_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,5}$")
_RUN_MANAGER = KaiAnalyzeRunManager()


async def _require_vault_owner_token(
    *,
    user_id: str,
    authorization: Optional[str],
) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=401,
            detail="Missing consent token. Call /api/consent/owner-token first.",
        )

    consent_token = authorization.replace("Bearer ", "")
    valid, reason, payload = validate_token(consent_token, ConsentScope.VAULT_OWNER)

    if not valid or not payload:
        raise HTTPException(status_code=401, detail=f"Invalid token: {reason}")

    if payload.user_id != user_id:
        raise HTTPException(status_code=403, detail="Token user mismatch")

    return consent_token


# ============================================================================
# MODELS
# ============================================================================


class StreamAnalyzeRequest(BaseModel):
    """Request for streaming analysis."""

    user_id: str
    ticker: str
    risk_profile: str = "balanced"
    context: Optional[Dict[str, Any]] = None
    run_id: Optional[str] = None
    resume_cursor: Optional[int] = Field(default=0, ge=0)


class StartAnalyzeRunRequest(BaseModel):
    """Request to create or attach to a session-locked analysis run."""

    user_id: str
    debate_session_id: str
    ticker: str
    risk_profile: str = "balanced"
    context: Optional[Dict[str, Any]] = None
    pick_source: Optional[str] = None
    pick_source_label: Optional[str] = None
    pick_source_kind: Optional[str] = None


# ============================================================================
# SSE EVENT HELPERS (sse_starlette format)
# ============================================================================

_stream_ctx: contextvars.ContextVar[CanonicalSSEStream | None] = contextvars.ContextVar(
    "kai_stream_ctx",
    default=None,
)


def create_event(event_type: str, data: dict, *, terminal: bool = False) -> dict[str, str]:
    """Create one canonical SSE event frame."""
    ctx = _stream_ctx.get()
    if ctx is None:
        ctx = CanonicalSSEStream("stock_analyze")
        _stream_ctx.set(ctx)
    return ctx.event(event_type, data, terminal=terminal)


def _safe_round(value: Any, fallback: int) -> int:
    if isinstance(value, int) and value in (1, 2):
        return value
    if isinstance(value, str) and value.isdigit() and int(value) in (1, 2):
        return int(value)
    return fallback


def _normalize_analyze_event_payload(
    event_name: str,
    payload: dict[str, Any],
    *,
    default_round: int,
    default_phase: str,
) -> dict[str, Any]:
    """Attach explicit round/phase metadata so frontend never infers state."""
    normalized = dict(payload)
    if event_name in {"agent_start", "agent_token", "agent_complete", "agent_error"}:
        round_value = _safe_round(normalized.get("round"), default_round)
        phase_value = normalized.get("phase")
        if not isinstance(phase_value, str) or not phase_value:
            phase_value = "debate" if round_value == 2 else "analysis"
        normalized["round"] = round_value
        normalized["phase"] = phase_value
    elif event_name in {"debate_round", "round_start"}:
        fallback_round = default_round if event_name == "round_start" else 2
        round_value = _safe_round(normalized.get("round"), fallback_round)
        normalized["round"] = round_value
        normalized.setdefault("phase", "debate" if round_value == 2 else "analysis")
    elif event_name == "kai_thinking":
        normalized.setdefault("phase", default_phase)
        normalized.setdefault("round", default_round)
    elif event_name == "insight_extracted":
        normalized.setdefault("phase", default_phase)
        normalized.setdefault("round", default_round)
    return normalized


def _is_retryable_rate_limit_error(error: Exception | str) -> bool:
    message = str(error).lower()
    markers = (
        "429",
        "too many requests",
        "rate limit",
        "resource_exhausted",
        "quota",
    )
    return any(marker in message for marker in markers)


def _pre_agent_streaming_enabled() -> bool:
    raw = str(os.getenv("KAI_STREAM_PRE_AGENT_THINKING", "false")).strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _build_fallback_fundamental_insight(ticker: str, error: Exception) -> FundamentalInsight:
    message = str(error) or "provider unavailable"
    return FundamentalInsight(
        summary=(
            f"Fundamental inputs are limited for {ticker} ({message}). "
            "Using a conservative baseline while live coverage recovers."
        ),
        key_metrics={},
        quant_metrics={},
        business_moat="Unavailable during this run",
        financial_resilience="Unavailable during this run",
        growth_efficiency="Unavailable during this run",
        bull_case="No reliable bull case from live providers in this run.",
        bear_case="Data gap increases uncertainty for downside analysis.",
        sources=["deterministic_fallback"],
        confidence=0.25,
        recommendation="hold",
    )


def _build_fallback_sentiment_insight(ticker: str, error: Exception) -> SentimentInsight:
    message = str(error) or "provider unavailable"
    return SentimentInsight(
        summary=(
            f"Sentiment coverage is limited for {ticker} ({message}). "
            "Using a neutral baseline until live headlines recover."
        ),
        sentiment_score=0.0,
        key_catalysts=[],
        news_highlights=[],
        sources=["deterministic_fallback"],
        confidence=0.25,
        recommendation="neutral",
    )


def _build_fallback_valuation_insight(ticker: str, error: Exception) -> ValuationInsight:
    message = str(error) or "provider unavailable"
    return ValuationInsight(
        summary=(
            f"Valuation coverage is limited for {ticker} ({message}). "
            "Using a fair-value baseline until peer quotes recover."
        ),
        valuation_metrics={},
        peer_comparison={},
        price_targets={},
        sources=["deterministic_fallback"],
        confidence=0.25,
        recommendation="fair",
    )


def _build_short_recommendation(
    decision: str,
    confidence: float,
    final_statement: str,
    degraded_agents: list[str],
) -> str:
    confidence_pct = max(0, min(100, round(confidence * 100)))
    first_sentence = final_statement.split(".")[0].strip()
    if not first_sentence:
        first_sentence = "Recommendation synthesized from multi-agent debate."
    suffix = ""
    if degraded_agents:
        suffix = f" Fallback used: {', '.join(sorted(set(degraded_agents)))}."
    text = f"{decision.upper()} ({confidence_pct}% confidence). {first_sentence}.{suffix}".strip()
    return text[:320]


def _normalize_advisor_screening_criteria(
    sections: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    if not isinstance(sections, list):
        return []
    normalized: list[dict[str, Any]] = []
    for section in sections:
        if not isinstance(section, dict):
            continue
        section_key = str(section.get("section") or "").strip()
        rows = section.get("rows")
        if not section_key or not isinstance(rows, list):
            continue
        normalized.append(
            {
                "section": section_key,
                "rows": [
                    {
                        "title": str(row.get("title") or "").strip(),
                        "detail": str(row.get("detail") or "").strip(),
                        "value_text": str(row.get("value_text") or "").strip() or None,
                    }
                    for row in rows
                    if isinstance(row, dict)
                ],
            }
        )
    return normalized


def _recommendation_bias_from_advisor_tier(tier: str | None) -> str | None:
    normalized = str(tier or "").strip().upper()
    if normalized == "ACE":
        return "STRONG_BUY"
    if normalized == "KING":
        return "BUY"
    if normalized == "QUEEN":
        return "HOLD_TO_BUY"
    if normalized == "JACK":
        return "HOLD"
    return None


async def _merge_ria_pick_package_context(
    *,
    user_id: str,
    ticker: str,
    pick_source: str | None,
    renaissance_context: dict[str, Any],
) -> dict[str, Any]:
    normalized_source = str(pick_source or "").strip()
    if not normalized_source.startswith("ria:"):
        return renaissance_context
    try:
        package = await RIAIAMService().get_pick_package_for_source(user_id, normalized_source)
    except Exception as exc:
        logger.warning(
            "[Kai Stream] advisor pick package unavailable for %s source %s: %s",
            user_id,
            normalized_source,
            exc,
        )
        return renaissance_context

    normalized_ticker = str(ticker or "").strip().upper()
    top_rows = package.get("top_picks") if isinstance(package, dict) else []
    avoid_rows = package.get("avoid_rows") if isinstance(package, dict) else []
    screening_sections = package.get("screening_sections") if isinstance(package, dict) else []
    advisor_top_row = next(
        (
            row
            for row in top_rows
            if isinstance(row, dict)
            and str(row.get("ticker") or "").strip().upper() == normalized_ticker
        ),
        None,
    )
    advisor_avoid_row = next(
        (
            row
            for row in avoid_rows
            if isinstance(row, dict)
            and str(row.get("ticker") or "").strip().upper() == normalized_ticker
        ),
        None,
    )
    merged_context = dict(renaissance_context)
    if advisor_top_row:
        merged_context["tier"] = advisor_top_row.get("tier") or merged_context.get("tier")
        merged_context["conviction_weight"] = (
            advisor_top_row.get("conviction_weight")
            if advisor_top_row.get("conviction_weight") is not None
            else merged_context.get("conviction_weight")
        )
        merged_context["investment_thesis"] = advisor_top_row.get(
            "investment_thesis"
        ) or merged_context.get("investment_thesis")
        merged_context["sector"] = advisor_top_row.get("sector") or merged_context.get("sector")
        merged_context["recommendation_bias"] = (
            advisor_top_row.get("recommendation_bias")
            or _recommendation_bias_from_advisor_tier(advisor_top_row.get("tier"))
            or merged_context.get("recommendation_bias")
        )
        merged_context["is_investable"] = True
    if advisor_avoid_row:
        merged_context["is_avoid"] = True
        merged_context["avoid_reason"] = advisor_avoid_row.get(
            "why_avoid"
        ) or advisor_avoid_row.get("reason")
    normalized_screening = _normalize_advisor_screening_criteria(screening_sections)
    if normalized_screening:
        merged_context["screening_criteria"] = normalized_screening
    merged_context["advisor_pick_package"] = {
        "source": normalized_source,
        "top_picks_count": len(top_rows) if isinstance(top_rows, list) else 0,
        "avoid_count": len(avoid_rows) if isinstance(avoid_rows, list) else 0,
        "screening_section_count": len(normalized_screening),
        "package_note": package.get("package_note") if isinstance(package, dict) else None,
    }
    return merged_context


def _extract_summary_count(summary: dict[str, Any] | None) -> int:
    if not isinstance(summary, dict):
        return 0
    for key in ("attribute_count", "holdings_count", "item_count"):
        value = summary.get(key)
        if isinstance(value, bool) or value is None:
            continue
        if isinstance(value, int):
            return max(0, value)
        if isinstance(value, float):
            if value != value:
                continue
            return max(0, int(value))
        if isinstance(value, str):
            text = value.strip()
            if not text:
                continue
            try:
                return max(0, int(float(text)))
            except Exception:
                continue
    return 0


def _now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _safe_float(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        out = float(value)
        if out != out:  # NaN guard
            return None
        return out
    try:
        text = str(value).strip().replace(",", "")
        if not text:
            return None
        out = float(text)
        if out != out:
            return None
        return out
    except Exception:
        return None


def _safe_int(value: Any) -> int | None:
    parsed = _safe_float(value)
    if parsed is None:
        return None
    return int(parsed)


def _is_cash_equivalent_context_row(row: dict[str, Any]) -> bool:
    symbol = str(row.get("symbol") or "").strip().upper()
    if symbol in {"CASH", "MMF", "SWEEP", "QACDS"}:
        return True
    name = str(row.get("name") or row.get("description") or "").strip().lower()
    asset_type = str(row.get("asset_type") or "").strip().lower()
    hints = ("cash", "money market", "sweep", "core position", "deposit")
    return any(hint in name for hint in hints) or any(hint in asset_type for hint in hints)


def _context_row_analyze_eligibility(row: dict[str, Any]) -> tuple[bool, str]:
    listing_status = str(row.get("security_listing_status") or "").strip().lower()
    symbol_kind = str(row.get("symbol_kind") or "").strip().lower()
    is_sec_common_equity = bool(row.get("is_sec_common_equity_ticker"))
    is_cash_equivalent = bool(row.get("is_cash_equivalent")) or _is_cash_equivalent_context_row(row)
    is_investable = bool(row.get("is_investable")) and not is_cash_equivalent

    if is_cash_equivalent or listing_status == "cash_or_sweep":
        return False, "excluded_cash"
    if listing_status == "fixed_income":
        return False, "excluded_fixed_income"
    if listing_status == "non_sec_common_equity":
        return False, "excluded_non_sec_common_equity"
    if not is_investable:
        return False, "excluded_missing_equity_classification"
    if (
        is_sec_common_equity
        or listing_status == "sec_common_equity"
        or symbol_kind == "us_common_equity_ticker"
    ):
        return True, "eligible_sec_common_equity"
    return False, "excluded_missing_equity_classification"


def _looks_non_equity_from_ticker_metadata(
    *,
    symbol: str,
    title: str,
    sector_primary: str,
    industry_primary: str,
    sic_description: str,
) -> tuple[bool, str]:
    combined = " ".join(
        [
            str(title or "").strip().lower(),
            str(sector_primary or "").strip().lower(),
            str(industry_primary or "").strip().lower(),
            str(sic_description or "").strip().lower(),
        ]
    )

    if symbol.endswith("X"):
        return True, "excluded_non_sec_common_equity"

    if any(term in combined for term in ("bond", "fixed income", "treasury", "municipal")):
        return True, "excluded_fixed_income"

    if any(
        term in combined
        for term in (
            "etf",
            "fund",
            "mutual",
            "index",
            "trust",
            "money market",
            "cash",
            "sweep",
            "commodity",
            "gold",
            "real estate",
            "reit",
        )
    ):
        return True, "excluded_non_sec_common_equity"

    return False, "eligible_sec_common_equity"


def _resolve_symbol_eligibility(
    *,
    ticker: str,
    request_context: dict[str, Any],
) -> dict[str, Any]:
    symbol = str(ticker or "").strip().upper()
    if not symbol:
        return {
            "symbol_eligibility": False,
            "eligibility_reason": "excluded_missing_equity_classification",
            "eligibility_source": "request_symbol",
        }

    holdings = request_context.get("holdings")
    if isinstance(holdings, list):
        for row in holdings:
            if not isinstance(row, dict):
                continue
            row_symbol = str(row.get("symbol") or "").strip().upper()
            if row_symbol != symbol:
                continue
            eligible, reason = _context_row_analyze_eligibility(row)
            return {
                "symbol_eligibility": eligible,
                "eligibility_reason": reason,
                "eligibility_source": "portfolio",
            }

    symbol_master = get_symbol_master_service()
    metadata = symbol_master.get_ticker_metadata(symbol) or {}
    classification = symbol_master.classify(symbol)
    if not classification.tradable:
        return {
            "symbol_eligibility": False,
            "eligibility_reason": "excluded_missing_equity_classification",
            "eligibility_source": "ticker_master",
        }

    non_equity, reason = _looks_non_equity_from_ticker_metadata(
        symbol=symbol,
        title=str(metadata.get("title") or ""),
        sector_primary=str(metadata.get("sector_primary") or ""),
        industry_primary=str(metadata.get("industry_primary") or ""),
        sic_description=str(metadata.get("sic_description") or ""),
    )
    if non_equity:
        return {
            "symbol_eligibility": False,
            "eligibility_reason": reason,
            "eligibility_source": "ticker_master",
        }

    return {
        "symbol_eligibility": True,
        "eligibility_reason": "eligible_sec_common_equity",
        "eligibility_source": "ticker_master",
    }


def _build_canonical_portfolio_context(holdings: list[dict[str, Any]]) -> dict[str, Any]:
    cleaned = [row for row in holdings if isinstance(row, dict)]
    non_cash = [row for row in cleaned if not _is_cash_equivalent_context_row(row)]
    investable = [
        row
        for row in non_cash
        if _TICKER_SYMBOL_RE.match(str(row.get("symbol") or "").strip().upper())
        and _context_row_analyze_eligibility(row)[0]
    ]

    investable_symbols: list[str] = []
    for row in investable:
        symbol = str(row.get("symbol") or "").strip().upper()
        if symbol and symbol not in investable_symbols:
            investable_symbols.append(symbol)

    total_value = sum(_safe_float(row.get("market_value")) or 0.0 for row in cleaned)
    cash_value = sum(
        _safe_float(row.get("market_value")) or 0.0
        for row in cleaned
        if _is_cash_equivalent_context_row(row)
    )
    losers = sum(
        1 for row in investable if (_safe_float(row.get("unrealized_gain_loss")) or 0.0) < 0
    )
    winners = sum(
        1 for row in investable if (_safe_float(row.get("unrealized_gain_loss")) or 0.0) > 0
    )
    estimated_annual_income = sum(
        _safe_float(row.get("estimated_annual_income")) or 0.0 for row in cleaned
    )

    return {
        "holdings_summary": cleaned[:30],
        "holdings_count": len(cleaned),
        "non_cash_holdings_count": len(non_cash),
        "investable_holdings_count": len(investable),
        "cash_positions_count": len(cleaned) - len(non_cash),
        "eligible_symbols": investable_symbols[:30],
        "cash_value": round(cash_value, 2),
        "total_value": round(total_value, 2),
        "estimated_annual_income": round(estimated_annual_income, 2),
        "losers_count": losers,
        "winners_count": winners,
    }


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _pick_first_numeric(source: dict[str, Any] | None, keys: tuple[str, ...]) -> float | None:
    if not isinstance(source, dict):
        return None
    for key in keys:
        parsed = _safe_float(source.get(key))
        if parsed is not None:
            return parsed
    return None


def _derive_market_trend(sentiment_score: float | None, decision: str) -> tuple[str, float]:
    base_score = 5.0
    if sentiment_score is not None:
        base_score = _clamp((sentiment_score + 1.0) * 5.0, 0.0, 10.0)
    decision_bias = {
        "buy": 0.6,
        "hold": 0.0,
        "reduce": -0.6,
        "sell": -0.6,
    }.get((decision or "").strip().lower(), 0.0)
    score = _clamp(base_score + decision_bias, 0.0, 10.0)
    if score >= 6.4:
        label = "Bullish"
    elif score <= 3.6:
        label = "Bearish"
    else:
        label = "Neutral"
    return label, round(score, 2)


def _derive_fair_value(
    *,
    price_targets: dict[str, Any] | None,
    valuation_metrics: dict[str, Any] | None,
    valuation_recommendation: str,
) -> tuple[str, float, float | None]:
    current_price = _pick_first_numeric(
        valuation_metrics,
        (
            "current_price",
            "price",
            "market_price",
            "spot_price",
            "last_price",
        ),
    )
    target_price = _pick_first_numeric(
        price_targets,
        (
            "base_case",
            "base",
            "fair_value",
            "consensus",
            "target",
            "optimistic",
            "conservative",
        ),
    )
    gap_pct: float | None = None
    if current_price and current_price > 0 and target_price is not None:
        gap_pct = ((target_price - current_price) / current_price) * 100.0
        score = _clamp(5.0 + (gap_pct / 4.0), 0.0, 10.0)
    else:
        rec = (valuation_recommendation or "").strip().lower()
        if "under" in rec:
            score = 7.2
        elif "over" in rec:
            score = 2.8
        else:
            score = 5.0
    if score >= 6.2:
        label = "Undervalued"
    elif score <= 3.8:
        label = "Overvalued"
    else:
        label = "Fairly Valued"
    return label, round(score, 2), (round(gap_pct, 2) if gap_pct is not None else None)


def _derive_company_strength_score(
    *,
    fundamental_confidence: float | None,
    valuation_confidence: float | None,
    debate_confidence: float,
    sentiment_score: float | None,
    fair_value_score: float,
    market_trend_score: float,
) -> float:
    fundamental_score = (
        _clamp((fundamental_confidence or 0.5) * 10.0, 0.0, 10.0)
        if fundamental_confidence is not None
        else 5.0
    )
    valuation_score = (
        _clamp((valuation_confidence or 0.5) * 10.0, 0.0, 10.0)
        if valuation_confidence is not None
        else fair_value_score
    )
    sentiment_component = (
        _clamp((sentiment_score + 1.0) * 5.0, 0.0, 10.0)
        if sentiment_score is not None
        else market_trend_score
    )
    debate_score = _clamp((debate_confidence or 0.5) * 10.0, 0.0, 10.0)
    blended = (
        (fundamental_score * 0.40)
        + (valuation_score * 0.20)
        + (sentiment_component * 0.20)
        + (debate_score * 0.20)
    )
    return round(_clamp(blended, 0.0, 10.0), 2)


def _derive_market_snapshot(
    *,
    valuation_metrics: dict[str, Any] | None,
    price_targets: dict[str, Any] | None,
    analysis_updated_at: str,
) -> dict[str, Any]:
    candidate_fields = (
        ("current_price", valuation_metrics, "valuation_metrics.current_price"),
        ("price", valuation_metrics, "valuation_metrics.price"),
        ("market_price", price_targets, "price_targets.market_price"),
        ("current_price", price_targets, "price_targets.current_price"),
        ("current", price_targets, "price_targets.current"),
    )
    for key, source, source_label in candidate_fields:
        if not isinstance(source, dict):
            continue
        parsed = _safe_float(source.get(key))
        if parsed is not None:
            return {
                "last_price": round(parsed, 4),
                "observed_at": analysis_updated_at,
                "source": source_label,
            }
    return {
        "last_price": None,
        "observed_at": analysis_updated_at,
        "source": "unavailable",
    }


def _validate_pkm_context_requirements(
    full_user_context: dict[str, Any],
) -> list[str]:
    missing: list[str] = []
    request_context = (
        full_user_context.get("request_context")
        if isinstance(full_user_context.get("request_context"), dict)
        else {}
    )

    request_holdings = request_context.get("holdings")
    canonical_holdings = full_user_context.get("holdings")
    holdings_summary = full_user_context.get("holdings_summary")
    holdings_count = _safe_int(full_user_context.get("holdings_count"))
    has_holdings = (
        (isinstance(request_holdings, list) and len(request_holdings) > 0)
        or (isinstance(canonical_holdings, list) and len(canonical_holdings) > 0)
        or (isinstance(holdings_summary, list) and len(holdings_summary) > 0)
        or (holdings_count is not None and holdings_count > 0)
    )
    if not has_holdings:
        missing.append("pkm_holdings")

    debate_context = request_context.get("debate_context")
    if not isinstance(debate_context, dict):
        debate_context = (
            full_user_context.get("debate_context")
            if isinstance(full_user_context.get("debate_context"), dict)
            else {}
        )
    if not isinstance(debate_context, dict):
        missing.append("pkm_debate_context")
        return missing

    portfolio_snapshot = debate_context.get("portfolio_snapshot")
    if not isinstance(portfolio_snapshot, dict):
        portfolio_snapshot = (
            full_user_context.get("portfolio_snapshot")
            if isinstance(full_user_context.get("portfolio_snapshot"), dict)
            else {}
        )
    if not isinstance(portfolio_snapshot, dict) or len(portfolio_snapshot) == 0:
        missing.append("pkm_portfolio_snapshot")

    coverage = debate_context.get("coverage")
    if not isinstance(coverage, dict) or len(coverage) == 0:
        missing.append("pkm_coverage")

    return missing


def _validate_renaissance_context_requirements(
    renaissance_context: dict[str, Any],
    renaissance_lookup_error: Exception | None,
) -> list[str]:
    missing: list[str] = []
    if renaissance_lookup_error is not None:
        missing.append("renaissance_context_lookup")
        return missing

    if not isinstance(renaissance_context, dict) or not renaissance_context:
        missing.append("renaissance_context_payload")
        return missing

    if "is_investable" not in renaissance_context:
        missing.append("renaissance_investable_flag")

    return missing


def _build_renaissance_comparison(renaissance_context: dict[str, Any]) -> dict[str, Any]:
    tier = renaissance_context.get("tier")
    is_investable = bool(renaissance_context.get("is_investable"))
    is_avoid = bool(renaissance_context.get("is_avoid"))
    recommendation_bias = renaissance_context.get("recommendation_bias")

    if is_avoid:
        status = "avoid"
        comparison_label = "Renaissance avoid"
    elif is_investable:
        status = "investable"
        comparison_label = f"Renaissance investable ({tier})" if tier else "Renaissance investable"
    elif renaissance_context.get("is_investable") is False:
        status = "outside_universe"
        comparison_label = "Outside Renaissance investable universe"
    else:
        status = "unknown"
        comparison_label = "Renaissance status unavailable"

    return {
        "status": status,
        "tier": tier,
        "is_investable": is_investable,
        "is_avoid": is_avoid,
        "comparison_label": comparison_label,
        "recommendation_bias": recommendation_bias,
    }


async def stream_agent_thinking(
    agent_name: str,
    ticker: str,
    prompt_context: str,
    request: Request,
    *,
    round_number: int,
    phase: str,
) -> AsyncGenerator[dict, None]:
    """
    Stream Gemini 3 thinking tokens for an agent analysis.
    Yields agent_token events that the frontend can display in real-time.
    """
    logger.info(f"[Kai Stream] Starting stream_agent_thinking for {agent_name}")
    token_count = 0
    stream_error_message: Optional[str] = None
    try:
        async for event in stream_gemini_response(
            prompt=f"""You are a {agent_name} analyst. Briefly think through your analysis approach for {ticker}.
            
Context: {prompt_context}

Think step by step in 2-3 sentences about what you'll analyze and why it matters.""",
            agent_name=agent_name.lower(),
        ):
            if event.get("type") == "token":
                token_count += 1
                logger.info(
                    f"[Kai Stream] Token #{token_count} for {agent_name}: {event.get('text', '')[:30]}..."
                )
                yield create_event(
                    "agent_token",
                    {
                        "agent": agent_name.lower(),
                        "text": event.get("text", ""),
                        "type": "token",
                        "token_source": event.get("token_source", "response"),
                        "round": round_number,
                        "phase": phase,
                    },
                )
            elif event.get("type") == "error":
                stream_error_message = str(event.get("message") or "unknown stream error")
                logger.error(f"[Kai Stream] Gemini error for {agent_name}: {stream_error_message}")
            elif event.get("type") == "complete":
                logger.info(
                    f"[Kai Stream] Streaming complete for {agent_name}, total tokens: {token_count}"
                )

            # Check if client disconnected after each token
            if await request.is_disconnected():
                logger.info(
                    f"[Kai Stream] Client disconnected during {agent_name} streaming, stopping..."
                )
                return

        if token_count == 0 and stream_error_message:
            fallback_text = (
                f"Live commentary is temporarily unavailable ({stream_error_message}). "
                "Continuing analysis so your recommendation still completes."
            )
            fallback_words = fallback_text.split()
            for idx, word in enumerate(fallback_words):
                token_text = f"{word} " if idx < len(fallback_words) - 1 else word
                yield create_event(
                    "agent_token",
                    {
                        "agent": agent_name.lower(),
                        "text": token_text,
                        "type": "token",
                        "token_source": "fallback",
                        "round": round_number,
                        "phase": phase,
                    },
                )
                if await request.is_disconnected():
                    return
                await asyncio.sleep(0.01)
    except Exception as e:
        logger.error(f"[Kai Stream] Streaming error for {agent_name}: {e}", exc_info=True)
        # Non-fatal - analysis will continue without streaming


# ============================================================================
# STREAMING GENERATOR
# ============================================================================


async def analyze_stream_generator(
    ticker: str,
    user_id: str,
    consent_token: str,
    risk_profile: str,
    context: Optional[Dict[str, Any]],
    request: Request,
) -> AsyncGenerator[dict, None]:
    """
    Generator for streaming Kai analysis via SSE.

    Yields events:
    - kai_thinking: Streaming tokens showing Kai's reasoning
    - agent_start: Agent begins analysis
    - agent_complete: Agent finished with insight
    - round_start: Debate round begins
    - debate_round: Each round of debate with agent statements
    - decision: Final decision card
    - error: Any errors
    """

    # Create disconnection event to signal DebateEngine when client disconnects
    disconnection_event = asyncio.Event()

    async def check_disconnected() -> bool:
        """Check if client disconnected and log for debugging."""
        is_disconnected = await request.is_disconnected()
        if is_disconnected:
            logger.info("[Kai Stream] Client disconnected, stopping processing...")
            disconnection_event.set()  # Signal DebateEngine to stop
        return is_disconnected

    logger.info(f"[Kai Stream] Starting analysis for {ticker} - user {user_id}")

    stream_token = _stream_ctx.set(CanonicalSSEStream("stock_analyze"))
    stream_ctx = _stream_ctx.get()
    stream_id = stream_ctx.stream_id if stream_ctx is not None else None
    loop = asyncio.get_running_loop()
    stream_started_at = loop.time()
    llm_calls_count = 0
    provider_calls_count = 0
    retry_counts: dict[str, int] = {"fundamental": 0, "sentiment": 0, "valuation": 0}
    pre_agent_thinking_enabled = _pre_agent_streaming_enabled()
    analysis_mode = "full_stream" if pre_agent_thinking_enabled else "lean_stream"
    symbol_eligibility = False
    eligibility_reason = "excluded_missing_equity_classification"
    eligibility_source = "request_symbol"

    def remaining_timeout() -> float:
        elapsed = loop.time() - stream_started_at
        remaining = STOCK_ANALYZE_TIMEOUT_SECONDS - elapsed
        if remaining <= 0:
            raise asyncio.TimeoutError(
                f"Analyze stream timed out after {STOCK_ANALYZE_TIMEOUT_SECONDS}s"
            )
        return remaining

    try:
        yield create_event(
            "start",
            {
                "phase": "analysis",
                "round": 1,
                "progress_pct": 1,
                "message": f"Starting Kai analysis stream for {ticker}.",
            },
        )
        yield create_event(
            "kai_thinking",
            {
                "phase": "analysis",
                "round": 1,
                "message": "Preparing PKM context and Renaissance universe signals...",
                "tokens": ["Connecting", "to", "context", "layers", "and", "screening", "data."],
            },
        )

        request_context: Dict[str, Any] = context if isinstance(context, dict) else {}
        eligibility = _resolve_symbol_eligibility(ticker=ticker, request_context=request_context)
        symbol_eligibility = bool(eligibility.get("symbol_eligibility"))
        eligibility_reason = str(
            eligibility.get("eligibility_reason") or "excluded_missing_equity_classification"
        )
        eligibility_source = str(eligibility.get("eligibility_source") or "request_symbol")
        if not symbol_eligibility:
            yield create_event(
                "error",
                {
                    "code": "ANALYZE_NOT_ELIGIBLE_FOR_ALPHAAGENTS",
                    "message": (
                        "Selected symbol is not eligible for equity-only AlphaAgents analysis. "
                        "Choose an SEC common equity holding."
                    ),
                    "ticker": ticker,
                    "symbol_eligibility": symbol_eligibility,
                    "eligibility_reason": eligibility_reason,
                    "eligibility_source": eligibility_source,
                },
                terminal=True,
            )
            return
        if not is_gemini_ready():
            yield create_event(
                "warning",
                {
                    "phase": "analysis",
                    "round": 1,
                    "code": "LLM_STREAM_UNAVAILABLE",
                    "retryable": False,
                    "message": get_gemini_unavailable_reason()
                    or "Gemini streaming unavailable. Continuing with deterministic fallback.",
                },
            )

        # =========================================================================
        # 1. FETCH FULL CONTEXT (The Omniscient Backend)
        # =========================================================================

        # A + B. Pull Renaissance + PKM context in parallel.
        renaissance_service = get_renaissance_service()
        pkm_service = get_pkm_service()
        context_results = await asyncio.wait_for(
            asyncio.gather(
                renaissance_service.get_analysis_context(ticker),
                pkm_service.get_index_v2(user_id),
                return_exceptions=True,
            ),
            timeout=remaining_timeout(),
        )
        renaissance_result, wm_result = context_results

        renaissance_lookup_error: Exception | None = (
            renaissance_result if isinstance(renaissance_result, Exception) else None
        )
        if renaissance_lookup_error is not None:
            logger.warning(
                "[Kai Stream] Renaissance context lookup failed for %s: %s",
                ticker,
                renaissance_lookup_error,
            )
            renaissance_context: Dict[str, Any] = {}
        else:
            renaissance_context = renaissance_result if isinstance(renaissance_result, dict) else {}

        if isinstance(wm_result, Exception):
            logger.warning("[Kai Stream] PKM fetch failed for %s: %s", user_id, wm_result)
            wm_index = None
        else:
            wm_index = wm_result

        request_pick_source = str(request_context.get("pick_source") or "").strip() or None
        if request_pick_source:
            renaissance_context = await _merge_ria_pick_package_context(
                user_id=user_id,
                ticker=ticker,
                pick_source=request_pick_source,
                renaissance_context=renaissance_context,
            )

        full_user_context: Dict[str, Any] = {
            "risk_profile": risk_profile,
            "holdings_summary": [],
            "holdings_count": 0,
            "goals": [],
            "learned_attributes": [],
            "preferences": {},
            "user_name": request_context.get("name")
            or request_context.get("display_name")
            or request_context.get("user_name")
            or "Investor",
            "request_context": request_context,
        }

        request_holdings = request_context.get("holdings")
        if isinstance(request_holdings, list):
            canonical_portfolio_context = _build_canonical_portfolio_context(request_holdings)
            full_user_context["holdings"] = request_holdings
            full_user_context["holdings_summary"] = canonical_portfolio_context["holdings_summary"]
            full_user_context["holdings_count"] = canonical_portfolio_context["holdings_count"]
            full_user_context["portfolio_snapshot"] = {
                "non_cash_holdings_count": canonical_portfolio_context["non_cash_holdings_count"],
                "investable_holdings_count": canonical_portfolio_context[
                    "investable_holdings_count"
                ],
                "cash_positions_count": canonical_portfolio_context["cash_positions_count"],
                "cash_value": canonical_portfolio_context["cash_value"],
                "total_value": canonical_portfolio_context["total_value"],
                "estimated_annual_income": canonical_portfolio_context["estimated_annual_income"],
                "losers_count": canonical_portfolio_context["losers_count"],
                "winners_count": canonical_portfolio_context["winners_count"],
            }
            full_user_context["eligible_symbols"] = canonical_portfolio_context["eligible_symbols"]

        requested_holdings_count = _safe_int(request_context.get("holdings_count"))
        if requested_holdings_count is not None:
            full_user_context["holdings_count"] = max(
                int(full_user_context.get("holdings_count") or 0),
                max(0, requested_holdings_count),
            )

        request_debate_context = request_context.get("debate_context")
        if isinstance(request_debate_context, dict):
            full_user_context["debate_context"] = request_debate_context
            snapshot = request_debate_context.get("portfolio_snapshot")
            if isinstance(snapshot, dict):
                snapshot_holdings = _safe_int(snapshot.get("holdings_count"))
                if snapshot_holdings is not None:
                    full_user_context["holdings_count"] = max(
                        int(full_user_context.get("holdings_count") or 0),
                        max(0, snapshot_holdings),
                    )

        for rich_key in (
            "account_summary",
            "asset_allocation",
            "income_summary",
            "realized_gain_loss",
            "quality_report_v2",
        ):
            value = request_context.get(rich_key)
            if isinstance(value, dict):
                full_user_context[rich_key] = value

        total_value_context = _safe_float(request_context.get("total_value"))
        if total_value_context is not None:
            full_user_context["total_value"] = total_value_context

        cash_balance_context = _safe_float(request_context.get("cash_balance"))
        if cash_balance_context is not None:
            full_user_context["cash_balance"] = cash_balance_context

        if wm_index and wm_index.domain_summaries:
            # Extract Financial Context
            fin_summary = wm_index.domain_summaries.get("financial", {})
            summary_holdings_count = _extract_summary_count(
                fin_summary if isinstance(fin_summary, dict) else {}
            )
            full_user_context["holdings_count"] = max(
                int(full_user_context.get("holdings_count") or 0),
                summary_holdings_count,
            )

            requested_allocation = request_context.get("asset_allocation")
            if isinstance(requested_allocation, dict):
                full_user_context["portfolio_allocation"] = requested_allocation
            else:
                full_user_context["portfolio_allocation"] = {
                    "equities": fin_summary.get("equities_pct", 0),
                    "cash": fin_summary.get("cash_pct", 0),
                    "fixed_income": fin_summary.get("bonds_pct", 0),
                }
            full_user_context["financial_summary"] = fin_summary

            # Extract financial profile summary flags (stored from onboarding preferences flow)
            financial_profile_summary = {
                "profile_completed": fin_summary.get("profile_completed"),
                "risk_profile": fin_summary.get("risk_profile"),
                "risk_score": fin_summary.get("risk_score"),
                "has_investment_horizon": fin_summary.get("has_investment_horizon"),
                "has_drawdown_response": fin_summary.get("has_drawdown_response"),
                "has_volatility_preference": fin_summary.get("has_volatility_preference"),
            }
            full_user_context["financial_profile_summary"] = {
                key: value
                for key, value in financial_profile_summary.items()
                if value not in (None, "")
            }

            # Extract Learned Attributes (across all domains)
            # In a real implementation, we might filter for relevant ones
            # For now, we pass the raw domain summaries
            full_user_context["domain_summaries"] = wm_index.domain_summaries

        # Merge frontend-provided preference hints (decrypted client-side context where available).
        preference_container = {}
        if isinstance(request_context.get("preferences"), dict):
            preference_container.update(request_context.get("preferences", {}))
        if isinstance(request_context.get("financial_profile"), dict):
            profile = request_context.get("financial_profile", {})
            preference_container.update(
                {
                    "investment_horizon": profile.get("investment_horizon"),
                    "investment_style": profile.get("investment_style"),
                    "risk_profile": profile.get("risk_profile"),
                }
            )
        if "investment_horizon" in request_context:
            preference_container["investment_horizon"] = request_context.get("investment_horizon")
        if "investment_style" in request_context:
            preference_container["investment_style"] = request_context.get("investment_style")
        full_user_context["preferences"] = {
            key: value for key, value in preference_container.items() if value not in (None, "")
        }

        missing_requirements = sorted(
            set(
                _validate_pkm_context_requirements(full_user_context)
                + _validate_renaissance_context_requirements(
                    renaissance_context,
                    renaissance_lookup_error,
                )
            )
        )
        context_integrity = {
            "pkm_context_present": not any(
                item.startswith("pkm_") for item in missing_requirements
            ),
            "renaissance_context_present": not any(
                item.startswith("renaissance_") for item in missing_requirements
            ),
            "missing_requirements": missing_requirements,
        }
        if missing_requirements:
            yield create_event(
                "error",
                {
                    "code": "ANALYZE_CONTEXT_REQUIRED",
                    "message": (
                        "Analysis requires both PKM portfolio context "
                        "and Renaissance screening context."
                    ),
                    "ticker": ticker,
                    "missing_requirements": missing_requirements,
                    "context_integrity": context_integrity,
                },
                terminal=True,
            )
            return
        renaissance_comparison = _build_renaissance_comparison(renaissance_context)

        # Yield thinking event about context retrieval
        yield create_event(
            "kai_thinking",
            {
                "text": f"Analyzing {ticker} with {renaissance_context.get('tier', 'Standard')} Tier context...",
                "phase": "analysis",
                "round": 1,
            },
        )

        # =========================================================================
        # 2. INITIALIZE ENGINE WITH INJECTED DATA
        # =========================================================================

        # Normalize risk_profile to lowercase for DebateEngine config
        normalized_risk_profile = risk_profile.lower() if risk_profile else "balanced"

        debate_engine = DebateEngine(
            risk_profile=normalized_risk_profile,
            disconnection_event=disconnection_event,
            user_context=full_user_context,
            renaissance_context=renaissance_context,
        )

        # =========================================================================
        # 3. STREAM AGENT THOUGHTS (Round 1 Pre-computation)
        # =========================================================================

        # Initialize agents
        fundamental_agent = FundamentalAgent(processing_mode="hybrid")
        sentiment_agent = SentimentAgent(processing_mode="hybrid")
        valuation_agent = ValuationAgent(processing_mode="hybrid")
        degraded_agents: list[str] = []

        # =====================================================================
        # PHASE 1: Parallel Agent Analysis
        # =====================================================================

        # Kai thinking - orchestration reasoning
        yield create_event(
            "kai_thinking",
            {
                "phase": "analysis",
                "round": 1,
                "message": f"🧠 Starting analysis pipeline for {ticker}...",
                "tokens": [
                    "Activating",
                    "three",
                    "specialist",
                    "agents:",
                    "Fundamental,",
                    "Sentiment,",
                    "and",
                    "Valuation.",
                ],
            },
        )
        await asyncio.sleep(0.05)

        yield create_event(
            "kai_thinking",
            {
                "phase": "analysis",
                "round": 1,
                "message": "📊 Each agent will perform deep analysis using specialized tools and data sources...",
                "tokens": [
                    "Fundamental:",
                    "SEC",
                    "filings,",
                    "financial",
                    "ratios.",
                    "Sentiment:",
                    "news,",
                    "catalysts.",
                    "Valuation:",
                    "P/E,",
                    "DCF",
                    "models.",
                ],
            },
        )
        await asyncio.sleep(0.05)

        # Emit agent starts before the concurrent provider work begins so the stream
        # contract still reflects real analysis start, not work that already completed.
        yield create_event(
            "agent_start",
            {
                "agent": "fundamental",
                "agent_name": "Fundamental Agent",
                "color": "#3b82f6",
                "message": f"Analyzing SEC filings for {ticker}...",
                "round": 1,
                "phase": "analysis",
            },
        )
        yield create_event(
            "agent_start",
            {
                "agent": "sentiment",
                "agent_name": "Sentiment Agent",
                "color": "#8b5cf6",
                "message": f"Analyzing market sentiment for {ticker}...",
                "round": 1,
                "phase": "analysis",
            },
        )
        yield create_event(
            "agent_start",
            {
                "agent": "valuation",
                "agent_name": "Valuation Agent",
                "color": "#10b981",
                "message": f"Calculating valuation metrics for {ticker}...",
                "round": 1,
                "phase": "analysis",
            },
        )

        # Parallelize the sequential agent calls to reduce 'Time-To-First-Token' for the debate engine.
        concurrent_results = await asyncio.gather(
            asyncio.wait_for(
                fundamental_agent.analyze(
                    ticker=ticker,
                    user_id=user_id,
                    consent_token=consent_token,
                    context=context,
                ),
                timeout=remaining_timeout(),
            ),
            asyncio.wait_for(
                sentiment_agent.analyze(
                    ticker=ticker,
                    user_id=user_id,
                    consent_token=consent_token,
                    context=context,
                ),
                timeout=remaining_timeout(),
            ),
            asyncio.wait_for(
                valuation_agent.analyze(
                    ticker=ticker,
                    user_id=user_id,
                    consent_token=consent_token,
                    context=context,
                ),
                timeout=remaining_timeout(),
            ),
            return_exceptions=True,
        )
        fundamental_first_res, sentiment_first_res, valuation_first_res = concurrent_results

        if pre_agent_thinking_enabled:
            llm_calls_count += 1
            # Optional pre-analysis thinking stream for debug visibility.
            async for token_event in stream_agent_thinking(
                agent_name="Fundamental",
                ticker=ticker,
                prompt_context="Analyze SEC filings, revenue trends, cash flow, and business moat.",
                request=request,
                round_number=1,
                phase="analysis",
            ):
                _ = remaining_timeout()
                yield token_event

                # Check for disconnection after each token
                if await check_disconnected():
                    logger.info(
                        "[Kai Stream] Client disconnected during fundamental streaming, stopping..."
                    )
                    return

        # Run actual fundamental analysis (this gets the structured data)
        try:
            max_agent_attempts = 3
            fundamental_insight = None
            fundamental_last_error: Optional[Exception] = None
            for attempt in range(1, max_agent_attempts + 1):
                try:
                    provider_calls_count += 1
                    if attempt == 1:
                        if isinstance(fundamental_first_res, Exception):
                            raise fundamental_first_res
                        fundamental_insight = fundamental_first_res
                    else:
                        fundamental_insight = await asyncio.wait_for(
                            fundamental_agent.analyze(
                                ticker=ticker,
                                user_id=user_id,
                                consent_token=consent_token,
                                context=context,
                            ),
                            timeout=remaining_timeout(),
                        )
                    fundamental_last_error = None
                    break
                except Exception as agent_err:
                    fundamental_last_error = agent_err
                    if _is_retryable_rate_limit_error(agent_err) and attempt < max_agent_attempts:
                        retry_counts["fundamental"] = retry_counts.get("fundamental", 0) + 1
                        retry_delay = min(8, 2**attempt)
                        yield create_event(
                            "warning",
                            {
                                "phase": "analysis",
                                "round": 1,
                                "agent": "fundamental",
                                "code": "AGENT_RATE_LIMIT_RETRY",
                                "retryable": True,
                                "retry_in_seconds": retry_delay,
                                "message": (
                                    "Fundamental agent hit provider rate limits. "
                                    f"Retrying from the same step in {retry_delay}s."
                                ),
                            },
                        )
                        yield create_event(
                            "kai_thinking",
                            {
                                "phase": "analysis",
                                "round": 1,
                                "message": (
                                    "Fundamental agent throttled by provider. "
                                    f"Retrying in {retry_delay}s without restarting debate."
                                ),
                            },
                        )
                        await asyncio.sleep(retry_delay)
                        continue
                    break
            if fundamental_last_error is not None or fundamental_insight is None:
                raise fundamental_last_error or RuntimeError("Fundamental agent returned no output")
            yield create_event(
                "agent_complete",
                {
                    "agent": "fundamental",
                    "summary": fundamental_insight.summary,
                    "recommendation": fundamental_insight.recommendation,
                    "confidence": fundamental_insight.confidence,
                    "key_metrics": fundamental_insight.key_metrics,
                    "quant_metrics": fundamental_insight.quant_metrics,
                    "business_moat": fundamental_insight.business_moat,
                    "financial_resilience": fundamental_insight.financial_resilience,
                    "growth_efficiency": fundamental_insight.growth_efficiency,
                    "bull_case": fundamental_insight.bull_case,
                    "bear_case": fundamental_insight.bear_case,
                    "sources": fundamental_insight.sources,
                    "round": 1,
                    "phase": "analysis",
                },
            )
        except Exception as e:
            logger.error(f"[Kai Stream] Fundamental agent error: {e}")
            yield create_event(
                "agent_error",
                {"agent": "fundamental", "error": str(e), "round": 1, "phase": "analysis"},
            )
            degraded_agents.append("fundamental")
            fundamental_insight = _build_fallback_fundamental_insight(ticker, e)
            yield create_event(
                "warning",
                {
                    "phase": "analysis",
                    "round": 1,
                    "agent": "fundamental",
                    "code": "AGENT_DEGRADED",
                    "message": "Fundamental agent degraded to deterministic fallback.",
                    "retryable": _is_retryable_rate_limit_error(e),
                    "analysis_degraded": True,
                },
            )
            yield create_event(
                "agent_complete",
                {
                    "agent": "fundamental",
                    "summary": fundamental_insight.summary,
                    "recommendation": fundamental_insight.recommendation,
                    "confidence": fundamental_insight.confidence,
                    "key_metrics": fundamental_insight.key_metrics,
                    "quant_metrics": fundamental_insight.quant_metrics,
                    "business_moat": fundamental_insight.business_moat,
                    "financial_resilience": fundamental_insight.financial_resilience,
                    "growth_efficiency": fundamental_insight.growth_efficiency,
                    "bull_case": fundamental_insight.bull_case,
                    "bear_case": fundamental_insight.bear_case,
                    "sources": fundamental_insight.sources,
                    "fallback_used": True,
                    "round": 1,
                    "phase": "analysis",
                },
            )

        # Check if client disconnected
        if await request.is_disconnected():
            return

        if pre_agent_thinking_enabled:
            llm_calls_count += 1
            # Optional pre-analysis thinking stream for debug visibility.
            async for token_event in stream_agent_thinking(
                agent_name="Sentiment",
                ticker=ticker,
                prompt_context="Analyze news sentiment, market catalysts, and momentum signals.",
                request=request,
                round_number=1,
                phase="analysis",
            ):
                _ = remaining_timeout()
                yield token_event

                # Check for disconnection after each token
                if await check_disconnected():
                    logger.info(
                        "[Kai Stream] Client disconnected during sentiment streaming, stopping..."
                    )
                    return

        # Run actual sentiment analysis
        try:
            max_agent_attempts = 3
            sentiment_insight = None
            sentiment_last_error: Optional[Exception] = None
            for attempt in range(1, max_agent_attempts + 1):
                try:
                    provider_calls_count += 1
                    if attempt == 1:
                        if isinstance(sentiment_first_res, Exception):
                            raise sentiment_first_res
                        sentiment_insight = sentiment_first_res
                    else:
                        sentiment_insight = await asyncio.wait_for(
                            sentiment_agent.analyze(
                                ticker=ticker,
                                user_id=user_id,
                                consent_token=consent_token,
                                context=context,
                            ),
                            timeout=remaining_timeout(),
                        )
                    sentiment_last_error = None
                    break
                except Exception as agent_err:
                    sentiment_last_error = agent_err
                    if _is_retryable_rate_limit_error(agent_err) and attempt < max_agent_attempts:
                        retry_counts["sentiment"] = retry_counts.get("sentiment", 0) + 1
                        retry_delay = min(8, 2**attempt)
                        yield create_event(
                            "warning",
                            {
                                "phase": "analysis",
                                "round": 1,
                                "agent": "sentiment",
                                "code": "AGENT_RATE_LIMIT_RETRY",
                                "retryable": True,
                                "retry_in_seconds": retry_delay,
                                "message": (
                                    "Sentiment agent hit provider rate limits. "
                                    f"Retrying from the same step in {retry_delay}s."
                                ),
                            },
                        )
                        yield create_event(
                            "kai_thinking",
                            {
                                "phase": "analysis",
                                "round": 1,
                                "message": (
                                    "Sentiment agent throttled by provider. "
                                    f"Retrying in {retry_delay}s without restarting debate."
                                ),
                            },
                        )
                        await asyncio.sleep(retry_delay)
                        continue
                    break
            if sentiment_last_error is not None or sentiment_insight is None:
                raise sentiment_last_error or RuntimeError("Sentiment agent returned no output")
            yield create_event(
                "agent_complete",
                {
                    "agent": "sentiment",
                    "summary": sentiment_insight.summary,
                    "recommendation": sentiment_insight.recommendation,
                    "confidence": sentiment_insight.confidence,
                    "sentiment_score": sentiment_insight.sentiment_score,
                    "key_catalysts": sentiment_insight.key_catalysts,
                    "sources": sentiment_insight.sources,
                    "round": 1,
                    "phase": "analysis",
                },
            )
        except Exception as e:
            logger.error(f"[Kai Stream] Sentiment agent error: {e}")
            yield create_event(
                "agent_error",
                {"agent": "sentiment", "error": str(e), "round": 1, "phase": "analysis"},
            )
            degraded_agents.append("sentiment")
            sentiment_insight = _build_fallback_sentiment_insight(ticker, e)
            yield create_event(
                "warning",
                {
                    "phase": "analysis",
                    "round": 1,
                    "agent": "sentiment",
                    "code": "AGENT_DEGRADED",
                    "message": "Sentiment agent degraded to deterministic fallback.",
                    "retryable": _is_retryable_rate_limit_error(e),
                    "analysis_degraded": True,
                },
            )
            yield create_event(
                "agent_complete",
                {
                    "agent": "sentiment",
                    "summary": sentiment_insight.summary,
                    "recommendation": sentiment_insight.recommendation,
                    "confidence": sentiment_insight.confidence,
                    "sentiment_score": sentiment_insight.sentiment_score,
                    "key_catalysts": sentiment_insight.key_catalysts,
                    "sources": sentiment_insight.sources,
                    "fallback_used": True,
                    "round": 1,
                    "phase": "analysis",
                },
            )

        if await request.is_disconnected():
            return

        if pre_agent_thinking_enabled:
            llm_calls_count += 1
            # Optional pre-analysis thinking stream for debug visibility.
            async for token_event in stream_agent_thinking(
                agent_name="Valuation",
                ticker=ticker,
                prompt_context="Analyze P/E multiples, DCF valuation, and peer comparisons.",
                request=request,
                round_number=1,
                phase="analysis",
            ):
                _ = remaining_timeout()
                yield token_event

                # Check for disconnection after each token
                if await check_disconnected():
                    logger.info(
                        "[Kai Stream] Client disconnected during valuation streaming, stopping..."
                    )
                    return

        # Run actual valuation analysis
        try:
            max_agent_attempts = 3
            valuation_insight = None
            valuation_last_error: Optional[Exception] = None
            for attempt in range(1, max_agent_attempts + 1):
                try:
                    provider_calls_count += 1
                    if attempt == 1:
                        if isinstance(valuation_first_res, Exception):
                            raise valuation_first_res
                        valuation_insight = valuation_first_res
                    else:
                        valuation_insight = await asyncio.wait_for(
                            valuation_agent.analyze(
                                ticker=ticker,
                                user_id=user_id,
                                consent_token=consent_token,
                                context=context,
                            ),
                            timeout=remaining_timeout(),
                        )
                    valuation_last_error = None
                    break
                except Exception as agent_err:
                    valuation_last_error = agent_err
                    if _is_retryable_rate_limit_error(agent_err) and attempt < max_agent_attempts:
                        retry_counts["valuation"] = retry_counts.get("valuation", 0) + 1
                        retry_delay = min(8, 2**attempt)
                        yield create_event(
                            "warning",
                            {
                                "phase": "analysis",
                                "round": 1,
                                "agent": "valuation",
                                "code": "AGENT_RATE_LIMIT_RETRY",
                                "retryable": True,
                                "retry_in_seconds": retry_delay,
                                "message": (
                                    "Valuation agent hit provider rate limits. "
                                    f"Retrying from the same step in {retry_delay}s."
                                ),
                            },
                        )
                        yield create_event(
                            "kai_thinking",
                            {
                                "phase": "analysis",
                                "round": 1,
                                "message": (
                                    "Valuation agent throttled by provider. "
                                    f"Retrying in {retry_delay}s without restarting debate."
                                ),
                            },
                        )
                        await asyncio.sleep(retry_delay)
                        continue
                    break
            if valuation_last_error is not None or valuation_insight is None:
                raise valuation_last_error or RuntimeError("Valuation agent returned no output")
            yield create_event(
                "agent_complete",
                {
                    "agent": "valuation",
                    "summary": valuation_insight.summary,
                    "recommendation": valuation_insight.recommendation,
                    "confidence": valuation_insight.confidence,
                    "valuation_metrics": valuation_insight.valuation_metrics,
                    "peer_comparison": valuation_insight.peer_comparison,
                    "price_targets": valuation_insight.price_targets,
                    "sources": valuation_insight.sources,
                    "round": 1,
                    "phase": "analysis",
                },
            )
        except Exception as e:
            logger.error(f"[Kai Stream] Valuation agent error: {e}")
            yield create_event(
                "agent_error",
                {"agent": "valuation", "error": str(e), "round": 1, "phase": "analysis"},
            )
            degraded_agents.append("valuation")
            valuation_insight = _build_fallback_valuation_insight(ticker, e)
            yield create_event(
                "warning",
                {
                    "phase": "analysis",
                    "round": 1,
                    "agent": "valuation",
                    "code": "AGENT_DEGRADED",
                    "message": "Valuation agent degraded to deterministic fallback.",
                    "retryable": _is_retryable_rate_limit_error(e),
                    "analysis_degraded": True,
                },
            )
            yield create_event(
                "agent_complete",
                {
                    "agent": "valuation",
                    "summary": valuation_insight.summary,
                    "recommendation": valuation_insight.recommendation,
                    "confidence": valuation_insight.confidence,
                    "valuation_metrics": valuation_insight.valuation_metrics,
                    "peer_comparison": valuation_insight.peer_comparison,
                    "price_targets": valuation_insight.price_targets,
                    "sources": valuation_insight.sources,
                    "fallback_used": True,
                    "round": 1,
                    "phase": "analysis",
                },
            )

        if await request.is_disconnected():
            return

        # =====================================================================
        # PHASE 2 & 3: Debate & Decision (Streaming)
        # =====================================================================

        # Kai thinking - starting debate
        yield create_event(
            "kai_thinking",
            {
                "phase": "round1",
                "round": 1,
                "message": "⚖️ Now orchestrating multi-agent debate to reach consensus...",
                "tokens": [
                    "Each",
                    "agent",
                    "will",
                    "present",
                    "their",
                    "position",
                    "in",
                    "two",
                    "rounds.",
                    "Dissent",
                    "will",
                    "be",
                    "captured.",
                ],
            },
        )

        # NOTE: DebateEngine now handles all intermediate streaming (kai_thinking, agent_token, debate_round)
        # We pipeline its generator directly to the output.

        debate_result = None
        current_round = 1
        current_phase = "analysis"
        debate_highlights: list[dict[str, Any]] = []

        async for event in debate_engine.orchestrate_debate_stream(
            fundamental_insight=fundamental_insight,
            sentiment_insight=sentiment_insight,
            valuation_insight=valuation_insight,
            user_context=full_user_context,  # Redundant but keeps signature clean
        ):
            # If client disconnected, stop yielding
            if await check_disconnected():
                return
            _ = remaining_timeout()
            event_name = event.get("event", "message")
            event_payload = event.get("data", {})
            if isinstance(event_payload, str):
                try:
                    event_payload = json.loads(event_payload)
                except json.JSONDecodeError:
                    event_payload = {"message": event_payload}
            elif not isinstance(event_payload, dict):
                event_payload = {"value": event_payload}
            normalized_payload = _normalize_analyze_event_payload(
                event_name,
                event_payload,
                default_round=current_round,
                default_phase=current_phase,
            )
            if event_name in {"debate_round", "round_start"}:
                current_round = _safe_round(normalized_payload.get("round"), current_round)
                current_phase = str(
                    normalized_payload.get("phase")
                    or ("debate" if current_round == 2 else "analysis")
                )
            elif event_name in {"agent_start", "agent_token", "agent_complete", "agent_error"}:
                current_round = _safe_round(normalized_payload.get("round"), current_round)
                current_phase = str(normalized_payload.get("phase") or current_phase)
                if event_name == "agent_start" and current_round == 2:
                    llm_calls_count += 1
            elif event_name == "insight_extracted":
                if len(debate_highlights) < 36:
                    debate_highlights.append(
                        {
                            "type": normalized_payload.get("type"),
                            "agent": normalized_payload.get("agent"),
                            "content": str(normalized_payload.get("content") or "")[:360],
                            "classification": normalized_payload.get("classification"),
                            "confidence": normalized_payload.get("confidence"),
                            "magnitude": normalized_payload.get("magnitude"),
                            "score": normalized_payload.get("score"),
                            "source": normalized_payload.get("source"),
                        }
                    )
            yield create_event(event_name, normalized_payload)

            # Check for disconnection after each event
            if await check_disconnected():
                logger.info("[Kai Stream] Client disconnected during debate streaming, stopping...")
                return

        # Access the final result from the engine state (cleaner than return value hacking)
        # We need to reconstruct it or expose it.
        # Let's assume for now we can rebuild the decision card from the stored rounds in the engine or similar.
        # Actually, let's look at DebateEngine again.

        # RE-READING my DebateEngine implementation:
        # It calculates "result" at the end and returns it.
        # To get this "result" object out of `async for`, we can't easily.
        # BETTER APPROACH: Do the logic here.

        # Wait, I can just recalculate it effectively or trust the engine to yield the "decision" event?
        # My DebateEngine implementation DOES NOT yield "decision". It yields "debate_round", etc.
        # So I need to calculate the decision here or add it to the engine.

        # Let's use the engine's internal state to build the final card.
        # Or better: call _build_consensus manually again? No, that's wasteful.

        # Let's do this:
        # The DebateEngine logic I wrote runs `_build_consensus` at the end.
        # I will call that here to get the final object for the "decision" event.

        debate_result = await asyncio.wait_for(
            debate_engine._build_consensus(
                fundamental_insight, sentiment_insight, valuation_insight
            ),
            timeout=remaining_timeout(),
        )
        # Note: debate_engine.rounds is populated by the generator run!
        debate_result.rounds = debate_engine.rounds

        # =====================================================================
        # FINAL DECISION EVENT
        # =====================================================================

        # Kai thinking - final reasoning
        yield create_event(
            "kai_thinking",
            {
                "phase": "decision",
                "round": 2,
                "message": "🎯 Synthesizing final recommendation from debate outcomes...",
                "tokens": [
                    "Weighting",
                    "agent",
                    "votes",
                    "by",
                    risk_profile,
                    "risk",
                    "profile.",
                    "Calculating",
                    "confidence",
                    "score.",
                ],
            },
        )
        await asyncio.sleep(0.3)

        if debate_result.consensus_reached:
            yield create_event(
                "kai_thinking",
                {
                    "phase": "decision",
                    "round": 2,
                    "message": "✅ Consensus reached. All agents agree on the recommendation.",
                    "tokens": ["Unanimous", "agreement:", debate_result.decision.upper()],
                },
            )
        else:
            yield create_event(
                "kai_thinking",
                {
                    "phase": "decision",
                    "round": 2,
                    "message": f"⚠️ Majority decision with {len(debate_result.dissenting_opinions)} dissenting opinion(s).",
                    "tokens": [
                        "Majority",
                        "recommends:",
                        debate_result.decision.upper(),
                        "with",
                        "dissent",
                        "noted.",
                    ],
                },
            )
        await asyncio.sleep(0.2)

        synthesis_payload = await asyncio.wait_for(
            synthesize_debate_recommendation_card(
                ticker=ticker,
                risk_profile=risk_profile,
                user_context=full_user_context,
                renaissance_context=renaissance_context,
                fundamental_payload={
                    "summary": fundamental_insight.summary,
                    "recommendation": fundamental_insight.recommendation,
                    "confidence": fundamental_insight.confidence,
                    "business_moat": fundamental_insight.business_moat,
                    "financial_resilience": fundamental_insight.financial_resilience,
                    "growth_efficiency": fundamental_insight.growth_efficiency,
                    "bull_case": fundamental_insight.bull_case,
                    "bear_case": fundamental_insight.bear_case,
                    "key_metrics": fundamental_insight.key_metrics,
                    "quant_metrics": fundamental_insight.quant_metrics,
                },
                sentiment_payload={
                    "summary": sentiment_insight.summary,
                    "recommendation": sentiment_insight.recommendation,
                    "confidence": sentiment_insight.confidence,
                    "sentiment_score": sentiment_insight.sentiment_score,
                    "key_catalysts": sentiment_insight.key_catalysts,
                },
                valuation_payload={
                    "summary": valuation_insight.summary,
                    "recommendation": valuation_insight.recommendation,
                    "confidence": valuation_insight.confidence,
                    "valuation_metrics": valuation_insight.valuation_metrics,
                    "peer_comparison": valuation_insight.peer_comparison,
                    "price_targets": valuation_insight.price_targets,
                },
                debate_payload={
                    "decision": debate_result.decision,
                    "confidence": debate_result.confidence,
                    "consensus_reached": debate_result.consensus_reached,
                    "agent_votes": debate_result.agent_votes,
                    "dissenting_opinions": debate_result.dissenting_opinions,
                    "final_statement": debate_result.final_statement,
                },
                highlights=debate_highlights,
            ),
            timeout=min(remaining_timeout(), 30.0),
        )
        analysis_degraded = len(degraded_agents) > 0
        if analysis_degraded:
            analysis_mode = "degraded"
        synthesis_short = ""
        if isinstance(synthesis_payload, dict):
            for key in ("short_recommendation", "thesis", "summary"):
                value = synthesis_payload.get(key)
                if isinstance(value, str) and value.strip():
                    synthesis_short = value.strip()
                    break
        short_recommendation = (
            synthesis_short
            if synthesis_short
            else _build_short_recommendation(
                debate_result.decision,
                debate_result.confidence,
                debate_result.final_statement,
                degraded_agents,
            )
        )
        sentiment_score_value = _safe_float(sentiment_insight.sentiment_score)
        market_trend_label, market_trend_score = _derive_market_trend(
            sentiment_score_value,
            debate_result.decision,
        )
        fair_value_label, fair_value_score, fair_value_gap_pct = _derive_fair_value(
            price_targets=valuation_insight.price_targets,
            valuation_metrics=valuation_insight.valuation_metrics,
            valuation_recommendation=valuation_insight.recommendation,
        )
        company_strength_score = _derive_company_strength_score(
            fundamental_confidence=_safe_float(fundamental_insight.confidence),
            valuation_confidence=_safe_float(valuation_insight.confidence),
            debate_confidence=_safe_float(debate_result.confidence) or 0.5,
            sentiment_score=sentiment_score_value,
            fair_value_score=fair_value_score,
            market_trend_score=market_trend_score,
        )
        analysis_updated_at = _now_utc_iso()
        market_snapshot = _derive_market_snapshot(
            valuation_metrics=valuation_insight.valuation_metrics,
            price_targets=valuation_insight.price_targets,
            analysis_updated_at=analysis_updated_at,
        )

        pkm_context = {
            "risk_profile": full_user_context.get("risk_profile"),
            "preferences": full_user_context.get("preferences", {}),
            "holdings_count": int(
                full_user_context.get("holdings_count")
                or len(full_user_context.get("holdings_summary", []) or [])
            ),
            "portfolio_allocation": full_user_context.get("portfolio_allocation", {}),
            "has_domain_summaries": bool(full_user_context.get("domain_summaries")),
        }

        pick_source = str(full_user_context.get("pick_source") or "").strip() or None
        pick_source_label = str(full_user_context.get("pick_source_label") or "").strip() or None
        pick_source_kind = str(full_user_context.get("pick_source_kind") or "").strip() or None
        structured_sources = [
            {
                "label": source,
                "url": None,
                "kind": "provider",
            }
            for source in list(
                set(
                    fundamental_insight.sources
                    + sentiment_insight.sources
                    + valuation_insight.sources
                )
            )
            if isinstance(source, str) and source.strip()
        ]
        structured_sources.append(
            {
                "label": "AlphaAgents paper",
                "paper_title": "AlphaAgents",
                "url": "https://arxiv.org/pdf/2508.11152",
                "kind": "paper",
            }
        )

        # Build raw_card structure
        raw_card = {
            "fundamental_insight": {
                "summary": fundamental_insight.summary,
                "business_moat": fundamental_insight.business_moat,
                "financial_resilience": fundamental_insight.financial_resilience,
                "growth_efficiency": fundamental_insight.growth_efficiency,
                "bull_case": fundamental_insight.bull_case,
                "bear_case": fundamental_insight.bear_case,
            },
            "quant_metrics": fundamental_insight.quant_metrics,
            "key_metrics": {
                "fundamental": fundamental_insight.key_metrics,
                "sentiment": {
                    "sentiment_score": sentiment_insight.sentiment_score,
                    "catalyst_count": len(sentiment_insight.key_catalysts)
                    if sentiment_insight.key_catalysts
                    else 0,
                },
                "valuation": valuation_insight.valuation_metrics,
            },
            "price_targets": valuation_insight.price_targets,
            "all_sources": list(
                set(
                    fundamental_insight.sources
                    + sentiment_insight.sources
                    + valuation_insight.sources
                )
            ),
            "structured_sources": structured_sources,
            "risk_persona_alignment": f"This {debate_result.decision.upper()} recommendation aligns with your {risk_profile} risk profile.",
            "debate_digest": debate_result.final_statement,
            "consensus_reached": debate_result.consensus_reached,
            "dissenting_opinions": debate_result.dissenting_opinions,
            "debate_highlights": debate_highlights[:20],
            "pkm_context": pkm_context,
            "context_integrity": context_integrity,
            "renaissance_comparison": renaissance_comparison,
            "renaissance_tier": renaissance_context.get("tier"),
            "renaissance_score": float(renaissance_context.get("conviction_weight", 0.0) or 0.0)
            * 100.0,
            "renaissance_context": {
                "tier": renaissance_context.get("tier"),
                "tier_description": renaissance_context.get("tier_description"),
                "conviction_weight": renaissance_context.get("conviction_weight"),
                "investment_thesis": renaissance_context.get("investment_thesis"),
                "fcf_billions": renaissance_context.get("fcf_billions"),
                "sector": renaissance_context.get("sector"),
                "sector_peers": renaissance_context.get("sector_peers", []),
                "recommendation_bias": renaissance_context.get("recommendation_bias"),
                "is_investable": renaissance_context.get("is_investable"),
                "is_avoid": renaissance_context.get("is_avoid"),
                "avoid_reason": renaissance_context.get("avoid_reason"),
                "screening_criteria": renaissance_context.get("screening_criteria"),
            },
            "alphaagents_trace": {
                "paper": "arXiv:2508.11152v1",
                "paper_title": "AlphaAgents",
                "paper_url": "https://arxiv.org/pdf/2508.11152",
                "protocol": "round_robin_adversarial_debate",
                "rounds_executed": len(debate_engine.rounds),
                "turns_per_agent": 2,
                "consensus_method": "weighted_vote_by_risk_profile",
                "consensus_threshold": 0.70,
                "consensus_reached": debate_result.consensus_reached,
            },
            "llm_synthesis": synthesis_payload,
            "company_strength_score": company_strength_score,
            "market_trend_label": market_trend_label,
            "market_trend_score": market_trend_score,
            "fair_value_label": fair_value_label,
            "fair_value_score": fair_value_score,
            "fair_value_gap_pct": fair_value_gap_pct,
            "analysis_updated_at": analysis_updated_at,
            "market_snapshot": market_snapshot,
            "short_recommendation": short_recommendation,
            "analysis_degraded": analysis_degraded,
            "degraded_agents": sorted(set(degraded_agents)),
            "stream_diagnostics": {
                "stream_id": stream_id,
                "llm_calls_count": llm_calls_count,
                "provider_calls_count": provider_calls_count,
                "retry_counts": retry_counts,
                "analysis_mode": analysis_mode,
            },
            "symbol_eligibility": symbol_eligibility,
            "eligibility_reason": eligibility_reason,
            "eligibility_source": eligibility_source,
            "pick_source": pick_source,
            "pick_source_label": pick_source_label,
            "pick_source_kind": pick_source_kind,
        }

        yield create_event(
            "decision",
            {
                "ticker": ticker,
                "decision": debate_result.decision,
                "confidence": debate_result.confidence,
                "consensus_reached": debate_result.consensus_reached,
                "agent_votes": debate_result.agent_votes,
                "dissenting_opinions": debate_result.dissenting_opinions,
                "final_statement": debate_result.final_statement,
                "fundamental_summary": fundamental_insight.summary,
                "sentiment_summary": sentiment_insight.summary,
                "valuation_summary": valuation_insight.summary,
                "company_strength_score": company_strength_score,
                "market_trend_label": market_trend_label,
                "market_trend_score": market_trend_score,
                "fair_value_label": fair_value_label,
                "fair_value_score": fair_value_score,
                "fair_value_gap_pct": fair_value_gap_pct,
                "analysis_updated_at": analysis_updated_at,
                "market_snapshot": market_snapshot,
                "short_recommendation": short_recommendation,
                "analysis_degraded": analysis_degraded,
                "degraded_agents": sorted(set(degraded_agents)),
                "stream_id": stream_id,
                "llm_calls_count": llm_calls_count,
                "provider_calls_count": provider_calls_count,
                "retry_counts": retry_counts,
                "analysis_mode": analysis_mode,
                "symbol_eligibility": symbol_eligibility,
                "eligibility_reason": eligibility_reason,
                "eligibility_source": eligibility_source,
                "pick_source": pick_source,
                "pick_source_label": pick_source_label,
                "pick_source_kind": pick_source_kind,
                "context_integrity": context_integrity,
                "renaissance_comparison": renaissance_comparison,
                "raw_card": raw_card,
                "round": 2,
                "phase": "decision",
            },
            terminal=True,
        )

        logger.info(f"[Kai Stream] Analysis complete for {ticker}: {debate_result.decision}")

    except asyncio.TimeoutError:
        logger.warning(
            "[Kai Stream] Hard timeout (%ss) reached for %s",
            STOCK_ANALYZE_TIMEOUT_SECONDS,
            ticker,
        )
        yield create_event(
            "error",
            {
                "code": "ANALYZE_TIMEOUT",
                "message": f"Analysis timed out after {STOCK_ANALYZE_TIMEOUT_SECONDS}s.",
                "ticker": ticker,
            },
            terminal=True,
        )
    except Exception as e:
        logger.exception(f"[Kai Stream] Error during analysis: {e}")
        yield create_event(
            "error",
            {"code": "ANALYZE_STREAM_FAILED", "message": str(e), "ticker": ticker},
            terminal=True,
        )
    finally:
        _stream_ctx.reset(stream_token)


def _create_sse_response(generator: AsyncGenerator[dict, None]) -> EventSourceResponse:
    async def _instrumented() -> AsyncGenerator[dict, None]:
        started = time.perf_counter()
        event_count = 0
        saw_terminal = False
        request_id = get_request_id() or "unknown"
        logger.info(
            "stream.lifecycle_start stream=kai_analyze request_id=%s",
            request_id,
        )
        try:
            async for frame in generator:
                event_count += 1
                data = frame.get("data") if isinstance(frame, dict) else None
                if isinstance(data, str) and '"terminal":true' in data.replace(" ", "").lower():
                    saw_terminal = True
                yield frame
        finally:
            duration_ms = round((time.perf_counter() - started) * 1000, 2)
            logger.info(
                "stream.lifecycle_end stream=kai_analyze request_id=%s duration_ms=%s event_count=%s terminal=%s",
                request_id,
                duration_ms,
                event_count,
                saw_terminal,
            )

    return EventSourceResponse(
        _instrumented(),
        ping=15,
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "Access-Control-Allow-Origin": "*",
        },
    )


def _parse_cursor(cursor: Optional[int]) -> int:
    if cursor is None:
        return 0
    try:
        parsed = int(cursor)
    except Exception as exc:  # pragma: no cover - guard
        raise HTTPException(status_code=422, detail="cursor must be an integer") from exc
    if parsed < 0:
        raise HTTPException(status_code=422, detail="cursor must be >= 0")
    return parsed


def _stream_factory(
    ticker: str,
    user_id: str,
    consent_token: str,
    risk_profile: str,
    context: Optional[Dict[str, Any]],
    request: Request,
) -> AsyncGenerator[dict, None]:
    return analyze_stream_generator(
        ticker=ticker,
        user_id=user_id,
        consent_token=consent_token,
        risk_profile=risk_profile,
        context=context,
        request=request,
    )


# ============================================================================
# SSE ENDPOINTS
# ============================================================================


@router.get("/analyze/stream")
async def analyze_stream(
    request: Request,
    ticker: str,
    user_id: str,
    risk_profile: str = "balanced",
    authorization: Optional[str] = Header(None, description="Bearer VAULT_OWNER consent token"),
):
    """
    SSE endpoint for streaming Kai analysis.

    Streams real-time updates as each agent completes analysis
    and during the multi-agent debate process.

    Events:
    - agent_start: Agent begins analysis
    - agent_complete: Agent finished with insight summary
    - agent_error: Agent encountered an error
    - debate_start: Debate phase begins
    - debate_round: Each round of agent debate
    - decision: Final decision card
    - error: Fatal error
    """
    # Auth path includes validate_token() inside _require_vault_owner_token().
    consent_token = await _require_vault_owner_token(user_id=user_id, authorization=authorization)

    # Log operation for audit trail (shows what vault.owner token was used for)
    consent_service = ConsentDBService()
    await consent_service.log_operation(
        user_id=user_id,
        operation="kai.analyze",
        target=ticker,
        metadata={"risk_profile": risk_profile, "endpoint": "stream/analyze"},
    )

    logger.info(f"[Kai Stream] SSE connection opened for {ticker} - user {user_id}")

    return _create_sse_response(
        analyze_stream_generator(
            ticker=ticker,
            user_id=user_id,
            consent_token=consent_token,
            risk_profile=risk_profile,
            context=None,
            request=request,
        )
    )


@router.post("/analyze/stream")
async def analyze_stream_post(
    request: Request,
    body: StreamAnalyzeRequest,
    authorization: Optional[str] = Header(None, description="Bearer VAULT_OWNER consent token"),
):
    """
    POST version of streaming analysis (allows context in body).
    Also supports streaming an existing resumable run via run_id.
    """
    # Auth path includes validate_token() inside _require_vault_owner_token().
    consent_token = await _require_vault_owner_token(
        user_id=body.user_id,
        authorization=authorization,
    )

    if body.run_id:
        run = await _RUN_MANAGER.get_run(body.run_id)
        if run is None:
            raise HTTPException(
                status_code=404,
                detail={
                    "code": "ANALYZE_RUN_NOT_FOUND",
                    "message": "No run found for requested run_id.",
                    "run_id": body.run_id,
                },
            )
        if run.user_id != body.user_id:
            raise HTTPException(status_code=403, detail="Token user mismatch")

        start_cursor = _parse_cursor(body.resume_cursor)
        if start_cursor > run.latest_cursor:
            raise HTTPException(
                status_code=410,
                detail={
                    "code": "ANALYZE_RUN_RESUME_EXPIRED",
                    "message": "Requested cursor is beyond buffered events.",
                    "run_id": run.run_id,
                    "latest_cursor": run.latest_cursor,
                },
            )
        return _create_sse_response(
            _RUN_MANAGER.stream_run_events(
                run=run,
                start_cursor=start_cursor,
                request=request,
            )
        )

    # Log operation for audit trail (shows what vault.owner token was used for)
    consent_service = ConsentDBService()
    await consent_service.log_operation(
        user_id=body.user_id,
        operation="kai.analyze",
        target=body.ticker,
        metadata={
            "risk_profile": body.risk_profile,
            "endpoint": "stream/analyze",
            "has_context": body.context is not None,
        },
    )

    return _create_sse_response(
        analyze_stream_generator(
            ticker=body.ticker,
            user_id=body.user_id,
            consent_token=consent_token,
            risk_profile=body.risk_profile,
            context=body.context,
            request=request,
        )
    )


@router.post("/analyze/run/start")
async def analyze_run_start(
    body: StartAnalyzeRunRequest,
    authorization: Optional[str] = Header(None, description="Bearer VAULT_OWNER consent token"),
):
    """Start or attach to a session-locked background analyze run."""
    consent_token = await _require_vault_owner_token(
        user_id=body.user_id,
        authorization=authorization,
    )
    consent_service = ConsentDBService()
    next_context = dict(body.context or {})
    if body.pick_source:
        next_context["pick_source"] = str(body.pick_source).strip()
    if body.pick_source_label:
        next_context["pick_source_label"] = str(body.pick_source_label).strip()
    if body.pick_source_kind:
        next_context["pick_source_kind"] = str(body.pick_source_kind).strip()
    await consent_service.log_operation(
        user_id=body.user_id,
        operation="kai.analyze.run.start",
        target=body.ticker,
        metadata={
            "risk_profile": body.risk_profile,
            "debate_session_id": body.debate_session_id,
            "has_context": bool(next_context),
            "pick_source": body.pick_source,
            "pick_source_kind": body.pick_source_kind,
        },
    )
    state, run = await _RUN_MANAGER.start_or_get_active(
        user_id=body.user_id,
        debate_session_id=body.debate_session_id,
        ticker=body.ticker,
        risk_profile=body.risk_profile,
        context=next_context or None,
        consent_token=consent_token,
        generator_factory=_stream_factory,
    )
    if state == "active":
        raise HTTPException(
            status_code=409,
            detail={
                "code": "ANALYZE_RUN_ALREADY_ACTIVE",
                "message": "A debate run is already active for this client session.",
                "active_run": run.to_public_dict(),
            },
        )
    return {"run": run.to_public_dict()}


@router.get("/analyze/run/active")
async def analyze_run_active(
    user_id: str,
    debate_session_id: str,
    authorization: Optional[str] = Header(None, description="Bearer VAULT_OWNER consent token"),
):
    """Get active run for a given user/session.

    Returns HTTP 200 with ``{"run": null}`` when no active run exists.
    """
    await _require_vault_owner_token(user_id=user_id, authorization=authorization)
    run = await _RUN_MANAGER.get_active(user_id=user_id, debate_session_id=debate_session_id)
    return {"run": run.to_public_dict() if run else None}


@router.get("/analyze/run/{run_id}/stream")
async def analyze_run_stream(
    request: Request,
    run_id: str,
    user_id: str,
    cursor: Optional[int] = 0,
    authorization: Optional[str] = Header(None, description="Bearer VAULT_OWNER consent token"),
):
    """Replay buffered events (from cursor) and continue streaming live."""
    await _require_vault_owner_token(user_id=user_id, authorization=authorization)
    run = await _RUN_MANAGER.get_run(run_id)
    if run is None or run.user_id != user_id:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "ANALYZE_RUN_NOT_FOUND",
                "message": "No run found for requested run_id.",
                "run_id": run_id,
            },
        )

    start_cursor = _parse_cursor(cursor)
    if start_cursor > run.latest_cursor:
        raise HTTPException(
            status_code=410,
            detail={
                "code": "ANALYZE_RUN_RESUME_EXPIRED",
                "message": "Requested cursor is beyond buffered events.",
                "run_id": run.run_id,
                "latest_cursor": run.latest_cursor,
            },
        )

    return _create_sse_response(
        _RUN_MANAGER.stream_run_events(
            run=run,
            start_cursor=start_cursor,
            request=request,
        )
    )


@router.post("/analyze/run/{run_id}/cancel")
async def analyze_run_cancel(
    run_id: str,
    user_id: str,
    authorization: Optional[str] = Header(None, description="Bearer VAULT_OWNER consent token"),
):
    """Cancel an active run."""
    await _require_vault_owner_token(user_id=user_id, authorization=authorization)
    run = await _RUN_MANAGER.cancel_run(run_id=run_id, user_id=user_id)
    if run is None:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "ANALYZE_RUN_NOT_FOUND",
                "message": "No run found for requested run_id.",
                "run_id": run_id,
            },
        )
    return {"run": run.to_public_dict()}
