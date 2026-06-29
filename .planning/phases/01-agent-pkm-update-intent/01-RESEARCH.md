# Phase 01: Agent PKM Update Intent - Research

**Researched:** 2026-06-24
**Domain:** Agent chat tool dispatch / PKM write pipeline / UI review panel
**Confidence:** HIGH (all findings verified from source code in this session)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- D-01: A new tool `pkm.update` must be added to Kai's tool definitions and system prompt alongside `pkm.add`.
- D-02: LLM must route PKM update intents to `pkm.update`, not to a route navigation action.
- D-03: No frontend regex interceptor — intent classification stays in the LLM.
- D-04: LLM uses loaded PKM domain metadata (from `AgentPkmContextStore`) to self-identify the target domain.
- D-05: Three confirmed user PKM domains: `identity`, `finance_portfolio`, `financial_domain`. Domain keys are arbitrary strings the LLM reads from context.
- D-06: LLM does NOT ask the user to pick a domain — it infers. May surface `candidate_domain_choices` if uncertain.
- D-07: `pkm.update` tool slots: `domain`, `field_path`, `proposed_value`, `current_value`.
- D-08: Reuse existing `AgentPkmReviewPanel` — do not build a new panel.
- D-09: Extend the panel with a `mode: "update"` prop that shows current → proposed value side by side. Same dismiss/confirm callbacks.
- D-10: User confirms → backend write executes. User dismisses → no write, no side effects.
- D-11: New flow applies only to PKM update intents. `pkm.add` flow is untouched.
- D-12: Non-PKM navigation actions continue to fire `router.push`. This is correct, not broken.
- D-13: General questions and analysis — LLM answers normally with no change.

### Claude's Discretion
- Exact merge strategy for the write (field-level patch vs. full domain re-write) — use `PkmWriteCoordinator` as-is.
- Whether `pkm.update` preview call reuses the existing preview endpoint or gets its own — researcher to decide (see Section 4 below).

### Deferred Ideas (OUT OF SCOPE)
None.
</user_constraints>

---

## Summary

This phase adds a `pkm.update` tool path to the agent chat pipeline. The existing `pkm.add` path is a complete and working template: the LLM emits a tool call with `actionId: "pkm.add"`, the frontend intercepts it in `executeFrontendTool` before it reaches `executeAgentGatewayAction`, calls a preview API, and shows `AgentPkmReviewPanel` for confirmation. The `pkm.update` handler must follow this exact pattern.

The Kai action gateway JSON (`kai-action-gateway.vnext.json`) does NOT currently contain a `pkm.update` or `pkm.add` action entry. Both `pkm.add` and `pkm.update` are handled by a frontend early-exit guard in `executeFrontendTool` that checks `toolEvent.actionId` before delegating to the gateway. This means the gateway JSON does not need a new entry for `pkm.update` — the frontend short-circuits before gateway lookup.

The `AgentPkmIntentFrame` and `AgentPkmPreviewCard` types have `mutation_intent` and `intent_class` fields but no enumeration of allowed values. The string `"update"` is not present anywhere in the codebase as a `mutation_intent` value — it is genuinely missing and needs to be introduced both in the LLM backend tool definition and in the frontend handler.

**Primary recommendation:** Clone the `executePkmAddTool` function to `executePkmUpdateTool`, intercept `pkm.update` in `executeFrontendTool` before the gateway dispatch, call the existing `/api/pkm/agent-lab/structure` endpoint with the slots as context, and extend `AgentPkmReviewPanel` with a `mode` prop and `currentValue` display.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Intent classification (update vs navigate) | Kai LLM backend | — | D-01, D-03: LLM owns intent routing |
| Tool call dispatch to frontend handler | Frontend (agent-chat-workspace.tsx) | — | `executeFrontendTool` early-exit pattern |
| Domain data read (current value) | Frontend cache (PkmDomainResourceService) | Network (PKM API) | Stale-first cache, then network fallback |
| Preview/structure call | Backend Python API (`/api/pkm/agent-lab/structure`) | — | Proxied through Next.js catch-all route |
| Review UI (current → proposed diff) | Frontend (AgentPkmReviewPanel, extended) | — | D-08, D-09 |
| Backend write | PkmWriteCoordinator (frontend orchestrates) | Backend Python API | Uses same path as pkm.add |
| Cache invalidation after write | AgentPkmContextStore.invalidateUser | PkmDomainResourceService.invalidateDomain | Both are called by addToPKM already |

