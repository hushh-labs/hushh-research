# 🤫 Permission Gateway API

_The Preference Subscription Fabric — PCHP RFC-002_

> The world subscribes to you. Not the other way around.

## Visual Map

The whole system at a glance: one profile the person owns, and scoped,
receipted subscriptions out to the world — nothing read without a grant, no
grant read without a receipt.

```
                        ┌───────────────────────────────┐
                        │   Personal World Model (PWM)   │   the person owns
                        │        /api/pwm  (owner)       │   one profile
                        └───────────────┬───────────────┘
                                        │ scopes bind to fields (fail-closed)
             owner grants access        ▼
   ┌────────────────────────────────────────────────────────────┐
   │  GRANT  ──▶  handle (HFG:…) ──▶  subscriber READ  ──▶ fields │
   │    │                                   │                     │
   │    └───────────────┬───────────────────┘                     │
   │                    ▼                                          │
   │      hash-chained RECEIPT ledger  (GRANT · READ · REVOKE)    │
   │      owner lists + verifies; REVOKE is fail-closed           │
   └────────────────────────────────────────────────────────────┘

   Two ways a subscriber comes to hold a handle:
     • Direct grant     — owner issues to a known subscriber          (§4a)
     • Handshake        — subscriber knocks with a pairing code;      (§4b)
                          the person approves from their own agent
```

