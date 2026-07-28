# Handshake economics — the first knock is free

Founder principle (Manish Sainani), recorded because it shapes the protocol and
every integration inherits it:

> The first handshake with any agent is free by default, so the handshake can
> happen. After the first handshake, it is up to the user's agent to decide how
> much they would like to charge for the second handshake.

## Visual Map

```
  subscriber's agent                        the person's 🤫 Agent One
        │                                            │
        │ POST /api/fabric/requests                  │
        │ (may state an OFFER — non-binding)         │
        ▼                                            │
   pairing code ───────── shown to the person ──────▶│
                                                     │
                                    ┌────────────────┴───────────────┐
                                    │  Have I met this agent before? │
                                    └────────────────┬───────────────┘
                                     no │                 │ yes
                                        ▼                 ▼
                              price = 0, always     owner's agent quotes
                              "first_handshake_      "owner_quoted", or
                               always_free"          free if it stays silent
                                        │                 │
                                        └────────┬────────┘
                                                 ▼
                                    grant + receipt carry the quote
```

## Why both halves matter

**Discovery is never gated by money.** A stranger's agent can always reach a
person once — no price, no negotiation, no payment instrument. If the first
approach cost anything the network would never form, and a person who cannot be
reached cannot be served. The floor is **zero, not a token amount**: "nearly
free" still requires a card on file, which is the barrier this rule removes.

**The person sets the price, not the bidder.** This is the inversion. In adtech
the buyer bids for attention and the person is inventory. Here the owner's agent
quotes and the subscriber decides whether to pay. The person is a counterparty
with pricing power.

## What this corrected

`price_cents` began as a parameter of `create_request` — which the **subscriber**
calls. So the brand proposed what it would pay. That is backwards under this
principle, and it is exactly the kind of thing every integration inherits if it
is not fixed early.

Price now belongs to the **approve** step. A subscriber's stated number is a
non-binding offer; the owner's agent decides.

## Why the decision can only happen at approve time

At request time **there is no owner**. That is the whole point of the pairing
handshake: the subscriber holds a short code and learns nothing about the person
until they choose to answer. *"Have I met this agent before?"* is a question only
the owner's side can answer.

## The rules, precisely

| Condition | Price | Reason recorded |
|---|---|---|
| No prior grant from this owner to this subscriber | **0** | `first_handshake_always_free` |
| Prior grant exists, owner quotes a price | owner's price | `owner_quoted` |
| Prior grant exists, owner quotes nothing | **0** | `owner_did_not_charge` |
| Priced but no currency | rejected | — |

**Revocation does not reset the meter.** The count is grants *ever issued*, not
grants still active. Otherwise a subscriber could revoke and re-handshake to farm
free access forever, turning a courtesy into an exploit.

**Fail-closed on the owner's side too.** A price the owner did not state is not a
price. Silence means free rather than guessed at.

The reason travels into the grant and the receipt, so a person can later see not
just *that* a handshake was free but *why*.

## Payment rails — the honest status

The principle needs settlement to be commercially real. What exists today:

| Rail | Status |
|---|---|
| **Stripe** (checkout, subscribe, webhook) | **Real code**, config-gated |
| Visa / Mastercard / Amex | via Stripe only |
| AP2 | **Named in copy, no implementation** |
| UCP | **Named in copy, no implementation** |
| Plaid | **Named in copy, no implementation** |
| Zelle | **Named in copy, no implementation** |
| Circle / USDC | **Named in copy, no implementation** |

Only Stripe has code behind it. The others appear across dozens of marketing
files with nothing implemented. **Say so plainly wherever they are mentioned**
until that changes — an unbuilt rail described as supported is the exact class
of claim that costs more than it earns.

Sequencing recommendation: settle **agent-to-agent payments on Stripe first**,
because it is already wired and covers the card networks. Add **Circle/USDC**
next — it is the only rail on the list that is genuinely agent-native, needs no
banking partner, and settles without a chargeback window, which matters when the
payer is software. AP2 and UCP are protocol work that should follow a real
counterparty asking for them, not precede one.

## Open decision

**Which direction does money move?** The plumbing (`price_cents` in the grant,
the request, and the signed handle payload) supports either. But a network where
the brand pays the *person* is a fundamentally different company from one where
the brand pays *us* — and the sovereign-ownership thesis says the former. This
has one-way-door properties and has not been decided.

## Sources

- `hushh_mcp/services/fabric_handshake_economics.py`
- `tests/test_fabric_handshake_economics.py`
- `hushh_mcp/services/fabric_request_service.py`
