# One Location Agent Chat — v2 (crypto handoff, public links, platform-aware)

- **Date:** 2026-06-29
- **Branch:** `feat/one-location-agent-chat-v2` (off latest `main`; v1 shipped + on UAT)
- **Status:** Approved design, ready for implementation plan
- **Builds on:**
  - `docs/superpowers/specs/2026-06-27-one-location-agent-chat-design.md` (backend v1, shipped)
  - `docs/superpowers/specs/2026-06-29-one-location-chat-ui-design.md` (UI v1, shipped)
  - their plans under `docs/superpowers/plans/`

## Visual Map

```text
One Location Agent Chat — v2 client-action handoff (coords stay in the browser)

Browser (/one/location chat)                         │  Server (consent-gated)
──────────────────────────────────────────────────  │  ──────────────────────────────────────
Turn A: "share my location with Mom for an hour"     │
  POST /api/one/location/chat                          │  require_vault_owner_token (403 on mismatch)
  { user_id, message, conversation_id? }        ────► │  LocationChatService.handle_turn()
                                                      │    Gemini fn-calling loop INSIDE HushhContext
                                                      │      → list_location_recipients (resolve "Mom")
                                                      │      → create_location_share  (@hushh_tool:
                                                      │          grant + HCT mint, scope-validated, NO coords)
                                                      │    attach clientAction (coordinate-free)
        ◄─────────────────────────────────────────┘    { response, clientAction:{type:"publish_share",
  detect clientAction → render ActionConfirmCard         grantId, recipients:[Mom], summary}, state_changed:false }
  [Share with Mom · 1h · Share | Cancel]              │
  on Share:                                           │
    captureCurrentPosition()                          │  (coordinates never leave the browser)
    encryptLocationForRecipient(per recipient)        │
    POST /grants/{grantId}/envelopes  (ciphertext) ─► │  store_encrypted_envelope (HCT re-validated,
                                                      │    rejects any plaintext coordinate key) → ciphertext row
Turn B: report completion                             │
  POST /api/one/location/chat                          │
  { user_id, conversation_id, actionResult:{      ──► │  agent confirms in words; state_changed:true
      id, type:"publish_share", status:"completed" } } │
        ◄─────────────────────────────────────────┘    { response:"Done — Mom can see you for 1h.",
  render reply; on state_changed → refresh()             is_complete:true, state_changed:true }
    + dispatch consent-state-changed                   │

Per-recipient shares: ciphertext-only end to end. Public links: owner-confirmed,
time-bounded plaintext SNAPSHOT (the one deliberately relaxed path — see §7).
The agent never sees or returns coordinates in any path.
```

## 1. Goal

v1 shipped a **control-plane** One Location assistant: query / revoke / request /
deny / refer, fully completed server-side, agent never sees coordinates. v2 adds
the **coordinate-touching** capabilities that v1 deferred, plus the surrounding
delivery UX, without breaking v1's privacy guarantees:

1. **Crypto handoff** — "share my location", "approve a request", "show me where
   X is" — via a structured **agent → client action-handoff contract**: the
   browser captures position, encrypts per recipient, and uploads an envelope; the
   server/agent still never see plaintext coordinates.
2. **Public share links** accessible **outside** One — a recipient with no
   One account can open a link and see a location. Reuses the existing
   public-invite infrastructure.
3. **Platform-aware sharing** — when a user says "share with <person>", the agent
   resolves the recipient against the **real** supported delivery set and asks a
   clarifying question only when needed. It never invents unsupported channels.

## 2. Context — actual state on this branch (Step 0 findings)

The hard parts already exist. v2 is mostly *wiring the agent to working code*, not
building new crypto.

### Crypto handoff — already built (reuse as-is)

