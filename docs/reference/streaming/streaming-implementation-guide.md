# Streaming Implementation Guide


## Visual Context

Canonical visual owner: [Streaming Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

Use this pattern for any new Kai, One Voice, Agent Chat, or portfolio-import streaming feature.

## 1. Backend Producer

- Kai producers emit SSE using the canonical envelope from `consent-protocol/api/routes/kai/_streaming.py`. Agent Chat uses its existing AG-UI bridge; do not wrap AG-UI events in a second Kai envelope.
- Always set explicit `event:` and canonical JSON `data`.
- Mark terminal events with `terminal=true`.
- Keep payload object-only.
- Enforce route-owned inactivity timeouts and emit heartbeat-safe events every `3-5s`.

## 2. Vertex AI Streaming

- Use streaming APIs (`generate_content_stream` / `streamGenerateContent`).
- Keep progress events independent of thought availability.
- Use structured output mode for extraction flows:
  - `response_mime_type="application/json"`
  - explicit response schema.

## 3. Native Plugins (iOS/Android)

- Parse SSE by blocks, not by lines.
- Preserve `event`, `id`, and envelope JSON.
- Emit exactly `{ event, data, id }` to JS listeners.
- Cleanup listeners on terminal events or stream completion.

## 4. Frontend Runtime

- Parse SSE with `hushh-webapp/lib/streaming/sse-parser.ts`.
- Validate envelopes with `hushh-webapp/lib/streaming/kai-stream-types.ts`.
- Consume streams with `hushh-webapp/lib/streaming/kai-stream-client.ts`.
- Never add route-specific ad hoc parsers.
- In Agent Chat, consume the existing AG-UI protocol through `hushh-webapp/lib/services/agent-chat-client.ts`; assistant text deltas are the source of incremental response text, not tool progress or provider payloads.
- Agent Chat's 90-second byte-idle watchdog begins after response headers and a
  stream body arrive. Cold pod admission retains its separate HTTP deadline;
  admission is not a silent model stream. Cancellation invalidates the run so
  late admission cannot dispatch a cancelled turn or restart its watchdog.
- Agent Chat settles a turn from an explicit `RUN_FINISHED` or `RUN_ERROR`. After a clean transport EOF without either event, the client allows 500 ms for already received parser callbacks, then aborts a stuck SDK transport and reports one incomplete result. The workspace reconciles persisted turn history before offering another attempt. An intentional review-card detach remains a separate pending state, not a stream failure. Terminal callbacks are guarded so a late frame cannot create a second completion.
- Managed `TEXT_CONTENT_FILTERED` and `TEXT_AUTHORITY_ENDED` errors use fixed
  client notices and do not imply backend capacity strain. Keep partial answer
  text, show the reason beneath it, and never turn the refusal into a successful answer.
- A confirmed chat-key refusal may retain one unexecuted request in memory for
  its requested unlock. The shared composer still clears on lock. Recovery
  requires the same validated authentication generation and restored conversation;
  any intervening text/attachment edit or explicit chat selection cancels it.
  Consume the continuation before dispatch. Calendar recovery rereads current
  permission and source content; it never restores fetched sources as a draft
  attachment or automatically captures them into Memory. Stale/exhausted refusals
  and uncertain transport outcomes do not gain automatic replay authority.

### Private pod reconnect and settled work

Private Agent Chat keeps its existing AG-UI protocol and encrypted conversation
store. `one_adk/pod_chat_stream.py` separates the transport reader from the
admitted run, with at most 64 buffered frames / 1 MiB. Detachment discards the
buffer; it does not resubmit the turn. The producer exhausts SDK cleanup and
retains only the original request-key lifetime (at most 300 seconds), including
the existing update permit and access checks. Explicit Stop and parked review
cards use the existing authenticated stop route. A preparing producer is fenced
by owner and conversation; an unacknowledged Stop is reported as unconfirmed.

Reconnection reads encrypted history and `turn.pending`; activity is sampled
before and after the read so an older snapshot cannot invite a duplicate turn.
No token replay log, parallel action ledger or automatic effect replay is added.
Lost or uncertain consequential outcomes still need their owning reconciliation.
Files activity reads only existing queued/running jobs, one at a time, while
visible and online. The ten-minute observation window stops on terminal state,
mutation, owner change, vault closure or unmount; it never resubmits a job.

Private command proposals and pending MCP arguments use separate bounded,
owner-chat-key-encrypted CAS slots in the existing owner object store. Command
reconnect reads the stored revision; it never dispatches an effect automatically.
An accepted effect is journaled as `dispatching` before execution. An uncertain
response stays uncertain rather than returning to a runnable checkpoint.

After a pod restart, MCP recovery reads the sealed native ADK confirmation and
its encrypted pending arguments. Only the process epoch may change. The existing
hub action ledger atomically cancels the old directive and issues its exact
successor with the original expiry; a fresh browser confirmation is required.
A persisted rebind intent reconciles a lost acknowledgement before another
restart. Consumed, expired or mismatched directives cannot be revived. Private
arguments and previews never enter hub persistence or the history cache.

Each recovered browser continuation has a fresh cancellation lifetime and
message identity. Late events cannot update a stopped or replaced segment.
Stop remains pending until its server acknowledgement; failure displays an
uncertain outcome. Recovery reads do not start a model turn or prolong idle
compute. Old clients are explicitly refused by the new command contract; a
legacy pod can accept a fresh supported command but cannot promise restart
recovery.

Process-local continuation does not guarantee completion after process loss.
Request-based Cloud Run does not provide continuous CPU after the request ends;
durable background completion belongs to the existing authenticated job/queue
owners. Keep selected cost settings unchanged. See [Cloud Run CPU and background
execution](https://docs.cloud.google.com/run/docs/tips/general).

### Personal World Model research

`GET /api/one/world-model/jobs/stream` is an owner-authorized research stream, separate from the Kai envelope above. It sends `progress` with observed counts and source titles, a cumulative `partial` list of checkpointed cited findings, `ping` heartbeats, and a terminal `result`. The client parses complete SSE blocks with the shared parser and validates each payload against the PWM schema. A later `partial` replaces the earlier list, including an empty list after authority or evidence invalidation. Reconnect or a status read restores the current checkpoint; a provider interruption must not erase already validated provisional findings. Provisional findings are read-only until the final offered report passes evidence validation and the owner chooses what to save.

### Live Email and Calendar reads

One Live Voice keeps ordered tool dispatch while its provider/client intake can
cancel only the active read task. A matching provider `tool_cancel`, new owner
speech, or new typed input fences its result and isolated narration before queued
dispatch catches up. Canceled reads publish one metadata-only terminal result:
`cancelled/provider_cancelled` or `superseded/newer_question`. Effects already
accepted retain their separate authoritative settlement and are never replayed
or canceled by this read policy.

Total budgets are 25 seconds for Calendar and 45 seconds for Email, including
retrieval and interpretation; isolated narration has an 8-second bound inside
the total. A retrieval deadline returns `rejected/read_timeout`. Narration
failure preserves a successfully published card and interrupts partial audio.
Provider receipt delivery and cancellation settlement are bounded to three
seconds; an unhealthy transport closes within one second and an uncertain
provider receipt is never retried. Unpublished entity offers are discarded; a late read cannot change which message
or event an ordinal selects. Cancellation is cooperative: a synchronous read
already running in a worker thread may finish, but its content cannot publish.

Calendar REST reads additionally have a 12-second provider/connection budget,
at most one safe transient retry and a 2 MiB streamed response cap. Calendar
writes do not inherit these retry rules. Google REST responses are JSON pages;
the app's lifecycle/card/audio frames are distinct from provider token streaming.

### Document request Feed wake-ups

One SSE channel per account wakes the Feed, Profile Payouts and the app badges.
Its server is `consent-protocol/api/routes/document_feed_stream.py`, reached
through two entry points:

| Entry point | Who calls it | Owner |
|---|---|---|
| `GET /api/consent/document-feed/{user_id}?v=1\|2` (`api/routes/sse.py`) | native apps directly; the web through the same-origin Next proxy `app/api/consent/document-feed/[userId]/route.ts` | Firebase bearer whose uid must equal the path (403 otherwise) |
| `GET /api/one/feed/events?v=2` (`api/routes/one/feed_events.py`) | the web, at the backend origin | the verified token only |

Three committed producers ring PostgreSQL `one_user_state_changed` with
metadata only. A `drive_share_events` insert sends the addressed user, the
opaque request ID and the event UUID. Payout producers send `bank_payout_changed`
through `consent-protocol/hushh_mcp/services/payout_doorbell.py`: the owner, the
closed `kinds` (`wallet`, `earnings`, `bank_payouts`, `account`, `balance`) and
optionally one request ID; the payload is deterministic, so identical doorbells
in one transaction collapse, and the owner-earning trigger
(`db/migrations/318_payout_doorbell_kinds.sql`) sends the same bytes. Every
committed `feed_events` write sends `feed_changed` with only the owner
(`db/migrations/313_feed_realtime_changes.sql`). Missing or unknown payout kinds
mean every kind.

Frames with `?v=2`:

| Frame | Data | When |
|---|---|---|
| `hello` | `{"v":2,"heartbeat_ms":15000,"max_lifetime_ms":<ms>,"live":bool}` | first |
| `feed_reset` | `{}` | on connect, after a LISTEN recovery or queue overflow |
| `feed_changed` | `id: <event UUID>`, `{"request_id":"<UUID>"}` | per Drive doorbell |
| `feed_changed` | `{}` | per other Feed write |
| `payout_changed` | `{"kinds":[...],"request_ids":[...]}` | per payout burst |
| `heartbeat` | `{"ts":<epoch ms>,"live":bool}` | every 15 s, time-based |
| `reconnect` | `{"after_ms":0..2000}` | just before the server closes |

`: ping` comments still arrive every 15 s. Payout doorbells coalesce per stream
(500 ms trailing debounce, 2 s maximum wait); `request_ids` holds at most 20 IDs
and is empty when a burst is not tied to specific requests. `live` is false
while the worker's LISTEN is down.

Without `v=2` (installed builds) the stream sends `feed_reset`, both
`feed_changed` forms and `heartbeat` `{"live":bool}` every 30 s. A payout burst
becomes one `feed_reset`. The stream closes about 500 ms after its first
post-connect reset or Drive frame (a general `feed_changed` never shortens it),
so a build that buffers the whole body sees a change within seconds and frees
its backend slot.

Bounds, per backend worker:

| Bound | Value |
|---|---|
| v2 lifetime, direct | 840 s plus or minus 60 s (below the iOS stream plugin's 900 s limit) |
| v1 lifetime | 110-120 s |
| lifetime through the Next proxy | 90-110 s, below the web server's request timeout (120 s production, 300 s UAT), so proxied streams rotate cleanly |
| token re-verification | every 30 s, also before releasing a hint that raced the timer; a refusal closes the stream silently |
| blocked send | 10 s, then the response ends and frees its subscription and slot |
| streams | at most 6 per worker and 3 per user; a fourth evicts that user's oldest; a full worker answers 503 with `Retry-After: 60` |

UAT keeps maximum API concurrency at 20 and requests earlier scale-out with a
20% concurrency utilization target; this preserves ordinary API/Voice ingress
headroom. Worker limits still apply during bursts and maximum-instance
saturation. The Next proxy preserves the closed `FEED_STREAM_BUSY` reason as
`detail.error_code` alongside the 503 and retry delay, without forwarding the
upstream diagnostic message.

The proxy marks its upstream request with the fixed header
`X-Hussh-Stream-Via: next-proxy`; the server trusts it only to shorten the
lifetime. `DOCUMENT_FEED_WEB_STREAM_ENABLED` turns the direct web endpoint on or
off; unset, it is on everywhere except production, and a disabled endpoint
answers 404 before reading any token.

`consent-protocol/api/consent_listener.py` probes its LISTEN connection with
`SELECT 1` (5 s timeout) every 30 s and re-listens when the probe fails. Every
activation pushes a local resync to each Feed stream on that worker, which sends
`feed_reset`, because NOTIFYs sent while LISTEN was down are lost. Feed streams
subscribe with snapshot resets: a full queue is replaced by one resync instead
of silently dropping hints. Legacy consent SSE queues never receive Feed hints
or resyncs, so a Feed burst cannot displace consent, message or location events.
A bank doorbell first invalidates that worker's 30 s account status cache.

The reset is the recovery path when a tab or backend instance missed NOTIFY:
subscribe first, then tell the client to fetch the authenticated Feed and
Consent Center snapshots, then drain queued changes. FCM and the visible
Feed's periodic/focus refresh remain fallbacks. No filenames, request reason,
amounts, provider identifiers, Stripe data, counterpart identity or secret
material may enter the stream. Frames never authorize payment, consent, file
access or a user-facing state label. The legacy consent SSE fallback switch
does not govern these endpoints.

Client. `hushh-webapp/components/feed/authenticated-feed-stream.tsx`, mounted
once in `app/providers.tsx`, opens the account's stream for the app's lifetime;
Feed and Profile calls to `useDocumentFeedStream` join that connection and never
open another. On web one tab per browser streams (Web Locks elect it; a
BroadcastChannel relays its frames to other tabs). A hidden tab aborts its
stream and gives up leadership, so only a visible tab holds a server slot.
`hushh-webapp/lib/services/document-feed-transport.ts` tries the direct v2
endpoint first. It falls back, within the same attempt, to the same-origin
proxy with `?v=2` on a CORS or network failure or no headers in 7 s (direct
skipped for 5 minutes), a 404 (30 minutes) or a 503 (its `Retry-After`, at
least 60 s). Both paths use raw `fetch`, so a stream 401 never signs anyone
out. Native apps use the HushhStream plugin, which really streams and cancels
when the app goes to the background.

`hushh-webapp/lib/feed/document-feed-stream-manager.ts` is the state machine.
Each attempt has its own AbortController; the token lookup must settle within
10 s and the response headers within 15 s, and a 45 s watchdog on received
bytes (comments count) aborts a silent stream, rereads payout data once and
reconnects. A late response for an abandoned attempt is cancelled. Failures
back off 1, 2, 4, 8, 16, then 30 s with 20% jitter, reset after 60 s of healthy
streaming; after 8 failures the client polls and retries on network, focus or
visibility, or every 5 minutes. A 503 waits for `Retry-After`. A 401 gets one
token refresh, then the stream waits for a recovery signal (session verified
again, a new ID token, network back, or visible 60 s after the last attempt), at
most 3 times per 15 minutes. Once the validated session owner changes, the old
stream connects and dispatches nothing. The manager rechecks that owner after
token acquisition and response headers; a retired attempt stops without retry
and cancels any late response body, even when the transport ignores abort.

`payout_changed` rings only the payout bus (`hushh-webapp/lib/payouts/payout-events.ts`).
Feed frames reread the Feed on a burst's first frame and once more after the
burst settles (1 s quiet, 5 s cap), because a forced reread joins any read
already in flight. `feed_reset` also rereads every payout kind; a general
`feed_changed` rereads the Feed without the consent cache cascade. Returning to
a hidden tab or a backgrounded app repairs the Feed once and reconnects; while
no healthy stream covers the tab, the Feed is repaired every 45 s.
The payout store (`hushh-webapp/lib/payouts/payout-live-store.ts`) polls on the
idle clock while visible: every 45 s, every 15 s for a moving transfer or
deposit while the stream is not live, and `account` no faster than every
5 minutes.

`hushh-webapp/app/api/_utils/consent-stream-proxy.ts` is the only proxy for
these streams (the Feed route and the legacy consent events route). Route
params arrive decoded, so it refuses `.`, `..`, separators, `%`, `?`, `#`,
whitespace and control characters before any fetch. It requires a bearer token,
forwards only `v=1|2`, refuses redirects and non-SSE responses, never reflects
upstream error bodies, passes on a plain `Retry-After` from a busy backend, and
answers `private, no-store` with `Content-Encoding: none` so compression cannot
hold frames back.

The first owner Stop access transition updates the request row rather than
writing a Drive outbox event. Its transaction sends the same opaque doorbell
to both participants, using the request UUID as its one-shot event ID. The
client rereads current access state; later removal outcomes follow the usual
durable Drive event path.

### Private connector events

The existing `one_adk/drive_result_privacy.py` projection also covers governed
dynamic MCP names (`mcp_` followed by a 40-character lowercase hexadecimal digest).
Strip their argument chunks and raw protocol metadata from browser diagnostics
and session copies. Successful native MCP content is processed in the live turn,
not retained as durable tool payloads. Persist only safe outcome metadata.
Server encryption at rest does not authorize retention of connector content.
Approval receipts, credential material and error bodies are not history content.
This projection alone does not certify assistant-text or other persistence paths;
those require separate custody verification. Explicit PKM capture remains separate.
The current browser tool-status projection stays metadata-only; richer connector
presentation must use an owner content surface, not diagnostic event payloads.
For failed AG-UI turns, timing logs and reviewer rehearsals retain only an
allowlisted error category (`connector`, `database`, `runtime`, `model`,
`other`, or `untyped`). Never retain the raw `RUN_ERROR` message or code as a
diagnostic; either may contain provider or owner information. The public
projection replaces bridge errors with a fixed message/code, including errors
that escape the adapter before it emits a terminal event. Adapter and endpoint
loggers drop raw exception text, tracebacks, and serialized SSE debug payloads;
their fixed phase and exception-kind labels are diagnostic only. Use turn
timing and those bounded labels to triage, not raw SDK exceptions.
For resumed snapshots, collect private call identities before projecting messages;
a result may precede its call and no start event may have been observed. The live
model-turn object remains unchanged. This redaction does not authorize a tool,
prove receipt consumption, or activate the shared toolset on the Chat roster.

ADK confirmation events duplicate the original call under `originalFunctionCall`.
The durable projection strips those nested arguments and private confirmation
payloads too, retaining a non-actionable identity skeleton. Restore reviewed
arguments only into the authenticated live invocation and revalidate exact-call
authority before execution; a historical confirmation is not permission to replay.
The browser resume receipt travels through scrubbed forwarded properties into a
request-memory reference, never a model-visible tool response. Remove that
reference from both persisted state deltas and public AG-UI state projections.

Pending MCP call recovery uses the existing expiring request-secret store and a
task-local resume scope. A server-issued handle binds the owner, conversation,
tool and original function-call ID. The encrypted session reader restores both
argument copies only on a deep-copied live session; normal history reads remain
redacted. Expiration, another server instance, or a restart requires review again.
`review_or_resume_call` requests native ADK confirmation on the first call and
requires an app-ledger receipt on resume. It is not live roster activation:
the browser review-card transport, pending-handle confirmation API, and governed
roster must be connected and verified together before exposing custom tools.

The Chat wire projection buffers native confirmation argument fragments (64 KB
per call, at most 32 pending envelopes). For private MCP calls it exposes only
the original call identity with empty arguments and the validated app review
reference; nested private hints, arguments and extra payload fields are removed.
The browser fetches exact review arguments through the authenticated review API.
Malformed, oversized or incomplete confirmations fail closed. Snapshot projection
also indexes confirmation identities before results, preventing an out-of-order
confirmation reply from exposing a private payload. Before a private connector
call, non-MCP confirmation contracts remain unchanged within those bounds. After
one, unexpected confirmation arguments are withheld; only the validated native
MCP review reference survives. Subsequent tool arguments/results are private even
when the model invents a blocked first-party call. Blocking execution alone is
not sufficient diagnostic isolation. Durable projection preserves safe outcomes,
not native connector result bodies, while retaining earlier unrelated calls
and fresh invocations; snapshot projection restarts that boundary at a new user
message. Live model objects remain unchanged.

## 4.1 UI Stream Mapping

The canonical app stream surface is `hushh-webapp/components/app-ui/stream-progress-panel.tsx`. Portfolio import and Agent Chat both use that primitive so progress, optional thinking, and answer text stay visually and semantically consistent.

- `Response` renders only real assistant/model text: SSE `token` deltas, or a final non-streamed assistant result when the backend did not stream tokens. Do not simulate token streaming from placeholders, staged strings, tool names, or progress events.
- `Activity` renders app-owned lifecycle events: `tool_start`, `tool_waiting`, `tool_result`, route/action settlement, import stages, cancellation state, backend progress frames, and validated AG-UI `ACTIVITY_SNAPSHOT`/`ACTIVITY_DELTA` messages.
- `Thinking` is optional provider telemetry. It must never be required for control flow, and it must never replace app-owned progress rows.
- Authenticated One Chat may stream Gemini's provider-authored thought summaries
  into the Chat body's `Thinking summary` section. The bridge forwards only
  bounded summary text; signatures, raw events, and reasoning snapshots never
  reach the browser. Browser SDK state and saved Chat history exclude reasoning.
  The owner-bound encrypted ADK session may retain provider summaries for model
  continuation. Intro Chat does not request or display them. A model may emit
  no summaries; Activity and Response must still work normally.
- Cards do not suppress assistant clarification or warnings. Avoid duplicate prose through the authored instruction, not text stripping. Discovery history projects allowlisted metadata in invocation order, deduplicates repeated invocation IDs, and excludes provider thought parts from answer text. Restoring a descriptor never executes its original action; current eligibility must be checked again before a consent mutation.
- Ambiguous person discovery uses `one.person_selection.v1`. The browser sends its opaque selection handle separately from visible message text. The server validates its owner, thread and expiry before profile access, rejects a mismatched profile subject, and requires a new explicit choice when changing an already-selected recipient. Selection handles are not grants and must not become persistent browser state or visible labels.
- Marketplace recommendations and other proactive cards should be preloaded by the workspace/session owner, then passed into the stream surface. Do not start durable fetches from a render-only accordion path when the workspace can load them at access or turn start.
- Provider/auth details such as Vertex ADC, API-key transport, Gemini Live, or OpenAI Realtime stay below this UI contract. The UI consumes normalized token/progress/thinking events only.
- Tool-based and activity-based generative UI must pass through the versioned
  app component registry. The model may select typed content, but it cannot
  author React, HTML, CSS, routes, or action authority. Unknown activity types
  are ignored safely, and opaque scope or record references never render.
- `RUN_FINISHED` with an interrupt outcome keeps the turn awaiting its authored
  review surface. Only the resumed terminal success/error settles the turn.

## 5. UI State Machines

- Native MCP results never enter the generic debug-result payload or app-action
  parser. A connector's returned JSON cannot become an executable Hussh directive.
  Owner-visible content does not grant action authority or persistence permission.

- Native MCP confirmation references use the ephemeral `onMcpReview` Chat
  callback only after the matching AG-UI interrupt is available. They are not
  structured history descriptors or generic diagnostic tool arguments.
- `ExternalConnectorService.reviewMcpCall` retrieves the exact pending call for
  an active owner/vault review; `confirmMcpCall` returns the existing ledger's
  receipt. Both reject stale effects and mismatched references. The receipt
  travels through scrubbed `forwardedProps.mcpApproval`; the ADK resume payload
  contains only `confirmed`. Cancellation sends `confirmed: false` without a
  receipt. Uncertain resumes are not retried automatically.
- The review callback exposes the initiating validated-owner/vault-epoch guard;
  the review surface uses it for fetches and invalidates private previews when
  it changes. Resume rechecks the same guard rather than relying only on a
  component having aborted its old turn.
- `McpCallReviewCard` is the transient Chat review surface. It displays the
  registered connector label, tool label and exact inputs, serializes visible
  reviews, confirms once, and clears private inputs before resume. Unmounting
  aborts the review operation; unknown outcomes offer no execution retry.
  Expired or unavailable previews cannot be approved. A native denial returns
  before argument validation or provider access, since recovered private
  arguments are intentionally absent without an approval receipt.
- Component tests do not establish live acceptance: the governed tool roster
  still needs integration, authenticated browser/native proof and release
  gates. Private previews and receipts must not enter persistence.

- Drive state transitions from canonical `event` + `payload`.
- Do not use thought events as control-plane requirements.
- Require explicit terminal handling and resource cleanup.
- For analyze flows, route by explicit `payload.round` and `payload.phase` only.

## 6. Testing Checklist

- Add parser tests for multiline `data:` frames and remainder handling.
- Add route-level stream contract tests for envelope fields.
- Add consumer tests for terminal cleanup and missing-thought tolerance.

## 7. Operational Checklist

- Validate: `npm run typecheck`, `npm run lint -- --max-warnings=0`, `npm run test:ci`.
- Validate backend: `ruff`, `mypy`, `pytest`.
- Run manual smoke on Import / Optimize / Analyze in iOS, Android, and web.


## Direct Puppy streams

`/api/one/pod/turn/stream` emits bounded `token` deltas followed by one `done` or
`error` terminal. It shares the ordinary turn's owner/device consent, admission
and update permits. The browser keeps its abort listener through the response
body and never falls back to a cloud model for unavailable Puppy inference.

Preparation is bounded at 205 seconds. Immediately before the authenticated
direct POST, the existing dispatch callback starts a separate 170-second
inference deadline in both the stream consumer and its caller. Cold admission
does not consume that inference budget. Neither tokens nor retries extend it;
an aborted preparation cannot dispatch later. The panel reports connection
until that dispatch point, then waits for the machine's response.

HTTP edges may keep the upstream alive after browser abort. The explicit
[turn stop](../architecture/api-contracts.md#direct-puppy-turn-cancellation) joins
that existing producer using the same request identity. Duplicate stops do not
interrupt cleanup or dispatch another turn. A stopped producer ends the upstream
with `PUPPY_CANCELLED`; the bounded browser stop wait reports
`PUPPY_CANCEL_UNCONFIRMED` if settlement cannot be established. Neither code
proves a device-side stop acknowledgement. The UI retains a stopping state until
the authoritative request settles; late deltas cannot repopulate a cancelled turn.

### Local Hermes chat

The localhost `/api/hermes/chat/stream` bridge follows Hermes’s existing
session-stream lifetime: request abort and downstream cancellation abort the
same upstream request, including session preparation. The bridge releases its
reader and removes listeners on settlement. Hiding the mounted Puppy surface
does not abort a turn. The Stop control distinguishes an owner cancellation
from a connection failure and preserves partial text. This is transport
cancellation under the local Hermes disconnect contract, not a direct-pod Stop
receipt or proof that an already delivered tool effect was undone.

## Typed-chat emoji reactions

One may call `react_to_message(emoji)` during the normal typed-chat turn. The
existing AG-UI tool-result frame carries `status: shown` and a validated emoji;
an optional `clientMessageId` comes only from server-owned joined-input metadata.
The client renders one badge on the bound user bubble and excludes the call from
activity rows and diagnostics. Invalid, repeated or ignored results show nothing.
The tool does not end the answer. Reactions are not sealed in ADK history or
restored after reload. No new endpoint, SSE event, storage schema or model
classifier is introduced. Voice instructions remain gated out.
