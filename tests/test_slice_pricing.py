# consent-protocol/tests/test_slice_pricing.py
"""Unit tests for the pure data-slice suggested-price engine."""

import pytest

from hushh_mcp.pricing.slice_pricing import (
    FLOOR_CENTS,
    SlicePricingInput,
    category_from_sensitivity,
    compute_suggested_price,
)


def _cents(**kwargs) -> int:
    return compute_suggested_price(SlicePricingInput(**kwargs)).suggested_price_cents


def test_affluent_travel_preferences_is_about_60_cents():
    # demographics/lifestyle, 3 attrs, affluent x affinity buyer -> ~ $0.60
    cents = _cents(
        category="demographics_lifestyle",
        attribute_count=3,
        power="affluent",
        mood="affinity",
    )
    assert 55 <= cents <= 65


def test_uhnw_luxury_purchase_intent_is_about_20_dollars():
    # private/financial, 4 attrs, UHNW x in-market, exclusive-to-one -> ~ $20
    cents = _cents(
        category="private_financial",
        attribute_count=4,
        power="uhnw",
        mood="in_market",
        exclusivity="limited",
    )
    assert 1900 <= cents <= 2100


def test_mass_passive_single_attribute_hits_the_floor():
    # demographics, 1 attr, mass x passive, stale -> computed dips under floor $0.10
    result = compute_suggested_price(
        SlicePricingInput(
            category="demographics_lifestyle",
            attribute_count=1,
            power="mass",
            mood="passive",
            weeks_stale=2,
        )
    )
    assert result.suggested_price_cents == FLOOR_CENTS
    assert result.floor_applied is True


def test_price_never_below_floor_for_any_valid_band():
    for category in (
        "identifiers",
        "quasi_identifiers",
        "demographics_lifestyle",
        "private_financial",
    ):
        for power in ("mass", "mid", "affluent", "hnw", "uhnw"):
            for mood in ("passive", "affinity", "in_market", "hot"):
                cents = _cents(
                    category=category, attribute_count=1, power=power, mood=mood, weeks_stale=52
                )
                assert cents >= FLOOR_CENTS


def test_more_attributes_never_lowers_price_diminishing_returns():
    prev = 0
    for n in range(1, 8):
        cents = _cents(
            category="private_financial", attribute_count=n, power="affluent", mood="in_market"
        )
        assert cents >= prev
        prev = cents


def test_intent_can_outweigh_wealth():
    # a "hot" mass-market buyer can outprice a "passive" UHNW buyer for the same slice
    hot_mass = _cents(category="private_financial", attribute_count=3, power="mass", mood="hot")
    passive_uhnw = _cents(
        category="private_financial", attribute_count=3, power="uhnw", mood="passive"
    )
    assert hot_mass > passive_uhnw


def test_unknown_band_raises_keyerror():
    with pytest.raises(KeyError):
        compute_suggested_price(SlicePricingInput(power="galactic"))


def test_category_from_sensitivity_maps_restricted_to_financial():
    assert category_from_sensitivity("restricted") == "private_financial"
    assert category_from_sensitivity("confidential") == "demographics_lifestyle"
    assert category_from_sensitivity(None, scope_kind="internal_secret") == "private_financial"
