"""
Kai Losers Analysis API Route

Provides a portfolio-level losers analysis using:
- Renaissance investable universe (tiers + thesis)
- Renaissance avoid list (direct + extended)
- Renaissance screening criteria rubric (criteria-first prompting)

Authentication:
- Requires VAULT_OWNER token (consent-first architecture)
"""

import asyncio
import json
import logging
import re
from decimal import Decimal
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from api.middleware import require_vault_owner_token
from api.routes.kai._streaming import (
    HEARTBEAT_INTERVAL_SECONDS,
    CanonicalSSEStream,
    parse_json_with_single_repair,
)
from hushh_mcp.constants import (
    GEMINI_MODEL,
    KAI_LLM_MAX_OUTPUT_TOKENS_DEFAULT,
    KAI_LLM_STREAM_INCLUDE_THOUGHTS,
    KAI_LLM_TEMPERATURE,
    KAI_LLM_THINKING_ENABLED,
    KAI_LLM_THINKING_LEVEL,
    KAI_OPTIMIZE_MAX_OUTPUT_TOKENS,
    KAI_OPTIMIZE_STREAM_TIMEOUT_SECONDS,
)
from hushh_mcp.operons.kai.fetchers import RealtimeDataUnavailable, fetch_market_data
from hushh_mcp.services.renaissance_service import get_renaissance_service

logger = logging.getLogger(__name__)

router = APIRouter()


class PortfolioLoser(BaseModel):
    symbol: str = Field(..., description="Ticker symbol")
    name: Optional[str] = None
    gain_loss_pct: Optional[float] = Field(
        None, description="Unrealized P/L percent (negative for losers)"
    )
    gain_loss: Optional[float] = Field(None, description="Unrealized P/L amount")
    market_value: Optional[float] = None


class PortfolioHolding(BaseModel):
    """Full-position snapshot for Optimize Portfolio (not only losers)."""

    symbol: str = Field(..., description="Ticker symbol")
    name: Optional[str] = None
    gain_loss_pct: Optional[float] = Field(None, description="Unrealized P/L percent")
    gain_loss: Optional[float] = Field(None, description="Unrealized P/L amount")
    market_value: Optional[float] = Field(None, description="Current market value of the position")
    sector: Optional[str] = Field(None, description="Sector or industry label if available")
    asset_type: Optional[str] = Field(
        None, description="High-level asset type (equity, cash, ETF, etc.)"
    )


class AnalyzeLosersRequest(BaseModel):
    user_id: str
    losers: list[PortfolioLoser] = Field(default_factory=list)
    threshold_pct: float = Field(-5.0, description="Only analyze losers at or below this %")
    max_positions: int = Field(
        10, ge=1, le=50, description="Max number of loser positions to analyze"
    )
    holdings: list[PortfolioHolding] = Field(
        default_factory=list,
        description="Optional full holdings snapshot for Optimize Portfolio.",
    )
    force_optimize: bool = Field(
        False,
        description=(
            "If true and losers do not meet the threshold, treat holdings as the "
            "optimization universe instead of returning an error."
        ),
    )
    user_preferences: dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "Optional user-level portfolio preferences from PKM context "
            "(e.g., investment_horizon, investment_style, concentration guardrails)."
        ),
    )


class AnalyzeLosersResponse(BaseModel):
    criteria_context: str
    summary: dict
    losers: list[dict]
    portfolio_level_takeaways: list[str]
    analytics: Optional[dict] = Field(None, description="Radar and sector distribution metrics")


