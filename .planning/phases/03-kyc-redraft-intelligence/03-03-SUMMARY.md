---
phase: 03-kyc-redraft-intelligence
plan: 03
subsystem: hushh-webapp (KYC client redact -> rewrite -> re-fill pipeline)
tags: [kyc, llm-redraft, pii-tokenization, zero-knowledge, token-integrity, vitest, frontend]
requires:
  - "POST /api/one/kyc/workflows/{id}/redraft-llm + {rewritten_template} contract (Wave 2 / 03-02)"
  - "ConsentScope agent.kyc.redraft.llm gated server-side (Wave 1 / 03-01, Wave 2 enforcement)"
  - "OneKycClientZkService.buildDraft + KycDraftBuildResult.approvedValues (existing)"
  - "sha256Hex export (existing, one-kyc-client-zk-service.ts:105)"
provides:
  - "redactDraftForLlm, resubstituteDraft, validateTokenIntegrity, isKeywordOnlyInstruction, htmlFromPlaintext, KycLlmRewriteCallable (one-kyc-client-zk-service.ts)"
  - "OneKycService.redraftWithLlm static client method"
  - "LLM branch in runAction('redraft') with routing + integrity + field-key gates + html re-derive"
affects:
  - "Wave 4: disclosure/consent UI + explicit routing override + e2e tests build on this pipeline"
tech-stack:
  added: []
  patterns:
    - "Map-driven (not scan-driven) deterministic PII redaction from approvedValues"
    - "Longest-value-first substitution to avoid partial-match shadowing; insertion-order token index"
    - "Hard token-integrity gate (exactly-once per token, no invented tokens) with fall-back, never throw past it"
    - "Injectable rewrite callable (KycLlmRewriteCallable) keeps the LLM target swappable (D-G)"
    - "Plaintext-then-re-render: LLM rewrites plaintext only; preview html re-derived (escaped) from resubstituted plaintext"
key-files:
  created:
    - hushh-webapp/__tests__/services/one-kyc-client-zk-service.redact.test.ts
  modified:
    - hushh-webapp/lib/services/one-kyc-client-zk-service.ts
    - hushh-webapp/lib/services/one-kyc-service.ts
    - hushh-webapp/app/one/kyc/page.tsx
decisions:
  - "D-B: redactDraftForLlm iterates approvedValues (map-driven) so redaction is exact and complete; real values never leave the browser; re-substitution is client-side only"
  - "D-H#1: completeness assertion throws before any network call if any value >= 3 chars survives in the tokenized template"
  - "D-H#2: validateTokenIntegrity returns false (never throws past) on dropped/duplicated/invented tokens -> fall back to prior draft"
  - "D-H#3: post-refill buildDraft re-validation compares approvedValues key set; mismatch -> fall back"
  - "D-G: rewrite is invoked through KycLlmRewriteCallable; OneKycService.redraftWithLlm is the default impl, swappable for on-device"
  - "D-F: keyword-only instructions stay on the unchanged regex path; semantic instructions route to the LLM (semantic-intent phrases override even when a keyword matches)"
  - "Preview fidelity: htmlBody re-derived via htmlFromPlaintext(resubstitutedBody), HTML-escaped, NOT reused from the stale render-model html"
metrics:
  duration: ~20m
  completed: 2026-06-25
---

# Phase 03 Plan 03: Frontend Redact -> Rewrite -> Re-fill Pipeline Summary

Built the client-side PII-tokenization pipeline that gives the KYC "Redraft" box real LLM intelligence while keeping the zero-knowledge guarantee intact: free-form instructions now redact every PII value to opaque `{{F0}}..{{FN}}` tokens before anything leaves the browser, send only the PII-free template to the Wave 2 Gemini proxy, hard-verify token integrity on the response, re-substitute the real values locally, re-validate the consented field set, and re-derive the preview HTML from the LLM output. Keyword-only instructions ("make it shorter", "bullet list") still take the unchanged fast regex path.

## What Was Built

