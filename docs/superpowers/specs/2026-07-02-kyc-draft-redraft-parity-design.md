# KYC Draft/Redraft Parity + Frontend Consistency — Design

- **Date:** 2026-07-02
- **Branch:** `feat/kyc-agent-enhancements`
- **Status:** Approved (design); pending spec review
- **Phase:** 1 of 3 (KYC agent enhancement roadmap)
- **Surface:** Frontend only (`hushh-webapp`)

## Roadmap context

This is Phase 1 of a three-phase KYC agent enhancement effort. The phases are
separable and each gets its own spec → plan → implementation cycle:

1. **Phase 1 (this doc) — Draft/redraft parity + frontend consistency.**
   Frontend only, self-contained, low risk. Makes a redraft look and behave
   like the original draft, and clears the frontend consistency debt.
2. **Phase 2 — KYC as a real ADK sub-agent of One.** Backend agent runtime
   (`agents/kyc/agent.py` + `tools.py` + enriched `agent.yaml`), mirroring the
   Location/Kai templates. One already expects KYC as a specialist (metadata,
   prompt, routing, `delegate_to_kyc_agent`, A2A scope) but there is no runnable
   ADK agent on the other end. Phase 2 is the enabler for Phase 3.
3. **Phase 3 — LLM comprehension + PKM availability reasoning.** Replace the
   deterministic intake classification with an LLM step that understands what
   the incoming email is asking for and maps it to what the user actually has in
   PKM. Depends on Phase 2. One open architectural decision (where comprehension
   runs / the ZK boundary) will be resolved in the Phase 3 spec.

Phases 2 and 3 are listed here for context only. **This document specifies
Phase 1 exclusively.**

## Problem

In the `/one/kyc` "Email Helper", the first draft and a subsequent redraft are
produced by two different rendering pipelines, so they look and behave
differently:

- **First draft** (`prepareClientDraft` → `buildDraft`, no `instructions`)
  renders from a structured render model. Financial scopes are consolidated
  (`consolidateFinancialPortfolio`) before tokenization, and the render model is
  turned into structured HTML — real `<table>` holdings and key/value cards —
  via `buildApprovedDisclosureHtml` → `blockToRenderBlocks` → `htmlTable` /
  `htmlList`.
- **Redraft** (`runLlmRedraft`) flattens the draft to plaintext, sends the
  tokenized plaintext to the backend Gemini proxy, re-substitutes real values,
  then re-renders the freeform prose with `renderLlmRedraftHtml` — a generic
  markdown-ish converter with **no** table/card logic. Holdings tables collapse
  to bullets; key/value cards become plain paragraphs.

The exact parting point is `one-kyc-client-zk-service.ts:1767`
(`renderLlmRedraftHtml(resubstitutedBody)` instead of rendering from the render
model). Additional consequences and debt:

- The `renderModel` returned on the redraft result (`:1772`) is **stale** — it
  describes the structured draft, not the LLM prose now in `body`/`htmlBody`.
- Dead/unreachable code: `isKeywordOnlyInstruction` (referenced only in tests),
  and the entire `buildDraft(instructions)` + `redraftTransformFromInstructions`
  style-transform mechanism (fully built and tested, never called with
  `instructions` from the UI).
- Duplicate alias types: `KycDraftStyle` / `KycDraftRenderEntry` /
  `KycDraftRenderSection` / `KycDraftRenderModel` are pure re-exports of the
  renderer's `RedraftTransform` / `RenderFact` / `RenderSection` /
  `ApprovedDisclosureRenderModel`.
- Thin LLM error handling: an empty/safety-blocked Gemini response yields an
  empty string that only fails downstream as a generic token-integrity error.

## Goal

A redraft is structurally identical in kind to the first draft — same sections,
same consolidated financial tables, same key/value cards — with only the
requested change applied. Frontend consistency debt in the KYC draft surface is
cleared in the same pass.

### Non-goals

- No backend changes. The backend `redraft_llm` contract (tokenized template in,
  rewritten template out; `draft_body` stays NULL) is unchanged.
- No change to the zero-knowledge guarantees. PII never leaves the client
  un-tokenized; both existing fail-closed guardrails remain.