def _convert_decimals(obj: Any) -> Any:
    """Recursively convert Decimal objects to float for JSON serialization."""
    if isinstance(obj, Decimal):
        return float(obj)
    if isinstance(obj, dict):
        return {k: _convert_decimals(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_convert_decimals(i) for i in obj]
    return obj


def _extract_likely_json_object(text: str) -> str | None:
    """
    Conservative salvage pass: trim code fences / prose around a root JSON object.
    Returns None when no viable object window is found.
    """
    if not text:
        return None

    candidate = text.strip()
    if candidate.startswith("```"):
        candidate = re.sub(r"^```(?:json)?\s*", "", candidate, flags=re.IGNORECASE)
    if candidate.endswith("```"):
        candidate = candidate[:-3]
    candidate = candidate.strip()

    start = candidate.find("{")
    end = candidate.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None

    trimmed = candidate[start : end + 1].strip()
    return trimmed or None


def _is_cash_equivalent_position(
    *,
    symbol: str,
    name: str | None = None,
    asset_type: str | None = None,
) -> bool:
    token = str(symbol or "").strip().upper()
    if token in {"CASH", "MMF", "SWEEP", "QACDS"}:
        return True
    name_l = str(name or "").strip().lower()
    asset_l = str(asset_type or "").strip().lower()
    hints = ("cash", "money market", "sweep", "core position", "deposit")
    return any(hint in name_l for hint in hints) or any(hint in asset_l for hint in hints)


def _summarize_excluded_cash_positions(holdings: list[PortfolioHolding]) -> tuple[int, float]:
    count = 0
    market_value_sum = 0.0
    for holding in holdings:
        if not _is_cash_equivalent_position(
            symbol=holding.symbol,
            name=holding.name,
            asset_type=holding.asset_type,
        ):
            continue
        count += 1
        market_value_sum += float(holding.market_value or 0.0)
    return count, round(market_value_sum, 2)


def _build_deterministic_optimization_fallback(
    *,
    criteria_context: str,
    per_loser_context: list[dict[str, Any]],
    replacement_pool: list[dict[str, Any]],
    total_mv: float,
) -> dict[str, Any]:
    """Fallback response when LLM synthesis is unavailable or malformed."""
    high_conviction = [
        candidate for candidate in replacement_pool if candidate.get("tier") in {"ACE", "KING"}
    ]
    avoid_count = 0
    investable_count = 0
    losers_payload: list[dict[str, Any]] = []

    for position in per_loser_context:
        ren = position.get("renaissance", {}) or {}
        is_avoid = bool(ren.get("is_avoid"))
        is_investable = bool(ren.get("is_investable"))
        tier = ren.get("tier")
        weight_pct = position.get("weight_pct")

        if is_avoid:
            action = "exit"
            rationale = "Renaissance avoid coverage flags this position as structurally weak for new capital."
            target_weight_pct = 0.0
            avoid_count += 1
        elif is_investable and tier in {"ACE", "KING"}:
            action = "hold"
            rationale = "This remains inside the investable universe, so the fallback keeps exposure while monitoring concentration."
            target_weight_pct = weight_pct
            investable_count += 1
        elif is_investable:
            action = "trim"
            rationale = "The position is investable but not top-tier, so the fallback trims risk before adding higher-conviction names."
            target_weight_pct = (
                round((weight_pct or 0.0) * 0.75, 2) if weight_pct is not None else None
            )
            investable_count += 1
        else:
            action = "rotate"
            rationale = "Coverage is incomplete or non-investable, so the fallback prefers rotating into higher-conviction names."
            target_weight_pct = 0.0

        replacements = [
            {
                "ticker": candidate.get("ticker"),
                "tier": candidate.get("tier"),
                "why": candidate.get("thesis")
                or "Higher-conviction Renaissance replacement candidate.",
            }
            for candidate in high_conviction[:3]
        ]

        losers_payload.append(
            {
                "symbol": position.get("symbol"),
                "name": position.get("name"),
                "renaissance_tier": tier,
                "avoid_category": ren.get("avoid_category"),
                "criteria_flags": [flag for flag in [tier, ren.get("avoid_category")] if flag],
                "needs_more_data": not is_investable and not is_avoid,
                "likely_driver": "unknown" if not is_investable else "fundamental",
                "confidence": 0.42,
                "action": action,
                "rationale": rationale,
                "replacement_candidates": replacements,
                "current_weight_pct": weight_pct,
                "target_weight_pct": target_weight_pct,
            }
        )

    current_health = max(25.0, min(85.0, 55.0 + investable_count * 6.0 - avoid_count * 12.0))
    projected_health = max(current_health, min(92.0, current_health + 12.0))
    avoid_weight_pct = 0.0
    investable_weight_pct = 0.0
    if total_mv > 0:
        for position in per_loser_context:
            ren = position.get("renaissance", {}) or {}
            market_value = float(position.get("market_value") or 0.0)
            pct = market_value / total_mv * 100.0
            if ren.get("is_avoid"):
                avoid_weight_pct += pct
            if ren.get("is_investable"):
                investable_weight_pct += pct

    takeaways = [
        "Fallback optimization was used because the model response could not be trusted for this run.",
        "Prefer rotating non-investable or avoid-list exposure into ACE or KING replacements first.",
        "Keep concentration in any single position below the product guardrail before adding new risk.",
    ]

    return {
        "criteria_context": criteria_context,
        "summary": {
            "health_score": round(current_health, 1),
            "projected_health_score": round(projected_health, 1),
            "health_reasons": [
                f"{investable_count} positions are still inside the investable universe.",
                f"{avoid_count} positions carry avoid-list risk or incomplete coverage.",
                "Fallback plan emphasizes diversification and higher-conviction replacements.",
            ],
            "portfolio_diagnostics": {
                "total_losers_value": round(total_mv, 2),
                "avoid_weight_estimate_pct": round(avoid_weight_pct, 2),
                "investable_weight_estimate_pct": round(investable_weight_pct, 2),
                "concentration_notes": [
                    "Review positions with the largest market values first.",
                    "Reduce reliance on names without durable realtime or filing coverage.",
                ],
            },
            "plans": {
                "minimal": {
                    "actions": [
                        {
                            "symbol": loser["symbol"],
                            "name": loser["name"],
                            "action": loser["action"].upper(),
                            "rationale": loser["rationale"],
                            "current_weight_pct": loser["current_weight_pct"],
                            "target_weight_pct": loser["target_weight_pct"],
                        }
                        for loser in losers_payload[:3]
                    ]
                },
                "standard": {
                    "actions": [
                        {
                            "symbol": loser["symbol"],
                            "name": loser["name"],
                            "action": loser["action"].upper(),
                            "rationale": loser["rationale"],
                            "current_weight_pct": loser["current_weight_pct"],
                            "target_weight_pct": loser["target_weight_pct"],
                        }
                        for loser in losers_payload
                    ]
                },
                "maximal": {
                    "actions": [
                        {
                            "symbol": loser["symbol"],
                            "name": loser["name"],
                            "action": "ROTATE"
                            if loser["action"] in {"exit", "rotate"}
                            else loser["action"].upper(),
                            "rationale": loser["rationale"],
                            "current_weight_pct": loser["current_weight_pct"],
                            "target_weight_pct": loser["target_weight_pct"],
                        }
                        for loser in losers_payload
                    ]
                },
            },
        },
        "losers": losers_payload,
        "portfolio_level_takeaways": takeaways,
        "analytics": {
            "health_radar": {
                "current": {
                    "Growth": round(current_health * 0.85, 1),
                    "Moat": round(current_health * 0.8, 1),
                    "Quality": round(current_health * 0.9, 1),
                    "Income": round(current_health * 0.65, 1),
                    "Resilience": round(current_health * 0.78, 1),
                    "Diversification": round(current_health * 0.75, 1),
                },
                "optimized": {
                    "Growth": round(projected_health * 0.9, 1),
                    "Moat": round(projected_health * 0.88, 1),
                    "Quality": round(projected_health * 0.92, 1),
                    "Income": round(projected_health * 0.7, 1),
                    "Resilience": round(projected_health * 0.84, 1),
                    "Diversification": round(projected_health * 0.86, 1),
                },
            },
            "sector_shift": [],
        },
    }


@router.post("/portfolio/analyze-losers", response_model=AnalyzeLosersResponse)
async def analyze_portfolio_losers(
    request: AnalyzeLosersRequest,
    token_data: dict = Depends(require_vault_owner_token),
) -> AnalyzeLosersResponse:
    """
    Analyze portfolio losers against Renaissance investable/avoid lists + criteria rubric.

    IMPORTANT: BYOK constraints mean the backend does not persist a user’s full holdings.
    The caller must provide the loser positions (symbol + P/L context).
    """
    if token_data["user_id"] != request.user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="User ID does not match token"
        )

    (
        _losers_filtered,
        criteria_context,
        criteria_rows,
        replacement_pool,
        per_loser_context,
        optimize_from_losers,
        total_mv,
    ) = await _build_optimization_context(
        request=request,
        user_id=request.user_id,
        consent_token=token_data["token"],
    )

    # LLM synthesis (Optimize Portfolio: criteria-first, JSON-only output)
    # SDK auto-configures from GOOGLE_API_KEY and GOOGLE_GENAI_USE_VERTEXAI env vars
    from google import genai
    from google.genai import types as genai_types
    from google.genai.types import HttpOptions

    client = genai.Client(http_options=HttpOptions(api_version="v1"))
    model_to_use = GEMINI_MODEL
    logger.info(f"Optimize Portfolio: Using Vertex AI with model {model_to_use}")
    cash_positions_excluded, cash_value_excluded = _summarize_excluded_cash_positions(
        request.holdings or []
    )

    portfolio_snapshot = {
        "threshold_pct": request.threshold_pct,
        "max_positions": request.max_positions,
        "mode": "losers" if optimize_from_losers else "full_portfolio",
        "total_positions_market_value": total_mv,
        "positions": per_loser_context,
        "cash_positions_excluded": cash_positions_excluded,
        "cash_value_excluded": cash_value_excluded,
        "user_preferences": request.user_preferences or {},
    }

    prompt = _build_optimization_prompt(
        criteria_context=criteria_context,
        criteria_rows=criteria_rows,
        replacement_pool=replacement_pool,
        portfolio_snapshot=portfolio_snapshot,
    )

    try:
        config_kwargs: dict[str, Any] = {
            "temperature": KAI_LLM_TEMPERATURE,
            "max_output_tokens": KAI_LLM_MAX_OUTPUT_TOKENS_DEFAULT,
            "response_mime_type": "application/json",
        }
        if KAI_LLM_THINKING_ENABLED:
            thinking_level = getattr(
                genai_types.ThinkingLevel,
                str(KAI_LLM_THINKING_LEVEL).upper(),
                genai_types.ThinkingLevel.HIGH,
            )
            config_kwargs["thinking_config"] = genai_types.ThinkingConfig(
                include_thoughts=False,
                thinking_level=thinking_level,
            )
        config = genai_types.GenerateContentConfig(**config_kwargs)
        resp = await client.aio.models.generate_content(
            model=model_to_use,
            contents=prompt,
            config=config,
        )
        raw = (resp.text or "").strip()
        payload, _ = parse_json_with_single_repair(
            raw,
            required_keys={"summary", "losers", "portfolio_level_takeaways"},
        )
    except RealtimeDataUnavailable as e:
        logger.warning(
            "Optimize Portfolio realtime dependency unavailable for user=%s dependency=%s",
            request.user_id,
            e.dependency,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=e.to_payload(),
        ) from e
    except Exception as e:
        logger.warning(
            "Losers analysis LLM failed for user=%s; returning deterministic fallback: %s",
            request.user_id,
            e,
        )
        payload = _build_deterministic_optimization_fallback(
            criteria_context=criteria_context,
            per_loser_context=per_loser_context,
            replacement_pool=replacement_pool,
            total_mv=total_mv,
        )

    # Ensure criteria_context is always present for UI (fallback to rubric)
    payload.setdefault("criteria_context", criteria_context)
    return AnalyzeLosersResponse(**payload)


