# Trusted Connections — Generalized Social Graph — Design Spec

**Date:** 2026-07-05
**Branch:** `feat/trusted-connections-graph` (cut from `main`)
**Status:** Approved design → ready for implementation plan

## Goal

Promote "trusted connections" from an SOS/location-only concept into a **first-class,
app-wide, directional social graph** that any Hushh agent can read, and that only the
central **Hushh One** agent can write.

Concretely: when a user tells **One** "add Alice to my trusted connections," One resolves
Alice to a real `user_id` (by phone or email) and writes a **directional** trust edge
(`owner → trusted`). Any backend agent (Location, Email, …) can then **read** that graph
in-process to make trust-aware decisions.

## Non-goals (YAGNI)

- **No request/accept flow.** The model is directional ("I designate you as trusted"),
  like emergency contacts — no approval by the trusted party is required.
- **No changes to SOS / One Location code.** The existing
  `one_location_network_connections` graph, its seed, and all its reads stay exactly as
  they are. Converging SOS onto the shared graph is explicit future work.
- **No UI, no invite links, no bidirectional mesh, no display-name resolution.**

## Guiding principles

1. **One is central and owns writes.** Its system instruction already says it "holds the
   relationship layer." Trusted connections are One's native domain. Writes happen *only*
   through One's delegation path.
2. **Reads are agent-agnostic.** The graph is a shared DB table exposed by a pure,
   in-process service any agent imports. No HTTP hop between agents.
3. **Additive, zero-regression.** New table, new service, new One lane. Nothing existing is
   modified except the classifier keyword map and the post-unlock seed bridge (a new,
   separate call — the SOS seed is untouched).

## Locked decisions

| Decision | Choice |
|---|---|
| Connection model | **Directional (follow / designate)** — `owner_user_id → trusted_user_id`, one directed edge per pair |
| Write authority | **Hushh One agent only**, via a new `agent_connections` delegation lane |
| Read access | **Any backend agent**, via in-process `TrustedConnectionsService` (no HTTP) |
| Storage | **New dedicated table** `trusted_connections` — separate from `one_location_network_connections` |
| SOS / location code | **Untouched** — no reads/writes/seed of `one_location_network_connections` change |
| Identity resolution | **Phone or email only** (reuse existing resolvers); unresolved → One asks the user to clarify. Raw `user_id` allowed for seed/testing |
| Seed topology | **New user → seed set** — mirror the existing SOS topology into the new table, reusing `SOS_SEED_DEV_USER_IDS`, as a *separate* seed call |
| Branch | `feat/trusted-connections-graph` from `main` |

## Architecture

### Visual map

```text
WRITE (only via One)
  user → One (agent_chat) → classifier matches "trusted connection" keywords
    → adk_bridge dispatch → agent_connections lane
      → TrustedConnectionsService.add_connection / remove_connection
        → resolve person (phone|email → user_id) → upsert trusted_connections row

SEED (post vault-unlock, mirror — SOS seed untouched)
  PostUnlockSyncService → (new) seed_new_user(owner, SOS_SEED_DEV_USER_IDS)
    → if owner has 0 active rows, insert owner→seed edges (source='seed')

READ (any agent, in-process)
  Location / Email / … → import TrustedConnectionsService
    → list_connections(owner) | is_trusted(owner, target)
```

### Component 1 — Data model: `trusted_connections` (new migration, next number after 076)

```sql
CREATE TABLE trusted_connections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   TEXT NOT NULL,        -- the user who trusts
  trusted_user_id TEXT NOT NULL,        -- the person being trusted
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  source          TEXT NOT NULL DEFAULT 'agent_one' CHECK (source IN ('agent_one','seed','import')),
  resolved_via    TEXT CHECK (resolved_via IN ('phone','email','user_id')),
  label           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT trusted_connections_no_self CHECK (owner_user_id <> trusted_user_id)
);

CREATE UNIQUE INDEX ux_trusted_connections_edge
  ON trusted_connections (owner_user_id, trusted_user_id);
CREATE INDEX idx_trusted_connections_owner
  ON trusted_connections (owner_user_id, status, created_at DESC);
CREATE INDEX idx_trusted_connections_trusted
  ON trusted_connections (trusted_user_id, status);
```

**Per-user connection mapping.** Every user is the `owner` of an *outbound* trust list —
exactly one directed edge per person they trust:

- "My trusted connections" = `SELECT ... WHERE owner_user_id = :me AND status = 'active'
  ORDER BY created_at DESC`.
- "Who trusts me" (future consumers) = `SELECT ... WHERE trusted_user_id = :me AND
  status = 'active'` (served by `idx_trusted_connections_trusted`).
- Re-adding a previously revoked edge flips it back to `active` (upsert on the unique
  index), rather than creating a duplicate.

This is intentionally *not* order-normalized (unlike `one_location_network_connections`,
which uses `user_a_id < user_b_id`): direction carries meaning here.

### Component 2 — `TrustedConnectionsService` (agent-agnostic, pure)

New service module (sibling to `one_location_agent_service.py`). No agent-specific
coupling; any backend caller can import it.

