# Runtime Surface


## Visual Map

```mermaid
flowchart TD
  persona["Persona"]
  routes["Investor / RIA / Marketplace routes"]
  apis["/api/iam /api/ria /api/consent"]
  tables["actor_profiles / relationships / share grants"]
  persona --> routes --> apis --> tables
```

## Purpose

Describe the current implemented Investor + RIA runtime surface (backend + web + MCP).

Founder-language note:

- this file documents the runtime side of `Separation of Duties`
- `Capability Tokens` remain explicit as route-level requirements because the reader needs exact runtime labels
- `TrustLink / A2A delegation` should be understood through [Agent Delegation Boundary](./agent-delegation-boundary.md): delegated proof and scoped access share the same IAM model, not a second authority system

## Runtime Contract

| Variable | Layer | Role |
| --- | --- | --- |
| `ENVIRONMENT` | backend | Canonical runtime environment identity (`development`, `uat`, `production`) |
| `NEXT_PUBLIC_APP_ENV` | frontend | Canonical client environment identity (`development`, `uat`, `production`) |

Compatibility fallback (temporary): frontend still accepts `NEXT_PUBLIC_OBSERVABILITY_ENV` and `NEXT_PUBLIC_ENVIRONMENT_MODE` if `NEXT_PUBLIC_APP_ENV` is unset.

## IAM Schema Compatibility Mode

1. IAM activation is migration-gated, not startup-mutated.
2. Run explicit commands:
   `python db/migrate.py --iam`
   `python db/verify/verify_iam_schema.py`
3. If IAM schema is missing:
4. `GET /api/iam/persona` returns `200` investor-safe payload with:
   `iam_schema_ready=false`, `mode="compat_investor"`.
5. `POST /api/iam/persona/switch` allows `investor` and returns `503 IAM_SCHEMA_NOT_READY` for `ria`.
6. `/api/ria/*` and `/api/marketplace/*` return `503` with code `IAM_SCHEMA_NOT_READY`.

## Route Families

1. Investor routes remain under existing `/kai/*`, `/one/consent`, `/one/profile`.
2. RIA routes:
   1. `/ria/onboarding`
   2. `/ria/clients`
   3. `/ria/workspace?clientId=<investor_user_id>`
3. Compatibility aliases:
   1. `/ria/requests` -> `/one/consent?actor=ria&view=outgoing`
   2. `/ria/settings` -> `/one/profile?section=ria`
4. Marketplace route: `/marketplace`.

## Backend API Surface

### IAM

1. `GET /api/iam/persona`
2. `POST /api/iam/persona/switch`
3. `POST /api/iam/marketplace/opt-in`

### RIA

1. `POST /api/ria/onboarding/submit`
2. `GET /api/ria/onboarding/status`
3. `GET /api/ria/firms`
4. `GET /api/ria/clients`
5. `GET /api/ria/requests` (compatibility alias)
6. `POST /api/ria/requests` (compatibility alias)
7. `GET /api/ria/clients/{investor_user_id}`
8. `GET /api/ria/workspace/{investor_user_id}`
9. `GET /api/ria/invites`
10. `POST /api/ria/invites`

### Consent Center

1. `GET /api/consent/center` (compatibility read model)
2. `GET /api/consent/center/summary`
3. `GET /api/consent/center/list`
4. `GET /api/consent/requests/outgoing`
5. `POST /api/consent/requests`

Consent-center and scope-discovery payloads may include scope display metadata for user-facing presentation:

1. `scopeLabel`
2. `scopeDescription`
3. `scopeIconName`
4. `scopeColorHex`

These fields are presentation metadata only. Authorization still evaluates the canonical scope string.

Consent-manager surface rules:

1. `/one/consent` is the One user access manager for incoming user-owned consent state.
2. `actor` is compatibility routing metadata, not One page identity. Missing actor, `actor=one`, and legacy `actor=investor` resolve to the same One consent lane.
3. RIA advisor workflows must opt in explicitly with `actor=ria&view=outgoing`; `/ria/requests` remains the compatibility launcher for that path.
4. The canonical page flow is `summary + one paginated list surface + detail panel`.
5. Normal `/one/consent` tabs use `GET /api/consent/center/summary` and `GET /api/consent/center/list`. `GET /api/consent/center` is reserved for compatibility and the relationships surface until that surface is paginated.
6. `/one/consent` keeps the canonical consent-manager URL, but the shared shell treats it as the `Profile > Privacy` workspace for breadcrumbs and bottom-nav context.
7. The mounted top app bar links to the Consent Center; it does not mount a Shield inbox or first-five preview. Consent pending counts remain sourced from the manager summary and notification/resource owners, not a top-bar popup.
8. Internal consent-review links must stay on SPA-native app routing; full document redirects are reserved for true external URLs only.
9. Long consent lists must use backend-backed pagination metadata and must not rely on a load-all-then-slice page contract.
10. Investor consent reads expand the authenticated Firebase UID to the account-owned identifier set before filtering `consent_audit`: Firebase UID, verified Firebase-auth email/phone, and verified non-revoked email aliases including Apple relay emails.
11. Pending approve/deny/cancel and active revoke actions resolve through the same owned identifier set, then write terminal audit rows against the matched request or token subject id.
12. History rows are identifier-grouped for the One user lane: requester/system/advisor identity plus subject user id appears once, with scope/request chains exposed as nested activity trails ordered by event time.

### Marketplace

1. `GET /api/marketplace/rias`
2. `GET /api/marketplace/investors`
3. `GET /api/marketplace/ria/{ria_id}`

## IAM Data Tables

