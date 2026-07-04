# One + Location — SOS Panic feature — Design Spec

**Date:** 2026-07-03
**Branch:** `feat/one-location-sos-panic` (cut from `origin/main`, maintainer lane)
**Status:** Approved design → ready for implementation plan

## Goal

Ship the **SOS panic** action in the One app's Location section. One tap (guarded by a
short countdown) alerts **all** trusted contacts and starts a real, encrypted
**live-location** share to each of them — reusing the live-share pipeline that already
exists. Because a fresh user has no one to alert, add a **login-time seed** that links
the user to a small, configured set of real developer accounts so SOS works end-to-end.

Of the six Location "Quick Actions" (Check-In, SOS, Drive To, Pick Me Up, Meeting, Safe
Arrival), **only SOS is built now**; the rest remain future work.

## Visual Map

```text
SEED (post vault-unlock)   PostUnlockSyncService → POST /api/one/location/seed-trusted
  → if user has 0 active connections, link them to SOS_SEED_DEV_USER_IDS
    via one_location_network_connections (→ they become share recipients)

PANIC (Location · Now tab · SosPanel)
  TAP TO PANIC → 3–5s countdown (Cancel) → for each share-ready trusted contact:
    createGrant(8h, reason:"sos_panic") → grant + FCM/in-app notify + audit
    existing watch loop streams encrypted envelopes; record grant ids (localStorage)
  LIVE LOCATION ACTIVE banner → "I'm safe" revokes the incident grants (8h TTL backstop)
```

## Guiding principle: reuse, don't rebuild

Live-location sharing **already works** end-to-end via `OneLocationAgentService`. SOS is
an **orchestration of existing primitives**, not new delivery. Ground truth:

- **A live share = a grant + envelopes.** `create_grant` inserts one row into
  `one_location_share_grants` (status `active`, `expires_at`, capability token in a JSON
  `metadata` field), automatically fires an FCM push + in-app notification, and writes a
  `location_share_created` audit row. Position data is separate: `store_encrypted_envelope`
  inserts ciphertext-only rows into `one_location_envelopes` (coordinates exist **only**
  inside the ciphertext) and bumps the grant's `latest_envelope_id`.
- **Live tracking = repeated envelope re-stores.** The browser's `watchCurrentPosition`
  → `publishMovement` loop re-encrypts and re-stores an envelope per recipient on each GPS
  fix; the recipient polls `view_latest_envelope` and decrypts locally. There is **no**
  live-session table.
- **Audit lives in `one_location_events`** (migration `061`), written by `_insert_event`.
  The `kai_location_*` tables (migration `060`) are **legacy/dead** — nothing writes to
  them except account-deletion cleanup. Do **not** touch them.
- **"Share with everyone" is a client-side loop** over recipients calling
  `createGrant` + `publishEnvelope` per recipient (`handleShare` in `page.tsx`). There is
  **no batch endpoint**; SOS uses the same loop.
- **Stop = revoke.** `revoke_grant` flips the grant to `revoked`, notifies the recipient,
  and subsequent envelope stores/views fail — the live loop halts. The client also tears
  down the GPS watch via `clearLocationWatch`.