| Area | Symbols / paths |
|---|---|
| Deferred agent tools | `consent-protocol/hushh_mcp/agents/location/tools.py` — `create_location_share` (scope `cap.location.live.share`), `publish_location_envelope`, `approve_location_request`, `view_location_envelope` (scope `cap.location.live.view`). `LOCATION_AGENT_TOOLS` (all 10) vs `CONTROL_PLANE_LOCATION_TOOLS` (6, used by v1). |
| Service business logic | `consent-protocol/hushh_mcp/services/one_location_agent_service.py` — `create_grant`, `store_encrypted_envelope`, `approve_request`, `view_latest_envelope`, `list_verified_recipients`, `_contains_plaintext_location_key` (rejects 18 coordinate keys in envelope metadata, 422). |
| REST routes | `consent-protocol/api/routes/one/location.py` — `POST /grants` (CreateGrantRequest), `POST /grants/{id}/envelopes` (StoreEnvelopeRequest), `POST /requests/{id}/approve` (ResolveAccessRequest), `GET /grants/{id}/envelope`, `POST /recipient-keys` (RecipientKeyRequest), `GET /recipients`. All require `require_vault_owner_token` except public-invite resolve/submit. |
| Envelope model | migration `061_one_location_agent.sql` — `one_location_recipient_keys`, `one_location_share_grants`, `one_location_envelopes` (ciphertext, iv, sender_ephemeral_public_key_jwk; algorithm `ECDH-P256-AES256-GCM`; per recipient; `duration_hours` CHECK ≤24). |
| Client crypto (works today) | `hushh-webapp/lib/one-location/encryption.ts` — `ensureLocationRecipientKey`, `encryptLocationForRecipient` (ephemeral ECDH P-256 + AES-256-GCM, per recipient), `decryptLocationEnvelope`; `key-bootstrap.ts`; `service.ts` `captureCurrentPosition`. Web Crypto (`crypto.subtle`) only — no third-party lib. Private keys live in IndexedDB, never leave the device. |
| Page callbacks (button-driven today) | `hushh-webapp/app/one/location/page.tsx` — `handleShare`, `publishEnvelope`, `handleApprove`, `viewGrantEnvelope`. v2 reuses these from the agent's directive. |

### Public links — already built (reuse + relax the agent prompt)

| Area | Symbols / paths |
|---|---|
| Public invite service | `one_location_agent_service.py` — `create_public_invite` (`secrets.token_urlsafe(32)`, stores SHA-256 hash only, ≤24h, optional `metadata.publicLocation` **plaintext** snapshot), `resolve_public_invite` (auto-expires), `submit_public_invite_request`. |
| Public routes | `api/routes/one/location.py` — `POST /public-invites` (owner), `GET /public-invites/{token}` (**no auth**), `POST /public-invites/{token}/submit` (**no auth**), `DELETE /public-invites/{id}` (owner). |
| Public tables | migration `064` — `one_location_public_invites`, `one_location_public_invite_submissions`. |
| Public viewer page (live today) | `hushh-webapp/app/one/location/request/[token]/page-client.tsx` — no-auth route (`isPublicRoute()` in `lib/navigation/routes.ts`); shows Google Maps embed of the snapshot + expiry badge; 410 expired / 404 invalid. |
| Links UI | `hushh-webapp/components/one-location/redesign/cards.tsx` — `TemporaryLinkCard` (Copy / Share / Revoke); `location-redesign-hub.tsx` LinksHub. |

### Delivery channels — what is ACTUALLY wired (drives platform-awareness)

| Channel | Status | Notes |
|---|---|---|
| FCM push (web/iOS/Android) to a One user | **Wired** | `one_location_agent_service.py` `_send_metadata_notification`; metadata-only, deep-link `/one/location`; best-effort (silently drops if no push token). |
| In-app consent-surface refresh | **Wired** | `hushh-webapp/lib/one-location/notifications.ts` + `consent-state-changed`. |
| Public / circle link (owner copy-pastes) | **Wired** | Backend returns `publicUrl`; it does **not** auto-dispatch the link anywhere. |
| SMS | **Absent** | No Twilio/SMS provider in the location flow. (An unrelated RIA invite enum lists `sms` but nothing sends it.) |
| Email to recipient | **Absent** | Gmail API exists only for KAI advisor invites; not wired to any location event. |