**Task 1 — redact/refill helpers + routing detector** (`one-kyc-client-zk-service.ts`)
- `KycLlmRewriteCallable` type: `(tokenizedTemplate, instruction) => Promise<string>` — the injectable rewrite interface (D-G).
- `isKeywordOnlyInstruction(instruction)`: reuses the exact keyword regexes from `redraftTransformFromInstructions`; returns true only if at least one keyword regex matches AND no semantic-intent phrase (`rephrase|rewrite|reword|warmer|...|tone|voice|style|explain|describe`) is present; empty / no-keyword -> false (D-F).
- `redactDraftForLlm({body, approvedValues})`: builds `tokenMap` (insertion-order `F${i}` -> value), substitutes longest values first via `replaceAll` (no regex, special-char safe), then asserts no value of length >= 3 survives — throws `KYC redact incomplete: ...` otherwise (D-B, D-H#1).
- `resubstituteDraft(tokenizedTemplate, tokenMap)`: exact inverse of redact; unknown placeholders left intact (the integrity check catches those upstream).
- `validateTokenIntegrity(_tokenized, rewritten, tokenMap)`: each token must appear exactly once (count !== 1 -> false); any `{{...}}` token not in `tokenMap` -> false (invented). Returns boolean, never throws past a violation (D-H#2).
- `htmlFromPlaintext(text)`: HTML-escapes `& < > " '` (ampersand first), splits on `\n\n+` into `<p style="margin:0 0 12px 0;">` blocks, converts single `\n` to `<br/>`. Used because `DraftReplyPreview` renders `htmlBody` via `dangerouslySetInnerHTML`.

**Task 2 — service client + runAction LLM branch** (`one-kyc-service.ts`, `page.tsx`)
- `OneKycService.redraftWithLlm({userId, vaultOwnerToken, workflowId, tokenizedTemplate, instruction})`: POSTs `{user_id, tokenized_template, instruction}` to `/api/one/kyc/workflows/{id}/redraft-llm`, returns `{rewritten_template}` (mirrors the existing `redraft()` shape).
- `page.tsx` imports the five helpers + `sha256Hex` (value) + `KycLlmRewriteCallable` (type) directly.
- `runAction('redraft')`: after the `localDraft` guard, computes `isKeywordOnlyInstruction(...)`. Free-form -> LLM branch: redact -> rewrite (via injected `llmRewrite` wrapping `redraftWithLlm`) -> `validateTokenIntegrity` (fail -> setError + return, prior draft kept) -> `resubstituteDraft` -> `buildDraft` re-validation comparing `approvedValues` key sets (mismatch -> setError + return) -> build `llmDraft` with `body`, `htmlBody = htmlFromPlaintext(resubstitutedBody)`, `draftHash = await sha256Hex(resubstitutedBody)` -> `setLocalDrafts` -> return. Keyword path (`OneKycService.redraft(...)` + subsequent `buildDraft`) is completely unchanged.
- The enclosing `try/finally` (`finally { setBusy(null) }`, page.tsx) resets the busy state on every early return, so the LLM-branch returns leave the UI in a clean state without explicit `setBusy(null)` calls.

## Verification

- `cd hushh-webapp && npm run typecheck` -> exits 0.
- `npx vitest run __tests__/services/one-kyc-client-zk-service.redact.test.ts` -> 23 passed.
- Regression: `one-kyc-client-zk-service.test.ts` + `one-kyc-service.test.ts` -> 62 total passed across the 3 files, no failures.
- `grep` gates from the plan, all confirmed:
  - six exports present in `one-kyc-client-zk-service.ts`.
  - `redraftWithLlm` + `redraft-llm` URL in `one-kyc-service.ts`.
  - five helpers imported/used in `page.tsx`; `htmlFromPlaintext(resubstitutedBody)` present.
  - `revalidatedDraft.htmlBody` -> no matches (stale html not reused; the explanatory comment was reworded to avoid the literal token).
  - `sha256Hex` used as a direct `await` call (no dynamic import, no optional guard).
  - `OneKycService.redraft(` original call still present (keyword path unchanged).
  - `redraftTransformFromInstructions` count in the renderer unchanged (= 1; function not modified).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Test runner is vitest, not jest**
- **Found during:** Task 1 (test authoring).
- **Issue:** The plan's acceptance criteria reference `npx jest one-kyc-client-zk-service.redact`, but this project's test runner is vitest (`package.json: "test": "vitest run"`; `vitest.config.ts` present; no jest config). Running jest would fail outright.
- **Fix:** Wrote the unit tests for vitest (`import { describe, expect, it, vi } from "vitest"`) following the existing `__tests__/services/one-kyc-client-zk-service.test.ts` conventions (same `vi.mock` of pkm + one-kyc-service deps so the pure helpers import in isolation). Placed at `hushh-webapp/__tests__/services/one-kyc-client-zk-service.redact.test.ts` (project test dir) rather than `lib/services/__tests__/`.
- **Verified:** `npx vitest run __tests__/services/one-kyc-client-zk-service.redact.test.ts` -> 23 passed.

**2. [Rule 1 - Bug] Strict-mode undefined on regex capture group**
- **Found during:** Task 1 typecheck.
- **Issue:** In `validateTokenIntegrity`, `match[1]` is typed `string | undefined` under the project's strict TS config; passing it to `Object.prototype.hasOwnProperty.call` failed `TS2345`.
- **Fix:** Added an explicit `tokenKey === undefined` guard before the membership check (treating an undefined capture as a failed integrity check).
- **Commit:** bb25f3fe8

### Implementation notes (not deviations)
- The plan's TDD flow for Task 1 is honored by writing the helpers and a comprehensive vitest suite in the same task; both were committed together (the helpers and their tests are a single cohesive unit). All 23 behaviors from the `<behavior>` block are covered.
- The plan snippet included explicit `setBusy(null)` calls on the LLM-branch early returns. These are redundant because the existing `try { ... } finally { setBusy(null) }` already resets busy on every return path; omitted to avoid double-setting. Behavior is identical.
- The completeness-assertion unit test required a genuine leak construction (a value literally equal to a token-syntax string `{{F1}}` that gets re-introduced by a later substitution), since plain `replaceAll` removes all occurrences and cannot otherwise leave a value behind — the assertion is a correct defensive guard for the token-collision edge case.

## Threat Model Compliance

- **T-03-03-01 (Info Disclosure — real PII in tokenizedTemplate):** mitigated. `redactDraftForLlm` completeness assertion throws before the network call if any value >= 3 chars remains; unit-tested.
- **T-03-03-02 (Tampering — mangled LLM output set as draft):** mitigated. `validateTokenIntegrity` -> false -> `setError` + early return; `localDraft` never replaced. Duplicate/dropped/invented cases unit-tested.
- **T-03-03-03 (Tampering — LLM adds/drops a consented field):** mitigated. Post-refill `buildDraft` re-validation compares `approvedValues` key sets; mismatch -> `setError` + fall back.
- **T-03-03-04 (Info Disclosure / XSS — dangerouslySetInnerHTML):** mitigated. `htmlFromPlaintext` HTML-escapes all of `& < > " '` (ampersand first, no double-escape) before any markup is built; unit-tested that no raw special chars survive.
- **T-03-03-05 (EoP — free-form bypasses scope guard):** mitigated upstream. `_redraft_requests_more_data` runs server-side (Wave 2) before Gemini; the client cannot bypass it.
- **T-03-03-06 (Tampering — hardcoded LLM call blocks on-device swap):** mitigated. `KycLlmRewriteCallable` is the injection point; `redraftWithLlm` is the default impl.
- **T-03-03-SC (supply chain):** accept. Zero new npm packages; all helpers use built-in `String`/`crypto.subtle` (`sha256Hex`).

## Known Stubs

None. The pipeline is fully wired: `redraftWithLlm` calls the live Wave 2 endpoint, redaction/refill/integrity run client-side, and the preview renders the re-derived LLM html. The consent/disclosure UI prompt and the explicit routing override are intentionally deferred to Wave 4 (03-04) per the phase plan — they are UI affordances on top of this pipeline, not stubs that block this plan's goal.

## Commits

- `bb25f3fe8` feat(03-03): add redact/resubstitute/integrity/html helpers for KYC LLM redraft (Task 1, + 23 vitest tests)
- `a9bb081cd` feat(03-03): wire LLM redraft pipeline into runAction with integrity gates (Task 2)

## Self-Check: PASSED

- `hushh-webapp/lib/services/one-kyc-client-zk-service.ts` — FOUND (modified)
- `hushh-webapp/lib/services/one-kyc-service.ts` — FOUND (modified)
- `hushh-webapp/app/one/kyc/page.tsx` — FOUND (modified)
- `hushh-webapp/__tests__/services/one-kyc-client-zk-service.redact.test.ts` — FOUND (created)
- commit `bb25f3fe8` — FOUND in git log
- commit `a9bb081cd` — FOUND in git log
