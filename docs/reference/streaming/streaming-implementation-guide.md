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

### Private connector events

The existing `one_adk/drive_result_privacy.py` projection also covers governed
dynamic MCP names (`mcp_` followed by a 40-character lowercase hexadecimal digest).
Strip their argument chunks, raw start metadata and raw results from browser
events and persisted session copies. Preserve safe invocation identity and outcome.
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
confirmation reply from exposing a private payload. Non-MCP confirmation argument
contracts remain unchanged within the same envelope bounds.

## 4.1 UI Stream Mapping

The canonical app stream surface is `hushh-webapp/components/app-ui/stream-progress-panel.tsx`. Portfolio import and Agent Chat both use that primitive so progress, optional thinking, and answer text stay visually and semantically consistent.

- `Response` renders only real assistant/model text: SSE `token` deltas, or a final non-streamed assistant result when the backend did not stream tokens. Do not simulate token streaming from placeholders, staged strings, tool names, or progress events.
- `Activity` renders app-owned lifecycle events: `tool_start`, `tool_waiting`, `tool_result`, route/action settlement, import stages, cancellation state, backend progress frames, and validated AG-UI `ACTIVITY_SNAPSHOT`/`ACTIVITY_DELTA` messages.
- `Thinking` is optional provider telemetry. It must never be required for control flow, and it must never replace app-owned progress rows.
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
- The transport does not establish visual acceptance: the owning Chat review
  surface and governed tool roster must be wired and verified before enabling
  remote tools. Private previews and receipts must not enter persistence.

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