**Recipient identity** is resolved by `user_id` (UUID). `list_verified_recipients`
returns only verified One users (network-connected or phone-verified) and embeds
each recipient's `keyId` + `publicKeyJwk`. `canReceiveLocation:true` iff a key is
registered (the recipient has opened One Location). Phone→user lookup happens
**only** in the public-invite submission intake, not at agent share time.

### The agent prompt to change

`consent-protocol/hushh_mcp/agents/location/agent.yaml` currently states:

> *"…Refuse public bearer links, plaintext server coordinates, notification
> coordinates, and referral flows that grant access without owner approval."*

This directly contradicts Goals 1–2. §6 reworks it.

## 3. Scope (locked)

**In scope (v2):**

- Crypto-handoff for **share** (`create_location_share` → `publish_share`
  directive), **approve** (`approve_location_request` → `publish_share`
  directive), and **view** ("show me where X is" → `view_envelope` directive).
- Agent-minted **public links** (reuse the plaintext-snapshot public invite),
  plus chat-driven **public-link revocation** (control-plane).
- **Platform-aware** recipient resolution + clarifying questions over the real
  supported set (encrypted in-app share, public link).

**Out of scope (explicit):**

- Streaming responses (true or cosmetic). Backend stays non-streaming.
- **SMS / email auto-send** — not wired anywhere in the location flow (planned for
  a future milestone — see §11 Future work).
- **Live / continuously-updating** public links — snapshot only.
- A new public viewer page — reuse `/one/location/request/[token]`.
- A new encryption scheme for public links — reuse the plaintext snapshot (per the
  Q2 decision in §8).
- Routing location intents through the global KAI assistant.
- Cross-reload persistence of `conversation_id` (stays memory-only).

## 4. Architecture — the client-action handoff contract

**Core principle:** every coordinate-touching operation splits into a *server-side
prep step* (a real `@hushh_tool` running in `HushhContext`, scope-validated, **no
coords**) and a *client-side completion step* (capture → encrypt → upload, coords
stay in the browser). This preserves v1's consent-enforcement invariant while the
browser does the crypto.

### Contract additions (backward-compatible with v1)

```python
class LocationChatRequest(BaseModel):
    user_id: str                       # min 1, max 128
    message: str | None = None         # min 1, max 4000 when present
    conversation_id: str | None = None # max 128
    action_result: ActionResult | None = None   # NEW — browser reports completion

class ActionResult(BaseModel):          # coordinate-free by construction
    id: str                            # echoes ClientAction.id (correlation)
    type: str                          # "publish_share" | "view_envelope" | "create_public_link"
    status: str                        # "completed" | "cancelled" | "failed"
    public_url: str | None = None      # for create_public_link
    detail: str | None = None          # safe, non-sensitive ("shared with 1 recipient")

class ClientAction(BaseModel):          # coordinate-free by construction
    id: str                            # idempotency / correlation key
    type: str                          # "publish_share" | "view_envelope" | "create_public_link"
    grant_id: str | None = None        # publish/view — created server-side this turn
    recipients: list[ActionRecipient] | None = None  # publish — userId,keyId,publicKeyJwk,label
    duration_hours: float | None = None  # create_public_link
    summary: str                       # human label for the confirm card

class LocationChatResponse(BaseModel):
    conversation_id: str
    response: str                      # coordinate-free reply
    is_complete: bool
    state_changed: bool
    client_action: ClientAction | None = None   # NEW — present when the browser must act
```

A turn carries **either** a `message` (user text) **or** an `action_result`
(completion report), never both required. `client_action` is present only on turns
that need the browser; otherwise the contract is identical to v1.

### Turn lifecycle (share / approve)

