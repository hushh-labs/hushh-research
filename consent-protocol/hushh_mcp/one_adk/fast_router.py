"""Fast System 1 Decision Router for Agent One.

Implements non-autoregressive, sub-15ms intent classification, candidate tool
pruning, and ambiguity detection before invoking heavy generative LLM turns.
Zero third-party API keys required; executes entirely in-process.
"""

from __future__ import annotations

import math
import re
import time
from dataclasses import dataclass, field
from typing import Any, Literal

DomainType = Literal["travel_transit", "finance", "email", "calendar", "general"]


@dataclass(frozen=True)
class FastRouteDecision:
    """Structured decision output from the System 1 reflex pass."""

    domain: DomainType
    confidence: float
    is_ambiguous: bool
    recommended_tools: tuple[str, ...] = field(default_factory=tuple)
    suggested_chips: tuple[str, ...] = field(default_factory=tuple)
    latency_ms: float = 0.0

    def as_dict(self) -> dict[str, Any]:
        return {
            "domain": self.domain,
            "confidence": round(self.confidence, 4),
            "is_ambiguous": self.is_ambiguous,
            "recommended_tools": list(self.recommended_tools),
            "suggested_chips": list(self.suggested_chips),
            "latency_ms": round(self.latency_ms, 2),
        }


# Canonical domain anchor vocabulary matrices
_DOMAIN_PROBES: dict[DomainType, dict[str, float]] = {
    "travel_transit": {
        "airport": 2.5,
        "flight": 2.0,
        "directions": 2.2,
        "navigate": 2.2,
        "navigation": 2.2,
        "route": 2.0,
        "traffic": 1.8,
        "station": 2.0,
        "taxi": 2.0,
        "cab": 2.0,
        "uber": 2.0,
        "drive": 1.8,
        "reach": 1.5,
        "go": 1.2,
        "miles": 1.5,
        "km": 1.5,
        "terminal": 2.0,
    },
    "finance": {
        "stock": 2.5,
        "stocks": 2.5,
        "invest": 2.2,
        "investment": 2.2,
        "portfolio": 2.5,
        "valuation": 2.2,
        "shares": 2.0,
        "earnings": 2.0,
        "revenue": 2.0,
        "dividend": 2.0,
        "nasdaq": 2.2,
        "ticker": 2.2,
        "market": 1.8,
        "kai": 2.5,
    },
    "email": {
        "email": 2.5,
        "emails": 2.5,
        "inbox": 2.5,
        "gmail": 2.5,
        "unread": 2.2,
        "draft": 2.0,
        "mail": 2.0,
        "reply": 1.8,
        "archive": 2.0,
        "sender": 1.8,
        "thread": 1.8,
    },
    "calendar": {
        "calendar": 2.5,
        "meeting": 2.5,
        "meetings": 2.5,
        "schedule": 2.2,
        "reschedule": 2.2,
        "appointment": 2.2,
        "free": 1.8,
        "slot": 1.8,
        "cancel": 1.5,
        "invite": 1.8,
    },
}

# Domain-specific tool pruning maps
_DOMAIN_PRUNED_TOOLS: dict[DomainType, tuple[str, ...]] = {
    "travel_transit": (
        "open_navigation_route",
        "get_my_location",
        "suggest_follow_ups",
    ),
    "finance": (
        "get_market_quotes",
        "get_ticker_news",
        "suggest_follow_ups",
    ),
    "email": (
        "ask_email_agent",
        "open_gmail_email_draft",
        "propose_gmail_mailbox_change",
        "suggest_follow_ups",
    ),
    "calendar": (
        "calendar_summary",
        "calendar_events",
        "calendar_free_slots",
        "propose_calendar_reschedule",
        "suggest_follow_ups",
    ),
    "general": (),
}