1. `actor_profiles`
2. `ria_profiles`
3. `ria_firms`
4. `ria_firm_memberships`
5. `ria_verification_events`
6. `advisor_investor_relationships`
7. `ria_client_invites`
8. `consent_scope_templates`
9. `relationship_share_grants`
10. `relationship_share_events`
11. `connection_scope_proposals`
12. `connection_scope_proposal_events`
13. `marketplace_public_profiles`
14. `runtime_persona_state` (transitional compatibility only)

## Persona State Ownership

1. `actor_profiles.last_active_persona` is the canonical persisted persona state.
2. `runtime_persona_state` is used only for transitional setup continuity before an account fully earns the `ria` persona.
3. Full-mode persona responses must prefer `actor_profiles` and never let runtime state override a real dual-persona account.

## Consent Integration

1. RIA requests for investor information write `REQUESTED` rows into `consent_audit` with actor metadata. They are independent of connection capabilities.
2. A generic `attr.*` consent decision never activates an advisor relationship or an advisor-picks source.
3. A connection can be accepted with zero scopes. `connection_scope_proposals` is the only authority for One-to-One capabilities: the owner approves requested scopes and the recipient explicitly opts into offered scopes.
4. `ria_active_picks_feed_v1` activates only through its current proposal → relationship-share grant → artifact lineage. The grant and each immutable share lifecycle event store the request and proposal identifiers for auditability.
5. The RIA workspace may use a generic active RIA consent capability. Market, preview, and Debate require the exact active Picks lineage; revocation, expiry, or disconnect removes new Picks access immediately.
6. Relationship-share grants are tracked outside `consent_audit` because advisor picks are advisor-authored relationship information, not investor PKM. Legacy implicit grants are retired and cannot authorize access.
7. Invite state is pre-consent workflow only; it is surfaced through the same consent-center read model but remains distinct from the canonical audit ledger.

## Legacy Picks Retirement

1. Migration `129_ria_pick_legacy_retirement.sql` deliberately retires the obsolete `ria_pick_uploads` and `ria_pick_upload_rows` tables. Legacy Picks are not imported into encrypted PKM; owners start with an empty encrypted `ria.advisor_package`.
2. `ria_pick_legacy_retirements` retains only the retired upload identifier, owner/profile identifiers, aggregate row count, timestamp, and product-authorized reason while the RIA persona exists. It contains no Pick values, package metadata, PKM material, or access authority, and is erased before RIA-persona or full-account deletion so its `ON DELETE RESTRICT` audit FK cannot create a retry loop.
3. The reset revokes every active legacy Picks grant/artifact that lacks explicit proposal lineage before dropping the tables. Historical proposal/share events remain immutable.

## Relationship Share Integration

1. Investor private information flowing to an RIA stays on the shared `/one/consent` lane and `consent_audit`.
2. Advisor-authored content flowing back to the investor uses `connection_scope_proposals`, `relationship_share_grants`, and append-only proposal/share event histories.
3. The reserved capability is `ria_active_picks_feed_v1`; connection acceptance alone never enables it.
4. Kai only exposes `ria:*` pick sources when the relationship, proposal, grant, and artifact are all active and refer to the same approved capability.
5. Active PKM-derived Picks syncs update the entitled artifact without requiring a new request. An advisor's bounded investor debate thesis travels only inside that same artifact and is used as attributed context for a selected investor's live Debate; it is not new `attr.*` scope authority, source lineage, event payload, or durable run history. A later revocation blocks new Market, preview, Debate, retry, and refresh reads, while an already-running Debate uses its authorized start-time snapshot.

## Google reauthentication for account deletion

For account deletion on the web, a configured Google sign-in client uses the existing, gesture-bound
Google Identity Services identity grant with Firebase `reauthenticateWithCredential`.
The deletion screen preloads that client before the tap. This avoids the hosted
Firebase popup return-event failure already handled by initial Google sign-in.
Unconfigured builds retain Firebase popup reauthentication; native Google keeps
its existing same-user bridge.

The grant requests identity scopes only. Credentials remain in memory and are
never exchanged through replacement sign-in. The Firebase user and current
owner session are checked across the grant, credential exchange and fresh-token
read. Readiness, cancellation, blocked windows and timeouts leave verification
retryable. Fresh backend authentication, linked-phone verification and the final
explicit deletion confirmation remain required. Local regression coverage does
not establish a successful deployed Google exchange or authorize a live deletion.

## MCP Read-Only Tools

1. `list_ria_profiles`
2. `get_ria_profile`
3. `list_marketplace_investors`
4. `get_ria_verification_status`
5. `get_ria_client_access_summary`

These tools remain read-only in V1 and are gated by auth + consent + scope policy checks.

### First-party Calendar Schedule read exception

`POST /api/one/calendar/schedule/today`,
`POST /api/one/calendar/schedule/availability`,
`POST /api/one/calendar/invitations`, and
`POST /api/one/calendar/board/day` use verified Firebase identity
plus the owner's active, scoped Google Calendar OAuth consent grant instead of
a VAULT_OWNER token. The server derives the owner from the bearer and verifies
the selected owner-bound Calendar connection/grant before and after provider reads. Firebase
alone, a Mail-only grant, or a disconnected Calendar never authorizes a read.
This exception exposes no vault/PKM, delegated-agent or mutation authority and
never mints a broad owner token. Vault lock/HCT revocation does not revoke these
provider reads; Calendar disconnect and Firebase invalidation do. Responses
are private/no-store and event information remains in component memory. Legacy
Calendar/chat reads and attendance mutations retain their existing HCT gates.