---

## 1. Kai Tool Registry — pkm.update Definition

### Current state of the gateway JSON

The file `hushh-webapp/contracts/kai/kai-action-gateway.vnext.json` is **generated** by `hushh-webapp/scripts/voice/generate-kai-action-gateway.mjs`. It aggregates `*.voice-action-contract.json` files from across the repo. The generator merges surface contracts and writes a combined gateway.

**Critical finding:** The `pkm.add` action does NOT exist in the gateway JSON. A search for `"pkm.add"` and `"pkm.update"` in the JSON returns zero matches. The only PKM-related actions in the gateway are:

- `route.profile_pkm_agent_lab` — navigation action to `/one/pkm`
- `profile.pkm.preview_capture` — voice tool in PKM Agent Lab page
- `profile.pkm.save_capture` — voice tool in PKM Agent Lab page

**Implication:** The `pkm.add` tool call from the LLM is NOT routed through the Kai action gateway at all. It is intercepted by an `if (toolEvent.actionId === "pkm.add")` check in `executeFrontendTool` *before* `executeAgentGatewayAction` is called. This means:

1. `pkm.update` does NOT need an entry in `kai-action-gateway.vnext.json` or any `*.voice-action-contract.json`.
2. The gateway script does NOT need to be re-run.
3. The only place to register `pkm.update` handling is in `agent-chat-workspace.tsx` inside `executeFrontendTool`.

### Where the LLM tool definition lives

The `streamAgentChat` call in `agent-chat-client.ts` sends `message` and `pkmContext` to the backend agent. The backend (Python service, not in this repo) controls what tool definitions the LLM receives. The frontend sends `pkmContext` as a string that contains domain keys, summaries, and highlights.

**The `pkm.add` tool definition lives in the Kai backend (Python), not in any frontend file.** Adding `pkm.update` requires a corresponding backend change to include the new tool in the LLM's tool list. The frontend side is self-contained once the LLM emits `actionId: "pkm.update"`.

### Tool slot contract (D-07)

The LLM must emit `AgentChatToolEvent` with:
```
actionId: "pkm.update"
slots: {
  domain: string,        // e.g. "identity", "finance_portfolio"
  field_path: string,    // e.g. "personal_info.name", "contact.email"
  proposed_value: string,
  current_value: string  // what the LLM read from PKM context
}
```

These are carried in `toolEvent.slots` and accessed as `toolEvent.slots.domain`, etc.

---

## 2. pkm.add End-to-End Flow (pattern to follow)

### Full verified flow

```
User message → streamAgentChat (backend SSE)
  ↓ SSE event: tool_start (actionId="pkm.add", slots={source_text})
  ↓ onToolStart callback → executeToolIfNeeded
  ↓ executeFrontendTool
    ↓ if (toolEvent.actionId === "pkm.add") → executePkmAddTool (early exit)
      ↓ previewAgentPkmMemory({ userId, message: sourceText, currentDomains, vaultOwnerToken })
        → POST /api/pkm/agent-lab/structure
        → Returns AgentPkmPreviewResponse { cards: AgentPkmPreviewCard[] }
      ↓ getAutoSavePkmCards(cards) → cards with write_mode === "can_save"
      ↓ getReviewRequiredPkmCards(cards) → cards with write_mode === "confirm_first"
      ↓ If autoSaveCards.length > 0:
          addToPKM({ userId, cards, vaultKey, vaultOwnerToken })
            → PkmWriteCoordinator.savePreparedDomain(...)
      ↓ If reviewCards.length > 0:
          setPkmReviews([...current, { id, turnId, sourceMessage, cards, saving: false }])
          → renders <AgentPkmReviewPanel cards={review.cards} onSave onDismiss />
      ↓ onSave → handleSavePkmReview → addToPKM → success toast + loadAgentPkmContext(forceRefresh)
      ↓ onDismiss → handleDismissPkmReview → setPkmReviews(filter out review)
```

### Key state shapes