- **Trusted recipients** come from `list_verified_recipients` — eligible if they have an
  active `one_location_network_connections` row with the user (rule #1), are phone-verified,
  or share an approved advisor relationship. There is no dedicated "trusted contact" table.

Consequence: **no new tables, no new migration, no new delivery code.** SOS reuses
`create_grant` / `store_encrypted_envelope` / `revoke_grant` / `watchCurrentPosition`
unchanged, tagging its grants so they can be found and stopped as a group.

## Locked decisions

| Decision | Choice |
|---|---|
| Panic scope | **Full real delivery** — real grants + encrypted envelopes + notifications + audit |
| Recipients | **All** trusted contacts always (per-contact toggles are display-only for now) |
| Activation | **Tap → 3–5s countdown with a large Cancel**, then fires |
| Live share ends | User taps **"I'm safe / Stop sharing"**, with a safety **8h** auto-expiry cap |
| Login seed | Create real `one_location_network_connections` to a **configured list of 3–4 dev user IDs**, only when the user has none |
| SOS grant identity | Pass `reason:'sos_panic'` (backend writes it to grant `metadata`); active incident tracked client-side in localStorage |
| Seed idempotency | "Zero active connections" check only — **no tracking table** |
| Branch | `feat/one-location-sos-panic` from `origin/main` |

## Architecture

### Component 1 — Login seed (`SosContactsSeedService`)

- **Purpose:** guarantee a fresh user has trusted recipients so SOS is never empty.
- **Trigger:** extend the existing `PostAuthOnboardingSyncBridge` →
  `PostUnlockSyncService.run({ userId, vaultKey, vaultOwnerToken })`, which fires once after
  vault unlock. Add a seed step there.
- **Behavior:** if the user has **zero active `one_location_network_connections`**, call a
  new backend endpoint that inserts active mutual-connection rows linking the user to each
  configured dev user ID. This makes those accounts appear via `list_verified_recipients`
  (rule #1) and makes `create_grant` to them permitted.
- **Config:** dev IDs read from backend config (env var, e.g. `SOS_SEED_DEV_USER_IDS`,
  comma-separated) — the list changes without a code edit.
- **Endpoint:** `POST /api/one/location/seed-trusted` (gated by `require_vault_owner_token`),
  idempotent; re-runs when connections already exist are no-ops.
- **Key-bootstrap safety (no silent half-works):** a recipient can only *receive* an
  encrypted envelope if it has published a location key (active `one_location_recipient_keys`
  row) and is phone-verified — otherwise `create_grant` returns 409. The seed inserts
  connections for **all** configured dev IDs (so they self-heal once keys are published), and
  the **panic action only alerts share-ready recipients** (`canReceiveLocation === true`),
  surfacing any skipped-but-not-ready contacts in a toast ("Alerted N of M; X not ready")
  rather than failing silently. The "WHO GETS ALERTED?" list marks not-ready contacts.
  - **Prerequisite:** the 3–4 dev accounts you supply must be **phone-verified** and have
    **opened One Location at least once** (to publish their location keys). Not-yet-ready
    accounts appear in the list but aren't alerted until ready.

### Component 2 — SOS panel UI (`sos-panel.tsx`)

- **Location:** new `hushh-webapp/components/one-location/redesign/sos-panel.tsx`, rendered
  in the **`Now` tab** of `location-redesign-hub.tsx`, fed via new `LocationHubViewModel`
  fields assembled in `app/one/location/page.tsx`.
- **Sections (mirroring the mockup):**
  - **EMERGENCY ALERT** — a large panic button using the `destructive`/red design token
    (never the legacy gold `#b8894d`/`#d4a574`).
  - **WHO GETS ALERTED?** — the trusted recipient list (from `recipients`); per-contact
    toggles rendered read-only for now (all are always alerted).
  - **LIVE LOCATION ACTIVE** — a banner shown while the tracked SOS incident is active,
    with the **"I'm safe / Stop sharing"** control.
- **Design system:** `destructive` / critical tokens for the panic + stop affordances.

### Component 3 — Panic activation flow (client orchestration)

1. Tap → a **countdown overlay (3–5s)** with a large **Cancel**. Cancelling aborts with no
   side effects.
2. On expiry:
   a. Fetch trusted recipients (`GET /api/one/location/recipients`).
   b. **Loop** `createGrant({ recipientUserId, recipientKeyId, durationHours: 8, reason: 'sos_panic' })`
      per share-ready recipient (reusing the existing per-recipient loop + `ensureForegroundLocationReady`).
      Notifications + audit fire automatically inside `create_grant`. Record the created grant
      ids as the active SOS incident (localStorage).
   c. The existing `watchCurrentPosition` → `publishMovement` effect (keyed on
      `activeOwnerGrants`) auto-starts once the SOS grants land, re-storing encrypted
      envelopes on each GPS fix — no new live-loop code.
- Coordinate-free/encrypted-at-rest invariants are already enforced by the reused paths.

### Component 4 — "I'm safe" / stop

- The stop control revokes **only the incident's grants** (the ids recorded in localStorage),
  calling `revokeGrant` per grant (→ flips status, notifies recipients), then clears the
  incident. The GPS watch tears itself down when no active owner grants remain
  (`clearLocationWatch`, existing effect cleanup). Non-SOS shares are untouched.
- The 8h grant TTL is the backstop: even if the user never taps stop, sharing auto-expires.

## Backend touches (minimal)

- **New:** `POST /api/one/location/seed-trusted` route + `SosContactsSeedService` logic
  (insert `one_location_network_connections` for all configured dev IDs, gated on the user
  having zero active connections; env-var config).
- **Reused:** `create_grant`, `revoke_grant`, `store_encrypted_envelope`,
  `list_verified_recipients`, `view_latest_envelope`. Backend `create_grant` **already**
  accepts `reason` and writes it to the grant's `metadata` JSONB — no backend signature
  change. The only frontend adjustment is adding `reason` to `OneLocationService.createGrant`
  (it currently drops it) so SOS grants are tagged `reason:'sos_panic'`.
- **No new tables, no new migration.**

## Data flow

```text
LOGIN (post vault-unlock)
  PostAuthOnboardingSyncBridge → PostUnlockSyncService
    → SosContactsSeedService: if 0 active connections →
        POST /api/one/location/seed-trusted
          → insert one_location_network_connections to each configured dev ID
            (idempotent ON CONFLICT; only when user has 0 active connections)

PANIC
  tap → 3–5s countdown (Cancel) → on expiry:
    GET /api/one/location/recipients        (trusted list)
    for each share-ready recipient:
      createGrant(durationHours=8, reason='sos_panic')       → one_location_share_grants
                                                              → FCM + in-app notify
                                                              → one_location_events (created)
    watchCurrentPosition → publishMovement (per GPS fix):
      storeEnvelope per SOS grant           → one_location_envelopes (+ latest_envelope_id)
                                            → one_location_events (envelope_updated)

STOP ("I'm safe")
  for each grant id in the tracked SOS incident:
    revokeGrant                             → one_location_share_grants (status=revoked)
                                            → notify recipient
                                            → one_location_events (revoked)
  clearLocationWatch                        (GPS watch torn down client-side)
  (8h TTL auto-expires grants as a backstop)
```

## Invariants (inherited from the existing pipeline)

- **Coordinate-free:** no `latitude`/`longitude`/coordinate keys in grant metadata, events,
  notifications, or any non-ciphertext field. Enforced by the reused paths.
- **Encrypted at rest:** position data exists only inside `one_location_envelopes.ciphertext`.
- **Palette:** SOS UI uses the purpose-built **`destructive` / critical** tokens
  (`variant="destructive"`, `.app-critical-*`) — the correct high-severity treatment for a
  panic button. Note: `verify:design-system` does **not** forbid the legacy tan hexes
  (`#d4a574` is the current de-facto brand accent), so avoiding raw hexes in new SOS code is
  a self-imposed cleanliness convention, not a CI-enforced gate.
- **Backward compatible:** all new fields (`createGrant.reason`, new seed endpoint) are additive and
  optional; existing share/chat flows are untouched.

## Testing & verification

- TDD, task-by-task, following the structure of
  `docs/superpowers/plans/2026-07-03-one-location-chat-ui-consistency.md` (failing test
  first, per-task commits with `-s`).
- Tri-flow (`new-feature-tri-flow`) verification bundle:
  `npm run verify:service-boundary`, `npm run typecheck`, `npm run verify:routes`,
  `npm run verify:design-system`, `./bin/hushh protocol test-ci`, plus native iOS/Android UAT.
- Manual smoke: seed a fresh user → SOS panel lists dev contacts → tap → countdown → cancel
  (no side effects); tap → fires → recipients notified + live share active; "I'm safe" →
  grants revoked + watch stopped; verify 8h expiry backstop; confirm no coordinates leak in
  events/notifications.

## Out of scope (future)

- The other five Quick Actions (Check-In, Drive To, Pick Me Up, Meeting, Safe Arrival).
- Real end-user connection/invite UX (the seed is the interim stand-in).
- Making per-contact "WHO GETS ALERTED?" toggles functional (currently display-only).
- Any migration off, or reuse of, the legacy `kai_location_*` tables.
