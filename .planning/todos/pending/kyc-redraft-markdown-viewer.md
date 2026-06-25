---
type: enhancement
created: 2026-06-25
resolves_phase:
area: hushh-webapp / One KYC Redraft Intelligence
priority: low
status: pending
---

# KYC redraft draft preview: render markdown

## Context
Future scope flagged during Phase 03 (KYC Redraft Intelligence) human verification.

When the user asks for bulleted points, the LLM returns markdown (e.g. `* item`).
The draft preview currently uses `htmlFromPlaintext()` in
`hushh-webapp/lib/services/one-kyc-client-zk-service.ts`, which only escapes text
and wraps paragraphs — so markdown syntax renders literally (a leading `*` shows
as `*` instead of a bullet).

## Ask
Enhance the KYC draft preview to render markdown (at minimum: bullet lists,
bold/italic, headings) instead of showing raw markdown characters. Likely a
markdown→sanitized-HTML renderer feeding `DraftReplyPreview` / `htmlBody`.

## Constraints
- Must remain ZK-safe: still derive preview HTML from the locally re-substituted
  plaintext; do not reintroduce any backend plaintext rendering.
- Sanitize rendered HTML (no XSS via LLM output).
