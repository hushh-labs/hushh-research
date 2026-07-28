"""Handshake economics: the first knock is free, then the person runs an auction.

FOUNDER PRINCIPLE (Manish Sainani). Every integration inherits this, so it is
stated in full:

    "The first handshake with any agent is free, and in it the user's agent
     shares age, sex and location for free. Every handshake after that costs at
     least 0.001 cent - the network minimum. For age, sex and location the user
     may charge $200, or a thousand dollars. It is completely up to the user to
     decide what each scope costs. The user does not make a lot of money from
     this. The point is that their information goes to auction, so they can see
     who values it most."

Three properties, all load-bearing:

1. **Discovery is never gated by money.** A stranger's agent can always reach a
   person once, with no price and no payment instrument. A person who cannot be
   reached cannot be served.

2. **There is a non-zero floor after that.** 0.001 cent is not revenue - it is a
   *price signal*. It makes every subsequent read an economic act, which is what
   turns a profile into an auction rather than a feed.

3. **The person sets every price.** In adtech the buyer bids for attention and
   the person is inventory. Here the owner's agent quotes and the subscriber
   decides whether to pay. Ceilings are the person's to choose - $200 or $1,000
   for the same three fields is a legitimate answer, and a refusal expressed as
   a price is still a refusal.

MONEY UNIT. Prices are **millicents** (1 cent = 1000 millicents), because the
floor is 0.001 cent and an integer cent cannot represent it. A millicent is
exactly the floor, so the minimum is 1 and there is no rounding at the boundary.
$1,000 is 100,000,000 millicents, comfortably inside BIGINT.

SETTLEMENT CONSEQUENCE, stated here because it constrains the whole design: a
0.001-cent charge cannot settle on card rails. Stripe's minimum charge is 50
cents. So sub-cent handshakes must either **accumulate** and settle in batches,
or settle on a rail with native sub-cent precision. See
docs/HANDSHAKE_ECONOMICS.md.
"""

from __future__ import annotations

from typing import Any

# 1 cent = 1000 millicents. The founder's floor of 0.001 cent is exactly 1.
MILLICENTS_PER_CENT = 1000
MINIMUM_HANDSHAKE_MILLICENTS = 1

# What the first handshake discloses at no charge, so an agent can tell whether
# this person is plausibly worth talking to at all.
#
# COARSENED ON PURPOSE. The precise triple {date of birth, sex, 5-digit ZIP}
# uniquely identifies most of the US population, so releasing it free to any
# agent that knocks would make the network a re-identification service. Age
# BAND, sex, and REGION preserve the qualifying signal without handing over an
# identity. See docs/HANDSHAKE_ECONOMICS.md.
FIRST_HANDSHAKE_FREE_SCOPES: tuple[str, ...] = (
    "profile.age-band",
    "profile.sex",
    "profile.region",
)


class HandshakeQuote:
    """What this handshake costs, and why - carried into the grant and receipt."""

    __slots__ = ("price_millicents", "currency", "is_first", "reason", "free_scopes")

    def __init__(
        self,
        *,
        price_millicents: int,
        currency: str | None,
        is_first: bool,
        reason: str,
        free_scopes: tuple[str, ...] = (),
    ) -> None:
        self.price_millicents = price_millicents
        self.currency = currency
        self.is_first = is_first
        self.reason = reason
        self.free_scopes = free_scopes

    @property
    def price_cents(self) -> float:
        """Display only. Never settle against this - it loses the sub-cent part."""
        return self.price_millicents / MILLICENTS_PER_CENT

    def as_dict(self) -> dict[str, Any]:
        return {
            "price_millicents": self.price_millicents,
            "price_cents": self.price_cents,
            "currency": self.currency,
            "is_first_handshake": self.is_first,
            "pricing_reason": self.reason,
            "free_scopes": list(self.free_scopes),
        }


def quote_handshake(
    *,
    prior_grant_count: int,
    owner_price_millicents: int | None,
    owner_currency: str | None,
) -> HandshakeQuote:
    """Price one handshake.

    ``prior_grant_count`` is how many grants this owner has ever issued to this
    subscriber - **not** how many are currently active. A revoked relationship
    still happened, so revoking cannot reset the meter and farm free handshakes.

    After the first handshake the floor applies and cannot be undercut: an owner
    who quotes nothing, or quotes zero, still charges the network minimum. That
    is what makes every read an economic act rather than a free feed.
    """
    if prior_grant_count <= 0:
        return HandshakeQuote(
            price_millicents=0,
            currency=None,
            is_first=True,
            reason="first_handshake_always_free",
            free_scopes=FIRST_HANDSHAKE_FREE_SCOPES,
        )

    if owner_price_millicents is None or owner_price_millicents < MINIMUM_HANDSHAKE_MILLICENTS:
        # Not a discount - a floor. The owner may price above it, never below.
        return HandshakeQuote(
            price_millicents=MINIMUM_HANDSHAKE_MILLICENTS,
            currency=(owner_currency or "USD").upper(),
            is_first=False,
            reason="network_minimum_applied",
        )

    if not owner_currency:
        raise ValueError("A priced handshake needs a currency.")

    return HandshakeQuote(
        price_millicents=int(owner_price_millicents),
        currency=owner_currency.upper(),
        is_first=False,
        reason="owner_quoted",
    )


def cents_to_millicents(cents: float) -> int:
    """Convert a human-facing price. $200 -> 20_000_000 millicents."""
    return int(round(cents * MILLICENTS_PER_CENT))


def settles_on_card_rails(price_millicents: int) -> bool:
    """Whether this amount can be charged directly to a card.

    Card processors enforce a minimum charge (Stripe: 50 cents USD). Anything
    below it must accumulate into a batch or settle on a sub-cent-native rail.
    Callers must branch on this rather than assume a charge will succeed.
    """
    return price_millicents >= 50 * MILLICENTS_PER_CENT
