# One Feed Notification Model

## Visual Map

```mermaid
flowchart TD
  consent["consent_audit<br/>INSERT trigger"]
  location["one_location_events<br/>INSERT trigger"]
  connected["connected_system_audit_events<br/>INSERT trigger"]
  kai["Kai analyze/import managers<br/>canonical terminal + delivery guard"]
  connections["connections_service.py<br/>accept / reject / revoke / withdraw"]
  outcomes["269 source-row triggers<br/>Calendar, Mail, Drive, connectors, Circle"]
  feed_events["feed_events table"]
  api["GET/POST /api/one/feed*<br/>FeedService"]
  page["/one/feed page<br/>FeedItemRow"]
  tab["Feed bottom-nav tab<br/>unread badge"]

  consent -->|trigger| feed_events
  location -->|trigger| feed_events
  connected -->|trigger| feed_events
  kai -->|app-level write| feed_events
  connections -->|app-level write| feed_events
  outcomes -->|closed terminal projection| feed_events
  feed_events --> api
  api --> page
  api --> tab
```

Feed is the cross-domain activity surface for One: a single, paginated,
read/unread-tracked list of what happened across Consent, Location, Kai,
KYC, Connected Systems, and Connections. It replaced the top-bar
`ActivityInbox` bell (which only ever surfaced Consent + background-task
activity) with a real bottom-nav tab and a dedicated route, `/one/feed`.

## The `feed_events` table

Migration `consent-protocol/db/migrations/117_feed_events.sql` adds a single,
presentation-only table:

