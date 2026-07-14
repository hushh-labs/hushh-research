"""Name/sex coherence + hero-fixture contract tests.

A synthetic human is only good demo data if it is internally coherent: a profile
named "Priya" must not be emitted as male. These tests lock that in, and pin the
curated showcase heroes so their stories stay reproducible from a seed alone.
"""

from __future__ import annotations

from scripts.synthetic_profiles.generator import ADDRESS_SPACE, generate
from scripts.synthetic_profiles.heroes import HERO_SEEDS, heroes
from scripts.synthetic_profiles.marginals import GIVEN_NAME_SEX


def test_given_name_and_sex_agree_across_a_large_sample():
    """Over a wide population sweep, no named male/female profile contradicts the
    gender its given name implies. Intersex profiles keep they/them and are exempt."""
    step = ADDRESS_SPACE // 20000
    mismatches = []
    for i in range(20000):
        p = generate((i * step) % ADDRESS_SPACE)
        sex = p["demographics"]["sex"]
        if sex == "intersex":
            continue
        name = p["identity"]["given_name"]
        implied = GIVEN_NAME_SEX.get(name)
        if implied is not None and implied != sex:
            mismatches.append((name, sex, implied))
    assert not mismatches, f"name/sex mismatches: {mismatches[:10]} (total {len(mismatches)})"


def test_pronouns_follow_sex():
    expected = {"female": "she/her", "male": "he/him", "intersex": "they/them"}
    step = ADDRESS_SPACE // 5000
    for i in range(5000):
        p = generate((i * step) % ADDRESS_SPACE)
        assert p["identity"]["pronouns"] == expected[p["demographics"]["sex"]]


def test_every_given_name_in_the_banks_has_a_gender():
    """Guard against a name being added to a pool without a gender, which would
    silently fall back to the drawn sex and reintroduce incoherence."""

    # Names are allowed to be gendered even if a specific region never draws them;
    # what we forbid is a *drawn* name lacking a gender. Sweep and assert coverage.
    step = ADDRESS_SPACE // 20000
    ungendered = set()
    for i in range(20000):
        p = generate((i * step) % ADDRESS_SPACE)
        name = p["identity"]["given_name"]
        if name not in GIVEN_NAME_SEX:
            ungendered.add(name)
    assert not ungendered, f"given names drawn but missing a gender: {sorted(ungendered)}"


def test_hero_fixture_is_reproducible_and_coherent():
    fixture = heroes()
    assert len(fixture) == len(HERO_SEEDS) >= 4
    for h in fixture:
        # deterministic: regenerating the same seed is byte-identical
        assert generate(h["seed"]) == h["profile"]
        prof = h["profile"]
        sex = prof["demographics"]["sex"]
        if sex != "intersex":
            implied = GIVEN_NAME_SEX.get(prof["identity"]["given_name"])
            assert implied is None or implied == sex
        assert h["headline"] and h["stance"]


def test_heroes_span_regions_and_the_consent_spectrum():
    fixture = heroes()
    regions = {h["profile"]["demographics"]["region"] for h in fixture}
    stances = {h["profile"]["consent_posture"]["privacy_stance"] for h in fixture}
    assert len(regions) >= 3, f"heroes not regionally diverse: {regions}"
    # the showcase should cover more than one point on the consent spectrum
    assert len(stances) >= 3, f"heroes not consent-diverse: {stances}"
