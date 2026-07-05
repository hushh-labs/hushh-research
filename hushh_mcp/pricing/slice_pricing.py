# consent-protocol/hushh_mcp/pricing/slice_pricing.py
"""
Data-slice suggested-price engine.

Phase 1 scope: a self-contained *pure function* that returns a **suggested**
30-day subscription price for a published `default_available` PKM slice. It is a
suggestion only — the owner sets the real price (a later phase), floor-guarded by
this same floor. This module:

- reads no ciphertext and no protected PKM content;
- touches no database and no network;
- takes only public slice metadata plus a demo audience band.

The shape is grounded in published data-market research:
- weighted-composite category valuation (Cheng et al.),
- two-part tariff / fixed floor + arbitrage-free bundling (arXiv 2303.04810),
- purchasing-power/buying-mood, freshness, exclusivity, geography as the primary
  marketplace price drivers (arXiv 2111.04427).

See docs/future/pkm-slice-marketplace-plan.md for the full rationale.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

# Fixed platform access floor (the fixed leg of the two-part tariff), in cents.
# Also the hard minimum on any suggested price so it never collapses to zero.
FLOOR_CENTS = 10  # $0.10

CURRENCY = "USD"

# Published category weight (k) and per-record dollar anchor (a).
# Keys are the four categories from the weighted-composite valuation model.
_CATEGORY_WEIGHTS: dict[str, float] = {
    "identifiers": 0.50,
    "quasi_identifiers": 0.41,
    "demographics_lifestyle": 0.45,
    "private_financial": 0.62,
}
_CATEGORY_ANCHORS: dict[str, float] = {
    "identifiers": 0.05,
    "quasi_identifiers": 0.02,
    "demographics_lifestyle": 0.05,
    "private_financial": 0.50,
}

# Purchasing power and buying-mood bands (the primary driver B = power x mood).
_POWER: dict[str, float] = {"mass": 1.0, "mid": 1.5, "affluent": 2.0, "hnw": 3.0, "uhnw": 4.0}
_MOOD: dict[str, float] = {"passive": 1.0, "affinity": 2.0, "in_market": 4.0, "hot": 6.0}

# Exclusivity / identifiability (X) and geography / coverage (G).
_EXCLUSIVITY: dict[str, float] = {"shared": 1.0, "limited": 1.5, "exclusive": 3.0}
_GEOGRAPHY: dict[str, float] = {"us": 1.0, "non_us": 0.6}

_FRESHNESS_DECAY_PER_WEEK = 0.12
_FRESHNESS_MIN = 0.3


@dataclass(frozen=True)
class SlicePricingInput:
    """Public, non-sensitive inputs for a single slice's suggested price."""

    category: str = "demographics_lifestyle"
    attribute_count: int = 1
    power: str = "mass"
    mood: str = "passive"
    weeks_stale: int = 0
    exclusivity: str = "shared"
    geography: str = "us"


@dataclass(frozen=True)
class SlicePriceBreakdown:
    """Deterministic price plus the factors that produced it (for 'show math')."""

    suggested_price_cents: int
    currency: str = CURRENCY
    floor_cents: int = FLOOR_CENTS
    composite_dollars: float = 0.0
    richness: float = 1.0
    multiplier_b: float = 1.0
    multiplier_f: float = 1.0
    multiplier_x: float = 1.0
    multiplier_g: float = 1.0
    floor_applied: bool = False
    formula: str = ""

    def as_dict(self) -> dict:
        return {
            "suggested_price_cents": self.suggested_price_cents,
            "currency": self.currency,
            "floor_cents": self.floor_cents,
            "composite_dollars": round(self.composite_dollars, 6),
            "richness": round(self.richness, 6),
            "multiplier_b": round(self.multiplier_b, 6),
            "multiplier_f": round(self.multiplier_f, 6),
            "multiplier_x": round(self.multiplier_x, 6),
            "multiplier_g": round(self.multiplier_g, 6),
            "floor_applied": self.floor_applied,
            "formula": self.formula,
        }


def _richness(attribute_count: int) -> float:
    """Diminishing returns on attribute count: 1 + ln(n), floored at n=1."""
    n = max(1, int(attribute_count))
    return 1.0 + math.log(n)


def category_from_sensitivity(sensitivity_tier: str | None, scope_kind: str | None = None) -> str:
    """
    Map a scope-registry entry's public metadata to a pricing category.

    Conservative Phase-1 mapping: restricted/financial/secret scopes price as
    private_financial (highest weight); everything else as demographics_lifestyle.
    """
    tier = (sensitivity_tier or "").strip().lower()
    kind = (scope_kind or "").strip().lower()
    if tier == "restricted" or "financial" in kind or "secret" in kind:
        return "private_financial"
    return "demographics_lifestyle"


def compute_suggested_price(inp: SlicePricingInput) -> SlicePriceBreakdown:
    """
    Suggested 30-day price:

        P = ( p_f + k_c * a_c * richness(n) ) * B * F * X * G
        final = max(FLOOR, P)

    Pure and deterministic. Raises KeyError on unknown band/category values so the
    caller (route) can surface a 422 rather than silently mispricing.
    """
    k = _CATEGORY_WEIGHTS[inp.category]
    a = _CATEGORY_ANCHORS[inp.category]
    richness = _richness(inp.attribute_count)

    floor_dollars = FLOOR_CENTS / 100.0
    composite = floor_dollars + (k * a * richness)

    power = _POWER[inp.power]
    mood = _MOOD[inp.mood]
    b = power * mood
    f = max(_FRESHNESS_MIN, 1.0 - _FRESHNESS_DECAY_PER_WEEK * max(0, int(inp.weeks_stale)))
    x = _EXCLUSIVITY[inp.exclusivity]
    g = _GEOGRAPHY[inp.geography]

    price_dollars = composite * b * f * x * g
    computed_cents = round(price_dollars * 100.0)
    floored_cents = max(FLOOR_CENTS, computed_cents)

    return SlicePriceBreakdown(
        suggested_price_cents=floored_cents,
        composite_dollars=composite,
        richness=richness,
        multiplier_b=b,
        multiplier_f=f,
        multiplier_x=x,
        multiplier_g=g,
        floor_applied=floored_cents != computed_cents,
        formula="( floor + k*a*richness ) x (power*mood) x freshness x exclusivity x geo",
    )
