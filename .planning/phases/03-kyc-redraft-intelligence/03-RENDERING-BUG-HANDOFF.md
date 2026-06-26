# Phase 03 — KYC Redraft Rendering Bug: Session Handoff

> Written mid-session because context hit 100%. Read this top-to-bottom before resuming.
> Branch: `feature/agent-pkm-update-intent`. Lightweight GSD project — there is **no**
> `.planning/STATE.md`, `ROADMAP.md` (config.json now exists, untracked, only holds
> `workflow._auto_chain_active`). SUMMARYs + atomic commits are the source of truth.

---

## 1. Where Phase 03 stands

`/gsd-execute-phase 03` was run. Phase = **KYC Redraft Intelligence**, 4 strictly-sequential
plans (one per wave). Executors ran in **sequential mode on the main tree** (no worktrees —
single-plan waves, `branching_strategy: none`).

| Plan | What | Status | Commits |
|------|------|--------|---------|
| 03-01 | `agent.kyc.redraft.llm` consent scope + manifest carve-out | ✅ SUMMARY written | b5cc4382d, 1c6dc4622, 82102b2e2 |
| 03-02 | Backend redact-safe LLM proxy `POST /redraft-llm` (no-persist) | ✅ SUMMARY written | d5065a425, a29c4e30e, c79e3b6ea, 5b2e32101 |
| 03-03 | Client redact→rewrite→re-fill pipeline | ✅ SUMMARY written | bb25f3fe8, a9bb081cd, dd2e6a876 |
| 03-04 | Consent/disclosure UI + tests (autonomous:false, human-verify) | ⏸ impl done, **SUMMARY NOT written** | 2a4d35d8f, 0878675e7 |
| 03-04 refinements | (post-checkpoint feedback) | ⏸ done, **SUMMARY NOT written** | 1a42069c1, f35744d96 |

**Refinements already applied** (from human-verify feedback, both committed):
1. **Removed the blocking "I understand" disclosure ack gate** — kept a small non-blocking
   informational note ("AI rewrite — only redacted placeholders are sent…"). `llmDisclosureAcknowledged`
   state fully removed. AI/keyword "Rewrite mode" toggle (`useAiRedraft`) kept.
2. **Template preservation** — added `splitDraftTemplate` / `reassembleDraftTemplate`
   (in `one-kyc-client-zk-service.ts`); LLM path now sends only the middle content and
   reassembles the byte-identical opening + signature. (Signature constant in code is
   literally `"Best,\nhussh One"` — note "hussh", looks like a brand typo but mirrored
   verbatim for byte-identical reassembly.)

**Backlog todo created:** `.planning/todos/pending/kyc-redraft-markdown-viewer.md` (markdown
preview — see §4, this overlaps with the LLM-restructure bug).

**Still TODO for phase completion (do these LAST, after the bug is fixed):**
- Write `03-04-SUMMARY.md` and commit.
- Run `code_review_gate` (Skill `gsd-code-review` 03), `regression_gate`, then spawn
  `gsd-verifier` for `verify_phase_goal`. Derive the goal from `03-CONTEXT.md` (no ROADMAP.md).
- There are paused executor agents from this session but they will be gone after `/clear` —
  just dispatch fresh `gsd-executor`(s).

---

## 2. THE BUG (what to fix next)

KYC draft preview rendering "is never the same / breaks." Confirmed on **two** triggers:
- **(a) Keyword path:** typing **"use bullet points"** → only the **first** line gets a `•`,
  the rest stay plain.
- **(b) LLM path:** asking the LLM to **"restructure the email"** → rendering breaks
  (NOT yet fully reproduced this session — finish in §3 step 1).

The content TEXT is correct in the bullet case; the **structure/markup** is wrong.

### How the preview renders (shared)
`DraftReplyPreview` (`app/one/kyc/page.tsx` ~2471): if `htmlBody` present →
`dangerouslySetInnerHTML`, else `<pre>{body}</pre>`. Used for both the draft (~2047) and the
sent/approved reply (~2204). So differences come entirely from **what `htmlBody` contains**.