async def _build_optimization_context(
    request: AnalyzeLosersRequest,
    user_id: str,
    consent_token: str,
) -> tuple[list[PortfolioLoser], str, list[dict], list[dict], list[dict], bool, float]:
    """
    Build the optimization context (shared between streaming and non-streaming endpoints).

    Returns:
        Tuple of (losers_filtered, criteria_context, criteria_rows, replacement_pool,
                  per_loser_context, optimize_from_losers, total_mv)
    """
    losers_in = [
        loser
        for loser in (request.losers or [])
        if not _is_cash_equivalent_position(symbol=loser.symbol, name=loser.name)
    ]
    holdings_in = [
        holding
        for holding in (request.holdings or [])
        if not _is_cash_equivalent_position(
            symbol=holding.symbol,
            name=holding.name,
            asset_type=holding.asset_type,
        )
    ]

    # Build optimization universe
    losers_filtered: list[PortfolioLoser] = []
    for loser in losers_in:
        pct = loser.gain_loss_pct
        if pct is None or pct <= request.threshold_pct:
            losers_filtered.append(loser)
    losers_filtered = losers_filtered[: request.max_positions]

    optimize_from_losers = bool(losers_filtered)

    if not optimize_from_losers:
        if holdings_in:
            if not request.force_optimize:
                logger.info(
                    "Optimize Portfolio: no losers met threshold for user=%s; falling back to holdings-based optimization",
                    request.user_id,
                )
            sorted_holdings = sorted(
                holdings_in,
                key=lambda h: h.market_value or 0.0,
                reverse=True,
            )[: request.max_positions]
            losers_filtered = [
                PortfolioLoser(
                    symbol=h.symbol,
                    name=h.name,
                    gain_loss_pct=h.gain_loss_pct,
                    gain_loss=h.gain_loss,
                    market_value=h.market_value,
                )
                for h in sorted_holdings
            ]
            optimize_from_losers = False
        else:
            if not losers_in:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="No losers provided. Provide loser positions from the client portfolio.",
                )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No losers met the threshold. Lower threshold_pct or provide more losers.",
            )

    renaissance = get_renaissance_service()
    criteria_context = await renaissance.get_screening_context()
    criteria_rows = await renaissance.get_screening_criteria()

    # Build investable replacement candidates: fetch EVERY investable stock
    all_investable = await renaissance.get_all_investable()
    replacement_pool = [
        {
            "ticker": s.ticker,
            "tier": s.tier,
            "sector": s.sector,
            "thesis": s.investment_thesis,
            "name": s.company_name,
        }
        for s in all_investable
    ]

    total_mv = sum((loser.market_value or 0.0) for loser in losers_filtered) or 0.0
    quote_semaphore = asyncio.Semaphore(6)

    async def _build_position_context(loser: PortfolioLoser) -> dict[str, Any]:
        ticker = loser.symbol.upper().strip()
        if not ticker:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Each position must include a ticker symbol.",
            )

        ren_task = asyncio.create_task(renaissance.get_analysis_context(ticker))
        try:
            async with quote_semaphore:
                market_ctx = await fetch_market_data(ticker, user_id, consent_token)
        except RealtimeDataUnavailable as market_error:
            logger.warning(
                "Optimize Portfolio: quote unavailable for %s (%s); failing closed",
                ticker,
                market_error.detail,
            )
            raise
        ren_ctx = await ren_task

        quote = market_ctx.get("quote", {}) if isinstance(market_ctx, dict) else {}
        price = quote.get("price") if isinstance(quote, dict) else None
        if price is None and isinstance(market_ctx, dict):
            price = market_ctx.get("price")
        change_pct = (
            quote.get("change_pct") or quote.get("change_percent")
            if isinstance(quote, dict)
            else None
        )
        if change_pct is None and isinstance(market_ctx, dict):
            change_pct = market_ctx.get("change_pct") or market_ctx.get("change_percent")

        weight_pct = (loser.market_value or 0.0) / total_mv * 100.0 if total_mv > 0 else None
        return {
            "symbol": ticker,
            "name": loser.name,
            "gain_loss_pct": loser.gain_loss_pct,
            "gain_loss": loser.gain_loss,
            "market_value": loser.market_value,
            "weight_pct": weight_pct,
            "realtime": {
                "source": (
                    market_ctx.get("provider") or market_ctx.get("source") or "unknown"
                    if isinstance(market_ctx, dict)
                    else "unknown"
                ),
                "fetched_at": market_ctx.get("fetched_at")
                if isinstance(market_ctx, dict)
                else None,
                "ttl_seconds": market_ctx.get("ttl_seconds")
                if isinstance(market_ctx, dict)
                else None,
                "is_stale": bool(market_ctx.get("is_stale"))
                if isinstance(market_ctx, dict)
                else True,
                "price": price,
                "change_pct": change_pct,
                "degraded": bool(market_ctx.get("degraded"))
                if isinstance(market_ctx, dict)
                else True,
                "fallback_reason": market_ctx.get("fallback_reason")
                if isinstance(market_ctx, dict)
                else None,
            },
            "renaissance": {
                "is_investable": ren_ctx.get("is_investable", False),
                "tier": ren_ctx.get("tier"),
                "tier_description": ren_ctx.get("tier_description"),
                "investment_thesis": ren_ctx.get("investment_thesis"),
                "fcf_billions": ren_ctx.get("fcf_billions"),
                "conviction_weight": ren_ctx.get("conviction_weight"),
                "is_avoid": ren_ctx.get("is_avoid", False),
                "avoid_category": ren_ctx.get("avoid_category"),
                "avoid_reason": ren_ctx.get("avoid_reason"),
                "avoid_source": ren_ctx.get("avoid_source"),
            },
        }

    per_loser_context = await asyncio.gather(
        *(_build_position_context(loser) for loser in losers_filtered)
    )

    return (
        losers_filtered,
        criteria_context,
        criteria_rows,
        replacement_pool,
        per_loser_context,
        optimize_from_losers,
        total_mv,
    )


