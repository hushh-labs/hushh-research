# Design: Unify Location SOS/Check-in onto the real Trusted Connections graph

**Date:** 2026-07-06
**Branch:** `feat/location-unify-trusted-connections`
**Status:** Approved (design) — pending implementation plan

## Problem

One Location's **Check-in** and **SOS/panic** features work today, but the "trusted
contacts" they broadcast to are **preseeded developer accounts**, not the user's
real trusted connections. The preseeded data comes from the `SOS_SEED_DEV_USER_IDS`
env var, which a post-unlock bridge inserts into the SOS connection graph for every
new user.

Separately, the repo has a newer, real **trusted connections** graph
(`trusted_connections`, migration 078) written through Agent One chat. It is
**deliberately disconnected** from the location SOS graph — migration 078 notes
"convergence is future work." This design is that convergence.

## Current state (two separate graphs)

| | `one_location_network_connections` (SOS graph, mig 068) | `trusted_connections` (real graph, mig 078) |
|---|---|---|
| Used by | SOS + Check-in today (via `list_verified_recipients` rule #1 and frontend `state.networkConnections`) | Only the `agent_connections` chat agent |
| Written by | Claiming a Circle invite **or the seed** | Agent One "add X to my trusted connections" **or the seed** |
| Shape | undirected pairs (`user_a_id < user_b_id`) | directional edges (`owner_user_id → trusted_user_id`) |

Key current-state references:
- Recipient directory: `consent-protocol/hushh_mcp/services/one_location_agent_service.py` `list_verified_recipients` (~L2340–2417); eligibility rule #1 is an active `one_location_network_connections` row (~L2376–2384).
- SOS recipient selection (frontend): `hushh-webapp/app/one/location/page.tsx` `sosTrustedRecipients` / `sosActionRecipients` (~L1906–1928) from `state.networkConnections`.
- SOS execution: `hushh-webapp/lib/one-location/sos-trigger.ts` (`selectSosConnectedRecipients` L80, `runSosPanic` L132, `reason: "sos_panic"`).
- Check-in reuses the SOS recipient set: `hushh-webapp/components/one-location/redesign/check-in-flow.tsx` (`vm.sosRecipients` L138); handler `handleCheckIn` in `page.tsx` (~L4047).
- Agent SOS: `propose_sos_panic` in `consent-protocol/hushh_mcp/agents/location/tools.py` (~L227); browser executor in `hushh-webapp/lib/agent/specialist-directive-runtime.ts` (~L143).
- Seed writers: `one_location_agent_service.seed_trusted_connections` (~L3462, `metadata.source="sos_seed"`); `trusted_connections_service.seed_new_user` (~L217).
- Seed endpoints: `consent-protocol/api/routes/one/location.py` `POST /location/seed-trusted` (~L338); `consent-protocol/api/routes/one/connections.py` `POST /connections/seed-trusted` (~L39).
- Seed trigger (frontend): `hushh-webapp/lib/services/post-unlock-sync-service.ts` (~L32–45).
- Circle invite claim (writes SOS graph): `one_location_agent_service.claim_circle_invite` (INSERT ~L3342–3369).
- Trusted graph service: `consent-protocol/hushh_mcp/services/trusted_connections_service.py` (`add_connection`, `remove_connection`, `list_connections`, `is_trusted`, `_resolve_query`).
- Trusted graph schema: `consent-protocol/db/migrations/078_trusted_connections.sql`.

## Decisions (locked)

1. **Unify** onto the single `trusted_connections` graph; migrate `one_location_network_connections` in and retire it.
2. **Location agent scope: use-only** — trigger SOS + a **new check-in tool** against the unified graph. Add/remove/list trusted connections stays in `agent_connections`.
3. **Seeding: remove entirely** — both seed endpoints, both seed service methods, the post-unlock seed calls, and `SOS_SEED_DEV_USER_IDS` plumbing.
4. **Data migration: migrate real rows, drop seeded** — copy non-seeded `one_location_network_connections` rows into `trusted_connections`; drop seeded rows.
5. **Circle invites: one-way (claimer → inviter)** — claiming an invite adds the **inviter** to the **claimer's** trusted connections.

**Chosen approach: A** — repoint reads/writes to `trusted_connections`, migrate data, keep the frontend `networkConnections` payload field name (now sourced from the unified graph) to minimize frontend churn.

## Non-goals

- No changes to encryption / consent-scope model or the coordinate-safety invariant.
- No new trusted-connection management UI; add/remove/list stays in `agent_connections`.
- No changes to public links, view/incoming, request/approve/deny, refer flows.
- No marketplace / phone-verified eligibility changes (rules #2/#3 unchanged).

## Design (Approach A)

### 1. Data model & migration

New migration `consent-protocol/db/migrations/079_unify_location_connections.sql`:

- Copy **real** rows from `one_location_network_connections` (where
  `metadata->>'source'` is distinct from `'sos_seed'`) into `trusted_connections`
  with `source='circle_invite'`, `status='active'`.
  - Each undirected pair `(a,b)` becomes **two** directional edges `a→b` and `b→a`
    so existing users keep mutual SOS reachability. Use
    `ON CONFLICT (owner_user_id, trusted_user_id) DO NOTHING` for idempotency.
  - Seeded rows (`metadata.source = 'sos_seed'`) are **not** copied.
- `DROP TABLE one_location_network_connections;` after the copy.

`trusted_connections` already has all needed columns (owner/trusted/status/source/
metadata) — no schema change required.

> Rollback note: dropping the table is destructive. The migration copies real data
> first and is idempotent. The old table is a graph rebuildable from Circle-invite
> history if ever needed; call out in the migration header.

### 2. Backend reads

**Two distinct surfaces — do not conflate them:**
- **Share location** uses the **broad** `list_verified_recipients` directory (all
  Hushh One users). It stays broad and is NOT restricted to trusted connections.
- **Check-in and SOS** (the quick actions) use only trusted connections — enforced
  by the `networkConnections` filter (`selectSosConnectedRecipients`), NOT by the
  directory.

- `one_location_agent_service.list_verified_recipients` — eligibility **rule #1**
  changes from an `one_location_network_connections` EXISTS to:
  ```sql
  EXISTS (
    SELECT 1 FROM trusted_connections tc
    WHERE tc.status = 'active'
      AND tc.owner_user_id = :owner_user_id
      AND tc.trusted_user_id = a.user_id
  )
  ```
  This repoint is required because the old table is being dropped (Task 9). It does
  **NOT** narrow the share directory: rule #2 (`phone_verified = TRUE`, i.e. all
  Hushh One users) and rule #3 (marketplace advisor/investor) are still OR'd in, so
  the directory remains `trusted ∪ all-phone-verified ∪ marketplace`. Its only
  effect is to guarantee a user's trusted connections are always shareable and
  present in the pool that Check-in/SOS then filter down.
- `one_location_agent_service.list_state` — keep returning a `networkConnections`
  field (frontend contract preserved) but source it from `trusted_connections`
  (owner's active trusted edges). **This is the actual gate** that makes Check-in
  and SOS target trusted connections only; `sosTrustedRecipients`/
  `sosActionRecipients` selection in `page.tsx` is unchanged.

### 3. Circle invites (behavior change)

- `claim_circle_invite` writes **one** directional edge **claimer → inviter** into
  `trusted_connections` (`source='circle_invite'`) instead of an undirected pair in
  the old table. Net: claiming adds the inviter to the **claimer's** circle, so the
  **claimer's** SOS/check-in reaches the inviter.
- ⚠️ **Semantic shift** from today's mutual behavior. Existing migrated pairs remain
  mutual (both directions copied); only new claims are one-way. This asymmetry is
  intentional per decision #5 and documented for reviewers.

### 4. Seeding removal

- Delete `POST /api/one/location/seed-trusted` (`location.py`) and
  `POST /api/one/connections/seed-trusted` (`connections.py`) and their handlers.
- Delete `seed_trusted_connections` (one_location_agent_service) and `seed_new_user`
  (trusted_connections_service).
- Remove post-unlock seed calls in `post-unlock-sync-service.ts` and the client
  methods `OneLocationService.seedTrustedContacts`, `OneConnectionsService.seedTrustedConnections`.
- Remove `SOS_SEED_DEV_USER_IDS` env plumbing (deploy configs, route helpers).
- Update docs referencing the seed endpoints (`docs/reference/architecture/api-contracts.md`).

### 5. Location agent (use-only: SOS + check-in)

- **SOS** — no tool change. `propose_sos_panic` + the browser SOS runtime already
  derive recipients from the directory / `networkConnections`; once those read the
  unified graph, agent-triggered SOS targets trusted connections automatically.
- **New `propose_check_in` tool** mirroring `propose_sos_panic`:
  - `consent-protocol/hushh_mcp/agents/location/tools.py` — add `propose_check_in`
    (coordinate-free; returns `{proposed: "check_in", durationHours, note?}`), add to
    `V2_LOCATION_TOOLS` and `agent.yaml`.
  - `consent-protocol/hushh_mcp/services/location_chat_service.py` — add its
    `FunctionDeclaration`; treat as a prompt/directive-producing tool.
  - `hushh-webapp/lib/agent/specialist-directive-runtime.ts` — handle `check_in`:
    capture → encrypt per ready trusted recipient → publish (reuse the check-in
    pipeline / `runSosPanic`-style loop with the chosen duration and note).
  - Flow: agent gathers duration (`request_duration_choice`) + optional note, then
    proposes; irreversible/bulk still confirmed as today.

### 6. Readiness

Unchanged: a trusted connection only *receives* if it has an active recipient key
(`canReceiveLocation` in the directory payload). SOS/check-in already filter to
share-ready recipients; trusted-but-not-ready people are silently skipped (as today).

### 7. Error handling & testing

- Migration idempotent (`ON CONFLICT DO NOTHING`); guarded copy; empty circle is a
  valid state (no error).
- Reads fail safe: a user with no trusted edges gets an empty recipient circle, not
  an error; SOS/check-in with no ready recipients surfaces the existing "no
  recipients" UX.
- Tests:
  - Migration/data-copy: real rows copied (both directions), seeded rows dropped,
    old table gone.
  - `list_verified_recipients` now keys off `trusted_connections` (rule #1).
  - `list_state.networkConnections` sourced from `trusted_connections`.
  - `claim_circle_invite` writes the one-way claimer→inviter edge.
  - Seed endpoints removed (404) and post-unlock no longer seeds.
  - New `propose_check_in` tool + FunctionDeclaration + browser runtime.
  - SOS still targets the unified set (backend + `sos-trigger` selection).
  - Existing location + connections suites stay green.

## Behavior changes / risks (reviewer attention)

1. **Circle-invite semantic** flips from mutual to one-way (claimer → inviter) for
   new claims (§3).
2. **`one_location_network_connections` is dropped** (§1) — destructive; migration
   copies real data first.
3. **New users start with an empty circle** (seeding removed, §4) — they must add
   real trusted connections (via `agent_connections`) or claim a Circle invite
   before SOS/check-in has recipients.

## Success criteria

- SOS and Check-in broadcast to the user's **real** `trusted_connections`, from both
  the location page and the location agent.
- No preseeded dev accounts appear as trusted contacts anywhere; seed paths removed.
- Real, pre-existing SOS circles are preserved through migration.
- The location agent can trigger both SOS and Check-in against trusted connections.
- All existing + new tests green; CI (governance, protocol, integration) passes.
