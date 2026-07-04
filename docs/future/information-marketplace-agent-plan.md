# Information Marketplace Agent — product plan

Status: **planning + partially built.** The conversational Information Marketplace
agent exists on branch `feat/personal-information-agent` (not merged). This doc
captures what is built and the **product-grade** forward path. Decision anchor:
treat this as a real product, **not a demo** — no browser-only state end to end.

Builds on [pkm-slice-marketplace-plan.md](./pkm-slice-marketplace-plan.md) (pricing
engine, `default_available` publish path, consent-first posture).

## Visual Map

```
User ──▶ Information Marketplace chat        Agent One ──(A2A delegate)──▶ Information Marketplace
        (/one/marketplace panel)                       specialist (adk_bridge)
                 │                                                │
                 ▼                                                ▼
        InformationChatService.handle_turn ◀──────────────────────┘
        (Gemini tool loop, per-@hushh_tool consent scope)
                 │
     ┌───────────┼───────────────────────────┬─────────────────────────┐
     ▼           ▼                           ▼                         ▼
 list_published  get_earnings_summary   propose_publish        list/approve/deny_
 _slices         (price + show-math)    (publish card,          access_request
     │           │                       topic-tailored)                │
     ▼           ▼                           ▼                         ▼
 MarketplaceInformationService  ◀── pkm_scope_registry     MarketplaceRequestService
 (owner's own safe metadata + pricing engine)              (marketplace_access_requests, mig 076)
                                                                       │
                                                                       ▼
                                          durable owner inbox: /one/marketplace Flow & requests
```

## What "Information Marketplace" is

A user publishes safe projections of their own PKM as priced, consentable data
slices so verified buyers can send them offers / favorable deals / money — the
value advertisers already extract, returned to the user with consent-first
control. Distinct from Kai's **Market Home** (markets/investing); "marketplace"
said bare is disambiguated by One.

## Built so far (branch `feat/personal-information-agent`)

- **Agent** `hushh_mcp/agents/personal_information/` (name: "Information Marketplace"),
  mirrors the Location agent: `agent.py` / `agent.yaml` / `manifest.py` / `tools.py`.
- **Tools**: `list_published_slices`, `get_earnings_summary` (potential-only,
  `accruedCents` always 0 with `math` factors + `formula`), `approve_access_request`
  / `deny_access_request` (emit a client-action).
- **Chat**: `services/information_chat_service.py` + route `POST /api/one/information/chat`;
  frontend panel `components/one-marketplace/` on `/one/marketplace`.
- **Scopes**: `cap.pkm.marketplace.{view,publish,manage}` (registered in the enum,
  `capability_scopes()`, and the `_AGENT_SCOPE_MAP` resolver).
- **A2A**: registered specialist `agent_personal_information` (delegation.py scope
  map + `adk_bridge/personal_information_agent.py` + `adk_bridge/__init__.py`);
  One delegates marketplace **questions** to it. Routing: qualified cues delegate;
  "open …" navigates (deterministic `route.one_marketplace` + voice-action contract);
  bare "marketplace" → One asks which (deterministic clarification).
- **Nav/UX**: `/one/marketplace` breadcrumb (Profile › Marketplace), One capability
  tile "Information Marketplace".

Known gap: marketplace **access requests are browser-only in-session state**
(`MarketRequest` in `app/one/marketplace/page.tsx`) — they clear on refresh and
have no backend record. This is the thing to fix first.

## Forward plan (product-grade, phased)

### Phase 1 — Persist marketplace requests end-to-end (foundation)
Turn the in-session `MarketRequest` into a real backend record, like a location
grant. New table (e.g. `marketplace_access_requests`): buyer ref, slice ref
(domain + scope handle), status (pending/approved/denied/expired), price, created/
resolved timestamps, owner user id. Routes to create/list/resolve. Requests
survive refresh; the owner has a real inbox. Consent + audit trail on approve.
**No browser-only state.**

### Phase 2 — Approve/deny over Agent One (A2A), mirroring Location
Once requests are real records, One → Information Marketplace → `approve_access_request`
updates the record **server-side** — identical to how One approves a Location
request today. No browser round-trip. Remove the "approve stays on direct chat"
caveat. Delegation router already sends marketplace intents; extend the A2A handler
to carry approve/deny (it already surfaces the client-action directive path).

### Phase 3 — Inline "publish for offers" nudge
Meet the user in the moment instead of making them visit the dashboard.
- **Signal detection** (new, small): tag a saved memory / mentioned fact as
  "offer-worthy" (renewals, purchase intent, life events) — keywords first, LLM later.
- **`propose_publish` card/tool** (new, small; mirrors approve/deny client-action):
  returns a publish card — safe summary + suggested price + [Publish] / [Not now].
- **Surfaces in BOTH**: the direct Information Marketplace chat AND Agent One (the
  A2A `specialist_directive` channel already carries specialist cards into One's
  chat — Location's directive rendering is the template). Plus an optional
  **dashboard flash card** ("N things worth publishing") as a catch-up nudge.
- **One-tap publish** reuses the existing `default_available` + owner-consent +
  pricing path — no new publish backend.

Smallest first step for Phase 3: the **chat publish card** (largest reuse), then
the save-to-PKM trigger and the on-page flash card.

## Reuse vs new (summary)

| Piece | Status |
|---|---|
| Publish a slice (Available + consent + price) | built |
| Pricing engine (price + math + formula) | built |
| Chat client-action card mechanism | built (approve/deny) |
| A2A delegation + directive-into-One channel | built |
| **Persisted marketplace requests + inbox** | Phase 1 (new) |
| **Approve/deny over One A2A** | Phase 2 (falls out of Phase 1) |
| **Offer-worthy signal detection** | Phase 3 (new, small) |
| **`propose_publish` card + inline triggers** | Phase 3 (new) |

## Out of scope (for now)
Payment rail / settlement (still no money moves); autonomous buyer/business agent
(demo runs on One ↔ Information Marketplace only).