- No new LLM output schema (that is a possible Phase 3 evolution).
- No changes to intake, consent, scope selection, send, or writeback.

## Approach (chosen: A)

**One rendering path.** Every draft — first draft and redraft — produces its
final `body` / `htmlBody` from a `renderModel` via
`buildApprovedDisclosurePlainText` / `buildApprovedDisclosureHtml`.
`renderLlmRedraftHtml` is retired from the draft flow. Parity becomes a
structural property of the code, not an aspiration.

The redraft stays **LLM-only** (respecting the deliberate
`2026-06-26-kyc-redraft-llm-only` decision). The LLM continues to rewrite
*wording* within the tokenized template. After re-substitution, the resubstituted
body is rendered through a **structured redraft renderer** that reuses the exact
block primitives the first draft uses — `draftSubBlocks` → `blockToRenderBlocks`
→ `htmlRenderBlock` (which already understand the `Holdings` and `Portfolio
summary` block markers, emitting real `<table>` holdings and key/value cards).
This is the concrete form of "one rendering path": the redraft HTML is built from
the same parser/primitives as `buildApprovedDisclosureHtml`, not the generic
markdown converter.

**Decision (2026-07-02): reviving the deterministic keyword-routing path is
deferred.** Parity does not require it — the divergence lives entirely in the
HTML renderer. The deterministic `buildDraft(instructions)` +
`redraftTransformFromInstructions` machinery stays in the codebase (used by
`buildDraft` internally) but is not re-wired into the UI as a routing branch in
Phase 1. This keeps the change minimal and avoids reversing the recent LLM-only
direction.

Approaches considered and rejected:

- **B — LLM returns a structured render model (JSON) instead of prose.**
  Strongest parity by construction, but requires a new output schema, token
  integrity over structured JSON, and heavier guardrails. Out of scope for
  Phase 1; revisit in Phase 3.
- **C — Minimal: only swap the redraft renderer at `:1767`.** Smallest diff, but
  leaves the dead code, stale `renderModel`, and duplicate types in place. C is
  a strict subset of A; we take A to clear the consistency debt too.

## Components & changes

All changes are in `hushh-webapp`.

### 1. Structured redraft renderer
`lib/services/one-kyc-approved-disclosure-renderer.ts`:
- Add `renderStructuredRedraftHtml(body: string): string` that parses the
  resubstituted body with the existing `draftSubBlocks` → `blockToRenderBlocks`
  → `htmlRenderBlock` primitives (real `<table>` holdings + key/value cards),
  reusing the same shell + signature chrome as `buildApprovedDisclosureHtml`.
- Extract the signature markup into a shared constant so both builders emit
  byte-identical framing.

### 1b. Unify the redraft rendering path
`lib/services/one-kyc-client-zk-service.ts` — `runLlmRedraft` (~`:1711`):
- Replace the `renderLlmRedraftHtml(...)` call at `:1767` with
  `renderStructuredRedraftHtml(resubstitutedBody)`.
- Keep the returned `renderModel` describing the structured draft
  (`revalidatedDraft.renderModel`); the emitted `htmlBody` is now produced from
  the same block primitives, so the model is no longer misleading.

### 2. Redraft entry (unchanged wiring)
`app/one/kyc/page.tsx` — redraft action (~`:989–1021`) continues to call
`runLlmRedraft` (LLM-only). It gains handling for the new result variants
(`LLM_EMPTY` error and the `structureFallback` notice — see Error handling).

### 3. Deterministic style transforms — deferred (not in Phase 1)
Per the 2026-07-02 decision, the deterministic `buildDraft(instructions)` +
`redraftTransformFromInstructions` routing is **not** re-wired into the UI in
Phase 1. It stays available in the codebase for a future phase if we want
keyword-driven restyling. Parity is achieved without it.

### 4. Remove dead code
- Delete `isKeywordOnlyInstruction` and retarget/remove its test-only
  references.
- Remove `renderLlmRedraftHtml` from the draft flow. (Keep the function only if
  another caller exists; searches show it is used solely by the redraft path —
  if so, delete it.)

