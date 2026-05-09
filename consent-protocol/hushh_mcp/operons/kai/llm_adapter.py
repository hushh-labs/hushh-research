# hushh_mcp/operons/kai/llm_adapter.py
"""
Adapter-routed Kai operons (proof migration).

This module ships an *adapter-aware* version of
`synthesize_debate_recommendation_card` that delegates inference to
the provider registry when a consent token + user_id are supplied,
and falls back to the existing Gemini-only path verbatim otherwise.

We isolate the migrated entry point in a new file (rather than rewriting
`llm.py` in place) for three reasons:

1. The diff stays surgical -- reviewers can see the migration as one
   added function and one one-line import change in
   `api/routes/kai/stream.py`, instead of a 1000-line file rewrite.
2. The original `synthesize_debate_recommendation_card` in `llm.py`
   stays as the safe fallback. Any caller that hasn't migrated yet
   still works.
3. Future migrations of `analyze_stock_with_gemini`,
   `analyze_sentiment_with_gemini`, etc. land in this file as well.
   The migration story becomes obvious from the file name alone.

The migration is consent-FORWARD: when callers supply consent tokens
they get the new behavior (provider-agnostic, audited, scope-gated);
when they don't, behavior is byte-for-byte identical to today.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, List, Optional

from hushh_mcp.constants import KAI_SYNTHESIS_MAX_OUTPUT_TOKENS
from hushh_mcp.operons.kai import llm as _llm
from hushh_mcp.operons.kai.providers import (
    CompletionRequest,
    ConsentScopeViolation,
    ProviderError,
    ProviderUnavailable,
    dispatch,
)
from hushh_mcp.operons.kai.providers.registry import default_provider_name

logger = logging.getLogger(__name__)


def _build_synthesis_prompt(
    *,
    ticker: str,
    risk_profile: str,
    user_context: Dict[str, Any],
    renaissance_context: Dict[str, Any],
    fundamental_payload: Dict[str, Any],
    sentiment_payload: Dict[str, Any],
    valuation_payload: Dict[str, Any],
    debate_payload: Dict[str, Any],
    highlights: List[Dict[str, Any]],
) -> str:
    """
    Build the synthesis prompt.

    Identical text to the prompt embedded in
    `llm.synthesize_debate_recommendation_card`. We extract it here so
    the prompt is version-controlled in one place and so the eval
    harness can diff prompt changes across runs.
    """
    return f"""
You are Kai Chief Investment Strategist.
You are given finalized multi-agent debate artifacts for {ticker}.

Your task: produce a concise, institution-grade synthesis that explicitly fuses:
1) AlphaAgents debate outputs,
2) PKM portfolio/user context,
3) Renaissance screening signals.

