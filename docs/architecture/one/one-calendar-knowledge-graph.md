# One Calendar Knowledge Graph

[One](README.md)

Status: current-code graph, including cross-account Chat availability source qualification on 2026-11-04. Live Google and deployed acceptance remain separate. This graph describes the owner's Google Calendar connection and One surfaces. It is context for people and agents, not a permission grant or alternate runtime router. The [Email graph](./one-email-knowledge-graph.md) describes the parallel Gmail boundary. The [implementation plan](../../roadmap/implementation/plans/2026-10-09-one-email-calendar-read-voice-plan.md) tracks repairs and remaining scope.

## Visual Map

~~~mermaid
flowchart LR
  owner["Owner"] --> ui["Calendar connection and upcoming card"]
  owner --> chat["Typed One Chat"]
  ui --> oauth["Owner-scoped Google OAuth grant"]
  chat --> one["One semantic tool selection"]
  one --> reads["Calendar read tools"]
  reads --> service["GoogleCalendarService"]
  oauth --> service
  service --> rest["Google Calendar v3 REST"]
  rest --> one
  one --> chat
  owner --> live["One Live Voice"]
  live --> voiceRead["Read-only Calendar voice tool"]
  voiceRead --> service
  one --> review["Calendar change proposal"]
  review --> owner
~~~

The voice tool is in this change. Its operational model receives counts and status; the owner's card receives event text. The ledger distinguishes semantic selection, information authority, provider calls, and owner approval.

## Nodes and authority

| ID | Node | Current contract |
| --- | --- | --- |
| U | Owner | Authenticated person who connects Calendar and asks One. |
| S1 | Calendar UI | OAuth entry and independently loaded, bounded upcoming card. |
| S2 | Typed One Chat | One selects admitted Calendar tools from the owner's request. |
| S3 | One Live Voice | Separate Live registry with a read-only Calendar tool; no Calendar mutation tool. |
| A1 | App identity | Firebase-authenticated owner on Calendar routes. |
| A2 | Google grant | Encrypted owner-bound tokens, with separate read and manage grant observations. |
| R1 | One model | Semantic tool selection and final answer; it can also see proposal tools. |
| R2 | Calendar read tools | Summary, subscribed-calendar list, bounded event list/search, exact event detail, availability, and opening suggestions. |
| R3 | GoogleCalendarService | Direct Calendar v3 REST with owner/grant recheck around reads. |
| P1 | Google Calendar API | External, untrusted event text and provider outcomes. |
| W1 | Change proposal | Typed Calendar write proposals require owner confirmation; no read authorizes a write. |
| G1 | Hosted Workspace MCP | Adapter exists but curated Calendar execution uses OAuth-backed REST while preview enrollment is off. |

## Typed edges

| Edge | From → to | Baseline behavior and evidence |
| --- | --- | --- |
| C01 | U → S1 → A1/A2 | Calendar UI enters Firebase-authenticated connect routes. hushh-webapp/components/calendar/calendar-agent-page.tsx; consent-protocol/api/routes/one/calendar.py. |
| C02 | A2 → R3 | GoogleConnectionService holds encrypted grant/account observations. consent-protocol/hushh_mcp/services/google_connection_service.py:211-314,783-879. |
| C03 | U → S2 → R1 | Typed One selects Calendar tools semantically. consent-protocol/hushh_mcp/one_adk/agent_tree.py:2451-2457; consent-protocol/hushh_mcp/agents/calendar/agent.yaml. |
| C04 | R1 → R2 → R3 → P1 | Typed Calendar reads call Calendar v3 REST through owner-bound service methods. consent-protocol/hushh_mcp/agents/calendar/tools.py; consent-protocol/hushh_mcp/services/google_calendar_service.py. |
| C05 | P1 → R1 → S2 | Summaries can include title, description, location, attendees and links. They are untrusted. google_calendar_service.py:143-180. |
| C06 | R1 → W1 → U | Typed change proposals are separate and require owner review. calendar/tools.py:330-438. |
| C07 | S1 → R3 → P1 | Upcoming card independently loads near-term events. hushh-webapp/lib/calendar/use-calendar-upcoming-events.ts:40-120. |
| C08 | S3 → R3 | One Live Voice exposes read_calendar for event windows, offered exact event details, calendar lists, free/busy, and openings. Its operational model sees content-free receipts. one_voice/tools/calendar.py; one_voice/tools/registry.py. |
| C09 | G1 ⇢ P1 | Hosted Calendar MCP adapter is dormant; active curated calls use direct REST. one_adk/workspace_mcp_tools.py:248-253,532-553. |