```
1. Turn A (user text) → Gemini loop inside HushhContext
     - list_location_recipients resolves the named person (scope-validated)
     - unambiguous One recipient w/ key → create_location_share
       (@hushh_tool: grant row + HCT mint, scope-validated, NO coords)
       (approve variant: approve_location_request, same shape)
     - service returns grant_id + recipient key info
     - LocationChatService attaches client_action{ type:"publish_share",
       grant_id, recipients[], summary } and ends the turn (state_changed:false)
2. Browser detects client_action → renders ActionConfirmCard (explicit click)
3. On confirm → EXISTING pipeline: captureCurrentPosition →
   encryptLocationForRecipient (per recipient) → POST /grants/{grant_id}/envelopes
   (ciphertext only). Coords never leave the browser.
4. Turn B (action_result, no message) → agent confirms in words;
   state_changed:true → existing refresh() + consent-state-changed
```

`view_envelope` ("show me where X is") works the same way: the directive carries
the `grant_id`; the browser fetches the ciphertext (`GET /grants/{id}/envelope`)
and `decryptLocationEnvelope` renders the map. `create_public_link` captures the
snapshot client-side and POSTs it to `create_public_invite` (§7).

### Why grant creation stays server-side

Folding grant minting into the client callback would skip the agent's
`HushhContext` + `@hushh_tool` scope validation. Instead, grant/approve run
server-side as real tool calls (scope-validated, coordinate-free); **only** the
envelope — the coordinate-bearing part — is delegated to the browser. The publish
and view REST routes additionally re-validate the HCT.

### Tool exposure (defense-in-depth)

| Intent | Server-side `@hushh_tool` (HushhContext, scope) | Emits `client_action` |
|---|---|---|
| "share with X" | `create_location_share` (`cap.location.live.share`) | `publish_share` |
| "approve X's request" | `approve_location_request` (`cap.location.live.share`) | `publish_share` |
| "where is X / show me" | *(read path; fetch is a directive, decrypt is client)* | `view_envelope` |
| "make a public link" | `create_public_invite` (after client snapshot upload) | `create_public_link` |
| "revoke the public link" | `delete_public_invite` (control-plane, server-side) | *(none)* |

`publish_location_envelope` and `view_location_envelope` are **never** exposed as
callable LLM tools — they are impossible server-side (need ciphertext /
decryption). The loop *translates* a completed `create_location_share` /
`approve_location_request` / view-intent into the matching `client_action`. The
allow-list is enforced in code, not only the prompt (same defense-in-depth as v1).

### New / changed backend files

| File | Change |
|---|---|
| `consent-protocol/hushh_mcp/services/location_chat_service.py` | **Edit** — widen the tool allow-list; after a grant-creating tool runs (or a view/public-link intent is detected) attach the matching `client_action` and end the turn; handle the `action_result` follow-up turn → confirmation reply + precise `state_changed`. |
| `consent-protocol/api/routes/one/location_chat.py` | **Edit** — extend request/response models with `action_result` / `client_action` (+ `ClientAction`, `ActionRecipient`, `ActionResult`). Backward-compatible. |
| `consent-protocol/hushh_mcp/agents/location/agent.yaml` | **Edit** — relax the refusal prompt (§6). |
| `consent-protocol/hushh_mcp/agents/location/tools.py` | **Edit (if needed)** — a v2 allow-list (`V2_LOCATION_TOOLS`) exposing resolve + grant/approve + public-invite create/delete; still excluding `publish_location_envelope` / `view_location_envelope` from LLM-callable tools. |

No new DB migration — all tables (061, 064) already exist.

## 5. Platform-aware resolution & clarifying behavior

The agent resolves a named person via `list_verified_recipients` into one of four
buckets and branches. **Only real channels are ever offered**: encrypted in-app
share (One recipient w/ key) and public link (anyone). SMS / email are never
offered; if the user explicitly asks ("text it to Mom"), the agent explains it
can't send SMS but can make a link to paste.

