# Phase 01: Agent PKM Update Intent - Context

**Gathered:** 2026-06-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Make the AI agent chat handle PKM **update** intents intelligently. When a user says something like "update my pkm records", "my name changed", or "update my finance details", the agent must:
1. Identify the correct PKM domain from its loaded context (not navigate to a route)
2. Draft the proposed change
3. Show a review panel with current → proposed values for user confirmation
4. Write the update to the backend on confirmation

Navigation actions remain intact for non-PKM intents ("take me to my profile", "open finance"). The LLM remains general for all other question types.

</domain>

<decisions>
## Implementation Decisions

### Architecture — where the fix lives
- **D-01:** The Kai LLM backend is the source of truth for intent classification. A new tool `pkm.update` must be added to Kai's tool definitions and system prompt alongside the existing `pkm.add`.
- **D-02:** The LLM must route PKM update intents to `pkm.update` (not to a route navigation action). Route navigation actions (`router.push`) remain unchanged and fire only for non-PKM intents.
- **D-03:** No frontend regex interceptor — intent classification stays in the LLM, not in the frontend.

### Domain disambiguation
- **D-04:** The LLM already receives PKM domain metadata in every turn via `AgentPkmContextStore` (domain keys, summaries, highlights, attribute counts). The LLM must use this loaded context to self-identify the target domain from the user's message.
- **D-05:** The three confirmed user PKM domains are: `identity`, `finance_portfolio`, `financial_domain`. Domain keys in the PKM are arbitrary strings — the LLM reads them from context, not a hardcoded list.
- **D-06:** The LLM does NOT ask the user to pick a domain — it infers it. If uncertain, it may surface `candidate_domain_choices` (already defined in `AgentPkmIntentFrame`) in its response.
- **D-07:** `pkm.update` tool slots: `domain`, `field_path`, `proposed_value`, `current_value`.

### Confirmation UX
- **D-08:** Reuse the existing `AgentPkmReviewPanel` (`components/agent/agent-pkm-review-panel.tsx`) — do not build a new panel.
- **D-09:** Extend the panel to support an `update` mode that shows **current stored value → proposed new value** side by side. Same dismiss/confirm callbacks as the existing add flow.
- **D-10:** User confirms → backend write executes. User dismisses → no write, no side effects.

### Scope
- **D-11:** New flow applies only to PKM update intents. PKM add flow (`pkm.add` + existing review panel) is untouched.
- **D-12:** Non-PKM navigation actions (`navigate_to_profile`, `navigate_to_finance`, etc.) continue to fire `router.push` as today. This is not broken — it is the correct behavior for navigation-only intents.
- **D-13:** General questions, analysis, and clarification — LLM answers normally with no change to existing chat behavior.

### Claude's Discretion
- Exact merge strategy for the write (field-level patch vs. full domain re-write) — use `PkmWriteCoordinator` as-is; it handles merge/conflict logic.
- Whether the `pkm.update` preview call reuses the existing preview endpoint or gets its own — researcher to decide based on backend contract.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Agent chat — main handler
- `hushh-webapp/components/agent/agent-chat-workspace.tsx` — Main chat UI and tool event dispatch. The `pkm.add` handler at line ~1782 is the pattern to follow for the new `pkm.update` handler.

### PKM tool handling
- `hushh-webapp/lib/agent/agent-pkm-memory.ts` — `previewAgentPkmMemory`, `addToPKM`, `AgentPkmPreviewCard`, `AgentPkmIntentFrame`, `AgentPkmDomainChoice` — the add flow is the direct analog for the update flow.
- `hushh-webapp/lib/agent/agent-pkm-context-store.ts` — How PKM domain metadata is loaded into LLM context per turn. The `AgentPkmWorkingContext` with `domains[]` is what the LLM already sees.
- `hushh-webapp/lib/agent/agent-pkm-context-store.ts` — `shouldUseBroadContext` shows how the store decides context depth from message text.

### Review panel
- `hushh-webapp/components/agent/agent-pkm-review-panel.tsx` — Panel to extend with `update` mode (current → proposed diff view).