Sections: [core concepts](#2-core-concepts) · [auth](#3-identity--auth) ·
[integration paths](#4-the-two-integration-paths) ·
[scopes](#5-scopes-reference) · [receipts](#6-receipts--verification) ·
[privacy signals](#7-privacy-signals) ·
[limits & errors](#8-rate-limits--error-codes) · [for agents](#9-for-ai-agents).

## 1. What it is

The Permission Gateway inverts surveillance. Today the world quietly builds a
profile of you from a thousand places you never see. The Permission Gateway
turns that around: **a person owns one profile — their Personal World Model
(PWM) — and the world subscribes to exactly the fields they grant.** Every
subscription is scoped, dated, priced (optionally), receipted, and revocable.
Consent and control stay in the person's hands, always.

Nothing is read without a grant, and no grant is read without leaving a signed
receipt. There is no bulk export, no shadow copy, no "read everything once."
A subscriber presents a grant handle and receives **only** the fields that grant
authorizes, at their current value, and the read writes an entry to a
tamper-evident ledger the owner can verify.

Read this two ways:

- **If you are a human developer** integrating a brand, a professional practice,
  or a product: the Gateway is a clean HTTP API. Your users hand you scoped,
  time-boxed read access to their own data, and you subscribe to it. No scraping,
  no data brokers, no cookie banner.
- **If you are an AI agent** acting on a consenting person's behalf: the Gateway
  is a handshake you can drive end to end. You discover what a subscriber is
  asking for, show your human exactly who wants what and why, and complete the
  grant under their explicit approval — with a receipt for every access. See
  [§9, For AI agents](#9-for-ai-agents).

**Security posture (honest):** the Gateway is built to be consent-first and to
the NIST 800-53 High control family — signed receipts for every access (AU-12),
least-privilege field release (fail-closed), and identity taken only from a
verified token. Certifications such as FedRAMP High and DoD Impact Levels are
**in pursuit**, not held. Nothing here is "certified" or "compliant" today; we
say so plainly.

### Base URLs

| Environment | Base URL | Status |
|---|---|---|
| UAT | `https://api.uat.hushh.ai` | **Live.** The fabric endpoints are available here. |
| Production | `https://api.hushh.ai` | **In progress.** Fabric endpoints are not yet live on production. Build and test against UAT. |

All paths below are relative to a base URL, e.g.
`POST https://api.uat.hushh.ai/api/fabric/grants`.

---

## 2. Core concepts

**Personal World Model (PWM).** The person's own preference document, stored at
`/api/pwm` and keyed by their verified user id. It is theirs: returned only to
its owner, mergeable, and fully wipeable. It is the single profile everything
else subscribes to.

**Scope.** A stable label — such as `wants.money.advisor` or
`privacy.marketing-email` — that names a slice of the PWM. The server maps each
scope to specific document fields through a **fail-closed** registry: a scope
with no registered binding releases **no** fields and is reported as unmapped.
An un-modelled scope can never leak an unintended field. See
[§5, Scopes reference](#5-scopes-reference).

**Grant + grant handle.** A grant binds `{ subscriber, scopes[], purpose, ttl,
price? }` to the owner's user id. Creating a grant returns a **grant handle** —
an opaque, signed, expiring, revocable credential the subscriber presents to
read. The handle format is:

```
HFG:<base64url(payload)>.<hmac-sha256>
```

`HFG` is the Hushh Fabric Grant prefix. The payload carries the grant id (`gid`),
owner user id (`uid`), subscriber (`sub`), issued-at (`iat`), expiry (`exp`),
and a commercial flag (`c`, set when the grant is priced) — all covered by an
HMAC-SHA256 signature. **The plaintext handle is returned exactly once, at
creation.** Only its SHA-256 fingerprint is stored server-side.

**Receipt ledger (hash-chained).** Every grant, every read, and every revoke
appends one receipt to a per-owner, append-only chain:

```
hash      = sha256( prev_hash || "\n" || canonical_payload )
signature = HMAC-SHA256( APP_SIGNING_KEY, hash )
```

The chain proves nothing was inserted, dropped, or reordered; the signature
makes each receipt tamper-evident on its own. Owners can list and verify the
chain, including pinning the head to detect truncation. See
[§6, Receipts & verification](#6-receipts--verification).

**Revocation is fail-closed.** Revoking a grant flips its row to `revoked` and
writes a REVOKE receipt. The handle stays cryptographically well-formed but
stops working immediately: the read path re-checks grant status inside the same
per-owner lock as revoke, so a read either commits before the revoke or fails
closed after it — no data leaks through the gap.

---

## 3. Identity & auth

Two kinds of caller, two kinds of token. **In both cases the user id is derived
only from the verified token, never from the request body.**

**Owner endpoints** — the person acting on their own PWM, grants, receipts, and
handshake approvals. Authenticate with a **Firebase ID token** as a bearer:

```
Authorization: Bearer <firebase-id-token>
```

The owner's `uid` comes from that token alone. On `/api/pwm`, any `uid`,
`user_id`, or `userId` field in the body is stripped before processing.

**Subscriber endpoints** — the third party (brand, professional, or agent)
reading granted fields and opening handshakes. Authenticate with a **developer
principal** as a bearer (a static `hdk_` token or OAuth client-credentials):

```
Authorization: Bearer <developer-principal-token>
```

The subscriber identity is the principal's `agent_id`. A principal with no
`agent_id` is rejected with `FABRIC_SUBSCRIBER_UNIDENTIFIED` (403).

| Endpoint | Auth |
|---|---|
| `POST /api/fabric/grants` | Owner (Firebase) |
| `GET /api/fabric/grants` | Owner (Firebase) |
| `POST /api/fabric/grants/{id}/revoke` | Owner (Firebase) |
| `GET /api/fabric/receipts` | Owner (Firebase) |
| `GET /api/fabric/receipts/verify` | Owner (Firebase) |
| `GET /api/fabric/requests/code/{code}` | Owner (Firebase) |
| `POST /api/fabric/requests/{id}/approve` | Owner (Firebase) |
| `POST /api/fabric/requests/{id}/deny` | Owner (Firebase) |
| `POST /api/fabric/read` | Subscriber (developer principal) |
| `POST /api/fabric/requests` | Subscriber (developer principal) |
| `GET /api/fabric/requests/{id}` | Subscriber (developer principal) |
| `GET / PUT / DELETE /api/pwm` | Owner (Firebase) |

---

## 4. The two integration paths

There are two ways a subscriber comes to hold a grant handle. Use the **direct
grant** when the owner already knows the subscriber's id and issues access
directly. Use the **brand-initiated handshake** when the subscriber wants to ask
— the "knock on the door" — without ever learning who the person is until they
consent.

### 4a. Direct grant

The owner creates a grant for a known subscriber, then the subscriber reads.

**Step 1 — Owner creates the grant.**

```
POST /api/fabric/grants
Authorization: Bearer <firebase-id-token>
Content-Type: application/json

{
  "subscriber_id": "agent_northwind_advisors",
  "scopes": ["wants.money.advisor"],
  "purpose": "Match you with a local fiduciary advisor",
  "subscriber_label": "Northwind Advisors",
  "ttl_ms": 2592000000,
  "price_cents": 0,
  "currency": "USD"
}
```

Notes on the body: `subscriber_id`, `scopes` (1–64), and `purpose` are required.
`ttl_ms` is optional and defaults to 30 days, capped at 1 year. A **priced**
grant requires both a non-negative `price_cents` and a `currency`; supplying
`price_cents` without `currency` returns `FABRIC_PRICE_INVALID`.

**Response (`200`):** the handle is here, once.

```json
{
  "grant_id": "3f9c1a2b4d5e6f7a8b9c0d1e2f3a4b5c",
  "handle": "HFG:eyJjIjpmYWxzZSwiZXhwIjoxN...Q.9a1b2c3d4e5f...",
  "subscriber_id": "agent_northwind_advisors",
  "scopes": ["wants.money.advisor"],
  "fields": ["connect.want", "connect.zip"],
  "purpose": "Match you with a local fiduciary advisor",
  "price_cents": 0,
  "currency": "USD",
  "expires_at_ms": 1793664000000,
  "receipt": {
    "id": 42,
    "seq": 7,
    "event_type": "GRANT",
    "prev_hash": "b1946ac9...",
    "hash": "c2d4e6f8...",
    "signature": "7f3a9b1c...",
    "created_at_ms": 1791072000000
  }
}
```

Store the `handle` securely — it is not retrievable again. Hand it to the
subscriber over your own trusted channel (in the handshake flow, the platform
does this for you; see §4b).

**Step 2 — Subscriber reads the granted fields.**

```
POST /api/fabric/read
Authorization: Bearer <developer-principal-token>
Content-Type: application/json

{ "handle": "HFG:eyJjIjpmYWxzZSwiZXhwIjoxN...Q.9a1b2c3d4e5f..." }
```

**Response (`200`):** only the granted fields that exist in the PWM right now,
plus a READ receipt.

```json
{
  "user_id": "firebase-uid-of-owner",
  "subscriber_id": "agent_northwind_advisors",
  "grant_id": "3f9c1a2b4d5e6f7a8b9c0d1e2f3a4b5c",
  "scopes": ["wants.money.advisor"],
  "fields": {
    "connect.want": "financial-advisor",
    "connect.zip": "98033"
  },
  "receipt": {
    "id": 43,
    "seq": 8,
    "event_type": "READ",
    "prev_hash": "c2d4e6f8...",
    "hash": "d3e5f7a9...",
    "signature": "8a4b0c2d...",
    "created_at_ms": 1791072300000
  }
}
```

Fields absent from the current PWM are simply omitted — the subscriber receives
only what exists now, at its current value. If privacy scopes were granted, the
response also carries a `privacy_signals` block; see
[§7, Privacy signals](#7-privacy-signals).

**Step 3 — Owner revokes at any time.**

```
POST /api/fabric/grants/{grant_id}/revoke
Authorization: Bearer <firebase-id-token>
```

```json
{ "grant_id": "3f9c1a2b...", "status": "revoked", "already": false, "receipt": { "...": "..." } }
```

Revocation is idempotent (`already: true` if the grant was already revoked) and
immediate: the very next read on that handle fails closed.

**Read errors** collapse to a single generic denial — see
[§8, Rate limits & error codes](#8-rate-limits--error-codes).

---

### 4b. Brand-initiated handshake — the open door

This is the marquee flow: a subscriber knocks, and the person opens the door on
their own terms. It is modeled on the OAuth 2.0 Device Authorization Grant, so
**the subscriber never learns who the person is before consent.** The person's
user id enters only at approval, and only from their verified token.

The whole handshake in four moves:

```
  Subscriber                     Person (owner)                 Platform
     │                                │                             │
  1. │ POST /requests ──────────────────────────────────────────▶  │  mint request_id + code
     │ ◀───────────── request_id, "TVXK-7P29" ──────────────────   │
     │                                │                             │
  2. │ ──── show code to person ────▶ │                             │
     │                                │ GET /requests/code/{code} ▶ │  who / what / why
     │                                │ ◀──── scopes, purpose, … ── │
     │                                │                             │
  3. │                                │ POST /requests/{id}/approve▶│  bind uid, mint grant,
     │                                │ ◀──── grant summary ─────── │  park handle for ONE claim
     │                                │                             │
  4. │ GET /requests/{id} (poll) ───────────────────────────────▶  │  return handle exactly once
     │ ◀───────────── handle ────────────────────────────────────  │
     │                                │                             │
     │ POST /read (handle) ─────────────────────────────────────▶  │  granted fields + receipt
```

**Step 1 — Subscriber opens a request.** No owner identity involved yet.

```
POST /api/fabric/requests
Authorization: Bearer <developer-principal-token>
Content-Type: application/json

{
  "scopes": ["wants.money.advisor"],
  "purpose": "Match you with a local fiduciary advisor",
  "subscriber_label": "Northwind Advisors",
  "ttl_ms": 2592000000,
  "price_cents": 0,
  "currency": "USD"
}
```

**Response (`200`):**

```json
{
  "request_id": "9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e",
  "pairing_code": "TVXK-7P29",
  "expires_at_ms": 1791072900000,
  "poll_interval_ms": 2500
}
```

Show the `pairing_code` to the person — on screen, in an email, on a card at the
counter. The code is drawn from a CSPRNG over an unambiguous alphabet (no
vowels, no `0/O/1/I/L` lookalikes), is single-use, and **expires in 15 minutes.**
If `subscriber_label` is omitted, the subscriber's registered display name is
used.

**Step 2 — Person looks up the code.** Their agent shows them exactly what is
being asked. Sign-in is required (Firebase), but no user id is bound to the
request yet.

```
GET /api/fabric/requests/code/TVXK-7P29
Authorization: Bearer <firebase-id-token>
```

**Response (`200`):**

```json
{
  "request_id": "9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e",
  "subscriber_id": "agent_northwind_advisors",
  "subscriber_label": "Northwind Advisors",
  "scopes": ["wants.money.advisor"],
  "fields": ["connect.want", "connect.zip"],
  "unmapped_scopes": [],
  "purpose": "Match you with a local fiduciary advisor",
  "ttl_ms": 2592000000,
  "price_cents": 0,
  "currency": "USD",
  "expires_at_ms": 1791072900000
}
```

`fields` is the exact set of PWM paths this grant would release; `unmapped_scopes`
lists any requested scope the registry does not bind (fail-closed — it releases
nothing). The person sees who, what, why, how long, and at what price before
deciding.

**Step 3a — Person approves.** This binds their verified user id, mints the
grant (and its GRANT receipt), and parks the handle for a single claim. The
pairing code must match the request, so a `request_id` alone is never enough.

```
POST /api/fabric/requests/{request_id}/approve
Authorization: Bearer <firebase-id-token>
Content-Type: application/json

{ "pairing_code": "TVXK-7P29" }
```

**Response (`200`):** the owner gets the grant summary and receipt — **never the
handle.** The handle belongs to the subscriber.

```json
{
  "request_id": "9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e",
  "status": "approved",
  "grant_id": "3f9c1a2b4d5e6f7a8b9c0d1e2f3a4b5c",
  "scopes": ["wants.money.advisor"],
  "fields": ["connect.want", "connect.zip"],
  "receipt": { "seq": 7, "event_type": "GRANT", "hash": "c2d4e6f8...", "signature": "7f3a9b1c...", "...": "..." }
}
```

**Step 3b — or the person denies.** One tap, terminal, fail-closed.

```
POST /api/fabric/requests/{request_id}/deny
Authorization: Bearer <firebase-id-token>
Content-Type: application/json

{ "pairing_code": "TVXK-7P29" }
```

```json
{ "request_id": "9b8c7d6e...", "status": "denied" }
```

**Step 4 — Subscriber polls and claims the handle once.** Poll at
`poll_interval_ms` (2500 ms). This endpoint is a **no-oracle** poll: an absent
request and a request that belongs to another subscriber return the same
`FABRIC_REQUEST_NOT_FOUND`.

```
GET /api/fabric/requests/{request_id}
Authorization: Bearer <developer-principal-token>
```

While pending:

```json
{ "request_id": "9b8c7d6e...", "status": "pending" }
```

On approval — **the handle is returned exactly once**, then the request flips to
`claimed` and the parked handle is cleared:

```json
{
  "request_id": "9b8c7d6e...",
  "status": "approved",
  "handle": "HFG:eyJjIjpmYWxzZSwiZXhwIjoxN...Q.9a1b2c3d4e5f...",
  "grant_id": "3f9c1a2b4d5e6f7a8b9c0d1e2f3a4b5c"
}
```

Terminal statuses a poll may report: `denied`, `expired`, `claimed`. After the
single claim, the subscriber holds the handle and every subsequent read flows
through the receipted `/api/fabric/read` path in §4a.

---

## 5. Scopes reference

Scopes are the vocabulary of consent. The server binds each scope to specific
PWM dot-paths through a **fail-closed** registry: a scope with no binding
releases nothing and is reported in `unmapped_scopes`. The public scope
catalogue is published at `/pchp/scopes.json`; the field bindings below are the
server-side authority.

| Scope | Releases (PWM fields) | What it is for |
|---|---|---|
| `wants.money.advisor` | `connect.want`, `connect.zip` | The person's stated want + ZIP, so a subscriber can make a local match — and nothing else. |
| `wants.financial-services` | `connect.want`, `connect.zip` | Same want + ZIP, for financial-services matching. |
| `privacy.marketing-email` | `privacy.marketing-email` | Permission to send marketing email. |
| `privacy.marketing-sms` | `privacy.marketing-sms` | Permission to send marketing SMS. |
| `privacy.analytics` | `privacy.analytics` | Permission for analytics storage. |
| `privacy.personalization` | `privacy.personalization` | Permission for personalization storage. |
| `privacy.ads` | `privacy.ads` | Permission for advertising storage, ad user data, and ad personalization. |
| `privacy.data-sale` | `privacy.data-sale` | The person's permission to sell/share (CCPA/CPRA). Its inverse drives the GPC signal. |

Each `privacy.*` scope authorizes exactly its own boolean preference — the
"wedge stream" that replaces the cookie banner (see §7). Bindings grow as the
PWM schema grows; a new PWM section becomes subscribable only when its binding is
added here.

---

## 6. Receipts & verification

Every GRANT, READ, and REVOKE writes one receipt to the owner's append-only,
hash-chained ledger. The owner (and only the owner) can read and verify it.

**Receipt shape** (as returned in listings):

```json
{
  "seq": 8,
  "event_type": "READ",
  "subscriber_id": "agent_northwind_advisors",
  "grant_id": "3f9c1a2b...",
  "scopes": ["wants.money.advisor"],
  "fields": ["connect.want", "connect.zip"],
  "purpose": "Match you with a local fiduciary advisor",
  "prev_hash": "c2d4e6f8...",
  "hash": "d3e5f7a9...",
  "signature": "8a4b0c2d...",
  "metadata": {},
  "created_at_ms": 1791072300000
}
```

**List the ledger:**

```
GET /api/fabric/receipts?limit=200
Authorization: Bearer <firebase-id-token>
```

```json
{ "receipts": [ { "seq": 1, "event_type": "GRANT", "...": "..." } ], "count": 12 }
```

Receipts are returned in ascending `seq` order. `limit` defaults to 200 and is
clamped to 1000.

**Verify the chain:**

```
GET /api/fabric/receipts/verify
Authorization: Bearer <firebase-id-token>
```

On success:

```json
{ "ok": true, "count": 12, "head_seq": 12, "head_hash": "e4f6a8b0..." }
```

Verification recomputes every link and signature and enforces two whole-chain
invariants a naive `prev_hash` walk would miss:

1. **Gap-free sequence.** `seq` must run `1..N` with no gaps. A missing row is
   reported explicitly (`reason: "sequence_gap"`) rather than inferred.
2. **Head anchoring (optional, tamper-detection).** A `prev_hash` walk cannot
   detect *tail-truncation* or a *full wipe* — dropping the newest receipts (or
   all of them) leaves the remaining rows linking perfectly. Pin the head you
   last saw and pass it back:

```
GET /api/fabric/receipts/verify?expected_head_seq=12&expected_head_hash=e4f6a8b0...
Authorization: Bearer <firebase-id-token>
```

If the current head has regressed below or diverged from the pin, verification
fails closed:

```json
{ "ok": false, "broken_at_seq": 9, "reason": "head_regressed", "head_seq": 9, "head_hash": "…", "expected_head_seq": 12 }
```

**How to use head pinning (trust-on-first-use):** on your first verify, store
the returned `head_seq` and `head_hash`. On each later verify, pass them back.
The head only ever moves forward; any regression or divergence means the ledger
was truncated or altered. Failure `reason` values you may see: `sequence_gap`,
`prev_hash_mismatch`, `hash_mismatch`, `signature_mismatch`, `head_regressed`,
`head_diverged`.

---

## 7. Privacy signals — the cookie-banner replacement

When a read includes any granted `privacy.*` field, the response carries a
`privacy_signals` block: the person's published privacy preferences, already
projected into the signals brands run today. Honoring "ask my agent" becomes one
call on the brand side.

```json
"privacy_signals": {
  "consent_mode_v2": {
    "analytics_storage": "granted",
    "ad_storage": "denied",
    "ad_user_data": "denied",
    "ad_personalization": "denied",
    "personalization_storage": "granted",
    "functionality_storage": "granted",
    "security_storage": "granted"
  },
  "gpc_opt_out": true,
  "channels": { "email": true, "sms": false }
}
```

Apply Google Consent Mode v2 directly:

```js
gtag("consent", "update", response.privacy_signals.consent_mode_v2);
```

How to read each part:

- **`consent_mode_v2`** — Google Consent Mode v2 keys. `ad_storage`,
  `ad_user_data`, and `ad_personalization` all follow `privacy.ads`;
  `analytics_storage` follows `privacy.analytics`; `personalization_storage`
  follows `privacy.personalization`. `functionality_storage` and
  `security_storage` (strictly-necessary) are always `granted`.
- **`gpc_opt_out`** — the Global Privacy Control signal. It is the **inverse** of
  `privacy.data-sale`: if the person did not grant permission to sell/share,
  `gpc_opt_out` is `true` (opted out).
- **`channels`** — direct-marketing permissions for `email` and `sms`.

Everything is **fail-closed**: a preference that is absent, ungranted, or not a
literal boolean `true` projects as denied / opted-out — never as granted.

---

## 8. Rate limits & error codes

### Per-route rate limits

Limits are per principal (per authenticated user or subscriber). Owner reads are
cheap and generous; subscriber reads and owner writes are bounded so no caller
can drain data or flood the ledger.

| Route | Limit | Bucket |
|---|---|---|
| `POST /api/fabric/read` | `60/minute` | `FABRIC_READ` |
| `GET /api/fabric/requests/{id}` (poll) | `60/minute` | `FABRIC_READ` |
| `POST /api/fabric/grants` | `20/minute` | `FABRIC_GRANT_WRITE` |
| `POST /api/fabric/grants/{id}/revoke` | `20/minute` | `FABRIC_GRANT_WRITE` |
| `POST /api/fabric/requests` | `20/minute` | `FABRIC_GRANT_WRITE` |
| `POST /api/fabric/requests/{id}/approve` | `20/minute` | `FABRIC_GRANT_WRITE` |
| `POST /api/fabric/requests/{id}/deny` | `20/minute` | `FABRIC_GRANT_WRITE` |
| `GET /api/fabric/grants` | `60/minute` | `FABRIC_OWNER_READ` |
| `GET /api/fabric/receipts` | `60/minute` | `FABRIC_OWNER_READ` |
| `GET /api/fabric/receipts/verify` | `60/minute` | `FABRIC_OWNER_READ` |
| `GET /api/fabric/requests/code/{code}` | `20/minute` | `FABRIC_REQUEST_LOOKUP` |
| `GET /api/pwm` | `60/minute` | `PWM_READ` |
| `PUT / DELETE /api/pwm` | `30/minute` | `PWM_WRITE` |

Exceeding a limit returns `429`. There is also a backstop of **100 pending
requests per subscriber** on the handshake: opening beyond that returns
`FABRIC_REQUESTS_RATE_LIMITED` (429).

### Error codes

Errors return an HTTP status and a body of the form
`{ "detail": { "code": "...", "message": "..." } }`.

**The read path has no oracle.** Every handle/grant authorization failure on
`POST /api/fabric/read` — forged handle, expired handle, wrong subscriber,
missing grant, revoked grant — collapses to a **single** generic response so the
endpoint cannot be used to probe what exists:

```
403  { "code": "FABRIC_READ_DENIED", "message": "Read denied." }
```

The specific reason is logged server-side for the owner's audit trail only,
never returned to the caller.

| Code | Status | Where | Meaning |
|---|---|---|---|
| `FABRIC_READ_DENIED` | 403 | read | Generic denial (handle invalid/expired, subscriber mismatch, grant missing/revoked). No oracle. |
| `FABRIC_SUBSCRIBER_UNIDENTIFIED` | 403 | read, requests, poll | Developer principal has no `agent_id`. |
| `FABRIC_SUBSCRIBER_REQUIRED` | 422 | grants | `subscriber_id` missing. |
| `FABRIC_SCOPES_REQUIRED` | 422 | grants, requests | No valid scope supplied. |
| `FABRIC_PURPOSE_REQUIRED` | 422 | grants, requests | Purpose missing. |
| `FABRIC_PRICE_INVALID` | 422 | grants, requests | Priced without a non-negative `price_cents` and a `currency`. |
| `FABRIC_GRANT_NOT_FOUND` | 404 | revoke | No such grant for this owner. |
| `FABRIC_REQUEST_NOT_FOUND` | 404 | lookup, approve, deny, poll | Request absent — or, on poll, belongs to another subscriber (no oracle). |
| `FABRIC_REQUEST_NOT_PENDING` | 410 / 409 | lookup, approve, deny | Request already resolved. `410` when expired, `409` otherwise. |
| `FABRIC_CODE_MISMATCH` | 403 | approve, deny | Pairing code does not match the request. |
| `FABRIC_REQUESTS_RATE_LIMITED` | 429 | requests | Too many pending requests for this subscriber. |
| `FABRIC_CODE_MINT_FAILED` | 500 | requests | Could not mint a unique pairing code (rare). |
| `PWM_NOT_FOUND` | 404 | `GET /api/pwm` | No world model for this user yet. |
| `PWM_BODY_INVALID` | 422 | `PUT /api/pwm` | Body is not a JSON object. |
| `PWM_BODY_TOO_LARGE` / `PWM_DOC_TOO_LARGE` | 413 | `PUT /api/pwm` | Document exceeds size limits. |

---

## 9. For AI agents

If you are an autonomous 🤫 Agent acting for a consenting human, the Gateway is
built for you. Consent stays with your human at every step; you carry it out.

**As the seeker's agent (completing a handshake for your human):**

1. **Watch for the knock.** A subscriber surfaces a pairing code (on a page, in a
   message, at a counter). Capture it.
2. **Look it up.** Call `GET /api/fabric/requests/code/{code}` with your human's
   Firebase token. Read back `subscriber_label`, `scopes`, `fields`, `purpose`,
   `ttl_ms`, and any price. **Show your human exactly who is asking, for what,
   why, how long, and at what cost.**
3. **Get explicit approval.** Do not decide for them. On a clear yes, call
   `POST /api/fabric/requests/{id}/approve` with the `pairing_code`. On no, call
   `.../deny`. The grant is minted under their verified identity, with a receipt.
4. **Keep the receipt.** The approval response carries the GRANT receipt. Pin the
   ledger head (`GET /api/fabric/receipts/verify`) so your human can later prove
   exactly what was shared and when — and revoke any grant with
   `POST /api/fabric/grants/{id}/revoke` at any time, fail-closed.

**As the subscriber's agent (asking on behalf of a brand or professional):**

1. Open a request: `POST /api/fabric/requests` with the minimum scopes and an
   honest purpose. Show the returned `pairing_code`.
2. Poll `GET /api/fabric/requests/{id}` at `poll_interval_ms`. Claim the handle
   the one time it is returned.
3. Read only when you need to, via `POST /api/fabric/read`. Every read is
   receipted; request the least, and expect denials to be opaque by design.

**Least privilege is the etiquette.** Ask for the fewest scopes that do the job,
state a truthful purpose, set a sensible `ttl_ms`, and expect revocation to take
effect immediately.

**Direction of travel — interop rails.** The Permission Gateway is HTTP-native
today and can be driven end to end with the calls above. Our platform speaks the
open agent and interoperability rails — **MCP, A2A, ADK, AP2, and UCP** — and the
direction of travel is to expose the Gateway's discover → handshake → grant →
read → verify loop natively over them, so a consenting person's 🤫 Agent One and
a subscriber's 🤫 Agent can complete the whole exchange agent-to-agent, with a
signed receipt for every access and control always in the person's hands.

---

_Preference Subscription Fabric — PCHP RFC-002. Consent-first. Built to NIST
800-53 High controls; certifications in pursuit. Own your data; the world
subscribes to you._