```typescript
// AgentPkmReview (workspace state per review pending)
type AgentPkmReview = {
  id: string;       // e.g. `${debugTurnId}-pkm-review`
  turnId: string;
  sourceMessage: string;
  cards: AgentPkmPreviewCard[];
  saving: boolean;
};

// How it is rendered (line 2913-2921):
{pkmReviews.map((review) => (
  <AgentPkmReviewPanel
    key={review.id}
    cards={review.cards}
    saving={review.saving}
    onSave={() => void handleSavePkmReview(review.id)}
    onDismiss={() => handleDismissPkmReview(review.id)}
  />
))}
```

### What `previewAgentPkmMemory` returns

POST `/api/pkm/agent-lab/structure` (Next.js catch-all proxy → Python backend).

Request body:
```json
{ "user_id": "...", "message": "...", "current_domains": ["identity", "finance_portfolio"] }
```

Response type `AgentPkmPreviewResponse`:
```typescript
{
  agent_id: string;
  agent_name: string;
  model: string;
  used_fallback: boolean;
  routing_decision?: string;
  error?: string | null;
  intent_frame?: AgentPkmIntentFrame;       // { save_class, intent_class, mutation_intent, ... }
  candidate_payload?: Record<string, unknown>;
  write_mode?: string;
  preview_cards?: AgentPkmPreviewCard[];
  ...
}
```

Each `AgentPkmPreviewCard` has:
- `write_mode`: `"can_save"` | `"confirm_first"` | `"do_not_save"` — controls auto-save vs review
- `candidate_payload`: the data object to write
- `target_domain`: which PKM domain
- `intent_class` / `mutation_intent`: classifier strings from the backend

---

## 3. AgentPkmReviewPanel — Current Props and Extension Plan

### Current props (verified from source)

```typescript
type AgentPkmReviewPanelProps = {
  cards: AgentPkmPreviewCard[];
  saving?: boolean;
  className?: string;
  onSave: () => void;
  onDismiss: () => void;
};
```

The panel currently renders:
- Header: "Save to PKM?" with Brain icon
- Description: "Agent found durable context that needs your review before it is stored."
- Per-card: domain badge + `intent_class` label + `source_text` + `confirmation_reason`
- Buttons: Skip (onDismiss) and Save (onSave)

### Extension plan for update mode

Add two new optional props:

```typescript
type AgentPkmReviewPanelProps = {
  cards: AgentPkmPreviewCard[];
  saving?: boolean;
  className?: string;
  onSave: () => void;
  onDismiss: () => void;
  // New for update mode:
  mode?: "add" | "update";           // defaults to "add" — backward compatible
  updateContext?: {                   // present when mode === "update"
    fieldPath: string;               // e.g. "personal_info.name"
    currentValue: string;
    proposedValue: string;
    domain: string;
  };
};
```

In update mode:
- Header: "Update PKM?" (instead of "Save to PKM?")
- Description: "Agent proposes a change to your saved record. Review before applying."
- Show current → proposed diff block (a two-column or arrow layout)
- Buttons remain identical: Skip / Update (label changes from "Save" to "Update")
- Same `onSave` and `onDismiss` callbacks — no interface change for callers

### Backward compatibility

Setting `mode` default to `"add"` means all existing `<AgentPkmReviewPanel>` call sites (lines 2914-2920 in workspace) compile and render exactly as today with no changes.

---

## 4. PKM Preview API Contract

### Existing endpoint

`POST /api/pkm/agent-lab/structure`

This is a Next.js catch-all proxy defined in `hushh-webapp/app/api/pkm/[...path]/route.ts`. All requests under `/api/pkm/**` are forwarded to the Python backend at `getPythonApiUrl() + /api/pkm/<path>`. There is no separate Next.js route file for `agent-lab/structure` — it routes straight through.

### Decision: reuse vs. new endpoint

**Recommendation: reuse `/api/pkm/agent-lab/structure` for the `pkm.update` preview call.**

Rationale:
- The backend already classifies intent via `intent_frame.mutation_intent`. Sending the update intent message through the same endpoint will produce a `candidate_payload` and `target_domain` the same way.
- The `pkm.update` tool slots (`domain`, `field_path`, `proposed_value`, `current_value`) can be serialized into the `message` parameter as structured context, or passed as additional body fields if the backend supports them.
- A new dedicated endpoint would require backend changes that are out of scope for the frontend phase. The frontend already owns the review UX, so it can construct the correct diff display from the slots directly without relying on backend-generated diff metadata.

