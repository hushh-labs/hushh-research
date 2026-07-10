# Scope One Location recipients to the Connections graph

**Date:** 2026-07-10
**Branch:** `feat/connections-location-mapping-ui`
**Status:** Approved (design)

## Summary

Today the One Location "Ready people" list and all five quick actions (drive-to,
pick-me-up, safe-arrival, check-in, SOS) draw their recipients from a **broad
verified-actor directory**. We are narrowing that source to the user's **accepted
connections only** (the two-way `connections` graph), and adding an empty-state
prompt that guides users with no connections to build their trusted circle.

This is a **strict** scoping change: you can only share your location with people
you are connected to.

## Motivation

- The "Ready to share people" subsection currently lists essentially the whole
  verified Hushh One directory, which is too broad for a private location-sharing
  feature.
- Recipients should be the people the user has explicitly, mutually connected with
  — the `connections` graph — not the wider directory, and not the legacy
  `trusted_connections` graph.
- All quick-action recipient pickers should share this same connection-scoped list.

## Current state (as-is)

### Data / backend
- `consent-protocol/db/migrations/086_connections.sql` — the two-way connection
  graph: `connection_requests` (directional handshake) and `connections` (the
  accepted mutual edge, canonicalized `CHECK (user_a_id < user_b_id)`,
  `status IN ('active','revoked')`).
- `consent-protocol/hushh_mcp/services/one_location_agent_service.py`
  - `list_verified_recipients(owner_user_id)` (~lines 2423–2498): eligibility SQL
    selecting from `actor_identity_cache` where **any** of three OR-branches hold —
    (1) an active `trusted_connections` edge, (2) `phone_verified = TRUE` (minus
    marketplace-hidden), or (3) an approved `advisor_investor_relationships` edge.
    A LATERAL join to `one_location_recipient_keys` computes `canReceiveLocation`.
  - `_recipient_payload` (~lines 663–679): builds each recipient object.
  - State endpoint (~line 3598, 3743): `recipients = list_verified_recipients(...)`
    included in the `/api/one/location/state` payload as `state.recipients`.
- Accepting a connection mirrors two directional `trusted_connections` edges
  (`source='connection'`) via `connections_service.accept_request`. SOS/network
  payloads (`_trusted_connection_as_network_payload`) still read `trusted_connections`.

### Frontend
- `hushh-webapp/lib/one-location/service.ts:162` — `getState()` → `GET /api/one/location/state`.
- `hushh-webapp/lib/one-location/types.ts:31-53` — `OneLocationRecipient` shape
  (`userId`, `displayName`, `maskedPhone`, `phoneVerified`, `keyId`, `publicKeyJwk`,
  `keyAlgorithm`, `keyRegisteredAt`, `canReceiveLocation`, + ranking fields).
- `hushh-webapp/app/one/location/page.tsx`
  - `state.recipients` → `visibleRecipients` (ranked/enriched, ~1897–1923).
  - `sosActionRecipients` (~2020–2023): prefers `sosTrustedRecipients` (derived from
    `state.networkConnections` via `selectSosConnectedRecipients`), else falls back to
    share-ready ranked recipients. Exposed as `vm.sosRecipients`.
- `hushh-webapp/components/one-location/redesign/location-redesign-hub.tsx`
  - `PeopleHub` (~767): "Ready people" `SectionCard` (~816) over `visibleRecipients`.
  - Quick-action flows (`drive-to-flow.tsx:56`, `pick-me-up-flow.tsx:190`,
    `safe-arrival-flow.tsx:146`, `check-in-flow.tsx:146`, `sos-panel.tsx`) all read
    `vm.sosRecipients`; no flow fetches its own list.
- `hushh-webapp/lib/services/connections-service.ts:71-78` — `listConnections()` →
  `GET /api/one/connections` → `ConnectionSummaryEntry[]`
  (`connectionId`, `userId`, `displayName?`, `photoUrl?`, `createdAt?`).

## Chosen approach

