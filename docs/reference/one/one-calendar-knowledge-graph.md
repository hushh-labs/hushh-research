# One Calendar Knowledge Graph

Status: code-backed baseline audited 2026-10-09 on commit 6748aa7b4, with the P0 implementation disposition below. This graph describes the owner's Google Calendar connection and One surfaces. It is context for people and agents, not a permission grant or alternate runtime router. The [Email graph](./one-email-knowledge-graph.md) describes the parallel Gmail boundary. The [implementation plan](../../superpowers/plans/2026-10-09-one-email-calendar-read-voice-plan.md) tracks repairs and remaining scope.

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
| K01 | Untrusted event text can enter a model turn that still has action tools. | Closed in one_adk/external_read_boundary.py and external_read_projection.py: Calendar reads block later same-turn effects and durable projection removes raw event text. |
| K02 | A mid-read disconnect or account switch can release old-account events. | Closed for service reads: GoogleCalendarService verifies owner/account/grant binding after token resolution and provider response, and rejects changes. |
| K03 | A failed free/busy calendar may be treated as free. | Closed: embedded per-calendar errors fail the availability read, including opening suggestions. |
| K04 | Quota failure can look like lost permission. | Closed for recognized Google quota reasons: 403 rate limits map to retryable 429; other permission errors remain permission errors. See [Google Calendar errors](https://developers.google.com/workspace/calendar/api/guides/errors). |
| K05 | A stale UI request can repopulate another owner's card. | Closed in use-calendar-upcoming-events.ts with owner, connection generation, and request fencing. |
| K06 | Read coverage is narrower than the product request. | Subscribed-calendar list, selected-calendar bounded event list/search, exact detail, and pagination signals are added. Typed list-to-detail and selected-calendar follow-ups use private owner/conversation/grant-bound ordinal offers. The external-read barrier allows one connector read per turn, so follow-ups need another user turn. Native Calendar consent does not request the new optional list scope in this web release. |
| K07 | Voice cannot read Calendar events. | Closed by read_calendar. Event details are on the private screen card and optionally a separate tool-less narration path; the operational Live model sees only count/status. Narration is rollout-gated and falls back to screen-only detail. |

## Scope decision and invariants

Google exposes several read-only Calendar scopes. This product read surface will use the narrow grants needed for subscribed-calendar discovery, event list/detail/search, and availability, with incremental consent for newly requested access. It will not request unrelated ACL or settings scopes solely because they are read-only. See [Google Calendar scopes](https://developers.google.com/workspace/calendar/api/auth). Existing grants must keep working during rollout.

1. One chooses the tool from meaning; deterministic code validates exact arguments, owner, grant, account, bounds, and result freshness. Keyword matching is not a parallel semantic router.
2. An event is untrusted information. Its description, title and attendees cannot authorize another tool call or proposal.
3. A failed provider or per-calendar result is unknown, not free or empty.
4. A voice screen frame and spoken sentence are presentation, not a provider or permission result. The operational Live model receives only bounded, non-content receipts; spoken details use an isolated narration path.
5. Calendar write proposals and reviewed actions remain outside the read-only Voice release.