| Bucket | Detection | Agent behavior |
|---|---|---|
| **Verified One recipient, has key** (`canReceiveLocation:true`) | exactly one name match with a registered key | Proceed: `create_location_share` → `publish_share` directive. No verbal question — the confirm card is the confirmation. |
| **On One, no key** (`canReceiveLocation:false`) | name match, no registered key | Ask: "Mom's on One but hasn't set up location sharing yet. I can send her a request to enable it, or create a public link you can send her." |
| **Ambiguous** | multiple name matches | Disambiguate with the matches ("Mom (•••4821) or Mom (work)?"). |
| **Unknown / off-platform** | no match | Ask: "I don't see {name} on One. I can create a public link you can send them — want that?" |

**Multi-recipient** ("share with Mom and Dad"): one `publish_share` directive with
a `recipients[]` array; the browser captures position **once** and encrypts **per
recipient** (`encryptLocationForRecipient` already does per-recipient ECDH). Mixed
buckets → handle the verified recipients via the share directive and offer a public
link for the rest, in a single clarifying reply.

## 6. Public links via the agent

Reuses the existing public-invite infrastructure end to end — no new crypto, no new
viewer page.

**Mint flow** (off-platform recipient, explicit "make a public link", or fallback
offer):

```
1. Agent turn → response + client_action{ type:"create_public_link", duration_hours }
2. Browser ActionConfirmCard ("Public link · viewable 1h · Create | Cancel")
3. On Create → captureCurrentPosition() → POST create_public_invite with the
   plaintext publicLocation snapshot (the relaxed path) + duration_hours
4. action_result{ status:"completed", public_url } → agent replies with the link +
   "anyone with this link can see this location for 1 hour; revoke it anytime."
   state_changed:true (Links tab refreshes)
```

**Bounds on the relaxed invariant (already enforced by existing code; restated as
justification):**

- **Static snapshot, not a live feed** — one position captured at creation.
- **Owner-initiated + explicitly confirmed** — only via the confirm card; the agent
  never auto-creates.
- **Time-bounded** — `duration_hours` DB CHECK ≤24h; auto-expires on resolve.
- **Revocable** — `DELETE /public-invites/{id}`; chat-driven via `delete_public_invite`
  ("kill that link"); Links tab shows/revokes (`TemporaryLinkCard`).
- **Token hygiene** — `token_urlsafe(32)`; only the SHA-256 hash stored; raw token
  returned once.

**Non-One viewer (unchanged):** the public page resolves the token, shows a
Google Maps embed of the snapshot + expiry badge + directions; expired → 410,
invalid → 404. No account, no login.

**Agent-prompt relaxation (`agent.yaml`).** Reword the single refusal line to:

- **Still refuse:** the agent itself emitting/handling coordinates; coordinates in
  notifications; access granted without explicit owner approval; arbitrary
  unbounded links.
- **Now permit (narrowly):** (a) delegating a coordinate operation to the browser
  via the structured `client_action` contract; (b) minting an **owner-initiated,
  time-bounded, revocable public link** (the plaintext-snapshot path). The prompt
  names these as the *only* sanctioned ways coordinates move, and ties public links
  to explicit owner confirmation + expiry.

The agent's own turn text stays coordinate-free; the relaxation is about
*delegating* and *link-minting*, not about the agent seeing coordinates.

## 7. Frontend

Builds on the shipped v1 chat UI (`use-location-chat.ts`, `LocationChatCard` /
`LocationChatOverlay`, `OneLocationService.chat`). The one new concept is a
**client-action dispatcher** on the existing hook.

**New behavior (`useLocationChat` extension or `useLocationChatActions`):**

- After each `chat()` response, inspect `client_action`. If present, set
  `pendingAction` instead of only rendering text.
- Render an inline **ActionConfirmCard** in the message stream (reusing chat
  bubble/token styling): icon + `summary` + `[Share]/[Create]/[View]` + `[Cancel]`.
  Security-sensitive → explicit click; never auto-fires.
