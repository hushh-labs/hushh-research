---
phase: 03-kyc-redraft-intelligence
plan: 04
subsystem: hushh-webapp (KYC redraft consent/disclosure UI, routing override, rendering) + consent-protocol (backend redraft-llm tests)
tags: [kyc, llm-redraft, disclosure, routing, rendering, markdown, zero-knowledge, vitest, pytest, frontend]
requires:
  - "Wave 3 (03-03) client redact -> rewrite -> re-fill pipeline + runAction('redraft') LLM branch"
  - "Wave 2 (03-02) POST /redraft-llm proxy + {rewritten_template} contract"
  - "Wave 1 (03-01) ConsentScope agent.kyc.redraft.llm"
  - "buildApprovedDisclosureHtml/PlainText + KycDraftRenderModel (renderer, existing)"
provides:
  - "useAiRedraft routing override (auto / force-LLM / force-regex) in runAction('redraft')"
  - "Non-blocking AI disclosure note in the Redraft SettingsGroup"
  - "splitDraftTemplate / reassembleDraftTemplate (template-framing preservation on LLM redraft)"
  - "renderLlmRedraftHtml + wrapApprovedDisclosureShell (sanitized markdown + shared email shell)"
  - "forceBullets uniform bullet rendering for the bullet/list keyword"
  - "Frontend redact/routing vitest suite + backend test_one_email_kyc_service_llm.py (10 tests)"
affects:
  - "Closes Phase 03 (KYC Redraft Intelligence). Resolves backlog todo kyc-redraft-markdown-viewer."
tech-stack:
  added: []
  patterns:
    - "Escape-FIRST markdown->HTML string renderer (only our own tags ever emitted -> XSS-safe)"
    - "Shared email-shell wrapper so structured draft + LLM redraft share identical chrome"
    - "Deterministic template split/reassemble (recompute opening from style.formal + accountHolder; constant signature) so only the content core is LLM-rewritten"
    - "Explicit forceBullets = bulletList && !structured && !table (isolates literal bullet/list keyword)"
    - "Golden snapshot locks the outward-facing sent-email HTML across a refactor"
key-files:
  created:
    - hushh-webapp/__tests__/services/one-kyc-approved-disclosure-renderer.test.ts
    - hushh-webapp/__tests__/services/__snapshots__/one-kyc-approved-disclosure-renderer.test.ts.snap
    - consent-protocol/tests/services/test_one_email_kyc_service_llm.py
  modified:
    - hushh-webapp/app/one/kyc/page.tsx
    - hushh-webapp/lib/services/one-kyc-approved-disclosure-renderer.ts
    - hushh-webapp/lib/services/one-kyc-client-zk-service.ts
    - hushh-webapp/__tests__/services/one-kyc-client-zk-service.redact.test.ts
decisions:
  - "D-E refined post-checkpoint: the blocking 'I understand' ack gate was removed per human-verify feedback; replaced with a small NON-BLOCKING informational disclosure note ('AI rewrite — only redacted placeholders are sent, never your actual details.'). llmDisclosureAcknowledged state fully removed."
  - "D-F: useAiRedraft override (null=auto-detect / true=force LLM / false=force regex) participates in the isKeywordOnlyInstruction routing decision in runAction('redraft')."
  - "Template preservation: LLM redraft sends only the middle content; splitDraftTemplate strips the recomputed opening + constant signature, reassembleDraftTemplate restores them byte-identically (defensive matched:false -> send whole body)."
  - "Rendering unified (strategy B): LLM output renders through renderLlmRedraftHtml (sanitized markdown) inside the SAME shell as buildApprovedDisclosureHtml; the divergent htmlFromPlaintext was retired."
  - "forceBullets: the bullet/list keyword renders EVERY entry as a uniform '- label: value' / <li>, fixing the inconsistent single-bullet output."
metrics:
  completed: 2026-06-25
---