## Audited fault edges

These are code-path findings, not measured production incident rates. The dispositions refer to this implementation branch; UAT acceptance remains a separate release check.

| ID | Failure edge | Disposition and remaining limit |
| --- | --- | --- |
| K01 | Untrusted event text can enter a model turn that still has action tools. | Closed in one_adk/external_read_boundary.py and external_read_projection.py: Calendar reads block later same-turn effects. Exact application-owned proposal tools may prepare owner review after the read completes in typed chat; they cannot execute changes. Durable projection removes read and proposal arguments/results and pending Calendar directives. |
| K02 | A mid-read disconnect or account switch can release old-account events. | Closed for service reads: GoogleCalendarService verifies owner/account/grant binding after token resolution and provider response, and rejects changes. |
| K03 | A failed free/busy calendar may be treated as free. | Closed: embedded per-calendar errors, malformed busy intervals and incomplete group expansion fail the availability read, including opening suggestions. |
| K04 | Quota failure can look like lost permission. | Closed for recognized Google quota reasons: 403 rate limits map to retryable 429; other permission errors remain permission errors. See [Google Calendar errors](https://developers.google.com/workspace/calendar/api/guides/errors). |
| K05 | A stale UI request can repopulate another owner's card. | Closed in use-calendar-upcoming-events.ts with owner, connection generation, and request fencing. |
| K06 | Read coverage is narrower than the product request. | Subscribed-calendar list, selected-calendar bounded event list/search, exact detail, and bounded pagination are implemented. Live Voice next-page continuation keeps query/window/cursor private to the active session and rechecks the same grant. Typed list-to-detail and selected-calendar follow-ups use private owner/conversation/grant-bound ordinal offers and a new user turn. Owner-cloud scheduling has a bounded Contacts-to-availability continuation described below. Native Calendar consent requests the optional list scope only when the Calendar recovery directive explicitly includes `includeCalendarList`; ordinary base consent remains unchanged. |
| K07 | Voice cannot read Calendar events. | Closed by read_calendar. Event details are on the private screen card and optionally a separate tool-less narration path; the operational Live model sees only count/status. Narration is rollout-gated and falls back to screen-only detail. |

## Scope decision and invariants

Google exposes several read-only Calendar scopes. This product read surface will use the narrow grants needed for subscribed-calendar discovery, event list/detail/search, and availability, with incremental consent for newly requested access. It will not request unrelated ACL or settings scopes solely because they are read-only. See [Google Calendar scopes](https://developers.google.com/workspace/calendar/api/auth). Existing grants must keep working during rollout.

1. One chooses the tool from meaning; deterministic code validates exact arguments, owner, grant, account, bounds, and result freshness. Keyword matching is not a parallel semantic router.
2. An event is untrusted information. Its description, title and attendees never authorize a provider change. Typed chat may prepare a review-only proposal from a completed read; the owner must confirm the exact proposed change through the existing authenticated execution boundary.
3. A failed provider or per-calendar result is unknown, not free or empty.
4. A voice screen frame and spoken sentence are presentation, not a provider or permission result. The operational Live model receives only bounded, non-content receipts; spoken details use an isolated narration path.
5. Calendar write proposals and reviewed actions remain outside the read-only Voice release.

## Current reliability boundaries

- A connected read grant does not authorize scheduling. Missing write permission produces an incremental `manage` authorization directive with the service reason retained; denied upgrades must not be described as a disconnected account. Typed post-read continuation can prepare this authorization handoff or a review-only proposal, but never executes a provider change.
- The Calendar authorization marker combines account identity, encrypted refresh-token generation and service grant revision. Access-token refresh alone leaves it stable; reconnect/revocation invalidates offers and in-flight results.
- REST reads have a 12-second total budget, a streamed 2 MiB cap and one bounded transient retry. Mutations retain their existing single-attempt authority contract.
- FreeBusy validation distinguishes malformed error containers/items from provider calendar failures. Request-correlated diagnostics record code-authored field paths, expected/received types and allowlisted reasons without calendar identifiers or payload values. A missing busy array remains unavailable; only an explicit successful empty array establishes no busy periods.
- Schedule Free time uses the existing server-side continuous-window calculation across included calendars. The device timezone is the default display zone shared with chat; provider calendar metadata never overrides it. Explicit session-only timezone settings remain available per Google account. Replacing an account retires prior responses and zone choices; invalid responses require deliberate Retry rather than automatic polling.
- Free time queries the entire selected civil day, midnight to next midnight, with DST-aware boundaries. Today offers only remaining time; 15/30/60-minute filters use elapsed duration. Attendance's editable alternative hours remain separate.
- Availability selection defaults exclude only Google's verified `#holiday@group.v.calendar.google.com` feed namespace. All calendars remain visible in Schedule; titles and failed queries never determine exclusion. Explicit Free time overrides are owner/account-fenced session choices, not a stored global preference. Direct chat uses the same default policy; it does not inherit Free time's session overrides.
- Create proposals check the requested meeting interval against selected calendars before preview, and store their IDs in the existing short-lived proposal JSON. Confirmation requires the same account and included set, then repeats the interval check before the single-claim executor mutates Google. Added/removed included calendars or legacy proposals without selected IDs require a new review. Added informational holiday feeds do not alter the selection. Primary event conflict details and existing duplicate protection remain intact.
- Structured permission/credential failures alone offer authorization recovery. Included-calendar errors (`calendar_unreadable`), malformed responses and provider failures block success without reconnecting. No conflict check treats a failed calendar as empty or falls back to primary-only.

### Verification boundary for shared availability repair

`tests/services/test_calendar_shared_availability.py` exercises real inventory, HTTP response validation, full-day calculation, tool directives, Calendar routes and proposal claim SQL with disposable local SQLite (Postgres dialect adapted only). Sanitized Explorer fixtures preserve the late-night busy period and holiday `notFound`; chat replays those busy entries against its exact meeting request. They are not a retained provider response from the original One incident. The companion full-workspace stream test consumes a normalized actual tool result verified by that Python test, through real AG-UI parsing and confirmation handling.

The shared workflow regression has 15 cases failing on the integration base and passing with the repair. The full-workspace test exercises both streamed tool-result and state-directive delivery, a second authorized request, denied consent, account replacement, provider failure and duplicate confirmation clicks. This is local replay evidence, not live invitation verification.

The original UAT request reached Google FreeBusy HTTP 200 and then backend 502 before preview. Its exact application request calendar set/provider response was not retained in the accessible diagnostic facility. Explorer used a separate grant. Local reproduction proves the selection/validation repair, not conclusive resolution of that historical live incident. Release still requires approved deployment and a correlated UAT read; any real invitation requires separate owner approval.

- Live reads have a 25-second total budget and isolated narration up to eight seconds. New input/cancellation retires unpublished results and offers. Provider receipt and client settlement waits are bounded; uncertain provider receipts are not retried.
- Private cards show busy timestamps, correct all-day ranges, attendee responses and safe Meet links. Owner and request generations fence connection labels and results. Auth failures offer the Calendar recovery path.
- A nine-scenario actual Live-model canary passed after correcting an instruction that allowed a preparatory read for an unsupported write. This is bounded routing evidence; complete paraphrase accuracy and deployed p95 are not established.

## Owner-cloud scheduling in typed chat

One can look up a named guest through the existing Google Contacts read grant,
offer the owner's Calendar openings, and prepare a meeting for the selected
guest and time. A scheduling lookup requests names and email addresses and
returns numbered mailbox hints to the model. One asks which person or address
to use when there is ambiguity. After a successful lookup, the chat tool
boundary admits one Calendar openings check for the exact window and duration
that One supplied before the lookup.

Selections expire after five minutes and bind to the owner, conversation, and
the corresponding provider grant. Contacts candidates stay in process memory
behind an opaque reference. Calendar openings use the existing encrypted chat
session. The Calendar review shows the selected address and exact interval.
The existing Calendar manage grant, conflict recheck, and single-claim
confirmation govern invitation delivery and the Google Meet request. A
Contacts grant change also invalidates a pending Contacts-based review.

The pod action regression uses synthetic Google People and Calendar REST
responses. It covers a follow-up selection, exact review and provider payload,
duplicate confirmation, a foreign conversation, and replacement of either
grant.

Google People requests use the packaged discovery definitions in
`google-api-python-client`. The private agent's async transport sends the
scoped REST requests. A named scheduling lookup searches Other Contacts only
if saved Contacts yields no usable address and the owner has granted
`contacts.other.readonly`. Connections offers a separate native consent
action. An existing base-only grant still serves saved Contacts.
Multiple named guests are looked up together, with a separate group of bounded
choices per name. The review requires one mailbox from each group.

A selected event detail can supply numbered guest addresses for a later
invite. The offer excludes the owner and room resources and requires a
complete guest list. A selected inbound Gmail message can supply its exact
From address through a bounded metadata read. Both handoffs use the same chat
and the source grant. Calendar pagination keeps the exact search and cursor in
encrypted chat state. Reschedule and cancellation use the current event
selection and require a single reviewable occurrence and matching ETag.
The sealed owner-cloud confirmation receipt lets a follow-up in the same
conversation reschedule or cancel the recently created event by its exact
provider ID. The current Calendar grant must still match. The owner can review
edits to an organizer-owned event on a selected writable secondary calendar
after granting calendar-list access. Both review and execution check the
selected calendar's role. New events still target the selected account's
primary calendar.

When asked to schedule and reply in a selected Gmail thread, One prepares both
effects in the existing review card. It shows the Calendar guest and the Gmail
recipient separately because the source can have a different Reply-To address.
The private agent claims the proposal once, confirms Calendar first, records
the Calendar event receipt, and sends the reviewed message with the original
thread and MIME headers. The sealed status read separates Calendar success
from a refused or uncertain Gmail send. Checking status dispatches no effects.

## Second read-reliability audit

The [implementation plan and 64-case matrix](../../roadmap/implementation/plans/2026-10-09-one-email-calendar-read-voice-plan.md#second-audit-read-reliability-and-latency) records the current follow-up: stable authorization generations, strict availability validation, read cancellation/deadlines, owner-fenced cards, empty-Mail grounding, and private Calendar continuation. Implementation and release evidence are tracked there; baseline tests alone did not cover the reproduced gaps.


## Invitations (source implementation, 2026-10-16)

The connected Invitations tab and inline One Chat cards share one received-invitation
reader and the existing attendance review/confirm service. Upcoming occurrences span
all subscribed readable calendars; connected-email identity excludes organizer-owned
meetings and shared-calendar `self` impersonation. Pending is `needsAction`; Responded
is accepted/declined/tentative. Exact source calendar and occurrence survive selection.
Accept reviews conflicts and rechecks before changing only the owner's RSVP. Decline
uses the same narrow patch, never organizer cancellation. Alternate-time requests keep
the current chat, use real availability, and prepare editable reviewed organizer Mail
with the existing public capability reader. The organizer must confirm a new time;
Calendar and Mail outcomes remain separate. Realtime voice only hands the bounded
request into that chat review. It never mutates Calendar in the operational Live tool.

No migrations or shared deployments are part of this implementation. Synthetic service,
route, chat and Chromium/WebKit proofs are distinct from authenticated Google/Mail
acceptance; provider-backed acceptance must be recorded against a deployed revision.

The single non-mutating Live-to-Chat adapter adds one declared tool. Its measured
worst-case negotiated voice payload is 87 tools, 51,867 instruction characters
(51,879 UTF-8 bytes), and 71,924 declaration bytes. The owning performance budget
is bounded at 87 tools, 51,900 characters / 51,912 UTF-8 bytes, and 72,000 schema
bytes; the description cap is unchanged. These are static payload measurements,
not a claim about provider latency or live speech interpretation.

- Calendar proposals preserve the requested elapsed duration across midnight; the next day starts at 00:00. Confirmation cards show the current chat timezone and date rollover, with whole minutes and any remaining seconds.
- Confirmed invitation responses dismiss the detail modal; pending invitations move to Responded. Partial or unknown Calendar/Mail outcomes stay visible for recovery. Offering another time opens the existing availability form inside the modal. Schedule labels pending responses and remains the chronological calendar view.

- Schedule compares absolute event instants for Happening now and Ended. Displaying another timezone does not change those states; Ended describes elapsed scheduled time, not verified attendance.


## Cross-account free time in Chat

`calendar_shared_free_slots` uses the Account Board's availability-only service:
the same included-calendar policy, per-account free/busy calculation and shared
intersection, without event-detail or portrait scans. It checks all one-to-three
verified identities for a requested civil date, timezone and 15/30/60-minute
duration. Missing details require clarification. Failed or unreadable coverage
returns no shared openings; it never means the account is free. The bounded
result contains one exact-duration candidate per fitting free interval, with
one-based ordinals. It does not establish any guest's availability.

The existing encrypted ADK opening-offer key holds owner/chat identity, original
creation time, exact UTC intervals, zone, and every account's full opaque grant
and selected calendars. Grants never enter the model response or public state.
Refresh restores the original five-minute lookup expiry. `calendar_opening_detail`
shows a saved option without proposing or executing anything. A later booking
uses `propose_calendar_event(slot_ordinal=...)`; multiple accounts require an
explicit verified hosting account, never a primary-account fallback. The existing
Board booking authority compares all original grants and calendar coverage and
rechecks availability before issuing review and before confirmed dispatch.
Changing the caller's timezone cannot move the selected slot.

A valid lookup is consumed when preparing a proposal. The existing proposal's
advertised ten-minute expiry then controls confirmation, with live authority and
availability rechecks. No new preference, reminder, scanner, PKM record or action
store is introduced. Shared cross-account inventory is unavailable through
owner-cloud/data-door ports; existing single-account owner-local reads remain.
Both new reads use the existing external-content barrier, durable-history
redaction and content-free tool timing.

`tests/agents/test_calendar_shared_opening_tools.py` covers reference substitution,
account ambiguity, reconnect races, changed coverage, busy slots, timezone/DST,
and confirmed execution. `tests/services/test_calendar_chat_availability_postgres.py`
uses actual OAuth account/grant storage, encrypted ADK session recovery and SQL
proposal claims in an attested disposable PostgreSQL service. Only Google HTTP
and unrelated product-value receipt ports are synthetic. These prove source
contracts, not live model routing or deployed Google acceptance. UAT remains
unverified; release blockers do not block this independent source qualification.

## Decline email and exact proposed times

Decline asks for an editable reason; the explicit send button prepares and
confirms the existing attendance transaction for the displayed organizer.
Decline and offer another time derives duration from From/Until (including
midnight as the end of the day), checks included calendars, and pauses on a
busy proposal for Continue or Change time. The organizer receives the reason
and exact proposed interval and remains responsible for updating the event.
This is a proposal, not a booking or a claim that a busy interval is free.

The same signed review and durable confirmation ledger own Calendar and Mail.
A calendar failure prevents Mail; partial/unknown Mail delivery never retries
automatically. The private agent's chat displays the actual settlement through
a memory-only handoff, without a second model decision or another send.
Expired reviews retain entered terms but require renewed confirmation.
Recognized Google holiday feeds follow the Free time exclusion consistently;
other unreadable included calendars block availability instead of appearing free.