- On confirm, dispatch by `type` to the **existing page callbacks** — no new crypto:
  - `publish_share` → `captureCurrentPosition` + `encryptLocationForRecipient` (per
    recipient) + `storeEnvelope` (existing `publishEnvelope` / `handleShare`).
  - `view_envelope` → fetch envelope + `decryptLocationEnvelope` → render map
    (existing `viewGrantEnvelope`).
  - `create_public_link` → `captureCurrentPosition` + `createPublicInvite`.
- On completion / cancel / failure, call `chat()` again with `action_result` (no
  message). On `state_changed`, the existing `onStateChanged` (`refresh()` +
  `dispatchConsentStateChanged`) fires; Now / People / Links tabs stay in sync.

**States to handle:** geolocation permission denied → `action_result{status:"failed",
detail:"location unavailable"}` → agent offers retry/alternative; recipient key
missing at publish → graceful "they need to open One Location first"; cancel →
agent acknowledges, no mutation.

**New suggestion chips:** "Share my location with…", "Show me where someone is",
"Make a public link".

**Reuse, don't rebuild.** All crypto, geolocation, key-bootstrap, and REST calls
already exist; v2 wires the directive to them. v1's chat surface, overlay, chips,
typing indicator, and error/retry are untouched except for the action-card branch.

### Changed frontend files

| File | Change |
|---|---|
| `hushh-webapp/lib/one-location/service.ts` | **Edit** — `chat()` accepts/returns `actionResult` / `clientAction`. |
| `hushh-webapp/components/one-location/redesign/use-location-chat.ts` | **Edit** — `pendingAction` state, action dispatcher, `action_result` follow-up turn. |
| `hushh-webapp/components/one-location/redesign/` | **New** — `ActionConfirmCard` (presentational); new suggestion chips. |
| `hushh-webapp/components/one-location/redesign/location-chat-*.tsx` | **Edit** — render the action card in the message stream. |

## 8. Invariant ledger — preserved vs. relaxed

| v1 invariant | v2 status | Detail |
|---|---|---|
| Consent enforcement via `HushhContext` + per-tool scope validation | **Preserved** | All server-side ops (resolve, create_grant, approve, revoke, public-link create/delete) run as `@hushh_tool` in `HushhContext`; publish/view REST routes re-validate the HCT. |
| Agent never sees/returns coordinates | **Preserved** | Coordinates exist only in the browser; `client_action` / `action_result` are coordinate-free by construction; agent turn text stays coordinate-free. |
| Zero **server-side** plaintext coordinates | **Preserved for per-recipient shares**; **RELAXED for public links** | Per-recipient envelopes remain ciphertext-only (`ECDH-P256-AES256-GCM`). Public links store a plaintext `publicLocation` snapshot server-side. **Justification:** owner-initiated + explicitly confirmed; static one-time snapshot (not live); ≤24h hard-capped + auto-expire; revocable; required because a external viewer has no key to decrypt. Scoped narrowly to this one path. |
| AES-256-GCM conversation encryption at rest | **Preserved** | Same `AgentChatService`; `client_action` / `action_result` metadata is coordinate-free and safe to persist. |
| Opaque errors | **Preserved** | `action_result` failures map to safe agent messages; no internal detail. |
| Agent refuses arbitrary bearer links / coords-in-notifications | **Preserved** | Prompt still refuses these; only the narrow confirmed-public-link + client-handoff paths are permitted. |

## 9. Testing strategy (TDD, extends v1 suites)

**Backend**
- `create_location_share` / `approve_location_request` produce a grant **and** a
  coordinate-free `client_action`.
- `publish_location_envelope` / `view_location_envelope` are **not** LLM-callable
  (asserted at the code level, not just the prompt).
- Scope enforcement fails closed when a matching scope is absent.
- `action_result` follow-up turn yields a confirmation reply + correct
  `state_changed` (true after a successful mutating action; false on cancel).