def _build_optimization_prompt(
    criteria_context: str,
    criteria_rows: list[dict],
    replacement_pool: list[dict],
    portfolio_snapshot: dict,
) -> str:
    """Build the LLM prompt for portfolio optimization."""
    return f"""
You are Kai's **Optimize Portfolio** investment committee.

ROLE AND CONSTRAINTS
--------------------
- You apply the Renaissance screening rubric, tiers, and avoid rules to optimize a REAL portfolio.
- BYOK / consent-first: you NEVER place trades. You only propose illustrative, auditable rebalancing plans.
- You must act like a senior CIO/Portfolio Manager for HNWI clients:
  - No leverage, margin, derivatives, or shorting.
  - No market timing or price targets. Focus on allocation quality and risk.
  - Prefer **tax-efficient rotation from losers into high-conviction ACE/KING names**.
  - Respect diversification: avoid >15% concentration in any single name.
  - REAL DATA: Use the actual `market_value` and `weight_pct` provided. Propose real, data-driven trades.
  - NO MOCK DATA: Never use placeholders like '0' or 'N/A' if reasoning can be derived.

DATA YOU HAVE
-------------
<<RENAISSANCE_RUBRIC>>
{criteria_context}

<<RENAISSANCE_CRITERIA_TABLE>>
{json.dumps(_convert_decimals(criteria_rows), ensure_ascii=False)}

<<RENAISSANCE_TIERS>>
ACE: conviction_weight 1.0  — highest quality, very rare, default bias STRONG_BUY.
KING: conviction_weight 0.85 — high quality, bias BUY.
QUEEN: conviction_weight 0.70 — solid but with more questions, bias HOLD_TO_BUY.
JACK: conviction_weight 0.55 — acceptable but lower quality, bias HOLD.
Any ticker not in the investable universe has conviction_weight 0.0.
If a ticker is in the Renaissance avoid list, conviction_weight is effectively NEGATIVE regardless of tier.

<<REPLACEMENT_POOL>>
{json.dumps(_convert_decimals(replacement_pool), ensure_ascii=False)}

<<USER_PORTFOLIO_SNAPSHOT>>
Depending on mode, this is either:
- Mode "losers": positions currently losing beyond the given threshold.
- Mode "full_portfolio": top positions by market value to optimize around.
Use their market values and weight_pct fields to reason about risk and concentration.
{json.dumps(_convert_decimals(portfolio_snapshot), ensure_ascii=False)}

INSTRUCTIONS
------------
1) Diagnose portfolio health focusing on these losers:
   - Classify each loser as one of: "core_keep", "trim", "exit", "rotate", "watchlist".
   - Compute how much risk is in:
     * Renaissance AVOID names.
     * Non-investable names (neither investable nor avoid).
     * ACE/KING investable names.
   - Comment on concentration and drawdowns using the data available (do NOT invent missing holdings).

2) Design target allocations (conceptual, not exact trading instructions):
   - For each loser, propose a **target_weight_delta** (relative importance) and an `action`:
     * "HOLD", "ADD", "TRIM", "EXIT", or "ROTATE".
   - When suggesting EXIT or ROTATE, pick 1–3 candidates from the replacement pool that better fit the Renaissance rubric.
   - Keep plans self-funded: assume sells in losers finance buys in higher-quality names.

3) Build three plan flavours:
   - "minimal": only obvious, high-conviction changes (e.g., exit avoid names, small trims).
   - "standard": reasonable diversification and risk clean-up.
   - "maximal": aggressively apply the Renaissance funnel, accepting more turnover (still no leverage).

RULES
-----
- Ground EVERY claim in the provided data (loser inputs + Renaissance context + criteria table + replacement pool).
- If you lack key data, set `needs_more_data=true` and say exactly what is missing.
- If a stock is in the avoid list, treat it as a **hard negative prior** and explain why (avoid_category + avoid_reason).
- If a stock is ACE/KING, treat it as a **quality prior**; consider trimming rather than exiting unless the position is extremely large or breaks diversification rules.
- Use the screening criteria rubric to justify recommendations. Whenever possible, reference specific criteria IDs or titles.
- NEVER recommend options, margin, or shorting. NEVER guarantee outcomes.

OUTPUT FORMAT
-------------
Return ONLY valid JSON with this shape (no prose, no markdown):
{{
  "criteria_context": string,
  "summary": {{
    "health_score": number,                     // 0–100 current portfolio health score
    "projected_health_score": number,           // 0–100 PROJECTED health score after plans are executed
    "health_reasons": [string],                 // bullets explaining the score
    "portfolio_diagnostics": {{
      "total_losers_value": number,             // sum of losers market_value
      "avoid_weight_estimate_pct": number,      // approximate % of losers value in avoid names
      "investable_weight_estimate_pct": number, // approximate % of losers value in ACE/KING
      "concentration_notes": [string]
    }},
    "plans": {{
      "minimal": {{ "actions": [ {{ "symbol": string, "name": string, "action": string, "rationale": string, "current_weight_pct": number, "target_weight_pct": number }} ] }},
      "standard": {{ "actions": [ {{ "symbol": string, "name": string, "action": string, "rationale": string, "current_weight_pct": number, "target_weight_pct": number }} ] }},
      "maximal": {{ "actions": [ {{ "symbol": string, "name": string, "action": string, "rationale": string, "current_weight_pct": number, "target_weight_pct": number }} ] }}
    }}
  }},
  "losers": [
    {{
      "symbol": string,
      "name": string,
      "renaissance_tier": string | null,
      "avoid_category": string | null,
      "criteria_flags": [string],
      "needs_more_data": boolean,
      "likely_driver": "fundamental" | "sentiment" | "macro_rates" | "idiosyncratic" | "unknown",
      "confidence": number,
      "action": "hold" | "add" | "trim" | "exit" | "rotate",
      "rationale": string,
      "replacement_candidates": [{{ "ticker": string, "tier": string, "why": string }}],
      "current_weight_pct": number | null,
      "target_weight_pct": number | null
    }}
  ],
  "portfolio_level_takeaways": [string],
  "analytics": {{
    "health_radar": {{
      "current": {{ "Growth": number, "Moat": number, "Quality": number, "Income": number, "Resilience": number, "Diversification": number }},
      "optimized": {{ "Growth": number, "Moat": number, "Quality": number, "Income": number, "Resilience": number, "Diversification": number }}
    }},
    "sector_shift": [
      {{ "sector": string, "before_pct": number, "after_pct": number }}
    ]
  }}
}}
""".strip()


