---
type: enhancement
created: 2026-06-25
resolved: 2026-06-25
resolves_phase: 03
area: hushh-webapp / One KYC Redraft Intelligence
priority: low
status: resolved
---

# KYC redraft draft preview: render markdown

## Context
Future scope flagged during Phase 03 (KYC Redraft Intelligence) human verification.

When the user asks for bulleted points, the LLM returns markdown (e.g. `* item`).
The draft preview previously used `htmlFromPlaintext()` in
`hushh-webapp/lib/services/one-kyc-client-zk-service.ts`, which only escaped text
and wrapped paragraphs — so markdown syntax rendered literally (a leading `*` showed
as `*` instead of a bullet).

## Ask
Enhance the KYC draft preview to render markdown (at minimum: bullet lists,
bold/italic, headings) instead of showing raw markdown characters. Likely a
markdown→sanitized-HTML renderer feeding `DraftReplyPreview` / `htmlBody`.

## Constraints
- Must remain ZK-safe: still derive preview HTML from the locally re-substituted
  plaintext; do not reintroduce any backend plaintext rendering.
- Sanitize rendered HTML (no XSS via LLM output).

## Resolution (2026-06-25, Phase 03 / Plan 03-04 rendering-bug fix)
Resolved by `renderLlmRedraftHtml` in
`hushh-webapp/lib/services/one-kyc-approved-disclosure-renderer.ts` (commit
`2f6f6552e`). It is an escape-FIRST, sanitized markdown→HTML string renderer
(ATX headings, `-`/`*` bullets, `**bold**`/`*italic*`, blank-line paragraphs)
wrapped in the shared approved-disclosure email shell, replacing the former
`htmlFromPlaintext`. ZK-safe (runs only on locally re-substituted plaintext) and
XSS-safe (escaping before parsing means only our own tags are emitted). Covered by
`__tests__/services/one-kyc-approved-disclosure-renderer.test.ts`.
