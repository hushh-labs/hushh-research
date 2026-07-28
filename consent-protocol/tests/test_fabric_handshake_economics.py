"""The first knock is free; after that the person runs an auction.

These guard a founder principle, not an implementation detail. If one starts
failing, the economics of the network have changed and that should be a
deliberate decision, loudly made.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.fabric_handshake_economics import (
    FIRST_HANDSHAKE_FREE_SCOPES,
    MINIMUM_HANDSHAKE_MILLICENTS,
    cents_to_millicents,
    quote_handshake,
    settles_on_card_rails,
)


def test_first_handshake_is_free_even_if_the_owner_quoted_a_price():
    """Discovery is never gated by money. The owner's own price cannot override it."""
    q = quote_handshake(
        prior_grant_count=0, owner_price_millicents=5_000_000, owner_currency="USD"
    )
    assert q.price_millicents == 0
    assert q.is_first is True
    assert q.reason == "first_handshake_always_free"
    assert q.currency is None


def test_the_free_first_handshake_discloses_the_qualifying_bundle():
    q = quote_handshake(prior_grant_count=0, owner_price_millicents=None, owner_currency=None)
    assert q.free_scopes == FIRST_HANDSHAKE_FREE_SCOPES
    assert set(q.free_scopes) == {"profile.age-band", "profile.sex", "profile.region"}


def test_the_free_bundle_is_coarsened_never_the_identifying_triple():
    """{date of birth, sex, 5-digit ZIP} uniquely identifies most people.

    Releasing that free to any agent that knocks would make this network a
    re-identification service. The bundle must stay banded and regional.
    """
    joined = " ".join(FIRST_HANDSHAKE_FREE_SCOPES)
    assert "age-band" in joined and "birth" not in joined
    assert "region" in joined and "zip" not in joined


def test_the_network_minimum_applies_to_every_later_handshake():
    """0.001 cent is not revenue - it is the price signal that makes it an auction."""
    for price in (None, 0, -5):
        q = quote_handshake(
            prior_grant_count=1, owner_price_millicents=price, owner_currency="USD"
        )
        assert q.price_millicents == MINIMUM_HANDSHAKE_MILLICENTS
        assert q.reason == "network_minimum_applied"
    # The floor IS the founder's 0.001 cent, exactly, with no rounding.
    assert MINIMUM_HANDSHAKE_MILLICENTS / 1000 == 0.001


def test_the_owner_may_price_far_above_the_floor():
    """$200 or $1,000 for age, sex and location is a legitimate answer.

    A refusal expressed as a price is still a refusal, and that is the person's
    right on their own information.
    """
    q = quote_handshake(
        prior_grant_count=1,
        owner_price_millicents=cents_to_millicents(20_000),  # $200
        owner_currency="usd",
    )
    assert q.price_millicents == 20_000_000
    assert q.currency == "USD"
    assert q.reason == "owner_quoted"

    grand = quote_handshake(
        prior_grant_count=1,
        owner_price_millicents=cents_to_millicents(100_000),  # $1,000
        owner_currency="USD",
    )
    assert grand.price_millicents == 100_000_000


def test_revoking_does_not_reset_the_meter():
    """Counts grants ever issued, not grants still active.

    Otherwise a subscriber revokes and re-handshakes to farm free access
    forever, turning a courtesy into an exploit.
    """
    q = quote_handshake(prior_grant_count=1, owner_price_millicents=None, owner_currency=None)
    assert q.is_first is False
    assert q.price_millicents == MINIMUM_HANDSHAKE_MILLICENTS


def test_a_priced_handshake_must_name_a_currency():
    with pytest.raises(ValueError):
        quote_handshake(
            prior_grant_count=1, owner_price_millicents=5_000_000, owner_currency=None
        )


def test_sub_cent_handshakes_cannot_settle_on_card_rails():
    """The floor is below every card processor's minimum charge.

    Callers must branch on this rather than assume a charge succeeds. It is the
    constraint that forces either accumulation or a sub-cent-native rail.
    """
    assert settles_on_card_rails(MINIMUM_HANDSHAKE_MILLICENTS) is False
    assert settles_on_card_rails(cents_to_millicents(49)) is False
    assert settles_on_card_rails(cents_to_millicents(50)) is True
    assert settles_on_card_rails(cents_to_millicents(20_000)) is True


def test_the_quote_travels_as_data_for_the_receipt():
    q = quote_handshake(prior_grant_count=0, owner_price_millicents=None, owner_currency=None)
    d = q.as_dict()
    # The receipt must say WHY it was free, not merely that it was.
    assert d["is_first_handshake"] is True
    assert d["pricing_reason"] == "first_handshake_always_free"
    assert d["price_millicents"] == 0
    assert d["free_scopes"] == list(FIRST_HANDSHAKE_FREE_SCOPES)
