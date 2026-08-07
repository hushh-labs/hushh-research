# Handshake economics — the first knock is free

Founder principle (Manish Sainani), recorded because it shapes the protocol and
every integration inherits it:

> The first handshake with any agent is free, and in it the user's agent shares
> age, sex and location for free. Every handshake after that costs at least
> 0.001 cent — the network minimum. For age, sex and location the user may charge
> $200, or a thousand dollars. It is completely up to the user to decide what
> each scope costs. The user does not make a lot of money from this. The point is
> that their information goes to auction, so they can see who values it most.

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
                              price = 0, always     owner's agent quotes,
                              + age-band, sex,       floored at 0.001 cent
                                region disclosed     (never below)
                                        │                 │
                                        └────────┬────────┘
                                                 ▼
                                    grant + receipt carry the quote
```

## Why both halves matter

**Discovery is never gated by money.** A stranger's agent can always reach a
person once — no price, no negotiation, no payment instrument. If the first
approach cost anything the network would never form, and a person who cannot be
reached cannot be served. The first handshake is **zero, not a token amount**:
"nearly free" still requires a card on file, which is the barrier this removes.

**After that there is a non-zero floor.** 0.001 cent is not revenue — it is a
price signal. It makes every subsequent read an economic act, which is what turns
a profile into an auction rather than a feed.

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
| No prior grant from this owner to this subscriber | **0**, and the free bundle is disclosed | `first_handshake_always_free` |
| Prior grant, owner quotes at or above the floor | owner's price | `owner_quoted` |
| Prior grant, owner quotes nothing or below the floor | **1 millicent** | `network_minimum_applied` |
| Priced but no currency | rejected | — |

The floor is **0.001 cent = 1 millicent**, and it is a floor rather than a
default: an owner may price above it, never below. That is not revenue. It is a
*price signal* — it makes every subsequent read an economic act, which is what
turns a profile into an auction rather than a feed.

Ceilings belong to the person. **$200 or $1,000 for age, sex and location is a
legitimate answer**, and a refusal expressed as a price is still a refusal.

### The money unit

Prices are **millicents** (1 cent = 1000 millicents). An integer-cent field
cannot represent 0.001 cent, and a float would round at exactly the boundary the
floor sits on. $1,000 is 100,000,000 millicents — comfortably inside BIGINT.

### What the free first handshake discloses

`profile.age-band`, `profile.sex`, `profile.region` — enough for an agent to
judge whether this person is plausibly worth talking to.

**Coarsened deliberately.** The precise triple {date of birth, sex, 5-digit ZIP}
uniquely identifies the large majority of the US population. Releasing that free
to any agent that knocks would make this network a re-identification service —
the exact opposite of the thesis. An age *band*, sex, and a *region* preserve the
qualifying signal without handing over an identity. A test asserts the bundle
never drifts back toward birthdate or ZIP5.

**Revocation does not reset the meter.** The count is grants *ever issued*, not
grants still active. Otherwise a subscriber could revoke and re-handshake to farm
free access forever, turning a courtesy into an exploit.

**Silence means the floor, not free.** After the first handshake an owner who
quotes nothing still charges the network minimum. The floor is the one price the
owner cannot waive — it is what keeps the auction an auction.

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

## The settlement consequence — this constrains everything

**A 0.001-cent charge cannot settle on card rails.** Stripe's minimum charge is
50 cents; the floor is 1/50,000th of that. So the floor is not merely a pricing
choice, it is an architectural one. Sub-cent handshakes must either:

- **accumulate** into a running balance and settle in batches when the total
  clears a processor minimum, or
- settle on a rail with **native sub-cent precision**.

`settles_on_card_rails()` exists so callers branch on this rather than assume a
charge will succeed. Nothing should attempt a direct card charge below 50 cents.

This is the strongest argument for **Circle/USDC as a first-class rail** rather
than a nice-to-have: USDC carries six decimals, so 0.001 cent is representable
natively, there is no banking partner in the path, and there is no chargeback
window — which matters a great deal when the payer is software rather than a
person. Accumulate-and-settle on Stripe is the pragmatic first step; USDC is the
one that makes per-read pricing work without a ledger of IOUs.

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
