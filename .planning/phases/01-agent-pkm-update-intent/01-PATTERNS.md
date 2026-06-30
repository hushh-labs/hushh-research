# Phase 01: Agent PKM Update Intent - Pattern Map

**Mapped:** 2026-06-24
**Files analyzed:** 4
**Analogs found:** 4 / 4

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `hushh-webapp/components/agent/agent-chat-workspace.tsx` | controller (tool dispatch) | event-driven | same file — `executePkmAddTool` / `executeFrontendTool` | exact (extend in-place) |
| `hushh-webapp/components/agent/agent-pkm-review-panel.tsx` | component | request-response (confirm/dismiss) | same file — existing add-mode render | exact (extend with `mode` prop) |
| `hushh-webapp/lib/agent/agent-pkm-memory.ts` | service | request-response (preview POST + write) | same file — `previewAgentPkmMemory` / `addToPKM` | exact (add new exported functions) |
| `hushh-webapp/app/api/pkm/[...path]/route.ts` | route (proxy) | request-response | same file — existing `proxyPkmRequest` | read-only; no change needed |

---

## Pattern Assignments

### `agent-chat-workspace.tsx` — add `executePkmUpdateTool` + guard in `executeFrontendTool`

**Analog:** `executePkmAddTool` in the same file (lines 1664–1776) and `executeFrontendTool` (lines 1778–1823).

**Local type to extend** (lines 118–124):
```typescript
type AgentPkmReview = {
  id: string;
  turnId: string;
  sourceMessage: string;
  cards: AgentPkmPreviewCard[];
  saving: boolean;
  // ADD for update mode:
  updateContext?: {
    domain: string;
    fieldPath: string;
    currentValue: string;
    proposedValue: string;
  };
};
```

**Imports pattern** (lines 1–100) — no new imports required; `previewAgentPkmMemory`, `addToPKM`, `AgentPkmPreviewCard`, `AgentPkmContext`, `loadAgentPkmContext` are already imported from `@/lib/agent/agent-pkm-memory` (lines 50–61). `AgentPkmReviewPanel` is already imported from `@/components/agent/agent-pkm-review-panel` (line 37).

**Vault guard pattern** (lines 1665–1672) — copy verbatim into `executePkmUpdateTool`:
```typescript
const executePkmUpdateTool = async (toolEvent: AgentChatToolEvent) => {
  if (!vaultKey || !token) {
    appendDebugEvent(debugTurnId, "pkm_tool_skipped", {
      reason: !vaultKey ? "vault_key_unavailable" : "vault_owner_token_unavailable",
      tool: toolEvent,
    });
    upsertPkmStatusMessage("Unlock your vault before saving to PKM.", "error");
    return;
  }
  // ... read slots from toolEvent.slots (domain, field_path, proposed_value, current_value)
```

**Slot access pattern** (lines 1674–1677 as analog) — slots are accessed as typed strings:
```typescript
// pkm.add reads source_text this way — mirror for pkm.update slots:
const sourceText =
  typeof toolEvent.slots.source_text === "string" && toolEvent.slots.source_text.trim()
    ? toolEvent.slots.source_text.trim()
    : text;

// For pkm.update, follow same guard pattern:
const domain =
  typeof toolEvent.slots.domain === "string" ? toolEvent.slots.domain.trim() : "";
const fieldPath =
  typeof toolEvent.slots.field_path === "string" ? toolEvent.slots.field_path.trim() : "";
const proposedValue =
  typeof toolEvent.slots.proposed_value === "string" ? toolEvent.slots.proposed_value.trim() : "";
const currentValue =
  typeof toolEvent.slots.current_value === "string" ? toolEvent.slots.current_value.trim() : "";
```

