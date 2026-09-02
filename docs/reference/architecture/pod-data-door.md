# The pod data door — how a keyless pod reads a DB-backed specialist

A per-person pod holds **no database credential and no OAuth token** — that zero-role
identity is the whole isolation story. So a specialist that needs the owner's stored
state (location shares, inbox, calendar, brokerage connections) cannot read it
in-pod; without the door it reports `runtime_unavailable`. **`runtime_unavailable`
is the honest state _before_ a specialist's door is opened, never the destination.**

The door is the read-path around the wall. The pod does not gain a credential; it
asks the **hub broker** to run one fixed, read-only read on the owner's own project
and hand back a **fail-closed projection**. This is the mechanism behind the
north-star's "staged door-by-door plan."

## Visual Map

```mermaid
flowchart TB
  relay["Hub relay<br/>mints a short-TTL per-specialist scope, best-effort"]
  pod["Keyless pod<br/>no DB credential, no OAuth token"]
  broker["Hub broker (pod_specialist)<br/>verify_pod_identity + re-validate scope + owner bind"]
  read["One fixed READ-ONLY read on the owner's own project<br/>location: list_state(read_only) · email: list_nudges (OAuth) · calendar: list_events (OAuth)"]
  projection["Fail-closed projection (pod_data_door)<br/>allow-list only: no body, no PII, no key, no resource handle"]
  summary["Deterministic summary rendered IN the pod<br/>_format_X_summary, from the projection"]

  relay -->|couriers dataDoorGrants[name] into the turn| pod
  pod -->|hands the scope token back to the broker| broker
  broker -->|A's scope on B's pod is refused| read
  read -->|raw owner state| projection
  projection -->|pod-safe subset only| summary
  summary -->|the specialist's answer, no runtime_unavailable| pod
```

## The four invariants (enforced in code, not asserted in prose)

1. **Read-only w.r.t. DOMAIN state.** No reader mutates the owner's location shares,
   mailbox, calendar, or financial records. There is no write registry, no verb, no
   branch that takes one. A pod that wants to CHANGE state uses the directive
   transport (it PROPOSES; the browser EXECUTES). The one permitted side effect is
   INFRASTRUCTURE: an OAuth-backed reader may prompt the hub to refresh a near-expiry
   access token in its own cache — the hub keeping its own credential fresh, invisible
   to the owner's data, granting the pod nothing.
2. **Fail-closed projection.** Every read is rebuilt through an ALLOW-LIST of fields to
   KEEP, never a deny-list. A field added upstream is dropped by omission. Raw
   addresses, opaque resource handles (Gmail thread/message ids), live join links,
   ciphertext ids, and above all message BODIES and the owner's wrapped private key
   never appear on a keep-list, so they cannot cross.
3. **Per-turn, owner-revocable, Nav-narrated scope.** The relay mints a short-TTL
   standing grant for the specialist's narrow read scope (never `vault.owner`, which
   would give the pod everything) and couriers it to the pod; the broker re-validates
   it and binds its owner to the pod's HusshID (A's scope on B's pod is refused).