**Concrete approach:**
In `executePkmUpdateTool`, the `message` passed to `previewAgentPkmMemory` can be constructed from the tool slots:
```
`Update ${domain} - ${field_path}: change from "${current_value}" to "${proposed_value}"`
```
This gives the backend enough context to generate a valid `candidate_payload`. The panel displays the diff using the original slot values (`current_value`, `proposed_value`, `field_path`) from `toolEvent.slots`, not from the preview response — the preview is for generating the write payload, not the display values.

Alternatively, `executePkmUpdateTool` can skip the preview API entirely and construct the `candidate_payload` directly from the slots (since `field_path` and `proposed_value` are already structured). This avoids a round-trip. **Call this Option B.** The tradeoff: Option A gets backend merge-mode intelligence; Option B is simpler and faster. Since `PkmWriteCoordinator.savePreparedDomain` accepts any `candidatePayload`, Option B is viable if field writes are simple key-value updates.

Leave the choice between Option A and Option B to the implementer — both are structurally sound.

---

## 5. PkmWriteCoordinator — Update vs Add

### How `savePreparedDomain` works (verified from source)

```typescript
PkmWriteCoordinator.savePreparedDomain({
  userId,
  domain,
  vaultKey,
  vaultOwnerToken,
  build: async (context) => ({
    domainData: candidatePayload,   // the new values to write
    summary: { ... },
    mergeDecision: card.merge_decision,
    structureDecision: nextStructureDecision,
    manifest: nextManifest || undefined,
  }),
})
```

Internally this does:
1. `ensureWritableVersion` — upgrades the domain if the manifest version is stale
2. `buildWriteContext` — calls `PkmDomainResourceService.prepareDomainWriteContext` to load current `baseFullBlob` and `expectedDataVersion`
3. Calls `PersonalKnowledgeModelService.storePreparedDomainWithPreparedBlob` with the merged payload
4. Retries up to 2 times on conflict (optimistic locking via `expectedDataVersion`)

**Does it support field-level patching?** No — it always writes the full `domainData` blob for the domain. The merge/conflict logic is at the domain level, not the field level. For a field update, the implementer must:
1. Load the current domain data (from `AgentPkmContextStore` which has the full decrypted blob, or via `PkmDomainResourceService.getStaleFirst`)
2. Apply the field patch to produce the new full `domainData` object
3. Pass that full object as `candidatePayload` to `savePreparedDomain`

The `build` callback receives `context.currentDomainData` which is the decrypted current state — the field patch can be applied inside `build`.

### Verification: same coordinator for update as for add

`addToPKM` calls `PkmWriteCoordinator.savePreparedDomain`. The update flow should call the same method with the same signature. No new coordinator method is needed. The planner should NOT add a new write method — use `savePreparedDomain` as-is.

### Cache invalidation after write

After a successful write, `addToPKM` calls:
```typescript
AgentPkmContextStore.invalidateUser(params.userId);
```

The `pkm.update` confirm handler should do the same, plus optionally:
```typescript
PkmDomainResourceService.invalidateDomain(userId, domain, { includeDevice: true });
```
This ensures the stale-first domain cache reflects the write immediately.

---

## 6. LLM Tool Definition Location

### Where `pkm.add` is defined for the LLM

The LLM tool definition is **not in any frontend file**. The frontend sends the user message and PKM context string to the Python backend via `streamAgentChat`. The Python backend (Kai agent service, in the `consent-protocol` repo or a separate backend) defines the LLM system prompt and tool list including `pkm.add`.

**Evidence:** `streamAgentChat` POSTs `{ user_id, message, conversation_id, pkmContext, ... }` to the backend. The response is an SSE stream that emits `tool_start` events with `action_id: "pkm.add"`. The frontend never sets the tool definition — it only handles the result.

### What needs to change on the LLM side

The Kai backend system prompt and tool list must be updated to include `pkm.update` as a new tool with the four slots from D-07:
- `domain` (string) — the PKM domain key, inferred from loaded context
- `field_path` (string) — dot-path to the field being updated
- `proposed_value` (string) — new value the user stated
- `current_value` (string) — current value from PKM context (for display, not for write authority)