### Action gateway — understanding current routing
- `hushh-webapp/lib/agent/agent-action-runtime.ts` — `executeAgentGatewayAction` — where `execution_target.path === "route"` triggers `router.push`. The update flow bypasses this entirely.
- `hushh-webapp/lib/voice/kai-action-gateway.ts` — Action registry, `KaiActionDefinition`, `KaiActionExecutionTarget` types. The new `pkm.update` tool must align with this contract.
- `hushh-webapp/contracts/kai/kai-action-gateway.vnext.json` — Generated action registry. May need a new action entry for `pkm.update`.

### Write path
- `hushh-webapp/lib/services/pkm-write-coordinator.ts` — `PkmWriteCoordinator` — handles merge, conflict retry, and write. Use as-is on confirm.
- `hushh-webapp/lib/pkm/pkm-domain-resource.ts` — `PkmDomainResourceService.prepareDomainWriteContext` — how to load current domain data before showing the review panel.

### PKM domain structure
- `hushh-webapp/lib/personal-knowledge-model/manifest.ts` — `DomainManifest`, `PathDescriptor`, `StructureDecision` — domain schema.
- `hushh-webapp/lib/services/personal-knowledge-model-service.ts` — Service layer for reading/writing domain data.

### Backend API
- `hushh-webapp/app/api/pkm/[...path]/route.ts` — PKM API proxy. Understand what preview and write endpoints exist before adding new ones.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `AgentPkmReviewPanel`: Already handles add-flow review + confirm/dismiss. Extend with a `mode: "update"` prop that renders current value alongside proposed value.
- `previewAgentPkmMemory` in `agent-pkm-memory.ts`: The preview call pattern (send message + current domains → get back preview cards with `write_mode`, `candidate_payload`, `target_domain`) is the template for the update preview call.
- `PkmDomainResourceService.prepareDomainWriteContext`: Loads current domain data with blob version for conflict-safe writes — call this before showing the review panel so current values are accurate.
- `AgentPkmIntentFrame` / `AgentPkmDomainChoice`: Already typed for domain disambiguation. The `candidate_domain_choices` field can surface alternatives if the LLM is uncertain.
- `executePkmAddTool` (inside `agent-chat-workspace.tsx`): The `pkm.add` handler at line ~1782 is the direct pattern to clone for `pkm.update`.

### Established Patterns
- Tool event dispatch: `toolEvent.actionId === "pkm.add"` → handled before `executeAgentGatewayAction`. The `pkm.update` handler must follow the same early-exit pattern.
- PKM context per turn: `loadAgentPkmContext` / `peekAgentPkmContext` loads domain metadata before the LLM call. The LLM already has domain keys, summaries, and highlights in context — no new plumbing needed for domain awareness.
- Review panel confirm: calls `addToPKM` → `PkmWriteCoordinator`. For update, call the same coordinator with the proposed field patch.
- Streaming tool events arrive via SSE in `agent-chat-client.ts` → `onToolStart` / `onToolWaiting` / `onToolResult`. The `pkm.update` tool will emit these same events.

### Integration Points
- **LLM → Frontend:** `pkm.update` tool call arrives as `AgentChatToolEvent` with `actionId: "pkm.update"` and slots `{ domain, field_path, proposed_value, current_value }`.
- **Frontend → PKM read:** `PkmDomainResourceService.getStaleFirst` to fetch current domain data for the panel.
- **Panel → Write:** On confirm, call `PkmWriteCoordinator` with the proposed payload against the domain.
- **Write → Cache invalidation:** `PkmDomainResourceService.invalidateDomain` after successful write.

</code_context>

<specifics>
## Specific Ideas

- The agent must **never redirect to `/profile` or `/finance`** for a PKM update intent. This was the specific broken behavior that triggered this phase.
- The review panel in update mode must show **"Current: [value] → Proposed: [value]"** — not just the proposed value. The user needs to see what's changing.
- The LLM's PKM context already contains domain summaries and highlights (built in `AgentPkmContextStore`). The system prompt / tool definition for `pkm.update` should instruct the LLM to reference this context when picking the target domain — not guess from the message alone.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 01-agent-pkm-update-intent*
*Context gathered: 2026-06-24*
