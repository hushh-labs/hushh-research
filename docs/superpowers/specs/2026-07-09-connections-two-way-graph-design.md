# Connections — Two-Way Graph, People Directory & Consent Integration

- **Date:** 2026-07-09
- **Branch:** `feat/connections-two-way-graph`
- **Status:** Approved design, ready for implementation planning

## Problem

The "Connect" experience today has three issues:

1. **The two "Connect" tabs are actually one page.** Both the default ("one" scope)
   and finance ("investor" scope) bottom-nav Connect tabs route to `/marketplace`
   (`app/marketplace/page.tsx`), a finance advisor/investor (RIA + investor)
   directory. There is no general people directory, and the default Connect tab
   should be a Facebook-like people search, not the finance deck.

2. **Connections are a one-way graph.** `trusted_connections`
   (`consent-protocol/db/migrations/078_trusted_connections.sql`) is directional and
   auto-`active` — adding someone trusts them immediately with **no consent from the
   other person**. It is written only through the chat "Connections specialist" agent
   (`connections_chat_service.py` → `TrustedConnectionsService.add_connection`). There
   is no pending/accepted lifecycle.

3. **Location sharing uses the whole platform directory.**
   `OneLocationAgentService.list_verified_recipients`
   (`one_location_agent_service.py:2356`) treats **any phone-verified user**
   (`OR a.phone_verified = TRUE`) as an eligible location recipient, not just the
   user's connections.

## Goals

- A new `/connect` people directory (default "one" scope) with a full users list and
  debounced search.
- A **two-way** connection graph modeled as a friend-request handshake
  (request → accept/reject).
- Incoming connection requests surface in the Consent Center **Requests** tab and
  contribute to the Shield **"consent guard"** badge (not the Bell/notifications
  system).
- A section on `/connect` showing the user's existing connections.
- Location recipient eligibility restricted to accepted connections.
- Full-stack: Postgres migration + Python service/endpoints + Next.js proxy routes +
  React UI.

## Non-Goals (YAGNI)

- Direct messaging / DM between connections.
- Asymmetric follow model.
- Directory privacy / opt-out / discoverability toggles (for now the whole users
  directory is listed; noted as future work).
- Any rework of the finance `/marketplace` advisor/investor directory.

## Decisions (locked)

| Decision | Choice |
| --- | --- |
| Default Connect tab | New `/connect` route; finance scope keeps `/marketplace` |
| Connection data model | New `connection_requests` + `connections` tables |
| Location link | Accepted connection = recipient eligibility; live share stays a separate explicit grant |
| Build scope | Full-stack |
| Consent surfacing | Unified Requests tab; folded into Shield `pendingCount` |
| Chat agent | "Add X" now sends a pending connection request |
| Legacy `trusted_connections` data | **Not** backfilled into `connections` (avoid retroactively "friending" without consent); legacy edges remain so current location sharing keeps working |

## Architecture

Three connected pieces:

- **A. People directory** — `/connect` page + directory search endpoint.
- **B. Two-way connection graph** — new tables, request/accept service, consent +
  guard-badge integration, chat agent change.
- **C. Location eligibility fix** — tighten `list_verified_recipients`.

### Data model — migration `081_connections.sql`

**`connection_requests`** (the handshake):

- `id UUID PK`
- `requester_user_id TEXT NOT NULL`
- `addressee_user_id TEXT NOT NULL`
- `status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','cancelled'))`
- `message TEXT` (optional note)
- `created_at`, `updated_at`, `responded_at`
- `metadata JSONB`
- `CHECK (requester_user_id <> addressee_user_id)`
- Partial unique index on `(requester_user_id, addressee_user_id) WHERE status = 'pending'`
  (prevents duplicate pending requests).

**`connections`** (the mutual edge, canonicalized undirected):

- `id UUID PK`
- `user_a_id TEXT NOT NULL`, `user_b_id TEXT NOT NULL`, `CHECK (user_a_id < user_b_id)`
- `status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked'))`
- `source TEXT NOT NULL DEFAULT 'request' CHECK (source IN ('request','circle_invite','import'))`
- `created_at`, `updated_at`, `revoked_at`
- `UNIQUE (user_a_id, user_b_id)`

**Relationship to `trusted_connections` (lowest-risk).** Keep `trusted_connections`
as the read source that existing location/SOS code already consumes, but only
populate it via accepted mutual connections. On **accept**, write the `connections`
row **and** two directional `trusted_connections` edges (`source='connection'`). No
existing reader is rewritten; only the write path and the eligibility query change.

### Location eligibility fix

In `list_verified_recipients` (`one_location_agent_service.py:2356`), remove the
`OR a.phone_verified = TRUE` clause. Eligibility becomes: active mutual connection
(via `trusted_connections`, now only populated from accepted connections) **OR** an
approved marketplace relationship. Live-location sharing remains a separate explicit
per-session grant — unchanged.

### Backend — `connections_service.py` + FastAPI router

New service modeled on `TrustedConnectionsService` +
`one_location_access_requests` handshake. Router
`consent-protocol/api/routes/connections.py`:

- `GET /connections/directory?query=&page=&limit=` — search/list `actor_profiles`
  (exclude self), each annotated with relationship status for the current user:
  `none | pending_outgoing | pending_incoming | connected`.
- `POST /connections/requests` `{ addressee_user_id, message? }` — create pending
  request; dedupe returns the existing pending request.
- `POST /connections/requests/{id}/accept` — create `connections` row + mirrored
  `trusted_connections` edges; idempotent if already accepted.