@router.post("/portfolio/analyze-losers/stream")
async def analyze_portfolio_losers_stream(
    request: AnalyzeLosersRequest,
    raw_request: Request,
    token_data: dict = Depends(require_vault_owner_token),
):
    """
    Streaming version of portfolio losers analysis with AI reasoning.

    Uses SSE to stream:
    - 'thinking' events: AI reasoning/thought summaries
    - 'chunk' events: Partial response text
    - 'complete' events: Final parsed JSON result
    - 'error' events: Error messages

    **Disconnection Handling (Production-Grade)**:
    - Layer 1: sse_starlette ping every 15s detects dead connections (app crash, force-close)
    - Layer 2: asyncio.timeout(240) hard ceiling prevents runaway LLM calls
    - Layer 3: backend heartbeats every 3-5s while waiting for model output
    - Layer 4: raw_request.is_disconnected() checked per-chunk for fast cleanup
    """
    if token_data["user_id"] != request.user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="User ID does not match token"
        )

    async def generate():
        HARD_TIMEOUT_SECONDS = KAI_OPTIMIZE_STREAM_TIMEOUT_SECONDS
        stream = CanonicalSSEStream("portfolio_optimize")

        try:
            async with asyncio.timeout(HARD_TIMEOUT_SECONDS):
                # Stage 1: Building context
                yield stream.event(
                    "stage",
                    {"stage": "analyzing", "message": "Analyzing portfolio positions..."},
                )

                (
                    losers_filtered,
                    criteria_context,
                    criteria_rows,
                    replacement_pool,
                    per_loser_context,
                    optimize_from_losers,
                    total_mv,
                ) = await _build_optimization_context(
                    request=request,
                    user_id=request.user_id,
                    consent_token=token_data["token"],
                )
                cash_positions_excluded, cash_value_excluded = _summarize_excluded_cash_positions(
                    request.holdings or []
                )

                portfolio_snapshot = {
                    "threshold_pct": request.threshold_pct,
                    "max_positions": request.max_positions,
                    "mode": "losers" if optimize_from_losers else "full_portfolio",
                    "total_positions_market_value": total_mv,
                    "positions": per_loser_context,
                    "cash_positions_excluded": cash_positions_excluded,
                    "cash_value_excluded": cash_value_excluded,
                    "user_preferences": request.user_preferences or {},
                }

                prompt = _build_optimization_prompt(
                    criteria_context, criteria_rows, replacement_pool, portfolio_snapshot
                )

                # Stage 2: LLM reasoning
                yield stream.event(
                    "stage",
                    {"stage": "thinking", "message": "AI reasoning about portfolio health..."},
                )

                from google import genai
                from google.genai import types as genai_types
                from google.genai.types import HttpOptions

                client = genai.Client(http_options=HttpOptions(api_version="v1"))
                model_to_use = GEMINI_MODEL
                logger.info(f"Optimize Portfolio Stream: Using Vertex AI with model {model_to_use}")

                # Configure for deterministic JSON reliability.
                config_kwargs: dict[str, Any] = {
                    "temperature": KAI_LLM_TEMPERATURE,
                    "max_output_tokens": KAI_OPTIMIZE_MAX_OUTPUT_TOKENS,
                    "response_mime_type": "application/json",
                    "response_schema": {
                        "type": "OBJECT",
                        "properties": {
                            "summary": {"type": "OBJECT"},
                            "losers": {"type": "ARRAY"},
                            "portfolio_level_takeaways": {"type": "ARRAY"},
                            "analytics": {"type": "OBJECT"},
                        },
                        "required": ["summary", "losers", "portfolio_level_takeaways"],
                    },
                }
                if KAI_LLM_THINKING_ENABLED:
                    thinking_level = getattr(
                        genai_types.ThinkingLevel,
                        str(KAI_LLM_THINKING_LEVEL).upper(),
                        genai_types.ThinkingLevel.HIGH,
                    )
                    config_kwargs["thinking_config"] = genai_types.ThinkingConfig(
                        include_thoughts=bool(KAI_LLM_STREAM_INCLUDE_THOUGHTS),
                        thinking_level=thinking_level,
                    )
                config = genai_types.GenerateContentConfig(**config_kwargs)

                # Stream the response
                full_response = ""
                thought_count = 0
                chunk_count = 0
                stream_started_at = asyncio.get_running_loop().time()

                # Get the stream object first (must await the coroutine)
                gen_stream = await client.aio.models.generate_content_stream(
                    model=model_to_use,
                    contents=prompt,
                    config=config,
                )

                client_disconnected = False

                # Then iterate over the stream with heartbeat-safe polling
                stream_iter = gen_stream.__aiter__()
                next_chunk_task: asyncio.Task | None = None
                while True:
                    # Check if client disconnected
                    if await raw_request.is_disconnected():
                        logger.info(
                            "[Losers Analysis] Client disconnected, stopping streaming — saving compute"
                        )
                        client_disconnected = True
                        if next_chunk_task and not next_chunk_task.done():
                            next_chunk_task.cancel()
                        break

                    try:
                        if next_chunk_task is None:
                            next_chunk_task = asyncio.create_task(stream_iter.__anext__())
                        chunk = await asyncio.wait_for(
                            asyncio.shield(next_chunk_task),
                            timeout=HEARTBEAT_INTERVAL_SECONDS,
                        )
                        next_chunk_task = None
                    except asyncio.TimeoutError:
                        elapsed = int(asyncio.get_running_loop().time() - stream_started_at)
                        yield stream.event(
                            "stage",
                            {
                                "stage": "thinking",
                                "message": "Still analyzing portfolio optimization options...",
                                "heartbeat": True,
                                "elapsed_seconds": elapsed,
                                "chunk_count": chunk_count,
                                "total_chars": len(full_response),
                            },
                        )
                        continue
                    except StopAsyncIteration:
                        next_chunk_task = None
                        break

                    appended_response_text = False
                    # Check for thought summaries (Gemini thinking mode)
                    if hasattr(chunk, "candidates") and chunk.candidates:
                        for candidate in chunk.candidates:
                            if hasattr(candidate, "content") and candidate.content:
                                for part in candidate.content.parts:
                                    # Check for thought content
                                    if hasattr(part, "thought") and part.thought:
                                        thought_count += 1
                                        yield stream.event(
                                            "thinking",
                                            {
                                                "phase": "thinking",
                                                "message": "Reasoning through optimization trade-offs...",
                                                "thought": part.text,
                                                "count": thought_count,
                                                "token_source": "thought",
                                            },
                                        )
                                    # Regular text content
                                    elif hasattr(part, "text") and part.text:
                                        chunk_count += 1
                                        full_response += part.text
                                        appended_response_text = True
                                        yield stream.event(
                                            "chunk",
                                            {
                                                "phase": "extracting",
                                                "text": part.text,
                                                "chunk_count": chunk_count,
                                                "token_source": "response",
                                            },
                                        )

                    # Some SDK responses include text on chunk.text even when candidates are present.
                    if not appended_response_text and getattr(chunk, "text", None):
                        chunk_count += 1
                        full_response += str(chunk.text)
                        yield stream.event(
                            "chunk",
                            {
                                "phase": "extracting",
                                "text": str(chunk.text),
                                "chunk_count": chunk_count,
                                "token_source": "response",
                            },
                        )

                # Skip all post-processing if client disconnected — no point parsing for nobody
                if client_disconnected:
                    logger.info(
                        "[Losers Analysis] Skipping post-processing, client gone — LLM compute saved"
                    )
                    return

                # Stage 3: Extracting results
                yield stream.event(
                    "stage",
                    {
                        "stage": "extracting",
                        "message": "Extracting optimization recommendations...",
                    },
                )

                # Parse the final JSON
                try:
                    payload, diagnostics = parse_json_with_single_repair(
                        full_response,
                        required_keys={"summary", "losers", "portfolio_level_takeaways"},
                    )
                    diagnostics["salvage_applied"] = False
                except Exception as parse_error:
                    salvage_candidate = _extract_likely_json_object(full_response)
                    if not salvage_candidate or salvage_candidate == full_response:
                        logger.error(f"Failed to parse LLM response: {parse_error}")
                        yield stream.event(
                            "error",
                            {
                                "code": "OPTIMIZE_PARSE_FAILED",
                                "message": "Unable to normalize optimization output. Please retry.",
                                "diagnostics": {
                                    "response_chars": len(full_response),
                                    "chunk_count": chunk_count,
                                },
                            },
                            terminal=True,
                        )
                        return

                    logger.warning(
                        "[Losers Analysis] Primary parse failed, attempting conservative salvage parse"
                    )
                    try:
                        payload, diagnostics = parse_json_with_single_repair(
                            salvage_candidate,
                            required_keys={"summary", "losers", "portfolio_level_takeaways"},
                        )
                        diagnostics["salvage_applied"] = True
                    except Exception as salvage_error:
                        logger.error(f"Failed to parse LLM response after salvage: {salvage_error}")
                        yield stream.event(
                            "error",
                            {
                                "code": "OPTIMIZE_PARSE_FAILED",
                                "message": "Unable to normalize optimization output. Please retry.",
                                "diagnostics": {
                                    "response_chars": len(full_response),
                                    "chunk_count": chunk_count,
                                },
                            },
                            terminal=True,
                        )
                        return

                try:
                    payload.setdefault("criteria_context", criteria_context)
                    payload["parse_report"] = {
                        "repair_applied": diagnostics.get("repair_applied", False),
                        "repair_actions": diagnostics.get("repair_actions", []),
                        "salvage_applied": diagnostics.get("salvage_applied", False),
                    }

                    yield stream.event("complete", payload, terminal=True)
                except Exception as payload_error:
                    logger.error(f"Failed to finalize parsed payload: {payload_error}")
                    yield stream.event(
                        "error",
                        {
                            "code": "OPTIMIZE_PARSE_FAILED",
                            "message": "Unable to normalize optimization output. Please retry.",
                            "diagnostics": {
                                "response_chars": len(full_response),
                                "chunk_count": chunk_count,
                            },
                        },
                        terminal=True,
                    )

            # end of asyncio.timeout context

        except asyncio.TimeoutError:
            logger.warning(
                f"[Losers Analysis] Hard timeout ({HARD_TIMEOUT_SECONDS}s) reached, stopping LLM"
            )
            yield stream.event(
                "error",
                {
                    "code": "OPTIMIZE_TIMEOUT",
                    "message": f"Analysis timed out after {HARD_TIMEOUT_SECONDS}s. Please try again.",
                },
                terminal=True,
            )
        except RealtimeDataUnavailable as realtime_error:
            yield stream.event(
                "error",
                realtime_error.to_payload(),
                terminal=True,
            )
        except HTTPException as http_err:
            detail = (
                http_err.detail
                if isinstance(http_err.detail, dict)
                else {"message": http_err.detail}
            )
            yield stream.event(
                "error",
                {"code": "OPTIMIZE_HTTP_ERROR", **detail},
                terminal=True,
            )
        except Exception as e:
            logger.error(f"Streaming losers analysis failed: {e}")
            yield stream.event(
                "error",
                {"code": "OPTIMIZE_STREAM_FAILED", "message": str(e)},
                terminal=True,
            )

    return EventSourceResponse(
        generate(),
        ping=15,  # Send ping every 15s — detects dead connections (app crash, force-close, network drop)
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