4. **The gate is the GRANT's presence, not a second flag.** No grant couriered → the
   specialist falls through to `runtime_unavailable` (today's behaviour, untouched).

## Status (2026-09-02)

| Specialist | Door | Read | Notes |
|---|---|---|---|
| location | **OPEN** | `list_state(read_only=True)` (sync DB) | first door; suppresses even expiry housekeeping |
| email | **OPEN** | `list_nudges` (async, OAuth) | inbox attention summary; `cap.email.inbox.view` |
| calendar | **OPEN** (2026-09-02) | `list_events` (async, OAuth, 36h window) | upcoming events, titles and times only; `cap.calendar.events.view`; read-only, the summary points at the Calendar screen for changes |
| nav, connections | next | dispatch specialists (hook fires) | same recipe as email |
| calendar | designed | `list_events` (async, OAuth) | in-process tool, needs the tool→broker bridge below |
| finance/Kai | designed (partial) | `get_status` connection status (sync DB) | see the finance split |

**The finance split.** Finance data is three-way: (a) connection status — which
brokerages are connected, account/holdings COUNTS, sync state — is server-readable
with NO vault key and IS door-eligible (`cap.finance.connections.view`); (b) the
portfolio itself (balances, holdings, decision cards) is zero-knowledge, vault-KEY
gated, and can NEVER cross a hub-run read — its path is browser-executed unlock; (c)
Plaid balances are server-readable but sensitive and stay off the keep-list. So a
keyless pod can honestly answer "you have Fidelity and Schwab connected, synced 2h
ago" without the vault, and says "unlock your vault to see holdings" for the rest.

**Dispatch vs in-process.** Email/location/nav/connections are DISPATCH specialists
(`_specialist_turn` → `serve_specialist_via_data_door` fires automatically). Calendar
and finance are in-process `AgentTool`s on the root agent, so opening their doors also
needs an in-process-tool→broker bridge (in `pod_mode`, route the tool's read through
the door instead of the direct DB/OAuth call that fails keyless).

## The extension recipe (adding a dispatch specialist's door)

Adding a door is a deliberate, reviewable act across these points:

1. **Scope** — `hushh_mcp/constants.py`: a `CAP_*_VIEW` enum member + add it to
   `capability_scopes()`. `hushh_mcp/consent/scope_helpers.py`: register it in
   `_AGENT_SCOPE_MAP` (so it resolves) and `_STATIC_SCOPE_META` (so the consent
   surface renders a sentence, not a title-cased handle).
2. **Projection + reader + registry** — `hushh_mcp/services/pod_data_door.py`: a
   fail-closed `project_X_state` with keep-lists, an `async def _read_X` (read-only;
   an OAuth reader turns the two EXPECTED "no live read" cases — not connected /
   needs reauth — into a coded marker instead of raising, so the answer is helpful),
   and registry entries in `POD_DATA_DOOR_READS` + `_READERS`. The reader path is
   async; a sync DB read wraps in `asyncio.to_thread`.
3. **Broker** — `api/routes/one/pod_specialist.py`: `_REQUIRED_SCOPE["X"] = "cap.X..."`
   (reuse the owner's real scope; the broker already awaits the async read).
4. **Specialist map + summary** — `hushh_mcp/one_adk/pod_data_door_specialist.py`:
   `_SPECIALIST_DOOR_NAMES["agent_X"] = "X"` and a deterministic `_format_X_summary`
   registered in `_SUMMARIZERS`.
5. **Relay grant** — `api/routes/one/pod_relay.py`: mint the scope via
   `issue_or_reuse_standing_scope(...)` (best-effort, INDEPENDENT: a mint failure for
   one door degrades only that door, never the turn or another door) and courier it
   in `dataDoorGrants["X"]`.

## The 10x edge-case checklist (every door must answer, none may crash)

- **not connected** → a "connect it" answer, never `runtime_unavailable`.
- **token expired / needs reauth** → a "reconnect it" answer.
- **empty** (no events / no nudges / no accounts) → a plain "nothing right now".
- **unexpected upstream error** (5xx/timeout) → propagates; the pod falls through to
  `runtime_unavailable`, NOT a false "not connected".
- **no grant couriered** (door off) → falls through (default).
- **revoked / wrong-owner scope** → broker 403 (`validate_token_with_db` + owner bind).
- **broker unreachable** → `serve_specialist_via_data_door` returns None → fall through.
- **PII / handle / body drop** → assert every raw address, resource id, join link, and
  body is absent from the projection, and a future upstream field is dropped by omission.
- **fail-closed on garbage** → a non-dict read projects to an empty/unavailable marker.

## Tests

`consent-protocol/tests/test_pod_data_door_projection.py` (location + the async
contract), `test_pod_data_door_email.py` (email projection drops, reader edge-case), `test_pod_data_door_calendar.py` (calendar projection drops, reader markers, one-name agreement, read-only summary
markers, deterministic summary branches, and one-name-across-three-maps),
`test_pod_data_door_specialist.py`, and `test_pod_specialist_broker.py`.

## Sources

- `consent-protocol/hushh_mcp/services/pod_data_door.py`
- `consent-protocol/hushh_mcp/one_adk/pod_data_door_specialist.py`
- `consent-protocol/api/routes/one/pod_specialist.py`
- `consent-protocol/api/routes/one/pod_relay.py`
- `docs/reference/architecture/private-agent-north-star.md`