**Counter + debug pattern** (lines 1679–1685):
```typescript
setActivePkmToolCount((count) => count + 1);
appendDebugEvent(debugTurnId, "pkm_tool_preview_start", {
  tool: "pkm.add",           // change to "pkm.update"
  current_domains: turnPkmContext.domains,
  source_text: sourceText,   // replace with domain, field_path, proposed_value, current_value
});
upsertPkmStatusMessage("Checking PKM and saving what fits...", "streaming");
```

**Preview call pattern** (lines 1688–1693) — `previewAgentPkmMemory` is the function to call; the `message` param is constructed from slots:
```typescript
const preview = await previewAgentPkmMemory({
  userId,
  message: sourceText,                  // for update: build message from slots
  currentDomains: turnPkmContext.domains,
  vaultOwnerToken: token,
});
```
For `pkm.update`, the message argument should be:
```typescript
const message = `Update ${domain} - ${fieldPath}: change from "${currentValue}" to "${proposedValue}"`;
```

**Review queue push pattern** (lines 1737–1757) — this is the state write that queues a panel. For update, add `updateContext`:
```typescript
if (reviewCards.length > 0 && latestVisibleTurnIdRef.current === debugTurnId) {
  setPkmReviews((current) => [
    ...current.filter((review) => review.turnId !== debugTurnId),
    {
      id: `${debugTurnId}-pkm-review`,
      turnId: debugTurnId,
      sourceMessage: sourceText,   // for update: use the constructed message
      cards: reviewCards,
      saving: false,
      updateContext: { domain, fieldPath, currentValue, proposedValue },  // ADD
    },
  ]);
}
```

**Early-exit guard in `executeFrontendTool`** (lines 1782–1786) — mirror this block for `pkm.update` immediately after the `pkm.add` block:
```typescript
// Existing pkm.add guard (lines 1782–1786):
if (toolEvent.actionId === "pkm.add") {
  pkmAddToolHandled = true;
  await executePkmAddTool(toolEvent);
  return;
}

// New pkm.update guard — add directly below:
if (toolEvent.actionId === "pkm.update") {
  await executePkmUpdateTool(toolEvent);
  return;
}
```

**Error handling pattern** (lines 1763–1775) — copy identically into `executePkmUpdateTool`:
```typescript
} catch (error) {
  const message =
    error instanceof Error && error.message
      ? error.message
      : "Agent could not save that PKM memory.";
  appendDebugEvent(debugTurnId, "pkm_tool_failed", {
    message,
    tool: toolEvent,
  });
  upsertPkmStatusMessage("Agent could not save that PKM memory.", "error");
} finally {
  setActivePkmToolCount((count) => Math.max(0, count - 1));
}
```

**`handleSavePkmReview` extension** (lines 1378–1445) — the existing function calls `addToPKM` for all reviews. It must detect `review.updateContext` and branch:
```typescript
const handleSavePkmReview = useCallback(
  async (reviewId: string) => {
    const review = pkmReviews.find((item) => item.id === reviewId);
    const token = getVaultOwnerToken();
    if (!review || !user?.uid || !vaultKey || !token) {
      toast.error("Unlock your vault before saving to PKM.");
      return;
    }
    // ... setSaving, setActivePkmToolCount, appendDebugEvent as today

    try {
      if (review.updateContext) {
        // UPDATE PATH — use PkmWriteCoordinator.savePreparedDomain directly
        // with a build callback that applies the field patch to context.currentDomainData
        const result = await PkmWriteCoordinator.savePreparedDomain({
          userId: user.uid,
          domain: review.updateContext.domain,
          vaultKey,
          vaultOwnerToken: token,
          build: async (context) => {
            // Apply field patch at review.updateContext.fieldPath
            // to context.currentDomainData and return the full domain blob
          },
        });
        // ... success/failure handling identical to add path
      } else {
        // EXISTING ADD PATH — unchanged
        const result = await addToPKM({ ... });
      }
    }
  },
  [appendDebugEvent, getVaultOwnerToken, pkmReviews, user?.uid, vaultKey]
);
```