### Two divergent htmlBody generators = the core problem
- **Original draft + keyword redraft:** `buildApprovedDisclosureHtml(renderModel)` —
  rich email-theme HTML (sections, cards, `<ul>/<li>`, tables). File:
  `lib/services/one-kyc-approved-disclosure-renderer.ts` (~496). **This is also the actual
  SENT email HTML** (via `buildSentReplySnapshot` → `html_body`, page.tsx ~2511), so changes
  here are outward-facing — TDD required.
- **LLM redraft:** `htmlFromPlaintext(reassembledBody)` —
  `lib/services/one-kyc-client-zk-service.ts` (~1572). Only escapes text + wraps `<p>`
  paragraphs. Renders any markdown (`*` bullets, `#` headings, `**bold**`) **literally**.

→ The same logical draft looks structurally different before vs after an LLM redraft, and
neither generator reliably renders bullets/markdown.

### Root cause (a) — keyword "bullet points" — CONFIRMED via code read
- `redraftTransformFromInstructions` (renderer ~264): `bulletList` (~272) =
  `structured || table || /\b(bullet|bullets|list)\b/`. **Overloaded.**
- `style.bulletList` is consumed ONLY at lines ~295 and ~505 — to **disable** the compact
  "direct answer" single-line layout. **It never actually renders bullets.**
- The stray `•` is accidental: `approvedEntryBlock` (~234) returns `"- ${label}: ${value}"`
  (~250) for simple single-line entries → `blockToRenderBlocks` (~384, `allBullets`/`restBullets`
  branches ~407/416) sees dash-prefixed lines → emits `<ul><li>` → browser draws `•`. Entries
  that render as a natural sentence or multi-line value become `<p>` (no bullet). So only the
  entry(ies) that happen to take the dash branch get bulleted → inconsistent.
- **Fix direction:** introduce an explicit-bullet condition
  `forceBullets = style.bulletList && !style.structured && !style.table`
  (isolates the literal bullet/list keyword from table/structured which also set bulletList),
  and when true render EVERY entry as a uniform list — both plaintext (`- ` per entry in
  `buildApprovedDisclosurePlainText`/`approvedEntryBlock`) and HTML (`<ul><li>` in
  `buildApprovedDisclosureHtml`). Must NOT regress table / structured / human / holdings.

### Root cause (b) — LLM "restructure" — HYPOTHESES (verify in §3)
Most likely the same divergence, plus markdown:
1. **htmlFromPlaintext can't render structure.** LLM returns markdown (bullets/headings/bold);
   `htmlFromPlaintext` escapes it literally → looks broken. (Same issue as the markdown-viewer
   backlog item.)
2. **Renderer switch.** After an LLM redraft, htmlBody comes from `htmlFromPlaintext`, not
   `buildApprovedDisclosureHtml` — so section cards/tables/spacing/fonts all change even when
   text is fine. This is the "structure is never the same" complaint.
3. **Template split fallback.** `splitDraftTemplate` returns `matched:false` (sends whole body,
   reassembles differently) if the opening/signature don't match exactly — e.g. on a *second*
   redraft where a prior LLM pass already altered the framing. Check whether matched is
   true/false in the failing repro.
4. **Token-integrity fallback.** If `validateTokenIntegrity` fails, the path early-returns to
   the prior draft with an error — confirm this isn't silently firing.

---

## 3. Plan for next session (systematic-debugging discipline)

User decision already made: **fix the bullet bug NOW, in this phase** (not deferred). Treat
the LLM-restructure breakage as part of the same rendering root-cause.

1. **Finish reproducing (b).** Run the app, do an LLM "restructure the email" redraft, capture
   the actual `htmlBody` string and the raw LLM `rewritten_template`. Confirm which of the four
   hypotheses fire (log/inspect `matched`, integrity result, and whether output is markdown).