- Resolution buckets (verified-with-key / on-One-no-key / ambiguous / unknown)
  drive the right branch and offer only real channels.
- Public-link mint requires confirmation, respects expiry, and is revocable via
  chat; the agent never auto-creates one.
- **No coordinate keys** appear in any stored message, `client_action`, or
  `action_result`.
- Reuse fakes/patterns from `consent-protocol/tests/test_one_location_*`.

**Frontend**
- `client_action` renders the ActionConfirmCard; it never auto-fires.
- Confirm dispatches to the existing crypto callbacks; multi-recipient encrypts per
  recipient from a single capture.
- Cancel / failure / permission-denied paths POST the correct `action_result`.
- `state_changed:true` triggers `refresh()` + `consent-state-changed`.
- Existing v1 chat/page tests stay green; `npx tsc --noEmit` clean.

## 10. Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Crypto-handoff model | Structured `client_action` directive + `action_result` follow-up turn | Clean contract; reuses all v1 crypto + REST; confirm gate fits a security-sensitive action |
| Grant creation | Server-side `@hushh_tool` in `HushhContext`; only the envelope delegated to the browser | Keeps grant minting under per-tool scope validation (v1 non-negotiable) |
| Public-link coordinate model | Reuse the existing **plaintext snapshot**; relax the invariant for this one path | Q2 decision; a external viewer has no key to decrypt — bounded, owner-confirmed, revocable, ≤24h |
| Platform confirmation | Resolve first; ask only when ambiguous / no-key / off-platform | Q3 decision; confirm card already shows target+platform+duration |
| Delivery channels offered | Encrypted in-app share + public link only | Only channels actually wired; no SMS/email |
| Public links | Live, no-auth `/request/[token]`; static snapshot | Reuse shipped infra; no new viewer page |
| Response mode | Non-streaming, consent-gated direct-Gemini loop in `HushhContext` | Same as v1 |

## 11. Future work — full multi-platform delivery (post-v2)

**Goal (future):** integrate location sharing with **all available delivery
platforms**, so the agent can deliver a share/link through whatever channel the
recipient prefers — not just in-app push + manually-pasted links.

v2 deliberately offers only the channels actually wired today (encrypted in-app
share + public link). A future milestone should expand the **platform-aware**
layer (§5) to offer and auto-dispatch additional channels once each is built and
verified:

- **SMS** — auto-send the public link (or an invite) via a real SMS provider
  (e.g. Twilio). Requires provider integration; today only an unrelated RIA enum
  references `sms` and nothing sends it.
- **Email** — auto-send via a transactional email service. A Gmail-API path exists
  for KAI advisor invites; it is **not** wired to any location event.
- **Native share sheet** — hand the public link to the OS share sheet (iOS/Android
  via Capacitor) so the user can pick any installed app (WhatsApp, iMessage, etc.).
- **Other push targets** beyond the current Firebase Admin path, if added.

**Design hooks to preserve for this:** the platform-resolution buckets in §5 and
the `client_action`/`action_result` contract in §4 are the natural extension
points. A future channel becomes (a) a new entry in the "real supported set" the
agent may offer, and (b) either a server-side dispatch step (SMS/email) or a new
`client_action.type` (native share sheet). The zero-plaintext-coordinate posture
must hold: links carry the bounded snapshot already covered by §8; no new channel
should transmit plaintext coordinates to the server beyond that one relaxed path.

**Out of scope for v2** — this section is a forward reference only; nothing here is
built in this milestone.

## 12. Skill plan (remainder of flow)

1. **superpowers:brainstorming** — complete (this spec).
2. User reviews this spec.
3. **superpowers:writing-plans** — implementation plan (TDD task breakdown).
4. **ui-ux-pro-max** — drives the visual execution of the ActionConfirmCard.
5. **superpowers:test-driven-development** + **superpowers:executing-plans** —
   build on `feat/one-location-agent-chat-v2`.