The system prompt must instruct the LLM: "Use `pkm.update` when the user explicitly states a change to an existing PKM record. Read domain keys and current values from the PKM context provided. Do not navigate to a route for PKM update requests."

**This backend change is outside the frontend scope but is a prerequisite for the end-to-end flow.** The frontend handler can be implemented and tested independently using a test harness that emits a synthetic `pkm.update` tool event.

---

## 7. Existing Intent Types

### Current `AgentPkmIntentFrame` type

```typescript
export type AgentPkmIntentFrame = {
  save_class?: string;
  intent_class?: string;
  mutation_intent?: string;
  requires_confirmation?: boolean;
  confirmation_reason?: string;
  candidate_domain_choices?: AgentPkmDomainChoice[];
};
```

The fields are untyped strings — no enum or union type constrains their values. The type system does not enumerate allowed `mutation_intent` values.

### Does "update" exist as a `mutation_intent`?

**No.** A full-text search for `"update"` as a `mutation_intent` value returns zero hits across the entire webapp codebase. The backend may internally use values like `"add"`, `"merge"`, `"replace"` — but none of these appear in the frontend code either. The string value of `mutation_intent` is rendered directly by `titleize(card.intent_class)` in `AgentPkmReviewPanel` and has no frontend branching logic on it.

**Implication:** The frontend does NOT need to add a new `mutation_intent` value to any enum — it does not branch on this field. The LLM backend produces it; the review panel displays it as a label. The new `mode: "update"` prop on `AgentPkmReviewPanel` is what controls the update-specific display, not `mutation_intent`.

### `AgentPkmDomainChoice` — already exists for disambiguation

```typescript
export type AgentPkmDomainChoice = {
  domain_key: string;
  display_name: string;
  description: string;
  recommended: boolean;
};
```

This type is already present in `AgentPkmIntentFrame.candidate_domain_choices`. The LLM can emit this when uncertain about the target domain, consistent with D-06. The frontend does not yet render `candidate_domain_choices` in the review panel — this is a future concern, out of scope for this phase.

---

## 8. Project Constraints and Codex Rules

### From AGENTS.md (repo-level operating rules)

1. **Premise verification gate:** Before accepting any claim in this phase (e.g., "pkm.update is missing"), verify from source. This research has done so — `pkm.update` is genuinely absent from all frontend files.

2. **Delegation checkpoint:** This phase is frontend-scoped (single surface, bounded write set). No subagent delegation needed. Work stays local.

3. **Do not build parallel paths:** AGENTS.md explicitly says "if the capability already exists, extend or harden the existing contract." The `pkm.add` contract is the existing path — this phase extends it, not builds a new parallel path.

4. **High-risk surface — verify twice:** PKM, vault, and consent surfaces require independent verification. The vault write path (`PkmWriteCoordinator`) has been read and understood. The confirm callback MUST guard on `vaultKey && token` exactly as `executePkmAddTool` does.

### From vault-pkm-governance skill

1. Vault keys and owner tokens are memory-only runtime state. Never persist them. The `pkm.update` handler accesses `vaultKey` and `token` from component scope exactly as `executePkmAddTool` does — no new risk.

2. Keep PKM/vault upgrade diagnostics out of consumer UI. The review panel must not show raw PKM paths, manifest versions, or sync checkpoint data to users.

3. Use plain terms in UI: "Update saved record" not "mutation_intent = update". Reserve technical strings for logs and dev tools.

4. `AgentPkmContextStore.invalidateUser` must be called after a successful write to evict the decrypted session cache.

### No CLAUDE.md found at workspace root or `hushh-webapp/`

No additional project-level CLAUDE.md directives apply. The vault-pkm-governance skill and AGENTS.md are the authoritative governance layer.

---

## Key Risks

### Risk 1: Backend tool definition prerequisite
The end-to-end flow requires the Kai Python backend to emit `pkm.update` tool calls. The frontend handler can be built independently but cannot be integration-tested without the backend change. The planner should include a task to coordinate the backend tool definition change (likely in `consent-protocol`) as a prerequisite or parallel track.