2. **Decide unified rendering strategy** (the real fix — pick one, discuss with user):
   - **A.** Make `htmlFromPlaintext` a proper **sanitized markdown renderer** (bullets, headings,
     bold, paragraphs). Closes the markdown backlog item too. MUST sanitize (XSS from LLM
     output) and stay ZK-safe (render only from the locally re-substituted plaintext — never
     reintroduce backend plaintext rendering). Lowest-risk for the LLM path; does not touch
     the sent-email structured renderer.
   - **B.** Route LLM output back through a structured renderer. Hard — LLM returns free text,
     not a renderModel.
   - **C.** Keep both renderers but make them produce visually consistent structure. Most work.
   - Recommendation to evaluate first: **A** for the LLM path + the dedicated `bulletList`
     wiring fix in `buildApprovedDisclosureHtml`/`buildApprovedDisclosurePlainText` for the
     keyword path.
3. **TDD.** No renderer tests exist yet. Create
   `hushh-webapp/__tests__/services/one-kyc-approved-disclosure-renderer.test.ts` (vitest, NOT
   jest). Failing tests first:
   - "bullet points → every entry is an `<li>` (HTML) and a `- ` line (plaintext)";
   - regression: table / structured / human / holdings still render as before;
   - if doing strategy A: markdown bullets/headings/bold from LLM output render as real HTML,
     output is sanitized, opening+signature preserved.
4. **Implement** the single root-cause fix per strategy, run `npm run typecheck` + vitest +
   eslint clean.
5. **Finalize phase** (see §1 "Still TODO"): write 03-04-SUMMARY.md, code-review gate,
   regression gate, gsd-verifier, then phase completion.

---

## 4. Key files & line anchors (approx — re-grep, file is changing)

- `hushh-webapp/lib/services/one-kyc-approved-disclosure-renderer.ts`
  - `redraftTransformFromInstructions` ~264; `bulletList` def ~272
  - `approvedEntryBlock` ~234 (the `- label: value` at ~250); `sectionPlainBlocks` ~253
  - `buildApprovedDisclosurePlainText` ~281 (opening/content/signature; bulletList guard ~295)
  - `blockToRenderBlocks` ~384 (list/table/paragraph classification; bullets ~407/416)
  - `htmlList` ~445 (`<ul><li>`); `buildApprovedDisclosureHtml` ~496 (bulletList guard ~505)
- `hushh-webapp/lib/services/one-kyc-client-zk-service.ts`
  - `buildDraft` ~1355 (sections/entries from approved values)
  - `htmlFromPlaintext` ~1572; `splitDraftTemplate` ~1625; `reassembleDraftTemplate` ~1659
  - `redactDraftForLlm`, `resubstituteDraft`, `validateTokenIntegrity` (~1480+)
- `hushh-webapp/app/one/kyc/page.tsx`
  - redraft `runAction` ~991–1150 (LLM path ~1006–1098, keyword path ~1100–1150)
  - `DraftReplyPreview` ~2471; draft render ~2047; sent/approved render ~2204
  - `buildSentReplySnapshot` ~2511 (sent-email html_body)
- Tests: `hushh-webapp/__tests__/services/one-kyc-client-zk-service.redact.test.ts` (vitest)
- Phase context: `.planning/phases/03-kyc-redraft-intelligence/03-CONTEXT.md`, `03-RESEARCH.md`,
  `03-0{1,2,3}-SUMMARY.md`, `03-04-PLAN.md`

## 5. Guardrails (do not regress)
- ZK contract: real PII values NEVER leave the browser; only `{{F0}}`-style tokens go to the
  LLM. Preview HTML must be derived from locally re-substituted plaintext.
- `buildApprovedDisclosureHtml` = the actual sent email — any change is outward-facing; TDD.
- Sanitize any markdown→HTML (XSS via LLM output).
- Project uses **vitest**, not jest. Commits atomic, reference `03-04`. No `--no-verify`.