```sql
CREATE TABLE feed_events (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_domain TEXT NOT NULL CHECK (source_domain IN
    ('consent','location','kai','kyc','connected_systems','connections')),
  event_type TEXT NOT NULL,
  actor_label TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_row_id TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`feed_events` is deliberately **not** a domain audit authority. Each domain's
own table (`consent_audit`, `one_location_events`,
`connected_system_audit_events`) or write path remains the source of truth
for its own compliance/business logic; `feed_events` exists only to give the
Feed route one uniform shape to paginate. Rows never carry ciphertext or
vault-protected content, only bounded, non-sensitive `metadata` a
human-readable line can be rendered from client-side (see
`hushh-webapp/lib/feed/feed-item-renderers.tsx`).

## Write paths (six domains, two mechanisms)

**Trigger-based** (existing durable per-domain event table, near-zero app
code — mirrors the established `consent_audit` NOTIFY-trigger pattern from
`011_consent_audit_notify_trigger.sql`):

- **Consent** — a trigger on `consent_audit` INSERT fans out `REQUESTED` /
  `CONSENT_GRANTED` / `REVOKED` rows.
- **Location** — a trigger on `one_location_events` INSERT fans out
  share/access lifecycle events, owner-scoped.
- **Connected Systems** — a trigger on `connected_system_audit_events` INSERT
  fans out terminal statuses (`approved`, `connected`, `rejected`, `failed`).

**App-level writes** (no existing durable event table to hook — this is new
tracking, added alongside each domain's existing mutation):

- **Kai** — analysis and import managers, after canonical terminal selection;
  success also requires actual local terminal delivery. Analysis history is
  saved by the client, not inferred from the server status. The completion row
  carries only ticker and opaque run ID.
- **Connections** — `consent-protocol/hushh_mcp/services/connections_service.py`,
  at `accept_request` / `reject_request` / `remove_connection`.

Provider outcome projections use `FeedService.record_event` or best-effort SQL
functions; a Feed outage must not turn provider success into another write.
Relationship history in Connections uses the same transaction as its source
mutation and retains that existing atomic policy.

## Read/unread and pagination

- `GET /api/one/feed?cursor=&limit=` — keyset pagination (`id` cursor, not
  page numbers) because a live-growing append-only feed drifts under
  page-number pagination. Returns `{items, next_cursor, unread_count}`.
- `GET /api/one/feed/unread-count` — lightweight, polled by the bottom-nav
  tab badge (`hushh-webapp/lib/feed/use-feed-unread-count.ts`, 45s interval +
  an immediate refresh on `FEED_STATE_CHANGED_EVENT`).
- `POST /api/one/feed/read` — marks unread rows read up to a given `id`.
  Fired once when the Feed page opens (Instagram/Twitter's "opening the tab
  clears the badge" convention), not per item.

The Feed tab's icon is fixed (no spinner or live-task overlay): the tab is a
static navigational affordance, and unread state surfaces only through its
badge count, not an icon swap.

## Live cards and chronological history

The Feed route renders under one fixed (sticky) header where only the list
scrolls. Current cards come from authorized domain services, followed by the
chronological Feed projection. Empty sections disappear:

- **Live:** active location/emergency sharing.
- **Needs you:** pending information, location, connection and Circle requests,
  Mail/KYC review and active Kai tasks, with existing vault/consent guards.
- **Coming up:** up to three upcoming Calendar events.
- **In progress:** Drive request search/sharing progress, grouped by request.
- **History:** durable events grouped by Today, Yesterday and date.

The actionable and history mechanisms remain distinct:

1. **"Needs you" (live + actionable).** A `useFeedActionables`
   (`hushh-webapp/lib/feed/use-feed-actionables.ts`) hook aggregates the live
   domain stores/services — not the `feed_events` log — so each action is real
   and current:
   - pending consent → **Review** (deep-links to the consent manager; the feed
     never one-tap-approves because approval requires the BYOK export-key
     ceremony that lives there),
   - pending location-access requests → inline **Approve** (1h) / **Deny**
     (`OneLocationService`),
   - incoming connection requests → inline **Confirm** / **Decline**
     (`ConnectionsService`),
   - running Kai debates → **Resume** (reconnects the stream via
     `analysis?focus=active&run_id=…`) + **Cancel**, and running background
     tasks → **Open** / **Cancel** (`DebateRunManagerService`,
     `AppBackgroundTaskService`).
   Vault-gated actions disable cleanly when the vault is locked.
2. **History.** The `feed_events` log, day-grouped
   (Today / Yesterday / date), each row deep-linking into its origin screen.

Both zones are built on the canonical `SettingsGroup` + `SettingsRow` list
primitives (`FeedRow` for history, `FeedActionableRow` for the actionable
zone), so the feed shares the app's list vocabulary.

## Person identity and responsive rows

Connect, Location People/Circle rosters, and both Feed zones use
`ConnectionPersonAvatar`. Person lists use a 40px circular leading visual and
a 68px text/separator inset. Compact rows use a 16px name, 13px description,
and a separate timestamp line. On narrow phones, relationship actions move
below the name instead of compressing it; interactive targets remain at least
44px even when the action looks like secondary text. These are shared React
and CSS contracts for web and the iOS/Android Capacitor containers.

Photo reads prefer a nonblank `actor_identity_cache.custom_photo_url`, then
`photo_url`. Pending connection-request DTOs include optional
`counterpartPhotoUrl`; Circle member-invite DTOs include optional
`inviterPhotoUrl` and `inviteePhotoUrl`. Web proxies and native HTTP transport
preserve these additive fields. Image failure, replacement, and removal reset
the avatar loading state and reveal the same initials used by Connect.
The live Feed passes the Circle inviter photo through unchanged and uses the
same avatar component as Connect for person cards. Person-to-person Consent
Center entries resolve the requester's public person reference to its active
account identity before the Feed uses the current `counterpart_image_url`.
Removed photos and inactive or unresolvable profiles fall back to initials,
not a stale request-time image; system and developer entries keep their domain icon.

Feed photo sanitization preserves complete bounded PNG/JPEG/WebP data URLs
(up to 300 KiB decoded, matching the upload contract). It never truncates
base64 to the general metadata text limit. Invalid/oversized data, SVG, and
unsupported schemes are omitted; HTTP(S) URLs remain bounded to 1024
characters. A failed identity read must not resurrect a stored photo snapshot.

Migration `202_feed_counterpart_identity.sql` adds a server-only companion
table, `feed_event_counterparts`, linking a Feed event to its registered
counterpart. An AFTER INSERT trigger resolves the source event with the
viewer's audience checks. This link survives short-lived Location source
cleanup and resolves the current photo at read time; it grants no location
access and is not part of the public Feed DTO. Feed deletion or counterpart
account deletion cascades the link; migration 201's tombstone/write guards
apply. Historical event copy remains historical rather than being rewritten
when a profile changes.

Reads resolve at most the requested Feed page, materializing counterpart IDs
before joining the indexed identity cache. Retained legacy sources can still
be resolved during a rolling migration. Legacy sources already purged before
the identity link existed cannot be reconstructed; their rows keep initials
or a domain icon, never another person's guessed photo.

Migrations 203–204 remove the Location audit-table scan from identity resolution.
Grant keys use the existing grant index; numeric audit keys retain their primary-key
lookup. Request, referral, and arbitrary legacy metadata keys inspect only the
viewer's owner/recipient events through indexes, then apply the original exact
source and audience checks. Legacy lookup cost can still grow with that viewer's
own history. No source records or identities are backfilled inside these migrations.

Apply through migration 204 before running the explicit resumable backfill outside
the schema transaction:

```bash
cd consent-protocol
python scripts/backfill_feed_counterpart_identity.py --apply --expected-database <exact-database-name> --batch-size 250 --max-batches 20
```

Without `--apply` it is a dry run. Output contains counts and cursors, not
identities or photos. The down migration is
`db/migrations/rollback/202_feed_counterpart_identity.rollback.sql`; it removes
only this derived feature and preserves Feed history. New readers fall back
to legacy source enrichment on an older schema.

Migration 203 builds the recipient/event-type index concurrently, as a single
statement outside a transaction. Migration 204 refuses to install the new resolver
if that index is missing or invalid. If a concurrent build is interrupted, an
`IF NOT EXISTS` retry can leave the invalid index in place. With migration runners
stopped, run `rollback/203_feed_counterpart_recipient_index.rollback.sql`, then run
the **203 SQL file itself** outside a transaction, and retry the release. Merely
retrying ledger mode after dropping the index is insufficient: 203 may already be
recorded as applied. Do not change an accepted migration checksum or delete ledger
history to repair the index.

To roll back this optimization, execute
`rollback/204_feed_counterpart_indexed_lookup.rollback.sql` first, then
`rollback/203_feed_counterpart_recipient_index.rollback.sql` outside a transaction.
This restores the 202 resolver and preserves all Feed events and counterpart links.

Automated proof includes the actual-component Feed fixture, Circle layout
contracts, image lifecycle unit tests, and
`tests/test_feed_counterpart_identity_postgres.py` and
`tests/test_feed_counterpart_lookup_postgres.py` against unique disposable
PostgreSQL databases. Set `FEED_IDENTITY_POSTGRES_TEST_URL` to a local disposable
server's admin database and run those tests explicitly. The lookup regression
checks buffer accesses with 250,000 unrelated audit rows in custom and generic plan
modes, source compatibility, concurrent-index failure recovery, and rollback.
Browser emulation and these fixtures do not replace
authenticated user review or physical iOS/Android acceptance.

## Useful agent outcomes (migration 269)

The Feed reports authoritative outcomes, not each helper/tool invocation. The
additive, forward-only `269_feed_agent_outcomes.sql` preserves existing consent
bundle, Calendar/Mail success and Drive request/payment publishers. It adds:

| Source | Feed-worthy transition and audience | Replay key / noise filter |
| --- | --- | --- |
| Calendar proposals | failed, owner | proposal ID; status change only |
| Reviewed Gmail mailbox proposals | executed/failed, owner | proposal ID; execution persists terminal status before sensitive proposal cleanup |
| CRM audit | create/update/delete succeeded or partial; disconnect succeeded, owner | intent ID or event ID; successful reads stay quiet |
| Custom connector connection | connected, needs reauthentication, revoked, owner | connector + generation + status; placeholder and refresh updates stay quiet |
| Drive owner search | completed/limited/failed/stopped, owner | job ID + event type; request-bound completed searches use existing request outcome instead |
| Reviewed Drive directive ledger | settled share/trash success, failure or unconfirmed, owner | directive ID; requires the reviewed-action context revision |
| Standalone Drive bulk sharing | final owner summary; confirmed recipient notice | share + final revision; stopped uses stable stop timestamp and waits for every in-flight effect; request-origin jobs retain their existing aggregation |
| Drive question | withdrawn or returned to pending for retry, owner | request + revision + type; no question/answer/error content |
| Consent audit | denied, withdrawn, timed out, owner | bundle or request + event type; wording does not imply all bundle items resolved alike |
| Circle invitation/membership | declined to inviter, withdrawn to invitee, left to owner, membership ended to affected member | invite ID or membership generation; cleanup after deletion stays quiet |
| Circle deletion | owner and previously active members | circle ID; one deletion row, no removal fanout |

Connections withdrawal writes both participants' history in the existing source
transaction, with counterpart labels and `actor_is_self`, only after the guarded
pending update succeeds. A retry or lost race writes no additional history.
Migration 269 extends the existing indexed counterpart resolver
to withdrawals, preserving both audiences' current photos and server-only identity
mappings; it does not place user IDs or photo snapshots in Feed metadata.

Kai analysis/import workers keep the first recognized terminal immutable and
close generators in the owning task. Failed/canceled outcomes follow source
cleanup and durable receipt persistence. Successful analysis and statement
parsing are projected only after a local stream actually consumes the canonical
terminal frame. Empty/end cursors, detached completion and remote fallback
replay never announce a ready result. Import copy describes parsing and the
current import, without claiming saved portfolio information.

The Feed projection cannot mask provider success or cause a repeated write.
Projection failures are best effort; relationship transactions retain their
existing atomic policy. CRM partial status can mean a successful mutation whose
readback failed; Drive bulk partial/failed can include uncertain provider writes.
Both prompt review before retrying instead of asserting the action did not happen.
Unconfirmed Drive writes and possibly partial Mail
changes ask people to check the provider before retrying. No query, filename,
mailbox ID, label ID, account label, credentials, provider errors, holdings,
HMAC or terminal payload is copied into Feed.

Drive and custom connector rows remain visible with the CRM build flag disabled.
Links use the existing chat, Profile connector/my-data panes, Consent, Calendar,
Mail, Kai and Circle management surfaces. Routine reads, reasoning, Memory and
Wallet updates remain quiet. No new API endpoint, table, retention policy or
domain authority is introduced.

Rollback: `db/migrations/rollback/269_feed_agent_outcomes.rollback.sql` removes
only the new triggers/functions, preserving source state and delivered history.
The release manifest and three environment schema contracts register version 269.
Real PostgreSQL tests cover transitions, audience, content boundaries, replay,
bulk-stop races, migration replay, projection failure and rollback/reapply.

## Caching

`FeedPage` (`hushh-webapp/components/feed/feed-page.tsx`) loads its first
page through `useStaleResource` under `CACHE_KEYS.FEED_LIST(userId)`
(`CACHE_TTL.SHORT`), so a revisit renders the last-known page instantly while
a background refresh runs, matching every other cache-coherent route.
Pagination beyond the first page ("load more") stays a live, uncached fetch
appended to local state — only the first page needs an instant warm render.
On refresh, row reuse compares the presentation metadata as well as the domain,
event, actor, timestamp, and read state. Consent bundles can update their details
under the same event ID, and counterpart photos are resolved at read time; those
updates must reach the visible row even when no new event is appended.
Opening the feed calls `FeedService.markRead` (clearing the unread badge via
`dispatchFeedStateChanged`) but deliberately does **not** force-refresh the
list: the rows on screen keep their unread styling for the current visit and
only read as seen on the next open, matching Instagram's "opening clears the
badge, the items you're looking at stay highlighted" behavior. `FEED_LIST`,
`FEED_UNREAD_COUNT`, and `CONNECTIONS_INCOMING` (the actionable zone's
connection-requests read) are all covered by `CacheService.invalidateUser`, so
sign-out and account deletion purge them with the rest of the session.