# Phase 03 Plan 04: Consent/Disclosure UI, Routing Override, Rendering Fix Summary

Completed the KYC Redraft Intelligence feature (Wave 4): the routing override toggle, the AI disclosure affordance, and the full backend + frontend test suites — then incorporated human-verification feedback (non-blocking disclosure, template-framing preservation) and fixed a user-confirmed draft-preview **rendering bug** affecting both the keyword and LLM paths. Phase 03 is now complete: a free-form instruction redacts every PII value, rewrites only the PII-free content core through the Gemini proxy, re-fills locally, and renders the result in the same themed email shell as the original draft.

## What Was Built

**Routing override + disclosure (`page.tsx`)**
- `useAiRedraft: boolean | null` state — `null` auto-detects via `isKeywordOnlyInstruction`, `true` forces the LLM path, `false` forces the regex path; wired into the `isKeyword` decision in `runAction('redraft')` and into a "Rewrite mode" selector in the Redraft SettingsGroup.
- A small **non-blocking** informational disclosure note ("AI rewrite — only redacted placeholders are sent, never your actual details.") rendered in the Redraft group.

**Tests (frontend + backend)**
- Frontend: extended `one-kyc-client-zk-service.redact.test.ts` (routing, round-trip, completeness assertion, token integrity, keyword regression).
- Backend: `consent-protocol/tests/services/test_one_email_kyc_service_llm.py` — 10 tests (scope gate, workflow-state check, scope-expansion block, no-persist `draft_body`, metadata/instruction-hash update, token-preserving prompt, return shape, regression of the keyword `redraft()`).

## Post-Checkpoint Refinements (human-verify feedback)

1. **Ack-gate removed.** The blocking "I understand" disclosure gate (`llmDisclosureAcknowledged`) was removed entirely; replaced with the non-blocking note above. The AI/keyword "Rewrite mode" toggle was kept. (commit `f35744d96`)
2. **Template-framing preservation.** Added `splitDraftTemplate` / `reassembleDraftTemplate` (`one-kyc-client-zk-service.ts`): the LLM path now sends only the middle content and reassembles the byte-identical opening + signature, so an LLM redraft can't drift the standard framing. (commits `1a42069c1`, `f35744d96`)

## Rendering Bug Fix (root cause + fix)

User-confirmed: the draft preview structure was wrong/inconsistent on **both** paths. Root cause = two divergent `htmlBody` generators plus a never-wired bullet flag (full analysis in `03-RENDERING-BUG-HANDOFF.md`). Fixed under systematic-debugging + TDD (the renderer is the actual sent-email HTML — no renderer tests existed previously).

**(a) Keyword "use bullet points" — only some entries bulleted.** `style.bulletList` was consumed only to disable the compact single-entry layout; it never rendered bullets. The stray bullet came from `approvedEntryBlock` emitting `"- label: value"` for single-line entries (classified as a list) while multi-line entries became paragraphs. **Fix:** explicit `forceBullets = bulletList && !structured && !table` (isolates the literal bullet/list keyword) renders EVERY entry as a uniform `- label: value` line (plaintext) and `<li>` (HTML). (commit `31c457d8f`)

**(b) LLM "restructure the email" — rendering breaks.** Two faults fired together: `htmlFromPlaintext` escaped the LLM's markdown literally (bullets/headings/bold shown as raw characters), and it dropped the approved-disclosure email theme (plain `<p>` vs the structured draft's cards/chrome), so a draft looked different before vs after a redraft. **Fix (strategy B):** new `renderLlmRedraftHtml` — escape-FIRST sanitized markdown subset (ATX headings, `-`/`*` bullets, `**bold**`/`*italic*`, blank-line paragraphs) — wrapped in `wrapApprovedDisclosureShell`, the shell extracted from `buildApprovedDisclosureHtml` so both paths share identical chrome. `htmlFromPlaintext` retired. A golden snapshot locks `buildApprovedDisclosureHtml` byte-for-byte across the extraction. (commit `2f6f6552e`)

