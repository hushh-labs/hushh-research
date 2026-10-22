"""Presentation of already-computed specialist results."""

from typing import Any, Optional


def build_deterministic_statement(
    agent_name: str,
    insight: Any,
    stream_error_message: Optional[str] = None,
) -> str:
    """
    Build a deterministic debate statement from already-computed agent insights.
    This prevents debate orchestration from failing when live LLM token streaming is unavailable.
    """
    recommendation = str(getattr(insight, "recommendation", "hold")).upper()
    confidence = (
        float(insight.confidence) if getattr(insight, "confidence", None) is not None else 0.5
    )
    summary = str(getattr(insight, "summary", "") or "").strip()

    base = summary if summary else f"{agent_name.capitalize()} analysis supports {recommendation}."
    extra = ""

    if agent_name == "fundamental":
        moat = str(getattr(insight, "business_moat", "") or "").strip()
        bull = str(getattr(insight, "bull_case", "") or "").strip()
        bear = str(getattr(insight, "bear_case", "") or "").strip()
        details = [val for val in (moat, bull, bear) if val]
        if details:
            extra = " ".join(details[:2])
    elif agent_name == "sentiment":
        catalysts = getattr(insight, "key_catalysts", None)
        if isinstance(catalysts, list) and catalysts:
            extra = f"Key catalyst: {str(catalysts[0])}."
    elif agent_name == "valuation":
        price_targets = getattr(insight, "price_targets", None)
        if isinstance(price_targets, dict) and price_targets:
            target = price_targets.get("base_case") or price_targets.get("fair_value")
            if target is not None:
                extra = f"Base valuation reference: {target}."

    reason = (
        f" Live streaming unavailable ({stream_error_message})." if stream_error_message else ""
    )
    return (
        f"{base} Recommendation: {recommendation} ({confidence:.0%} confidence)."
        f"{(' ' + extra) if extra else ''}{reason}"
    ).strip()