- **Write (invoked only from One's lane):**
  - `add_connection(owner_user_id, *, phone=None, email=None, user_id=None, label=None) -> row`
    — resolves identity, records `resolved_via`, upserts an `active` edge.
  - `remove_connection(owner_user_id, trusted_user_id) -> row` — soft revoke
    (`status='revoked'`, `revoked_at=now()`).
- **Read (any agent):**
  - `list_connections(owner_user_id) -> list[row]` — active outbound edges.
  - `is_trusted(owner_user_id, trusted_user_id) -> bool` — single directed-edge check.
- **Seed:**
  - `seed_new_user(owner_user_id, seed_user_ids) -> {seeded, existingCount, skippedSelf}`
    — idempotent, gated on zero active edges for `owner`, skips self/blanks, writes
    `source='seed'`. Mirrors the shape/guarantees of the existing
    `seed_trusted_connections` (so its tests translate directly).

**Identity resolution helper.** Extract a shared resolver reusing the existing primitives:
phone via the digit-normalized match in `_identity_row_by_phone_digits`
(`one_location_agent_service.py`), email via the Firebase / `actor_identity_cache.email` /
`actor_verified_email_aliases` path. Contract: return a `user_id` or raise a typed
"unresolved" error that One surfaces as a clarifying question. **No display-name
resolution** (names are non-unique).

### Component 3 — One's write path (`agent_connections` lane)

Following the specialist-delegation pattern mapped in the codebase:

- Register a lightweight specialist lane in `hushh_mcp/adk_bridge/__init__.py`
  (`register_specialist("agent_connections", ...)`) whose handler parses add/remove/list
  intent and calls `TrustedConnectionsService`. Start with a deterministic intent parser
  (matching the repo's existing "deterministic regex planner" style) rather than a full
  Gemini tool loop; a tool-loop upgrade is future work.
- Add a classifier domain in `hushh_mcp/agents/orchestrator/tools.py`
  (`classify_specialist_domain`) with keywords such as *"add … to (my) trusted
  connections"*, *"remove … from (my) trusted connections"*, *"who do I trust"*, *"my
  trusted connections"*, so `resolve_delegate_target` routes these turns from One to the
  new lane.
- Writes are reachable **only** through this lane — no other agent calls the write methods.

### Component 4 — Reads by other agents

Location and Email import `TrustedConnectionsService` directly and call
`list_connections` / `is_trusted` where they need trust signals. This spec adds the
service and its reads; wiring specific Location/Email read *call-sites* is deferred to
those agents' own work (out of scope here) — but the read surface they will use is
defined and tested now. **No existing SOS/location read path is modified.**

### Component 5 — Seeding (mirror, SOS untouched)

Extend the post-unlock bridge (`PostUnlockSyncService`) with a **separate** call to
`seed_new_user(owner, SOS_SEED_DEV_USER_IDS)` writing the new table. The existing SOS seed
(`/api/one/location/seed-trusted` → `seed_trusted_connections` →
`one_location_network_connections`) is left exactly as-is; the two seeds run
independently.

## Data flow — "add Alice by phone"

1. User → One: "add Alice, +1 555 010 1234, to my trusted connections."
2. One's classifier matches → delegate to `agent_connections`.
3. Lane parses intent `add`, extracts phone → `TrustedConnectionsService.add_connection(owner, phone=...)`.
4. Service resolves phone → `user_id` (verified). If unresolved → typed error → One replies
   "I couldn't find a Hushh user with that phone/email — can you share their verified
   phone or email?"
5. On success, upsert `trusted_connections (owner, trusted_user_id, source='agent_one',
   resolved_via='phone')`; One confirms.

## Error handling

- **Unresolved identity** → typed `IdentityUnresolvedError`; One asks for clarification
  (never writes a guessed edge).
- **Self-add** → rejected by `trusted_connections_no_self` and pre-checked in the service.
- **Duplicate / re-add** → idempotent upsert; revoked edges are reactivated.
- **Remove of a non-existent edge** → no-op success (idempotent).
- **Seed when already populated** → gated no-op (`existingCount` reported).

## Testing

Mirror the existing `test_one_location_sos_seed.py` style (stubbed DB, no real Postgres):

- Service: `add_connection` (phone-resolved, email-resolved, `user_id` passthrough,
  unresolved → error), `remove_connection` (revoke + idempotent no-op), `list_connections`
  (active only), `is_trusted` (directional true/false), `seed_new_user` (idempotency,
  skip-self, skip-blank, zero-gate).
- Migration applies cleanly (up).
- Classifier: the new keywords route to `agent_connections`; unrelated messages do not.
- `no_self` constraint rejects self-edges.

## Open items for the implementation plan

- Exact migration number (next after `076_marketplace_access_requests.sql`).
- Whether the `agent_connections` handler lives in `adk_bridge/` alone or gets a thin
  `agents/connections/` manifest for symmetry with other specialists.
- Precise email-resolution source of truth (Firebase vs `actor_identity_cache.email` vs
  verified aliases) — pick one and document it in the plan.