Swap the recipient source at a **single backend seam** —
`list_verified_recipients` — so it sources from `connections` instead of the broad
directory. This keeps the `OneLocationRecipient` shape identical (no frontend type
changes), preserves the recipient-key and identity-cache joins, and makes both the
People tab and quick actions change from one place.

**Rejected alternative:** fetch `ConnectionsService.listConnections()` on the
frontend and merge into recipients. This would duplicate the encryption-key /
eligibility logic and drift from the state payload. Not chosen.

## Design

### 1. Backend — recipient eligibility (`one_location_agent_service.py`)

Rewrite the eligibility body of `list_verified_recipients` to select the **other
party of every active `connections` row** for the owner:

- Source rows: `connections` where `status = 'active'` AND
  (`user_a_id = :owner` OR `user_b_id = :owner`); the recipient is the *other*
  column.
- Preserve the existing join to `actor_identity_cache` for `displayName`,
  `photoUrl`/masked phone, `phone_verified`.
- Preserve the existing LATERAL join to active `one_location_recipient_keys` for
  `keyId`/`publicKeyJwk`/`keyAlgorithm`/`keyRegisteredAt` → `canReceiveLocation`.
- Output continues through `_recipient_payload`, so the shape is unchanged.

**Consequences (intended):**
- Phone-verified-only users and marketplace advisor/investor relationships no longer
  appear as location recipients unless they are also a connection.
- A connection who has not registered a recipient key still appears but with
  `canReceiveLocation = false` (so they are listed but not "share ready" — same as
  today's behavior for keyless recipients).

### 2. Backend — share-grant guard (defense-in-depth)

On the share-grant creation path, reject a target `userId` that is not an active
connection of the owner. This enforces the strict rule even if a stale client posts
an old recipient id. Return a clear error (e.g. 403 / "not a connection").

**Not changed:** existing active share grants to non-connections are left untouched.
This change governs who you can *newly* pick, not who is *currently* sharing.

### 3. Frontend — quick-actions basis (`page.tsx`)

Simplify `sosActionRecipients` to drop the `sosTrustedRecipients` /
`state.networkConnections` preference branch. Since every recipient is now a
connection, all five quick actions use the same connection-sourced ranked list
directly. This satisfies "quick actions should use the same connections, not the
trusted connections."

### 4. Frontend — empty state + copy (`location-redesign-hub.tsx`)

- In `PeopleHub` "Ready people" and in each quick-action recipient list, when the
  connection-sourced list is empty, render an empty-state card:
  **"Add connections to start building your trusted circle"** with a button linking
  to `/connect`.
- Update the "Ready people" section copy to reflect that these are the user's
  connections (rather than the generic "approved, ready people" wording).

### 5. Trusted-graph mirror (unchanged)

The `connections → trusted_connections` mirror on accept stays in place. With
recipients now sourced directly from `connections`, the mirror becomes a
ranking/legacy signal that SOS/network payloads still consume. Leaving it avoids
breaking SOS in this branch.

## Testing

**Backend**
- `list_verified_recipients` returns a recipient only when an active `connections`
  edge exists; the recipient disappears when the connection is revoked.
- A connection without a recipient key appears with `canReceiveLocation = false`.
- Share-grant creation is rejected for a non-connection `userId`; accepted for a
  connection.

**Frontend**
- "Ready people" and quick-action lists render the empty-state card with a working
  `/connect` CTA when there are zero connections.
- With ≥1 connection, recipients render and quick actions use the same list.

## Out of scope (follow-up)

- "Connection addons" (deferred by decision).
- Ripping out or repurposing the `trusted_connections` mirror.
- Migrating/revoking existing non-connection share grants.
- A dedicated "friends on a map" marker view (not requested for this branch).

## Files likely touched

- `consent-protocol/hushh_mcp/services/one_location_agent_service.py`
  (`list_verified_recipients`, share-grant guard)
- `consent-protocol/tests/` — One Location recipient + guard tests
- `hushh-webapp/app/one/location/page.tsx` (`sosActionRecipients`)
- `hushh-webapp/components/one-location/redesign/location-redesign-hub.tsx`
  (empty state + copy)
- Possibly the quick-action flow components for empty-state rendering