**Mitigation:** A Storybook story or test harness that synthesizes a `pkm.update` `AgentChatToolEvent` lets frontend work proceed without the backend being ready.

### Risk 2: Full domain re-write vs. field patch
`PkmWriteCoordinator.savePreparedDomain` writes the full domain blob. The `build` callback receives `context.currentDomainData`. Applying a field patch requires merging `proposed_value` at `field_path` into the current domain data inside `build`. If `field_path` uses nested dot notation (e.g., `personal_info.name`), the implementer must write a path-set utility. This is straightforward but must not be hand-rolled in a fragile way.

**Mitigation:** Use a simple recursive path setter (5-10 lines) or `structuredClone` + manual path traversal. Do NOT pull in a library like `lodash.set` without legitimacy checks.

### Risk 3: `current_value` slot trust
The LLM populates `current_value` from what it read in the PKM context string. This may be stale (the context has a 5-minute TTL). The panel displays this as the "before" value. Before writing, the `build` callback reads `context.currentDomainData` which is the authoritative current state. If the LLM's `current_value` differs from the actual stored value, this is informational — the write uses the fresh domain data from the write context, not the LLM's slot value.

**Mitigation:** Display `current_value` from the LLM slot in the panel (good UX), but apply the patch to `context.currentDomainData` in the write `build` callback (correctness).

### Risk 4: Review panel state sharing (add vs. update)
The `pkmReviews` state currently holds `AgentPkmReview[]` which references `AgentPkmPreviewCard[]`. The update flow needs additional metadata (`field_path`, `current_value`, `proposed_value`). The state type must be extended without breaking existing add-flow reviews.

**Mitigation:** Extend `AgentPkmReview` with an optional `updateContext` field parallel to `AgentPkmReviewPanelProps.updateContext`. Existing add-flow reviews leave this field undefined.

---

## Implementation Order

This sequence minimizes integration risk and allows parallel backend/frontend work:

**Wave 0 — Type and state scaffolding (no behavior change)**
1. Extend `AgentPkmReview` type in `agent-chat-workspace.tsx` with optional `updateContext` field.
2. Add `mode` and `updateContext` props to `AgentPkmReviewPanel` (backward-compatible defaults).
3. Render update-mode diff block in panel when `mode === "update"`.
4. Write unit/Storybook test for panel update mode display.

**Wave 1 — Frontend handler**
5. Add `executePkmUpdateTool` function in `agent-chat-workspace.tsx` (clone of `executePkmAddTool`).
6. Add `if (toolEvent.actionId === "pkm.update")` guard in `executeFrontendTool`, parallel to `pkm.add`.
7. Inside `executePkmUpdateTool`: read slots, call `previewAgentPkmMemory` (or build payload directly), set `pkmReviews` with `mode: "update"` + `updateContext`.
8. Inside `handleSavePkmReview`: detect `review.updateContext` and call `PkmWriteCoordinator.savePreparedDomain` with the field-patched domain data.
9. Call `AgentPkmContextStore.invalidateUser` and `PkmDomainResourceService.invalidateDomain` on success.

**Wave 2 — Backend tool definition (parallel, separate PR)**
10. Add `pkm.update` tool definition to Kai backend system prompt with four slots from D-07.
11. Instruct LLM to use loaded PKM context for domain inference and field identification.
12. Integration test: send "my name changed to X" → verify `pkm.update` tool event fires with correct slots.

**Wave 3 — End-to-end test**
13. Integration test with backend wired: user message → tool event → review panel → write → context refresh.
14. Regression: verify `pkm.add` still works (unchanged code path).
15. Regression: verify navigation actions (profile, finance) still fire `router.push` unchanged.

---

## Validation Architecture

No `nyquist_validation` config found. Treating as enabled.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Jest + React Testing Library (Next.js project standard) |
| Config file | `hushh-webapp/jest.config.*` (not inspected — assumed present) |
| Quick run | `npx jest --testPathPattern=agent-pkm-review-panel --passWithNoTests` |
| Full suite | `npx jest --passWithNoTests` |

### Phase Requirements → Test Map

