---
name: streaming-contracts
description: Use when changing SSE events, streaming payload contracts, parser behavior, degraded-state handling, or provider-specific streaming notes.
---

# Hushh Streaming Contracts Skill

## Purpose and Trigger

- Primary scope: `streaming-contracts`
- Trigger on SSE events, streaming payload contracts, parser behavior, degraded-state handling, and provider-specific streaming implementation notes.
- Avoid overlap with `quality-contracts` and `backend-api-contracts`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `security-audit`

Owned repo surfaces:

1. `docs/reference/streaming`
2. `hushh-webapp/lib/streaming`
3. `hushh-webapp/__tests__/streaming`
4. `consent-protocol/api/routes/sse.py`
5. `consent-protocol/api/routes/kai/stream.py`
6. `consent-protocol/api/routes/kai/_streaming.py`

Non-owned surfaces:

1. `security-audit`
2. `backend`
3. `frontend`

## Do Use

1. SSE event and payload contract work.
2. Frontend parser or client-stream behavior that must stay aligned with backend stream semantics.
3. Streaming degraded-state, provider-note, or implementation-guide updates.

## Do Not Use

1. Broad security or backend intake where the correct spoke is still unclear.
2. Generic API contract work outside streaming.
3. General quality policy when streaming is not the main contract.

## Read First

1. `docs/reference/streaming/streaming-contract.md`
2. `docs/reference/streaming/streaming-implementation-guide.md`
3. `docs/reference/streaming/vertex-ai-streaming-notes.md`

## Workflow

1. Treat backend events, frontend parsers, and streaming docs as one contract surface.
2. Keep degraded-state handling explicit in both docs and tests.
3. Route broad quality-policy work to `quality-contracts` and broad backend routing to `backend`.

## Handoff Rules

1. If the request is still broad or ambiguous, route it back to `security-audit`.
2. If the task becomes general quality-policy work, use `quality-contracts`.
3. If the task becomes general backend API contract work, use `backend-api-contracts`.

## Required Checks

```bash
cd hushh-webapp && npm test -- __tests__/streaming/sse-parser.test.ts
cd consent-protocol && python3 -m pytest tests/test_kai_stream_contract.py -q
```