This also closes the backlog item `kyc-redraft-markdown-viewer` (moved to `.planning/todos/done/`).

## Verification

- `cd hushh-webapp && npm run typecheck` -> exits 0.
- `npx eslint` on all changed files (`--max-warnings=0`) -> clean.
- `npx vitest run __tests__/services/one-kyc-approved-disclosure-renderer.test.ts` -> 13 passed (5 characterization/regression incl. golden snapshot, 2 forceBullets, 6 renderLlmRedraftHtml incl. XSS-escape + shared-shell).
- Full frontend suite: `npx vitest run` -> **1657 passed, 6 skipped, 0 failed** (267 files) — no regressions.
- Backend: `consent-protocol/tests/services/test_one_email_kyc_service_llm.py` -> 10 tests (scope gate / no-persist / scope-expansion / prompt integrity / return shape / keyword regression).

## Threat Model Compliance

- **T-03-04-01 (Repudiation — LLM used without informed consent):** disclosure note shown in the Redraft group (refined from a blocking gate to a non-blocking note per human feedback); the LLM path remains gated server-side on `agent.kyc.redraft.llm`.
- **T-03-04-02 (Tampering — auto-send):** unchanged; the rewritten draft is set as `localDraft` for human review; `send-approved-reply` is the only send path. No auto-send.
- **T-03-04-03 (Tampering — regex regression):** keyword transforms covered by the renderer characterization tests (plain/table/human/structured held stable) + the forceBullets tests.
- **T-03-04-04 (Info Disclosure — tests mock away ZK):** backend tests mock only Gemini and assert `draft_body` is never in the `_update_workflow` kwargs.
- **XSS (dangerouslySetInnerHTML):** `renderLlmRedraftHtml` escapes before applying markdown, so only its own tags are emitted; underscore emphasis intentionally unsupported so re-substituted PII with underscores is never mangled. Unit-tested with a `<script>` payload.
- **ZK contract:** preview/sent HTML is derived only from the locally re-substituted plaintext; no backend plaintext rendering was reintroduced.

## Deviations from Plan

- **D-E disclosure changed from blocking to non-blocking** per human-verify feedback (see Refinements). The exact original D-E ack-gate string and `llmDisclosureAcknowledged` state were removed; the informational note conveys the same disclosure without blocking.
- **Rendering bug fix added to the plan's scope** by user decision (fix now, in this phase) — not in the original 03-04 task list; handled via TDD with the new renderer test suite.
- Tests use **vitest** (not the `jest` referenced in the plan acceptance text) and **pytest**, matching the projects' actual runners.

## Commits

- `2a4d35d8f` feat(03-04): add LLM disclosure banner + AI/keyword routing toggle to Redraft UI
- `0878675e7` test(03-04): complete frontend + backend redraft-LLM unit suites
- `1a42069c1` feat(03-04): preserve KYC draft template framing on LLM redraft
- `f35744d96` feat(03-04): non-blocking AI disclosure + content-only LLM redraft
- `31c457d8f` fix(03-04): render every entry as a uniform bullet on bullet-points keyword
- `2f6f6552e` fix(03-04): unify LLM-redraft rendering via sanitized markdown + shared shell

## Self-Check: PASSED

- `hushh-webapp/lib/services/one-kyc-approved-disclosure-renderer.ts` — FOUND (modified)
- `hushh-webapp/lib/services/one-kyc-client-zk-service.ts` — FOUND (modified)
- `hushh-webapp/app/one/kyc/page.tsx` — FOUND (modified)
- `hushh-webapp/__tests__/services/one-kyc-approved-disclosure-renderer.test.ts` — FOUND (created)
- `consent-protocol/tests/services/test_one_email_kyc_service_llm.py` — FOUND (created)
- commits `31c457d8f`, `2f6f6552e` — FOUND in git log