Return STRICT JSON with keys:
- thesis: string (1 short paragraph)
- key_drivers: string[] (3-6 bullets, specific and evidence-backed)
- key_risks: string[] (3-6 bullets, concrete downside risks)
- action_plan: string[] (3-5 practical next actions for this user)
- watchlist_triggers: string[] (3-6 measurable triggers users should monitor)
- horizon_fit: string (how this fits user's horizon/style/risk)

Constraints:
- No markdown.
- No generic filler.
- Use investor-friendly language suitable for portfolio owners.
- Must mention Renaissance tier/screening signal explicitly.
- Must include at least one concrete user-context personalization (holdings/risk/horizon/style).
- Must include at least one portfolio impact statement (concentration, diversification, drawdown, or risk tradeoff).
- If Renaissance signal conflicts with debate recommendation, state the conflict and risk-control framing.
- Keep each bullet <= 140 chars.

INPUT:
risk_profile={risk_profile}
user_context={json.dumps(user_context, default=str)[:7000]}
renaissance_context={json.dumps(renaissance_context, default=str)[:4000]}
fundamental={json.dumps(fundamental_payload, default=str)[:5000]}
sentiment={json.dumps(sentiment_payload, default=str)[:4000]}
valuation={json.dumps(valuation_payload, default=str)[:4000]}
debate={json.dumps(debate_payload, default=str)[:4000]}
highlights={json.dumps(highlights[:24], default=str)[:4000]}
"""


async def synthesize_debate_recommendation_card_v2(
    *,
    ticker: str,
    risk_profile: str,
    user_context: Dict[str, Any],
    renaissance_context: Dict[str, Any],
    fundamental_payload: Dict[str, Any],
    sentiment_payload: Dict[str, Any],
    valuation_payload: Dict[str, Any],
    debate_payload: Dict[str, Any],
    highlights: List[Dict[str, Any]],
    # New: optional consent + provider routing.
    consent_token: Optional[str] = None,
    user_id: Optional[str] = None,
    provider_name: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Adapter-routed synthesis card.

    Backward compatibility
    ----------------------
    When `consent_token` is None, this function delegates to the
    original `llm.synthesize_debate_recommendation_card` and returns
    its result unchanged. Existing callers in `api/routes/kai/stream.py`
    can migrate at their own pace.

    Adapter mode
    ------------
    When `consent_token` is provided, the call routes through the
    provider registry. The registry validates the token's scope
    against the chosen provider BEFORE any network call. Audit metadata
    (provider, scope, hashes, latency) is recorded in `consent_audit`.

    On adapter-mode failures we fall back to the legacy Gemini path so
    Kai's UX stays identical -- a misconfigured registry must never
    take down the synthesis card.
    """
    # Legacy path: no consent token provided => original behavior verbatim.
    if not consent_token:
        return await _llm.synthesize_debate_recommendation_card(
            ticker=ticker,
            risk_profile=risk_profile,
            user_context=user_context,
            renaissance_context=renaissance_context,
            fundamental_payload=fundamental_payload,
            sentiment_payload=sentiment_payload,
            valuation_payload=valuation_payload,
            debate_payload=debate_payload,
            highlights=highlights,
        )

    prompt = _build_synthesis_prompt(
        ticker=ticker,
        risk_profile=risk_profile,
        user_context=user_context,
        renaissance_context=renaissance_context,
        fundamental_payload=fundamental_payload,
        sentiment_payload=sentiment_payload,
        valuation_payload=valuation_payload,
        debate_payload=debate_payload,
        highlights=highlights,
    )
    request = CompletionRequest(
        prompt=prompt,
        timeout_seconds=25.0,
        max_output_tokens=KAI_SYNTHESIS_MAX_OUTPUT_TOKENS,
        response_mime_type="application/json",
    )

    try:
        response = await dispatch(
            request,
            consent_token=consent_token,
            provider_name=provider_name or default_provider_name(),
            user_id=user_id or "",
            agent_id="agent_kai",
        )
        parsed = _llm._extract_json(response.text)  # noqa: SLF001 - intentional reuse
        if not parsed:
            raise ValueError("Empty synthesis JSON from adapter path")
        # Annotate provider used for downstream observability.
        parsed.setdefault("_meta", {})
        parsed["_meta"]["provider"] = response.provider
        parsed["_meta"]["model"] = response.model
        return parsed
    except ConsentScopeViolation:
        # Consent failures are NOT silently downgraded. Re-raise so the
        # caller can surface the error to the user verbatim (this is the
        # consent-first invariant -- denial must be visible).
        raise
    except (ProviderUnavailable, ProviderError) as err:
        logger.warning(
            "[Kai LLM Adapter] Provider %s failed for %s (%s); falling back to legacy Gemini path",
            provider_name,
            ticker,
            err,
        )
        return await _llm.synthesize_debate_recommendation_card(
            ticker=ticker,
            risk_profile=risk_profile,
            user_context=user_context,
            renaissance_context=renaissance_context,
            fundamental_payload=fundamental_payload,
            sentiment_payload=sentiment_payload,
            valuation_payload=valuation_payload,
            debate_payload=debate_payload,
            highlights=highlights,
        )
    except asyncio.TimeoutError:
        logger.warning("[Kai LLM Adapter] timeout on synthesis for %s", ticker)
        return {
            "error": "LLM_SYNTHESIS_TIMEOUT",
            "fallback": True,
        }