### 5. Collapse duplicate alias types
Replace the `KycDraft*` re-export aliases with direct use of the renderer's
canonical types (`RedraftTransform`, `RenderFact`, `RenderSection`,
`ApprovedDisclosureRenderModel`). Single source of truth.

## Data flow (redraft, after change)

```
approved values
  → buildDraft → renderModel
  → buildApprovedDisclosurePlainText (plaintext template)
  → splitDraftTemplate (isolate fixed opening + signature)
  → redactDraftForLlm  ({{Fn}} tokens; PII map stays client-local)
  → llmRewrite(tokenizedTemplate, instruction)   [backend Gemini, wording only]
  → validateTokenIntegrity                        [fail-closed]
  → resubstituteDraft + reassembleDraftTemplate
  → re-parse into renderModel (blockToRenderBlocks)
  → buildApprovedDisclosureHtml / PlainText       [unified renderer]
  → field-key-set unchanged guard                 [fail-closed]
  → { body, htmlBody, renderModel (consistent), draftHash }
```

## Error handling / guardrails

All guardrails are fail-closed and preserve the last good draft:

- **Token integrity fail** → keep prior draft, surface error (existing).
- **Field-key set changed** (scope-expansion attempt) → keep prior draft
  (existing).
- **Re-parse / render mismatch** (LLM prose no longer parses into the structured
  model, e.g. block markers dropped) → fall back to the deterministic structured
  draft. This is Approach A's safety net; the user never sees a silently
  degraded prose draft. *(new)*
- **LLM empty / safety-blocked response** → treat as an explicit redraft failure
  with a clear user-facing message, rather than emitting an empty string that
  only fails later as a generic error. *(new)*

## Testing

- **Parity assertion:** for the same approved values, the redraft `htmlBody`
  contains the same structured elements (holdings `<table>`, key/value cards) as
  the first draft. Extend
  `__tests__/services/one-kyc-client-zk-service.redraft-llm.test.ts`.
- **renderModel consistency:** the `renderModel` returned by a redraft matches
  the emitted `body` / `htmlBody` (regression against the stale-model bug).
- **Deterministic style transforms reachable:** tests that exercise
  `buildDraft(instructions)` restyling through the UI-facing path
  (bullets / table / formal / compact / human).
- **Fallback path:** when re-parse fails, the prior structured draft is retained
  (assert no prose-only output escapes).
- **LLM error path:** empty/blocked response surfaces a clear failure and keeps
  the prior draft.
- **ZK redaction stays green:** existing
  `one-kyc-client-zk-service.redact.test.ts` and
  `one-kyc-client-zk-service.test.ts` continue to pass (no PII leak; tokenization
  intact).
- **Dead-code cleanup:** remove or retarget `isKeywordOnlyInstruction` tests;
  ensure no remaining references to `renderLlmRedraftHtml` in the draft flow.

## Key file references

- First draft: `app/one/kyc/page.tsx:723`, `:800`;
  `lib/services/one-kyc-client-zk-service.ts:1403`, `:1465–1476`;
  `lib/services/one-kyc-financial-consolidation.ts:187`.
- Structured HTML renderer: `lib/services/one-kyc-approved-disclosure-renderer.ts:398`,
  `:442`, `:459`, `:491`, `:510`, `:568`.
- Redraft: `app/one/kyc/page.tsx:964`, `:989–1006`;
  `lib/services/one-kyc-client-zk-service.ts:1711`, `:1721`, `:1733`, `:1751`,
  **`:1767`** (divergence point), `:1771–1776`;
  `lib/services/one-kyc-approved-disclosure-renderer.ts:596` (`renderLlmRedraftHtml`).
- Dead / aliased: `lib/services/one-kyc-client-zk-service.ts:1511`, `:80–83`,
  `:1624` / `:1630`.

## Risks

- **Re-parse reliability:** the LLM may drop the block markers
  (`Holdings` / `Portfolio summary`) the parser keys on. Mitigated by the
  fail-closed fallback to the deterministic structured draft.
- **Opening/signature coupling:** `computeDraftOpening` / `DRAFT_SIGNATURE` must
  stay byte-identical to the renderer's opening/signature or `splitDraftTemplate`
  falls back to whole-body handling. Called out so the unification keeps a single
  source for these strings where practical.
