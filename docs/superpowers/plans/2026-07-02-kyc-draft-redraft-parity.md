# KYC Draft/Redraft Parity + Frontend Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a KYC email redraft render with the same structured layout (holdings tables + key/value cards) as the first draft, and clear the frontend consistency debt around the KYC draft surface.

**Architecture:** One rendering path — both the first draft and the LLM redraft build their HTML from the same block primitives (`draftSubBlocks` → `blockToRenderBlocks` → `htmlRenderBlock`). The redraft stays LLM-only; the divergence is fixed purely in the renderer, not by reviving deterministic keyword routing. Two new fail-closed guardrails (empty/blocked LLM response; structure-loss fallback) preserve the last good draft.

**Tech Stack:** TypeScript, Next.js (App Router), Jest (`hushh-webapp` test suite via `npm test`).

## Global Constraints

- Frontend only — no changes under `consent-protocol/`, no backend contract changes. (from spec: Surface, Non-goals)
- Zero-knowledge invariant: PII values never leave the client un-tokenized; the token map and real values stay in the browser. Do not weaken `redactDraftForLlm` / `validateTokenIntegrity`. (from spec: Non-goals)
- Redraft stays **LLM-only**; do not re-wire deterministic keyword routing into the UI. (from spec: Decision 2026-07-02)
- All new guardrails fail closed — on any failure the user keeps the last good draft. (from spec: Error handling)
- Reply signature framing must stay byte-identical between the first-draft renderer and the redraft renderer, or `splitDraftTemplate` breaks. (from spec: Risks)
- Run the webapp test suite from `hushh-webapp/` with `npm test`.

---

### Task 1: Shared signature markup constant

Extract the reply signature HTML currently inlined in `buildApprovedDisclosureHtml` into a shared constant so the new redraft renderer emits byte-identical framing.

**Files:**
- Modify: `hushh-webapp/lib/services/one-kyc-approved-disclosure-renderer.ts` (`buildApprovedDisclosureHtml`, ~`:510-558`)
- Test: `hushh-webapp/__tests__/services/one-kyc-approved-disclosure-renderer.test.ts`

**Interfaces:**
- Produces: `disclosureSignatureHtml(): string` — module-internal function returning the `<p>…Best,<br/>hussh One</p>` signature block. (Consumed by Task 2.)

- [ ] **Step 1: Write the failing test**

Add to `__tests__/services/one-kyc-approved-disclosure-renderer.test.ts`:

```ts
import { buildApprovedDisclosureHtml } from "@/lib/services/one-kyc-approved-disclosure-renderer";

test("disclosure HTML contains the canonical signature block", () => {
  const html = buildApprovedDisclosureHtml({
    contractId: "agent_kyc.approved_disclosure_formatter.v1",
    contractVersion: "1.0.0",
    accountHolder: "Jane Doe",
    style: {},
    sections: [],
    missingFields: [],
  });
  expect(html).toContain("Best,<br/>hussh One");
  expect(html).toContain(`border-top:1px solid`);
});
```

- [ ] **Step 2: Run test to verify current behavior**

Run: `cd hushh-webapp && npm test -- one-kyc-approved-disclosure-renderer`
Expected: PASS (the signature already renders). This test locks the framing before refactor.

- [ ] **Step 3: Extract the constant**

In `one-kyc-approved-disclosure-renderer.ts`, add above `buildApprovedDisclosureHtml`:

```ts
function disclosureSignatureHtml(): string {
  return `<p style="margin:0;padding-top:14px;border-top:1px solid ${EMAIL_THEME.border};color:${EMAIL_THEME.heading};font-weight:650;line-height:1.5;">Best,<br/>hussh One</p>`;
}
```

Then in `buildApprovedDisclosureHtml`, replace the inline signature string in the `content` array with `disclosureSignatureHtml()`:

```ts
  const content = [
    htmlParagraph(opening),
    sections || htmlParagraph("No requested values were present in the approved data."),
    disclosureSignatureHtml(),
  ].join('<div style="height:18px;line-height:18px;">&nbsp;</div>');
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd hushh-webapp && npm test -- one-kyc-approved-disclosure-renderer`
Expected: PASS (no snapshot changes — output is byte-identical).

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/lib/services/one-kyc-approved-disclosure-renderer.ts hushh-webapp/__tests__/services/one-kyc-approved-disclosure-renderer.test.ts
git commit -s -m "refactor(kyc): extract shared disclosure signature markup"
```

---

### Task 2: `renderStructuredRedraftHtml` — structured redraft renderer

Add a renderer that turns the resubstituted redraft body into structured HTML using the same block primitives as the first draft (tables + cards), with byte-identical shell + signature.

**Files:**
- Modify: `hushh-webapp/lib/services/one-kyc-approved-disclosure-renderer.ts`
- Test: `hushh-webapp/__tests__/services/one-kyc-approved-disclosure-renderer.test.ts`

**Interfaces:**
- Consumes: `disclosureSignatureHtml()` (Task 1); existing module-internal `draftSubBlocks`, `blockToRenderBlocks`, `htmlRenderBlock`, `htmlParagraph`, `wrapApprovedDisclosureShell`, and `DRAFT_SIGNATURE` semantics.
- Produces: `export function renderStructuredRedraftHtml(body: string): string` — parses a full reply body (opening line + blocks + trailing `Best,\nhussh One`) into structured HTML. (Consumed by Task 3.)

- [ ] **Step 1: Write the failing test**

Add to `__tests__/services/one-kyc-approved-disclosure-renderer.test.ts`:

```ts
import { renderStructuredRedraftHtml } from "@/lib/services/one-kyc-approved-disclosure-renderer";

const REDRAFT_BODY = [
  "I am replying on behalf of Jane Doe.",
  "",
  "Holdings",
  "- AAPL: 100 shares; $20,000 value; $200 price; +$1,000 gain/loss; equity",
  "- MSFT: 50 shares; $15,000 value; $300 price; +$500 gain/loss; equity",
  "",
  "Best,",
  "hussh One",
].join("\n");

test("renderStructuredRedraftHtml renders a holdings table, not bullets", () => {
  const html = renderStructuredRedraftHtml(REDRAFT_BODY);
  expect(html).toContain("<table");
  expect(html).toContain("AAPL");
  expect(html).toContain("Best,<br/>hussh One");
});

