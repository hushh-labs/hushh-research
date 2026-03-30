# Streaming Contract (Canonical SSE)


## Visual Context

Canonical visual owner: [Streaming Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This document is the single source of truth for Kai streaming across backend, native plugins, proxy, and frontend consumers.

## Scope

This contract is mandatory for:

- Import Portfolio stream (`/api/kai/portfolio/import/stream`)
- Optimize Portfolio stream (`/api/kai/portfolio/analyze-losers/stream`)
- Analyze Stock stream (`/api/kai/analyze/stream`)

No legacy stream payload shape is supported.

## Runtime Guardrails

- `portfolio_import` timeout is `360s`.
- `portfolio_optimize` timeout is `240s`.
- `stock_analyze` timeout is `300s`.
- Producers emit heartbeat-safe `stage` updates roughly every `3-5s` while waiting for model chunks.
- Terminal behavior is mandatory: every stream ends with one terminal `complete`, `aborted`, or `error`.

## Transport Format

All streams use Server-Sent Events with explicit event frames:

```text
event: <event_name>
id: <sequence>
data: <json envelope>

```

- `event` must always be present.
- `data` must be a single JSON object (canonical envelope).
- Multiline `data:` lines are allowed by SSE and must be reassembled before JSON parse.

## Canonical Envelope

```json
{
  "schema_version": "1.0",
  "stream_id": "strm_<uuid>",
  "stream_kind": "portfolio_import | portfolio_optimize | stock_analyze",
  "seq": 1,
  "event": "stage",
  "terminal": false,
  "payload": {}
}
```

Rules:

- `schema_version` is fixed to `1.0` for this release.
- `stream_id` is stable for a stream session.
- `seq` is strictly increasing within a stream.
- envelope `event` must match SSE `event:`.
- `terminal=true` is required on terminal events.
- `payload` must be an object.

## Event Sets

### Import Portfolio (`stream_kind=portfolio_import`)

- `stage`
- `chunk`
- `progress`
- `aborted` (terminal)
- `complete` (terminal)
- `error` (terminal)

Import phase values now include:
- `uploading`
- `indexing`
- `scanning`
- `extracting`
- `normalizing`
- `validating`
- `complete`

### Optimize Portfolio (`stream_kind=portfolio_optimize`)

- `stage`
- `thinking`
- `chunk`
- `aborted` (terminal, optional)
- `complete` (terminal)
- `error` (terminal)

### Analyze Stock (`stream_kind=stock_analyze`)

- `kai_thinking` (optional telemetry)
- `agent_start`
- `agent_token`
- `agent_complete`
- `agent_error` (non-terminal agent-level failure)
- `debate_round`
- `insight_extracted` (optional, debate insight telemetry)
- `decision` (terminal)
- `error` (terminal)

Analyze payload rules:

- `agent_start`, `agent_token`, `agent_complete`, `agent_error` must include:
  - `round` (`1` or `2`)
  - `phase` (`analysis` or `debate`)
- `debate_round` must include `round` and `phase=debate`.
- `decision` must include `phase=decision`.

### Decision Payload Extension (Current)

The terminal `decision` payload must include final recommendation context and degradation transparency:

```json
{
  "event": "decision",
  "phase": "decision",
  "short_recommendation": "Concise actionable recommendation",
  "company_strength_score": 7.4,
  "market_trend_label": "Bullish",
  "market_trend_score": 7.1,
  "fair_value_label": "Near fair value",
  "fair_value_score": 6.6,
  "fair_value_gap_pct": -2.3,
  "analysis_updated_at": "2026-02-22T02:15:12Z",
  "analysis_degraded": false,
  "degraded_agents": [],
  "stream_id": "strm_<uuid>",
  "llm_calls_count": 0,
  "provider_calls_count": 0,
  "retry_counts": { "llm": 0, "providers": 0 },
  "analysis_mode": "full_stream | lean_stream | degraded"
}
```

Notes:
- `short_recommendation` is mandatory in terminal decision output.
- `company_strength_score`, `market_trend_score`, and `fair_value_score` are additive deterministic scores in `0..10`.
- `market_trend_label`, `fair_value_label`, and `fair_value_gap_pct` are additive valuation/trend summaries derived from real decision inputs.
- `analysis_updated_at` is a UTC ISO timestamp for the final decision synthesis.
- `analysis_degraded`/`degraded_agents` are mandatory when one or more agents/providers fail.
- `stream_id` in payload should match envelope `stream_id`.

## Thought Events

Thought summaries are best-effort telemetry.

- UI must never depend on thought events for control-flow progression.
- Missing thought events is valid and must not block completion.
- Optimize `thinking` payloads normalize to:
  - `phase`
  - `message`
  - `thought`
  - `count`
  - `token_source`
  - `timestamp` (envelope-normalized)
  - `progress_pct` (envelope-normalized)
- Import extraction does not emit investor-visible thought chunks; `thought_count` remains `0` in diagnostics.
- Import `holdings_preview` is derived from confirmed parsed holding objects during stream assembly.
- Analyze stream continues to use `kai_thinking` plus `agent_token`; `agent_token` includes `token_source`.

## Parser Requirements

Consumers must use block-based SSE parsing:

1. Split by blank line terminator (`\n\n` after CRLF normalization).
2. Collect multiline `data:` lines and join with `\n`.
3. Parse JSON once per complete frame.
4. Validate canonical envelope fields.
5. Verify `frame.event === envelope.event`.
6. Stop on terminal envelope and perform deterministic cleanup.

## Prohibited Legacy Shapes

The following are invalid for new or existing stream consumers:

- payload-only lines without explicit `event:` semantics
- routing logic based on `data.type` / `data.stage` without envelope validation
- mixed nested wrappers that require shape guessing

## Compatibility Policy

Streaming changes must preserve this contract.

- New events may be added if documented here.
- Existing fields may not be removed without a version bump.
- Any contract change requires parser tests and route-contract tests updates.

## Degraded-Mode Guarantee

For `stock_analyze`, partial provider/agent failures should degrade gracefully:

- stream remains valid under canonical envelope rules,
- terminal `decision` still emits when recoverable,
- degraded metadata must be explicit (`analysis_degraded`, `degraded_agents`),
- terminal `error` is reserved for unrecoverable failures only.
