# Streaming Implementation Guide


## Visual Context

Canonical visual owner: [Streaming Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

Use this pattern for any new Kai streaming feature.

## 1. Backend Producer

- Emit SSE using canonical envelope from `consent-protocol/api/routes/kai/_streaming.py`.
- Always set explicit `event:` and canonical JSON `data`.
- Mark terminal events with `terminal=true`.
- Keep payload object-only.
- Enforce `120s` timeout and emit heartbeat-safe `stage` events every `3-5s`.

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
