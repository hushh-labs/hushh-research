"""Handshake economics: the first knock is free, the owner prices the rest.

FOUNDER PRINCIPLE (Manish Sainani), and the reason this module exists:

    "The first handshake with any agent is free by default, so the handshake can
     happen. After the first handshake, it is up to the user's agent to decide
     how much they would like to charge for the second handshake."

Two properties fall out of that, and both are load-bearing:

1. **Discovery is never gated by money.** A stranger's agent can always reach a
   person once. No price, no negotiation, no account. If the first approach cost
   anything, the network would never form - and a person who cannot be reached
   cannot be served.

2. **The person sets the price, not the bidder.** This is the inversion. In
   adtech the buyer bids for attention and the person is inventory. Here the
   owner's agent quotes, and the subscriber decides whether to pay. The person is
   a counterparty with pricing power, not a lot at auction.

WHAT THIS CORRECTS. `price_cents` began as a parameter of `create_request`,
which the *subscriber* calls - so the brand proposed what it would pay. That is
backwards under this principle, and it is the kind of thing every integration
inherits if it is not fixed early. Price now belongs to the approve step, where
the owner is finally known. The subscriber's number, if any, is a non-binding
offer.

WHY IT CAN ONLY BE DECIDED AT APPROVE TIME. At request time there is no owner -
that is the entire point of the pairing handshake: the subscriber holds a short
code and learns nothing about the person until they choose to answer. "Have I met
this agent before?" is a question only the owner's side can answer, so the rule
lives here and not in request creation.
"""

from __future__ import annotations

from typing import Any

# The floor is zero, not a token amount. A "nearly free" first handshake still
# requires a payment instrument, which is the barrier this rule exists to remove.
FIRST_HANDSHAKE_PRICE_CENTS = 0


class HandshakeQuote:
    """What this handshake costs, and why - carried into the grant and receipt."""

    __slots__ = ("price_cents", "currency", "is_first", "reason")

    def __init__(
        self,
        *,
        price_cents: int,
        currency: str | None,
        is_first: bool,
        reason: str,
    ) -> None:
        self.price_cents = price_cents
        self.currency = currency
        self.is_first = is_first
        self.reason = reason

    def as_dict(self) -> dict[str, Any]:
        return {
            "price_cents": self.price_cents,
            "currency": self.currency,
            "is_first_handshake": self.is_first,
            "pricing_reason": self.reason,
        }


def quote_handshake(
    *,
    prior_grant_count: int,
    owner_price_cents: int | None,
    owner_currency: str | None,
) -> HandshakeQuote:
    """Price one handshake.

    ``prior_grant_count`` is how many grants this owner has ever issued to this
    subscriber - not how many are currently active. A revoked relationship still
    counts as having happened, so revoking cannot be used to reset the meter and
    farm free handshakes.

    Fail-closed on the owner's side: a price the owner did not state is not a
    price. If they quote nothing, the handshake is free rather than guessed at.
    """
    if prior_grant_count <= 0:
        return HandshakeQuote(
            price_cents=FIRST_HANDSHAKE_PRICE_CENTS,
            currency=None,
            is_first=True,
            reason="first_handshake_always_free",
        )

    if owner_price_cents is None or owner_price_cents <= 0:
        return HandshakeQuote(
            price_cents=0,
            currency=None,
            is_first=False,
            reason="owner_did_not_charge",
        )

    if not owner_currency:
        raise ValueError("A priced handshake needs a currency.")

    return HandshakeQuote(
        price_cents=int(owner_price_cents),
        currency=owner_currency.upper(),
        is_first=False,
        reason="owner_quoted",
    )