| Req | Behavior | Test Type | Command |
|-----|----------|-----------|---------|
| D-02 | `pkm.update` tool event does NOT trigger `router.push` | Unit | Test that `executeFrontendTool` with `actionId: "pkm.update"` never calls `router.push` |
| D-08/09 | Panel shows update mode with current → proposed diff | Unit | Render `AgentPkmReviewPanel` with `mode="update"` + `updateContext`, assert both values visible |
| D-10 | onDismiss leaves no side effects | Unit | Test `handleDismissPkmReview` does not call `addToPKM` |
| D-10 | onSave triggers write | Unit | Test `handleSavePkmReview` with update review calls `PkmWriteCoordinator.savePreparedDomain` |
| D-11 | pkm.add flow unchanged | Regression | Existing pkm.add test (or new smoke test for the add path) |

### Wave 0 Gaps

- [ ] `hushh-webapp/components/agent/__tests__/agent-pkm-review-panel.test.tsx` — covers D-08/D-09 update mode rendering
- [ ] No existing test files found for `agent-pkm-review-panel.tsx` (inferred — not verified)

---

## Security Domain

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V4 Access Control | Yes | `vaultKey && token` guard before any write — same as `executePkmAddTool` |
| V5 Input Validation | Yes | Slots are `unknown` — read with typed accessors, not raw cast |
| V6 Cryptography | Yes (via coordinator) | `PkmWriteCoordinator` owns encrypt/write — do not bypass |

**Known threat pattern:** The `current_value` slot from the LLM must not be trusted as authoritative source of truth for the write. It is display-only. The write must use `context.currentDomainData` from inside the `build` callback to avoid a stale-read → overwrite race.

---

## Sources

All findings in this research are `[VERIFIED]` from direct source code reads in this session.

| File | What was checked |
|------|-----------------|
| `components/agent/agent-chat-workspace.tsx` | `executePkmAddTool`, `executeFrontendTool`, `AgentPkmReview` type, `pkmReviews` state and render |
| `components/agent/agent-pkm-review-panel.tsx` | Full component — all props and render logic |
| `lib/agent/agent-pkm-memory.ts` | `previewAgentPkmMemory`, `addToPKM`, all exported types |
| `lib/agent/agent-pkm-context-store.ts` | `AgentPkmContextStore`, `buildContextText`, `shouldUseBroadContext` |
| `lib/agent/agent-action-runtime.ts` | `executeAgentGatewayAction`, route dispatch path |
| `lib/voice/kai-action-gateway.ts` | `KaiActionDefinition`, `KaiActionExecutionTarget`, `validateAction` |
| `contracts/kai/kai-action-gateway.vnext.json` | PKM action entries (confirmed: no `pkm.add` or `pkm.update`) |
| `lib/services/pkm-write-coordinator.ts` | `savePreparedDomain`, `saveMergedDomain`, conflict retry, `buildWriteContext` |
| `lib/pkm/pkm-domain-resource.ts` | `prepareDomainWriteContext`, `getStaleFirst`, `invalidateDomain` |
| `app/api/pkm/[...path]/route.ts` | Catch-all proxy — all PKM paths forwarded to Python backend |
| `lib/services/agent-chat-client.ts` | `AgentChatToolEvent`, SSE event parsing, `normalizeToolEvent` |
| `scripts/voice/generate-kai-action-gateway.mjs` | Generator reads `*.voice-action-contract.json` files, not inline tool defs |
| `app/profile/pkm-agent-lab/page-client.voice-action-contract.json` | PKM lab voice contract (confirmed: no `pkm.add`/`pkm.update` here either) |
| `AGENTS.md` | Premise verification gate, delegation rules, PKM governance |
| `.codex/skills/vault-pkm-governance/SKILL.md` | PKM write governance, UI language rules, cache invalidation rules |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Jest + RTL is the test framework for this project | Validation Architecture | Different framework needs different command syntax |
| A2 | The Kai LLM backend (Python) controls the tool definition list and system prompt | Section 6 | If tool defs are in a frontend config file, the change location is different — but no such file was found |
| A3 | Option A (preview API call) vs Option B (direct payload construction) — both viable | Section 4 | If the preview endpoint rejects non-natural-language messages or requires specific message format, Option A may fail and Option B becomes mandatory |

**All structural findings (types, function signatures, file locations, gateway entry counts) are VERIFIED from source code reads — not assumed.**
