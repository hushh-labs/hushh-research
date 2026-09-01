# Streaming Implementation Guide


## Visual Context

Canonical visual owner: [Streaming Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

Use this pattern for any new Kai, One Voice, Agent Chat, or portfolio-import streaming feature.

## 1. Backend Producer

- Emit SSE using canonical envelope from `consent-protocol/api/routes/kai/_streaming.py`.
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
- In Agent Chat, consume the Agent SSE protocol through `hushh-webapp/lib/services/agent-chat-client.ts`; `token` frames are the only source of incremental assistant response text.

## 4.1 UI Stream Mapping

The canonical app stream surface is `hushh-webapp/components/app-ui/stream-progress-panel.tsx`. Portfolio import and Agent Chat both use that primitive so progress, optional thinking, and answer text stay visually and semantically consistent.

- `Response` renders only real assistant/model text: SSE `token` deltas, or a final non-streamed assistant result when the backend did not stream tokens. Do not simulate token streaming from placeholders, staged strings, tool names, or progress events.
- `Activity` renders app-owned lifecycle events: `tool_start`, `tool_waiting`, `tool_result`, route/action settlement, import stages, cancellation state, backend progress frames, and validated AG-UI `ACTIVITY_SNAPSHOT`/`ACTIVITY_DELTA` messages.
- `Thinking` is optional provider telemetry. It must never be required for control flow, and it must never replace app-owned progress rows.
- Marketplace recommendations and other proactive cards should be preloaded by the workspace/session owner, then passed into the stream surface. Do not start durable fetches from a render-only accordion path when the workspace can load them at access or turn start.
- Provider/auth details such as Vertex ADC, API-key transport, Gemini Live, or OpenAI Realtime stay below this UI contract. The UI consumes normalized token/progress/thinking events only.
- Tool-based and activity-based generative UI must pass through the versioned
  app component registry. The model may select typed content, but it cannot
  author React, HTML, CSS, routes, or action authority. Unknown activity types
  are ignored safely, and opaque scope or record references never render.
- `RUN_FINISHED` with an interrupt outcome keeps the turn awaiting its authored
  review surface. Only the resumed terminal success/error settles the turn.

## 5. UI State Machines

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