- `POST /connections/requests/{id}/reject` — requester's request → `rejected`.
- `POST /connections/requests/{id}/cancel` — requester withdraws → `cancelled`.
- `GET /connections/requests?direction=incoming|outgoing`.
- `GET /connections` — current user's active connections.
- `DELETE /connections/{id}` — revoke connection + revoke mirrored trusted edges.

**Consent integration.** Extend the consent-center **summary** (`counts.pending`) and
**list** (`surface = "pending"`) so incoming connection requests count into the same
`pendingCount` and render as `kind: "connection_request"`. Emit a consent realtime
event on new/resolved request so the Shield badge and consent tab auto-refresh via
the existing SSE/FCM path (`notification-provider.tsx` →
`CONSENT_STATE_CHANGED_EVENT`).

**Chat agent.** `connections_chat_service._add` calls `create_request` instead of
`add_connection` (response: "sent Priya a connection request").

### Next.js proxy routes (`app/api/connections/...`)

Following the existing `app/api/consent/*` proxy pattern (proxy to Python via
`getPythonApiUrl`):

- `directory/route.ts` (GET)
- `requests/route.ts` (GET list, POST create)
- `requests/[id]/accept/route.ts`, `.../reject/route.ts`, `.../cancel/route.ts`
- `route.ts` (GET connections list)
- `[id]/route.ts` (DELETE)

### Frontend

- **Service** `lib/services/connections-service.ts` — class modeled on `RiaService`:
  `searchDirectory`, `listConnections`, `listRequests`, `sendRequest`, `accept`,
  `reject`, `cancel`, `removeConnection`; cached via `CacheService`.
- **Page** `app/connect/page.tsx` + `page-client.tsx` (`"use client"`) with sections:
  1. **My Connections** — accepted connections list.
  2. **Pending** — outgoing requests you sent (incoming shortcut links to consent
     tab).
  3. **People directory** — full paginated user list + search, driven by
     `useDebouncedValue(query, 300)` (`hooks/use-debounced-value.ts`); each row shows a
     relationship-aware button (*Connect / Requested / Respond / Connected*). Fetch
     via `useState` + `useEffect` with a `cancelled` guard, mirroring
     `app/marketplace/ria/page-client.tsx`. Current user via `useAuth()`; render name
     from `display_name`, avatar from `photo_url`.
- **Bottom nav** — add `ROUTES.CONNECT = "/connect"` (`lib/navigation/routes.ts`);
  make `resolveBottomNavAction` `case "connect"` scope-aware
  (`lib/navigation/app-bottom-nav.ts:316`): `"one"` → `/connect`,
  `"investor"`/`"ria"` → `/marketplace`. Update `kai-route-tabs.ts`,
  `top-shell-breadcrumbs.ts`, and `route-map.ts` to match.
- **Consent Center** — render Accept/Reject on `connection_request` entries in
  `consent-center-page.tsx`; add a preview line in `consent-inbox-dropdown.tsx`.
  `pendingCount` picks them up automatically from the backend summary change.

## Data Flow

New request:

```
/connect (Connect button) OR chat "add X"
  → POST /api/connections/requests → Python create_request (status=pending)
  → emit consent event
  → addressee: FCM/SSE → notification-provider → CONSENT_STATE_CHANGED_EVENT
  → Shield badge pendingCount++, Consent Center Requests tab shows connection_request
```

Accept:

```
Consent Center Requests → Accept
  → POST /api/connections/requests/{id}/accept
  → connections row (a<b) + two trusted_connections edges (source='connection')
  → both users now eligible location recipients; appears in each /connect "My Connections"
```

## Error Handling

- Self-request and duplicate pending blocked at DB (`CHECK`, partial unique) and
  service (idempotent return of existing request).
- Accept/reject/cancel are idempotent — resolving an already-resolved request returns
  current state; accept when `connections` already exists is a no-op.
- Directory: pagination with explicit loading / empty / error states; debounce
  prevents request storms.
- Page gated by `useRequireAuth`; 401 handled by existing `api-client`.
- Realtime failure falls back to refetch on window focus / consent events.

## Testing

- **Backend (pytest):**
  - request → accept creates one `connections` row + two mirrored
    `trusted_connections` edges;
  - reject / cancel transitions;
  - duplicate-pending dedupe; self-request blocked;
  - `list_verified_recipients` no longer returns non-connection phone-verified users.
- **Frontend:**
  - `connections-service` unit tests (request/accept/list);
  - debounced-search behavior;
  - relationship-status button state matrix
    (none/pending_outgoing/pending_incoming/connected).
  - (Confirm the existing test harness/setup during planning.)

## Key Files

- Migration: `consent-protocol/db/migrations/081_connections.sql` (new)
- Backend service: `consent-protocol/hushh_mcp/services/connections_service.py` (new)
- Backend router: `consent-protocol/api/routes/connections.py` (new)
- Location fix: `consent-protocol/hushh_mcp/services/one_location_agent_service.py:2356`
- Chat agent: `consent-protocol/hushh_mcp/services/connections_chat_service.py`
- Consent summary/list: `consent-protocol` consent-center endpoints + `hushh-webapp/lib/services/consent-center-service.ts`
- Proxy routes: `hushh-webapp/app/api/connections/**` (new)
- Frontend service: `hushh-webapp/lib/services/connections-service.ts` (new)
- Frontend page: `hushh-webapp/app/connect/page.tsx` + `page-client.tsx` (new)
- Nav: `hushh-webapp/lib/navigation/routes.ts`, `app-bottom-nav.ts`, `kai-route-tabs.ts`
- Consent UI: `hushh-webapp/components/consent/consent-center-page.tsx`, `consent-inbox-dropdown.tsx`
- Debounce hook: `hushh-webapp/hooks/use-debounced-value.ts` (existing, first real use)
