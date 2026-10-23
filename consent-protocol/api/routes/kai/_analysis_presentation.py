"""SSE result presentation from already-computed specialist outputs."""


def _collect_degraded_agents(
    degraded_agents, fundamental_insight, sentiment_insight, valuation_insight
):
    for name, insight in (
        ("fundamental", fundamental_insight),
        ("sentiment", sentiment_insight),
        ("valuation", valuation_insight),
    ):
        if getattr(insight, "analysis_degraded", False) and name not in degraded_agents:
            degraded_agents.append(name)
    from hushh_mcp.observability.market_provider_calls import degraded_provider_resources

    if degraded_provider_resources() and "market sources" not in degraded_agents:
        degraded_agents.append("market sources")


def _analysis_measurements(
    fundamental_insight,
    sentiment_insight,
    valuation_insight,
    debate_result,
    _safe_float,
    _derive_market_trend,
    _derive_fair_value,
    _derive_company_strength_score,
):
    sentiment_score_value = _safe_float(sentiment_insight.sentiment_score)
    market_trend_label, market_trend_score = _derive_market_trend(
        sentiment_score_value,
        debate_result.decision,
    )
    fair_value_label, fair_value_score, fair_value_gap_pct = _derive_fair_value(
        price_targets=valuation_insight.price_targets,
        valuation_metrics=valuation_insight.valuation_metrics,
        valuation_recommendation=valuation_insight.recommendation,
        provider_snapshot=valuation_insight.market_snapshot,
    )
    company_strength_score = _derive_company_strength_score(
        fundamental_confidence=_safe_float(fundamental_insight.confidence),
        valuation_confidence=_safe_float(valuation_insight.confidence),
        debate_confidence=_safe_float(debate_result.confidence)
        if _safe_float(debate_result.confidence) is not None
        else 0.5,
        sentiment_score=sentiment_score_value,
        fair_value_score=fair_value_score if fair_value_score is not None else 5.0,
        market_trend_score=market_trend_score,
    )
    return (
        market_trend_label,
        market_trend_score,
        fair_value_label,
        fair_value_score,
        fair_value_gap_pct,
        company_strength_score,
    )


def _market_snapshot(snapshot):
    return snapshot or {
        "last_price": None,
        "observed_at": None,
        "source": "unavailable",
        "currency": "USD",
    }


def _synthesis_recommendation(synthesis_payload, debate_result, degraded_agents, build_short):
    synthesis_short = ""
    if isinstance(synthesis_payload, dict):
        for key in ("short_recommendation", "thesis", "summary"):
            value = synthesis_payload.get(key)
            if isinstance(value, str) and value.strip():
                synthesis_short = value.strip()
                break
    return synthesis_short or build_short(
        debate_result.decision,
        debate_result.confidence,
        debate_result.final_statement,
        degraded_agents,
    )