**Cache invalidation after update write** — copy from `addToPKM` (agent-pkm-memory.ts line 321) and add domain-level invalidation:
```typescript
AgentPkmContextStore.invalidateUser(params.userId);
// Also call:
void loadAgentPkmContext({
  userId: user.uid,
  vaultOwnerToken: token,
  vaultKey,
  forceRefresh: true,
}).catch(() => undefined);
```

**Panel render site** (lines 2913–2921) — pass `updateContext` and `mode` through to the panel:
```typescript
{pkmReviews.map((review) => (
  <AgentPkmReviewPanel
    key={review.id}
    cards={review.cards}
    saving={review.saving}
    onSave={() => void handleSavePkmReview(review.id)}
    onDismiss={() => handleDismissPkmReview(review.id)}
    mode={review.updateContext ? "update" : "add"}          // ADD
    updateContext={review.updateContext}                     // ADD
  />
))}
```

---

### `agent-pkm-review-panel.tsx` — extend with `mode` prop and update-mode diff block

**Analog:** The existing file in its entirety (129 lines — already read in full above).

**Current props type** (lines 9–15):
```typescript
type AgentPkmReviewPanelProps = {
  cards: AgentPkmPreviewCard[];
  saving?: boolean;
  className?: string;
  onSave: () => void;
  onDismiss: () => void;
};
```
**Extend to:**
```typescript
type AgentPkmReviewPanelProps = {
  cards: AgentPkmPreviewCard[];
  saving?: boolean;
  className?: string;
  onSave: () => void;
  onDismiss: () => void;
  // New — backward-compatible defaults:
  mode?: "add" | "update";
  updateContext?: {
    domain: string;
    fieldPath: string;
    currentValue: string;
    proposedValue: string;
  };
};
```

**Destructuring pattern** (line 44–50) — add new props with defaults:
```typescript
export function AgentPkmReviewPanel({
  cards,
  saving = false,
  className,
  onSave,
  onDismiss,
  mode = "add",          // ADD — defaults to "add", existing callers unaffected
  updateContext,         // ADD
}: AgentPkmReviewPanelProps) {
  if (cards.length === 0 && mode === "add") return null;   // guard: update can have 0 cards
```

**Header text pattern** (lines 66–69) — branch on `mode`:
```typescript
// Existing:
<p className="font-medium text-foreground">Save to PKM?</p>
<p className="mt-1 text-xs leading-5 text-muted-foreground">
  Agent found durable context that needs your review before it is stored.
</p>

// Replace with:
<p className="font-medium text-foreground">
  {mode === "update" ? "Update PKM?" : "Save to PKM?"}
</p>
<p className="mt-1 text-xs leading-5 text-muted-foreground">
  {mode === "update"
    ? "Agent proposes a change to your saved record. Review before applying."
    : "Agent found durable context that needs your review before it is stored."}
</p>
```

**Save button label pattern** (lines 84–93):
```typescript
// Change "Save" label to branch on mode:
{saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
{mode === "update" ? "Update" : "Save"}
```

**Update-mode diff block** — insert between the header and the cards list (after line 95, before line 97):
```typescript
{mode === "update" && updateContext ? (
  <div className="mt-3 rounded-md border border-border/60 bg-background p-2 text-xs">
    <p className="mb-1 font-medium text-foreground">
      {titleize(updateContext.fieldPath.replace(/\./g, " "))}
    </p>
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground">Current</p>
        <p className="mt-0.5 text-foreground">{cleanText(updateContext.currentValue)}</p>
      </div>
      <div className="shrink-0 text-muted-foreground">→</div>
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground">Proposed</p>
        <p className="mt-0.5 font-medium text-foreground">{cleanText(updateContext.proposedValue)}</p>
      </div>
    </div>
    <p className="mt-1 text-muted-foreground">
      Domain: {titleize(updateContext.domain)}
    </p>
  </div>
) : null}
```