_AMBIGUITY_TRIGGERS: dict[DomainType, tuple[re.Pattern[str], ...]] = {
    "travel_transit": (
        re.compile(r"\b(go to|head to|reach|directions to|take me to)\s+(the\s+)?(airport|station|downtown|terminal)\b", re.IGNORECASE),
        re.compile(r"\b(i want to go|how to reach|travel to)\s+(the\s+)?(airport|station)\b", re.IGNORECASE),
    ),
    "finance": (
        re.compile(r"\b(should i buy|how is|check|look at)\s+[a-z]{1,5}\b", re.IGNORECASE),
    ),
    "email": (
        re.compile(r"\b(check|read|any)\s+(my\s+)?(mail|emails|messages)\b", re.IGNORECASE),
    ),
    "calendar": (
        re.compile(r"\b(am i free|what do i have|schedule for)\s+(today|tomorrow)\b", re.IGNORECASE),
    ),
}

_DEFAULT_CLARIFYING_CHIPS: dict[DomainType, tuple[str, ...]] = {
    "travel_transit": (
        "Directions to nearest airport",
        "Directions to international airport",
        "Check flight details",
    ),
    "finance": (
        "Fundamental analysis",
        "Valuation model",
        "Market sentiment",
    ),
    "email": (
        "Check unread mail",
        "Search recent emails",
        "Draft a new message",
    ),
    "calendar": (
        "Today's schedule",
        "Find free slots tomorrow",
        "Next upcoming meeting",
    ),
    "general": (),
}


class FastSystem1Router:
    """Sub-15ms non-autoregressive decision and pruning engine."""

    def __init__(self, confidence_threshold: float = 0.55) -> None:
        self.confidence_threshold = confidence_threshold

    def _tokenize(self, text: str) -> list[str]:
        cleaned = re.sub(r"[^\w\s]", " ", text.lower())
        return [word for word in cleaned.split() if len(word) > 1]

    def classify(self, query: str) -> FastRouteDecision:
        """Evaluate intent, confidence, tool pruning, and ambiguity in a single forward pass."""
        t_start = time.perf_counter()
        words = self._tokenize(query)

        if not words:
            return FastRouteDecision(
                domain="general",
                confidence=0.0,
                is_ambiguous=False,
                latency_ms=(time.perf_counter() - t_start) * 1000,
            )

        # Vector dot-product across domain probes
        domain_scores: dict[DomainType, float] = {}
        for domain, probes in _DOMAIN_PROBES.items():
            score = 0.0
            for word in words:
                score += probes.get(word, 0.0)
            domain_scores[domain] = score

        best_domain: DomainType = "general"
        highest_score = 0.0

        for domain, score in domain_scores.items():
            if score > highest_score:
                highest_score = score
                best_domain = domain

        # Softmax calibration
        if highest_score <= 0.0:
            confidence = 0.0
            best_domain = "general"
        else:
            exp_scores = {dom: math.exp(min(sc, 15.0)) for dom, sc in domain_scores.items()}
            total_exp = sum(exp_scores.values()) + math.exp(0.5)  # General baseline
            confidence = exp_scores[best_domain] / total_exp

        # Ambiguity check
        is_ambiguous = False
        suggested_chips: tuple[str, ...] = ()
        if best_domain != "general" and confidence >= self.confidence_threshold:
            for pattern in _AMBIGUITY_TRIGGERS.get(best_domain, ()):
                if pattern.search(query):
                    is_ambiguous = True
                    suggested_chips = _DEFAULT_CLARIFYING_CHIPS.get(best_domain, ())
                    break

        # Tool pruning selection
        pruned_tools = (
            _DOMAIN_PRUNED_TOOLS.get(best_domain, ())
            if confidence >= self.confidence_threshold
            else ()
        )

        latency_ms = (time.perf_counter() - t_start) * 1000.0

        return FastRouteDecision(
            domain=best_domain if confidence >= self.confidence_threshold else "general",
            confidence=confidence,
            is_ambiguous=is_ambiguous,
            recommended_tools=pruned_tools,
            suggested_chips=suggested_chips,
            latency_ms=latency_ms,
        )


# Global singleton
_GLOBAL_ROUTER: FastSystem1Router | None = None


def get_fast_system1_router() -> FastSystem1Router:
    global _GLOBAL_ROUTER
    if _GLOBAL_ROUTER is None:
        _GLOBAL_ROUTER = FastSystem1Router()
    return _GLOBAL_ROUTER