test("renderStructuredRedraftHtml renders plain narrative as a paragraph", () => {
  const html = renderStructuredRedraftHtml("Thanks for reaching out.\n\nBest,\nhussh One");
  expect(html).toContain("Thanks for reaching out.");
  expect(html).not.toContain("<table");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npm test -- one-kyc-approved-disclosure-renderer`
Expected: FAIL — `renderStructuredRedraftHtml is not a function` / not exported.

- [ ] **Step 3: Implement the renderer**

In `one-kyc-approved-disclosure-renderer.ts`, add near `renderLlmRedraftHtml`:

```ts
/**
 * Structured redraft renderer (zero-knowledge, LLM-only path).
 *
 * Parses the resubstituted redraft body with the SAME primitives as
 * buildApprovedDisclosureHtml (draftSubBlocks -> blockToRenderBlocks ->
 * htmlRenderBlock) so a redraft keeps real <table> holdings and key/value cards
 * instead of collapsing to bullets. The trailing "Best,\nhussh One" signature is
 * rendered via the shared disclosureSignatureHtml() for byte-identical framing.
 */
export function renderStructuredRedraftHtml(body: string): string {
  const source = (body ?? "").replace(/\s+$/, "");
  const withoutSignature = source.endsWith(DRAFT_SIGNATURE)
    ? source.slice(0, source.length - DRAFT_SIGNATURE.length).replace(/\s+$/, "")
    : source;
  const blocks = draftSubBlocks(withoutSignature).flatMap(blockToRenderBlocks);
  const rendered = blocks.length
    ? blocks.map(htmlRenderBlock).join('<div style="height:14px;line-height:14px;">&nbsp;</div>')
    : htmlParagraph("");
  const content = [rendered, disclosureSignatureHtml()].join(
    '<div style="height:18px;line-height:18px;">&nbsp;</div>'
  );
  return wrapApprovedDisclosureShell(content);
}
```

Note: `DRAFT_SIGNATURE` (`"Best,\nhussh One"`) is defined in `one-kyc-client-zk-service.ts:1624`. Add a local module constant in the renderer to avoid a cross-module import cycle:

```ts
const DRAFT_SIGNATURE = "Best,\nhussh One";
```

Place it near the top of the renderer module with the other constants.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd hushh-webapp && npm test -- one-kyc-approved-disclosure-renderer`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/lib/services/one-kyc-approved-disclosure-renderer.ts hushh-webapp/__tests__/services/one-kyc-approved-disclosure-renderer.test.ts
git commit -s -m "feat(kyc): structured redraft HTML renderer with table/card parity"
```

---

### Task 3: Route redraft through the structured renderer + new guardrails

Switch `runLlmRedraft` to the structured renderer, add the empty/blocked-response guard, and add the structure-loss fallback. Extend the result type.

**Files:**
- Modify: `hushh-webapp/lib/services/one-kyc-client-zk-service.ts` (`LlmRedraftResult` ~`:1696`, `runLlmRedraft` ~`:1711-1780`)
- Test: `hushh-webapp/__tests__/services/one-kyc-client-zk-service.redraft-llm.test.ts`

**Interfaces:**
- Consumes: `renderStructuredRedraftHtml` (Task 2).
- Produces: extended `LlmRedraftResult`:
  ```ts
  export type LlmRedraftResult =
    | { ok: true; draft: KycDraftBuildResult; structureFallback?: boolean }
    | { ok: false; errorCode: "TOKEN_INTEGRITY" | "FIELD_SET_CHANGED" | "LLM_EMPTY" };
  ```
  (Consumed by Task 4.)

- [ ] **Step 1: Write the failing tests**

Add to `__tests__/services/one-kyc-client-zk-service.redraft-llm.test.ts` (follow the existing setup/mocks in that file for `localDraft`, `workflow`, `exportPayloads`):

```ts
test("redraft htmlBody preserves the holdings table (parity with first draft)", async () => {
  const result = await runLlmRedraft({
    localDraft: portfolioLocalDraft,          // built via buildDraft with a financial scope
    instruction: "make it more concise",
    workflow: portfolioWorkflow,
    exportPayloads: portfolioExportPayloads,
    llmRewrite: async (tokenized) => tokenized, // echo: preserves tokens + structure
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.draft.htmlBody).toContain("<table");
  }
});

test("empty LLM response fails closed with LLM_EMPTY", async () => {
  const result = await runLlmRedraft({
    localDraft: portfolioLocalDraft,
    instruction: "make it more concise",
    workflow: portfolioWorkflow,
    exportPayloads: portfolioExportPayloads,
    llmRewrite: async () => "",
  });
  expect(result).toEqual({ ok: false, errorCode: "LLM_EMPTY" });
});

test("structure loss falls back to the deterministic structured draft", async () => {
  const result = await runLlmRedraft({
    localDraft: portfolioLocalDraft,
    instruction: "summarize",
    workflow: portfolioWorkflow,
    exportPayloads: portfolioExportPayloads,
    // Drop the Holdings block markers so the redraft can no longer form a table,
    // but keep every token so token-integrity still passes.
    llmRewrite: async (tokenized) => tokenized.replace(/Holdings\n/g, ""),
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.structureFallback).toBe(true);
    expect(result.draft.htmlBody).toContain("<table"); // deterministic draft restored
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd hushh-webapp && npm test -- one-kyc-client-zk-service.redraft-llm`
Expected: FAIL — `LLM_EMPTY`/`structureFallback` unknown; htmlBody has no `<table>` (still using `renderLlmRedraftHtml`).

- [ ] **Step 3: Update the result type**

In `one-kyc-client-zk-service.ts` replace the `LlmRedraftResult` definition (~`:1696`):

```ts
export type LlmRedraftResult =
  | { ok: true; draft: KycDraftBuildResult; structureFallback?: boolean }
  | { ok: false; errorCode: "TOKEN_INTEGRITY" | "FIELD_SET_CHANGED" | "LLM_EMPTY" };
```

- [ ] **Step 4: Wire the renderer + guardrails**

Add the import at the top of `one-kyc-client-zk-service.ts` (extend the existing renderer import):

```ts
import { renderStructuredRedraftHtml } from "@/lib/services/one-kyc-approved-disclosure-renderer";
```

In `runLlmRedraft`, after the `llmRewrite` call (~`:1733`) add the empty-response guard:

```ts
  const rewrittenTemplate = await llmRewrite(tokenizedTemplate, instruction);

  // Empty / safety-blocked response — fail closed before other checks.
  if (!rewrittenTemplate || !rewrittenTemplate.trim()) {
    return { ok: false, errorCode: "LLM_EMPTY" };
  }
```

Replace the render block at the end (~`:1763-1777`) with:

```ts
  // 6. Render the redraft through the SAME block primitives as the first draft.
  const hadTable = localDraft.htmlBody.includes("<table");
  const llmHtmlBody = renderStructuredRedraftHtml(resubstitutedBody);
  const structureLost = hadTable && !llmHtmlBody.includes("<table");

  // Structure-loss fallback (fail closed): keep the deterministic structured draft.
  if (structureLost) {
    return { ok: true, draft: revalidatedDraft, structureFallback: true };
  }

  const llmDraftHash = await sha256Hex(resubstitutedBody);
  return {
    ok: true,
    draft: {
      ...revalidatedDraft,
      body: resubstitutedBody,
      htmlBody: llmHtmlBody,
      draftHash: llmDraftHash,
    },
  };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd hushh-webapp && npm test -- one-kyc-client-zk-service.redraft-llm`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add hushh-webapp/lib/services/one-kyc-client-zk-service.ts hushh-webapp/__tests__/services/one-kyc-client-zk-service.redraft-llm.test.ts
git commit -s -m "feat(kyc): redraft renders via structured path with fail-closed fallbacks"
```

---

### Task 4: Surface new redraft outcomes in the UI

Handle the `LLM_EMPTY` error and the `structureFallback` notice in the KYC page.

**Files:**
- Modify: `hushh-webapp/app/one/kyc/page.tsx` (redraft result handling, ~`:1008-1023`)

**Interfaces:**
- Consumes: extended `LlmRedraftResult` (Task 3).

- [ ] **Step 1: Update the result handling**

Replace the `if (!result.ok) { ... }` error branch (~`:1008-1018`) with a `switch` covering all three error codes, and add a `structureFallback` notice after the success assignment:

```ts
          if (!result.ok) {
            const message =
              result.errorCode === "TOKEN_INTEGRITY"
                ? "AI output failed token integrity check — using original draft. Try again or use a simpler instruction."
                : result.errorCode === "FIELD_SET_CHANGED"
                  ? "AI output altered the consented field set — using original draft. Try again."
                  : "AI returned an empty response — using original draft. Try again.";
            setError(message);
            setRedraftInstructions("");
            return;
          }
          setLocalDrafts((current) => ({
            ...current,
            [workflow.workflow_id]: result.draft,
          }));
          if (result.structureFallback) {
            setError(
              "Couldn't apply the AI wording without breaking the layout — kept the structured draft.",
            );
          }
          setRedraftInstructions("");
          return;
```

- [ ] **Step 2: Typecheck**

Run: `cd hushh-webapp && npm run typecheck`
Expected: PASS (no type errors from the new result variants).

- [ ] **Step 3: Commit**

```bash
git add hushh-webapp/app/one/kyc/page.tsx
git commit -s -m "feat(kyc): surface empty-response and structure-fallback redraft outcomes"
```

---

### Task 5: Remove dead code (`renderLlmRedraftHtml`, `isKeywordOnlyInstruction`)

Delete the now-unused generic markdown redraft renderer and the unused keyword router; retarget their tests.

**Files:**
- Modify: `hushh-webapp/lib/services/one-kyc-approved-disclosure-renderer.ts` (`renderLlmRedraftHtml` ~`:596-657`, and `renderInlineRedraftMarkdown` if it becomes unused)
- Modify: `hushh-webapp/lib/services/one-kyc-client-zk-service.ts` (`isKeywordOnlyInstruction` ~`:1511`)
- Modify: `hushh-webapp/__tests__/services/one-kyc-client-zk-service.redact.test.ts` (drop the `isKeywordOnlyInstruction` block)
- Modify: `hushh-webapp/__tests__/services/one-kyc-approved-disclosure-renderer.test.ts` (drop any `renderLlmRedraftHtml` tests)

- [ ] **Step 1: Confirm no live callers remain**

Run:
```bash
cd hushh-webapp && grep -rnE "renderLlmRedraftHtml|isKeywordOnlyInstruction" lib app
```
Expected: no matches in `lib`/`app` (only test files reference them). If any live caller remains, stop and reassess.

- [ ] **Step 2: Delete the functions and their tests**

- Remove `renderLlmRedraftHtml` (and `renderInlineRedraftMarkdown` if now unused — re-grep to confirm) from the renderer.
- Remove `isKeywordOnlyInstruction` from `one-kyc-client-zk-service.ts`.
- Remove the `isKeywordOnlyInstruction` describe/test block from `one-kyc-client-zk-service.redact.test.ts` and any `renderLlmRedraftHtml` test from the renderer test file.

- [ ] **Step 3: Run the KYC test suite**

Run: `cd hushh-webapp && npm test -- one-kyc`
Expected: PASS (no references to removed symbols).

- [ ] **Step 4: Commit**

```bash
git add hushh-webapp/lib/services/one-kyc-approved-disclosure-renderer.ts hushh-webapp/lib/services/one-kyc-client-zk-service.ts hushh-webapp/__tests__/services/one-kyc-client-zk-service.redact.test.ts hushh-webapp/__tests__/services/one-kyc-approved-disclosure-renderer.test.ts
git commit -s -m "chore(kyc): remove dead redraft renderer and keyword router"
```

---

### Task 6: Collapse duplicate alias types

Replace the `KycDraft*` re-export aliases with the renderer's canonical types.

**Files:**
- Modify: `hushh-webapp/lib/services/one-kyc-client-zk-service.ts` (alias defs ~`:80-83`, internal usages in `buildDraft` ~`:1418-1472`)
- Modify: `hushh-webapp/__tests__/services/one-kyc-client-zk-service.redact.test.ts:34,43` (import `ApprovedDisclosureRenderModel`)

**Interfaces:**
- Removes: `KycDraftStyle`, `KycDraftRenderEntry`, `KycDraftRenderSection`, `KycDraftRenderModel`.
- Canonical types (already exported from the renderer): `RedraftTransform`, `RenderFact`, `RenderSection`, `ApprovedDisclosureRenderModel`.

- [ ] **Step 1: Find all usages**

Run:
```bash
cd hushh-webapp && grep -rnE "KycDraftStyle|KycDraftRenderEntry|KycDraftRenderSection|KycDraftRenderModel" lib app __tests__
```
Expected matches: the alias definitions + internal `buildDraft` usages in `one-kyc-client-zk-service.ts`, and `redact.test.ts:34,43`.

- [ ] **Step 2: Replace usages with canonical types**

- In `one-kyc-client-zk-service.ts`: delete the four `export type KycDraft* = …` lines; ensure `RenderFact`, `RenderSection`, `RedraftTransform`, `ApprovedDisclosureRenderModel` are imported from the renderer; replace internal uses (`KycDraftRenderSection[]` → `RenderSection[]`, `KycDraftRenderEntry[]` → `RenderFact[]`, `KycDraftRenderModel` → `ApprovedDisclosureRenderModel`).
- In `redact.test.ts`: change the import at `:34` to `import type { ApprovedDisclosureRenderModel } from "@/lib/services/one-kyc-approved-disclosure-renderer";` and the annotation at `:43` to `ApprovedDisclosureRenderModel`.

- [ ] **Step 3: Typecheck + KYC tests**

Run: `cd hushh-webapp && npm run typecheck && npm test -- one-kyc`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add hushh-webapp/lib/services/one-kyc-client-zk-service.ts hushh-webapp/__tests__/services/one-kyc-client-zk-service.redact.test.ts
git commit -s -m "refactor(kyc): drop duplicate draft type aliases for renderer types"
```

---

### Task 7: Full KYC suite + typecheck gate

- [ ] **Step 1: Run the full KYC frontend suite**

Run: `cd hushh-webapp && npm test -- one-kyc`
Expected: PASS — includes `one-kyc-client-zk-service`, `.redact`, `.redraft-llm`, `one-kyc-approved-disclosure-renderer`, `one-kyc-financial-consolidation`, `one-kyc-service`, `kyc-workflow-pkm-service`, `one-kyc-workflow-state`.

- [ ] **Step 2: Typecheck**

Run: `cd hushh-webapp && npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Confirm ZK tests intact**

Run: `cd hushh-webapp && npm test -- one-kyc-client-zk-service.redact`
Expected: PASS — no PII leak regressions; tokenization intact.

---

## Self-Review

**Spec coverage:**
- Unify rendering path → Task 2 (renderer) + Task 3 (wiring). ✓
- Stale `renderModel` → Task 3 keeps `renderModel` consistent with the block-rendered `htmlBody`. ✓
- Re-parse fallback guardrail → Task 3 (`structureFallback`). ✓
- LLM empty/blocked guardrail → Task 3 (`LLM_EMPTY`) + Task 4 (UI). ✓
- Remove dead code (`isKeywordOnlyInstruction`, `renderLlmRedraftHtml`) → Task 5. ✓
- Collapse duplicate alias types → Task 6. ✓
- Deterministic-transform revival → deferred per 2026-07-02 decision (not a task). ✓
- Tests (parity, renderModel consistency, fallback, error path, ZK green) → Tasks 2, 3, 7. ✓

**Type consistency:** `LlmRedraftResult` extended once (Task 3) and consumed with matching variants (Task 4). `renderStructuredRedraftHtml(body: string): string` defined in Task 2, imported/called in Task 3. Canonical renderer types used consistently in Task 6.

**Placeholder scan:** No TBD/TODO; every code step shows concrete code; every command has expected output.