**`cleanText` and `titleize`** (lines 17–29) — both utility functions are already in this file. Use them unchanged for the diff block.

---

### `agent-pkm-memory.ts` — add `previewAgentPkmUpdate` and `saveAgentPkmUpdate` (optional helpers)

**Analog:** `previewAgentPkmMemory` (lines 169–202) and `addToPKM` (lines 216–330) in the same file — already read in full above.

**Note from RESEARCH.md:** The planner may choose Option A (call `previewAgentPkmMemory` from `executePkmUpdateTool` directly — no new function needed in this file) or Option B (skip preview, construct payload directly). The new functions below are for Option A if the planner wants a clean named export.

**`previewAgentPkmUpdate` — pattern to follow** (copy `previewAgentPkmMemory` lines 169–202):
```typescript
export async function previewAgentPkmUpdate(params: {
  userId: string;
  domain: string;
  fieldPath: string;
  currentValue: string;
  proposedValue: string;
  currentDomains: string[];
  vaultOwnerToken: string;
}): Promise<AgentPkmPreviewResponse & { cards: AgentPkmPreviewCard[] }> {
  // Build a message from structured slots — same ApiService.apiFetch pattern:
  const message = `Update ${params.domain} - ${params.fieldPath}: change from "${params.currentValue}" to "${params.proposedValue}"`;
  return previewAgentPkmMemory({
    userId: params.userId,
    message,
    currentDomains: params.currentDomains,
    vaultOwnerToken: params.vaultOwnerToken,
  });
}
```

**`saveAgentPkmUpdate` — pattern to follow** (copy `addToPKM` lines 216–330 core structure):
```typescript
export async function saveAgentPkmUpdate(params: {
  userId: string;
  domain: string;
  fieldPath: string;       // dot-notation, e.g. "personal_info.name"
  proposedValue: string;
  vaultKey: string;
  vaultOwnerToken: string;
}): Promise<PkmWriteCoordinatorResult> {
  return PkmWriteCoordinator.savePreparedDomain({
    userId: params.userId,
    domain: params.domain,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    build: async (context) => {
      // Apply field patch to context.currentDomainData
      const updatedData = applyFieldPatch(
        context.currentDomainData,
        params.fieldPath,
        params.proposedValue
      );
      return {
        domainData: updatedData,
        summary: {
          source: "agent_chat_update",
          field_path: params.fieldPath,
          proposed_value: params.proposedValue,
        },
      };
    },
  });
}

// Path-set utility (5-10 lines — no lodash):
function applyFieldPatch(
  data: Record<string, unknown>,
  path: string,
  value: unknown
): Record<string, unknown> {
  const parts = path.split(".");
  const result = structuredClone(data);
  let cursor: Record<string, unknown> = result;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!cursor[key] || typeof cursor[key] !== "object") {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
  return result;
}
```

**Imports pattern** — no new imports needed. `PkmWriteCoordinator` and `AgentPkmContextStore` are already imported (lines 11–14). `ApiService` is already imported (line 6).

**Cache invalidation pattern** (line 321 of agent-pkm-memory.ts):
```typescript
// After successful write, mirror addToPKM:
AgentPkmContextStore.invalidateUser(params.userId);
```

---

### `app/api/pkm/[...path]/route.ts` — read-only reference (no change)

**Role:** Transparent catch-all proxy. All `/api/pkm/**` paths are forwarded to Python backend at `getPythonApiUrl() + /api/pkm/<path>` (line 138).

**Key facts for the planner:**
- `/api/pkm/agent-lab/structure` (POST) routes straight through — used by `previewAgentPkmMemory`.
- No Next.js middleware intercepts PKM writes — `proxyPkmRequest` handles POST/PUT with `PKM_PROXY_WRITE_TIMEOUT_MS` (180 seconds, line 23).
- No new route file is needed. The existing proxy handles any new endpoint the Python backend exposes.
- The route normalizes 404 GET responses to empty payloads (lines 85–118) — does not affect POST calls from the update flow.

