"""Curated showcase "hero" seeds for the synthetic HumanProfile system.

Hand-picked seeds whose generated profiles make vivid, coherent demo stories
spanning region, income, age, household, and the full consent spectrum
(open -> pragmatic -> guarded -> fortress). Everything is deterministic: the
same seed always yields the same human, so a teammate can reproduce any demo
from the seed alone -- no PII, no fixtures to keep in sync, just an integer.

Usage:
    from scripts.synthetic_profiles.heroes import heroes, HERO_SEEDS
    for h in heroes():
        print(h["headline"], h["profile"]["identity"]["display_name"])
"""

from __future__ import annotations

from typing import Any

from .generator import generate

# The showcase set. Keep the headlines honest to what the seed actually produces.
HERO_SEEDS: list[dict[str, Any]] = [
    {
        "seed": 4193772206,
        "stance": "open",
        "headline": "MENA homemaker, comfortable, opens up: One lines up remittance day, "
        "school fees, and a missed tax deduction to clear the family loan a year early.",
    },
    {
        "seed": 480000000,
        "stance": "pragmatic",
        "headline": "Rural Sub-Saharan fisher, eight-person household: One syncs the whole "
        "family's clinic visits to market days from just shopping and location.",
    },
    {
        "seed": 2020202020,
        "stance": "guarded",
        "headline": "82-year-old North American lawyer who revokes often: One previews the "
        "credit-card gap without reading a balance, then asks for one revocable look.",
    },
    {
        "seed": 1618033988,
        "stance": "fortress",
        "headline": "European fortress-privacy postal worker: One still finds better work "
        "touching only location and professional, never health or money.",
    },
]


def hero(seed: int) -> dict[str, Any]:
    """Generate one hero profile with its curated headline."""
    match = next((h for h in HERO_SEEDS if h["seed"] == seed), None)
    return {
        "seed": seed,
        "stance": match["stance"] if match else None,
        "headline": match["headline"] if match else None,
        "profile": generate(seed),
    }


def heroes() -> list[dict[str, Any]]:
    """The full curated showcase set, each with its generated profile."""
    return [hero(h["seed"]) for h in HERO_SEEDS]
