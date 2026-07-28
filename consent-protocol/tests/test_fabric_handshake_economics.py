"""The first knock is free; the owner prices the rest.

These guard a founder principle, not an implementation detail. If one of them
starts failing, the economics of the network have changed and that should be a
deliberate decision, loudly made.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.fabric_handshake_economics import quote_handshake


def test_first_handshake_is_free_even_if_the_owner_quoted_a_price():
    """Discovery is never gated by money. The owner's own price cannot override it."""
    q = quote_handshake(prior_grant_count=0, owner_price_cents=5000, owner_currency="USD")
    assert q.price_cents == 0
    assert q.is_first is True
    assert q.reason == "first_handshake_always_free"
    # No currency on a free handshake: there is nothing to denominate.
    assert q.currency is None


def test_owner_prices_the_second_handshake():
    q = quote_handshake(prior_grant_count=1, owner_price_cents=250, owner_currency="usd")
    assert q.price_cents == 250
    assert q.currency == "USD"
    assert q.is_first is False
    assert q.reason == "owner_quoted"


def test_a_price_the_owner_did_not_state_is_not_a_price():
    """Fail-closed on the owner's side: silence means free, never a guess."""
    for price in (None, 0):
        q = quote_handshake(prior_grant_count=3, owner_price_cents=price, owner_currency="USD")
        assert q.price_cents == 0
        assert q.reason == "owner_did_not_charge"


def test_revoking_does_not_reset_the_meter():
    """prior_grant_count counts grants ever issued, not grants still active.

    Otherwise a subscriber could revoke and re-handshake to farm free access
    forever, which would make the free-first rule an exploit rather than a
    courtesy.
    """
    q = quote_handshake(prior_grant_count=1, owner_price_cents=100, owner_currency="USD")
    assert q.is_first is False
    assert q.price_cents == 100


def test_a_priced_handshake_must_name_a_currency():
    with pytest.raises(ValueError):
        quote_handshake(prior_grant_count=1, owner_price_cents=100, owner_currency=None)


def test_the_quote_travels_as_data_for_the_receipt():
    q = quote_handshake(prior_grant_count=0, owner_price_cents=None, owner_currency=None)
    d = q.as_dict()
    # The receipt must be able to say WHY it was free, not merely that it was.
    assert d["is_first_handshake"] is True
    assert d["pricing_reason"] == "first_handshake_always_free"
    assert d["price_cents"] == 0