---

## Shared Patterns

### Vault guard (apply to every new function that writes or reads vault-keyed data)
**Source:** `agent-chat-workspace.tsx` lines 1665–1672
```typescript
if (!vaultKey || !token) {
  appendDebugEvent(debugTurnId, "pkm_tool_skipped", {
    reason: !vaultKey ? "vault_key_unavailable" : "vault_owner_token_unavailable",
    tool: toolEvent,
  });
  upsertPkmStatusMessage("Unlock your vault before saving to PKM.", "error");
  return;
}
```
**Apply to:** `executePkmUpdateTool`, `handleSavePkmReview` update branch.

### Slot access guard (apply to all `toolEvent.slots` reads)
**Source:** `agent-chat-workspace.tsx` line 1675 pattern
```typescript
typeof toolEvent.slots.source_text === "string" && toolEvent.slots.source_text.trim()
  ? toolEvent.slots.source_text.trim()
  : text;
```
**Apply to:** All four slot reads in `executePkmUpdateTool` (`domain`, `field_path`, `proposed_value`, `current_value`).

### `PkmWriteCoordinator.savePreparedDomain` call signature
**Source:** `agent-pkm-memory.ts` lines 284–301
```typescript
await PkmWriteCoordinator.savePreparedDomain({
  userId: params.userId,
  domain: targetDomain,
  vaultKey: params.vaultKey,
  vaultOwnerToken: params.vaultOwnerToken,
  build: async () => ({
    domainData: candidatePayload,
    summary: { ... },
    mergeDecision: card.merge_decision,
    structureDecision: nextStructureDecision,
    manifest: nextManifest || undefined,
  }),
});
```
**Apply to:** `saveAgentPkmUpdate` / `handleSavePkmReview` update branch. The `build` callback receives `context: BaseContext` where `context.currentDomainData` is the authoritative current state — apply the field patch there, not to the LLM's `current_value` slot.

### Cache invalidation after write
**Source:** `agent-pkm-memory.ts` line 321 + `agent-chat-workspace.tsx` lines 1416–1421
```typescript
AgentPkmContextStore.invalidateUser(params.userId);
void loadAgentPkmContext({
  userId: user.uid,
  vaultOwnerToken: token,
  vaultKey,
  forceRefresh: true,
}).catch(() => undefined);
```
**Apply to:** `handleSavePkmReview` update branch on success.

### Debug event naming convention
**Source:** `agent-chat-workspace.tsx` lines 1680–1684, 1698–1707, 1710–1711, 1748–1751
```
"pkm_tool_preview_start"
"pkm_tool_preview_result"
"pkm_tool_save_start"
"pkm_tool_save_result"
"pkm_tool_review_required"
"pkm_tool_failed"
```
**Apply to:** `executePkmUpdateTool` — use the same names with `tool: "pkm.update"` in payload.

### `previewAgentPkmMemory` API call
**Source:** `agent-pkm-memory.ts` lines 169–202
```typescript
const response = await ApiService.apiFetch("/api/pkm/agent-lab/structure", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${params.vaultOwnerToken}`,
  },
  body: JSON.stringify({
    user_id: params.userId,
    message: params.message,
    current_domains: params.currentDomains,
  }),
});
```
**Apply to:** `previewAgentPkmUpdate` if implemented as a new function, or call `previewAgentPkmMemory` directly from `executePkmUpdateTool`.

---

## No Analog Found

None. All four files in this phase have direct analogs (three are extend-in-place, one is read-only).

---

## Metadata

**Analog search scope:** `hushh-webapp/components/agent/`, `hushh-webapp/lib/agent/`, `hushh-webapp/lib/services/`, `hushh-webapp/app/api/pkm/`
**Files scanned:** 4 source files read in full
**Pattern extraction date:** 2026-06-24
