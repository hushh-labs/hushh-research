# One → Location over A2A, in the central chat (slice 1)

- **Date:** 2026-07-02
- **Branch:** `feat/kyc-agent-enhancements` (design authored here; implementation will branch off latest `main`)
- **Status:** Approved design (pending user spec review)
- **Direction decided with user:** A2A-first (real Google ADK `Runner` adoption deferred); first slice wires the **Location** specialist into the existing central "Ask your agent anything" chat, then a later slice unifies One; slice-1 A2A transport is **in-process, A2A-shaped** (swappable to network A2A with no contract change).

## Visual Map

```text
One → Location over A2A, surfaced in the central "Ask your agent anything" chat
(in-process transport; coordinates never leave the browser)

Browser: AgentChatWorkspace (central chat)          │  Server (consent-gated)
──────────────────────────────────────────────────  │  ─────────────────────────────────────────
"share my location with Mom for 1h"                  │
  POST /api/kai/agent/chat/stream                     │  require_vault_owner_token
  { user_id, message, conversation_id }        ────► │  agent_chat_service: One turn
                                                     │    delegation decision → intent="location"
                                                     │    build A2A task {user_id, message,
                                                     │      conversation_id} + X-Consent-Token
                                                     │    dispatch("agent_location", task)  (in-process)
                                                     │      → LocationAgentA2A.handle_message
                                                     │        validate_a2a_consent_token
                                                     │        Location's EXISTING tool loop in HushhContext:
                                                     │          list_verified_recipients (resolve "Mom")
                                                     │          create_location_share (grant+HCT, NO coords)
                                                     │        returns directive envelope:
                                                     │          { text, directive:{kind:"action",
                                                     │            payload: clientAction publish_share},
                                                     │            is_complete:false, state_changed:false }
        ◄──────── SSE: specialist_directive ───────┘
  render Location action card (dispatcher beside pkm.add)
  user clicks "Share":
    captureCurrentPosition + encryptLocationForRecipient  (crypto stays in browser)
    POST /grants/{grantId}/envelopes (ciphertext)    ────►  store_encrypted_envelope (HCT re-validated)
    POST /api/kai/agent/chat/stream                   │
      { delegate_result:{ id, type:"publish_share",   ────► One relays delegate_result to
        status:"completed" } }                         │      dispatch("agent_location", ...) → confirms
        ◄──────── SSE: token + complete ─────────────┘
  "Done — Mom can see you for 1h."  (state refresh)

Per-recipient shares stay ciphertext-only end to end. One and the A2A envelope are
coordinate-free by construction. Disambiguation ("which Mom?") rides
directive.kind:"prompt"; the browser answers with a delegate_result selection.
```

## 1. Goal & scope

**Goal.** Let the central "Ask your agent anything" chat do the Location specialist's
full work — grant, ask/request, share, revoke, and the browser-side crypto handoff —
by having **One delegate the whole turn to Location over a real A2A contract** and
relay Location's rich flow back into the single chat. This is the first vertical proof
of the **One-parent → sub-agent** pattern.

**In scope (slice 1):**

- Location specialist only.
- The central chat: `consent-protocol/hushh_mcp/services/agent_chat_service.py` +
  `consent-protocol/api/routes/kai/agent_chat.py` + `hushh-webapp/components/agent/agent-chat-workspace.tsx`.
- In-process, A2A-shaped transport.
- The four transport-independent pieces (§4–§6): a delegation decision in One, an A2A
  handler wrapping Location's existing loop, an SSE extension, and a frontend
  specialist-directive dispatcher — all designed **specialist-generic** so Nav/KYC/Kai
  plug in next.

**Out of scope (deferred — see §8):**

- Network A2A deployment (own port / HTTP hop) for Location.
- Renaming or rehoming the central chat as the dedicated `agent_one` identity.
- Wiring Kai / Nav / KYC through the central chat.
- Adopting the real Google ADK `Runner` / `LlmAgent` execution engine.

## 2. Current state (verified against the codebase)

The design is constrained by what actually runs today; the exploration that produced
this is summarized here so the plan does not re-litigate it.

- **Google ADK is inert.** `google-adk==1.28.1` is pinned but every `google.adk.*`
  import fails (wrong path `google.adk.model`, no sync `.run()`, wrong constructor) and
  falls back to a stub that raises. Only the bundled `google.genai` (Gemini client) is
  used. `hushh_mcp/hushh_adk/` is a home-grown, ADK-*shaped* abstraction, not real ADK.
  `HushhAgent.run()` is never executed in production.
- **The live runtimes are per-agent "chat services"** — direct Gemini function-calling
  loops inside a `HushhContext`: `services/location_chat_service.py`
  (→ `/api/one/location/chat`) and `services/agent_chat_service.py`
  (→ `/api/kai/agent/chat/stream`). Consent is enforced through `@hushh_tool` +
  `HushhContext`, not the ADK runtime.
- **A2A is real but Kai-only and off to the side.** `adk_bridge/kai_agent.py`
  (`KaiA2AServer`, subclasses `python_a2a`'s `A2AServer`) + `server_a2a.py` (AgentCard,
  port 8001) is a genuine A2A service, but standalone and **not mounted** in the main
  API. `adk_bridge/delegation.py` is a scope-name→`ConsentScope` map
  (`agent_kai → AGENT_KAI_ANALYZE`, `agent_kyc → AGENT_KYC_PROCESS`, …) plus
  `validate_a2a_consent_token` — naming + consent validation, not routing.
- **`agents/one/` is pure metadata** (manifest + `agent.yaml`, specialists: kai, nav,
  kyc, location); **no runner**. `agents/orchestrator/` has the real routing logic
  (`classify_specialist_domain`, `delegate_to_*`) but it only returns a handoff
  descriptor dict, has **no `location` route**, and is **not wired to any production
  route** (test-only).
- **The central chat is a single-shot action-planner.** `agent_chat_service.py` plans
  one action *before* streaming; if `execution=="frontend"` it emits a `tool_waiting`
  SSE frame carrying a free-form `slots` dict and returns. It has **no multi-step tool
  loop, no disambiguation channel, and no action-result round-trip**. Its client
  (`agent-chat-client.ts`) preserves unknown payload fields verbatim (`slots`/`raw`).
  Frontend action execution (`lib/agent/agent-action-runtime.ts`) can only navigate or
  run fixed Kai commands — it **cannot run an arbitrary client-side callback**, which is
  why `pkm.add` is intercepted directly in `agent-chat-workspace.tsx` to run its own
  vault-crypto flow. That interception is the established precedent slice 1 follows.
- **The Location chat is already rich.** `location_chat_service.py` runs a real
  multi-step Gemini tool loop in `HushhContext` and already returns coordinate-free
  `clientAction` / `clientPrompt` directives, with `actionResult` / `selectionResult`
  round-trips (resolve → clarify → confirm → share → confirm-done). The browser crypto
  (`lib/one-location/encryption.ts`, `service.ts`, `use-location-chat.ts`
  `confirmAction`) is complete and reused unchanged.

**Implication.** "Put Location in sync with the central chat" is best done by letting
One **hand the turn to Location and relay its existing rich flow**, not by
re-implementing location reasoning in the thin central planner.

## 3. Architecture — three actors, one new seam

- **One (router / relay).** The existing central turn in `agent_chat_service.py` gains a
  *delegation decision*. When a turn classifies as `location`, One stops planning
  locally, hands the whole turn to the Location specialist over the A2A contract, and
  relays whatever Location returns over SSE. One never learns location reasoning and
  holds no location scope of its own.
- **A2A delegation interface.** A small in-process dispatcher (`agent_id → handler`)
  speaking the **same envelope Kai's A2A server speaks** (`X-Consent-Token` + task
  message). For slice 1 it is a Python call; later it becomes an HTTP client to a
  network endpoint with **no contract change**.
- **Location specialist (A2A handler).** Wraps Location's **existing** tool loop behind
  an A2A `handle_message`. All disambiguation / confirm / share / completion logic is
  reused verbatim; it already emits coordinate-free `clientAction` / `clientPrompt`.

The router/relay split is the load-bearing decision: it keeps a single "brain" per
domain (Location owns location reasoning; One owns routing) and avoids forking logic
into the central planner.

## 4. The A2A contract (transport-agnostic core)

Modeled on Kai's `KaiA2AServer` + `AgentCard`; standardized so every future specialist
reuses it.

- **Agent card (per specialist):**
  `{ agent_id: "agent_location", name, description, required_scope, skills }`.
  Registered in a small registry that extends `adk_bridge/delegation.py`'s existing
  `SPECIALIST_A2A_SCOPE_MAP`.
- **Task message (One → specialist):**
  `{ user_id, message?, conversation_id, delegate_result? }` + `X-Consent-Token` header.
  Consent is validated at the specialist boundary via the existing
  `validate_a2a_consent_token(agent_id, token)` (fail-closed).
- **Directive envelope (specialist → One):**
  `{ text, directive?: { kind: "action" | "prompt", payload }, is_complete, state_changed }`.
  `payload` is Location's existing coordinate-free `clientAction` / `clientPrompt`,
  unchanged. The envelope is **specialist-generic**: Nav / KYC / Kai later return the
  same shape with their own payloads.

## 5. Backend changes

| File | Change |
|---|---|
| `consent-protocol/hushh_mcp/adk_bridge/delegation.py` | Add `agent_location` to the scope map (location capability scope + `AGENT_ONE_ORCHESTRATE` at the One boundary); add an agent-card registry entry. |
| `consent-protocol/hushh_mcp/adk_bridge/location_agent.py` **(new)** | `LocationAgentA2A` — thin A2A handler that validates consent, then calls Location's existing tool loop and returns the directive envelope. Mirrors `kai_agent.py`'s structure (without requiring the network `A2AServer`). |
| `consent-protocol/hushh_mcp/adk_bridge/dispatch.py` **(new)** | In-process `dispatch(agent_id, task_message)` → handler. This one seam is later swapped for an HTTP client to go network-A2A. |
| `consent-protocol/hushh_mcp/services/agent_chat_service.py` | Add a **delegation branch**: classify intent (reuse `classify_specialist_domain`; add a `location` route to `orchestrator/tools.py`'s `_SPECIALIST_ROUTES`); if location, call `dispatch("agent_location", …)` and yield a `specialist_directive` / text instead of the local action-planner. Add a `delegate_result` path that re-dispatches to the specialist for the confirmation turn. Existing Kai action-plan and text turns are untouched. |
| `consent-protocol/api/routes/kai/agent_chat.py` | Extend `AgentChatStreamRequest` with optional `delegate_result`; emit the new SSE frames (§6). Backward-compatible. |
| `consent-protocol/hushh_mcp/services/location_chat_service.py` | Refactor only enough to expose its turn loop to the A2A handler (extract the loop into a callable the handler can invoke). The existing `/api/one/location/chat` route keeps working against the same loop. |

The Location backend (tools, `OneLocationAgentService`, REST envelope routes) is
otherwise reused as-is.

## 6. SSE protocol extension (central chat)

Both additions are additive; the existing Kai action-plan / text / `tool_waiting`
frames are unchanged, and the client parser already preserves unknown payload fields.

- **`specialist_directive` frame:**
  `{ delegate_agent_id, directive: { kind, payload }, message }` — carries Location's
  `clientAction` / `clientPrompt`.
- **`delegate_result` round-trip:** the browser POSTs a follow-up to
  `/agent/chat/stream` with
  `delegate_result: { id, type, status, detail? }` (coordinate-free); One relays it to
  the specialist, which confirms in words. This gives the central chat the
  completion/confirmation turn it currently lacks.

**Disambiguation** ("which Mom?") flows through `directive.kind: "prompt"`; the browser
answers with a `delegate_result` carrying the selection. This preserves Location's full
clarify/confirm richness inside a chat that previously had none.

## 7. Frontend changes

| File | Change |
|---|---|
| `hushh-webapp/lib/services/agent-chat-client.ts` | Handle the `specialist_directive` event (add `onSpecialistDirective`); add `delegateResult` to the stream request body. |
| `hushh-webapp/components/agent/agent-chat-workspace.tsx` | Add a **specialist-directive dispatcher** beside the existing `pkm.add` interception (`executeFrontendTool`). For `delegate_agent_id: "location"`, render the action / confirm / select card and run the crypto; post the `delegate_result` follow-up. |
| `hushh-webapp/components/agent/specialist-cards/` **(new)** | Presentational Location action & prompt cards; reuse styling from the existing location `ActionConfirmCard`. |
| reuse | `hushh-webapp/lib/one-location/*` — `captureCurrentPosition`, `encryptLocationForRecipient`, `storeEnvelope`, and the `confirmAction` dispatch logic from `use-location-chat.ts`. **No new crypto.** |

The dispatcher is keyed by `delegate_agent_id`, so slice 2 adds Nav / KYC cards without
touching the plumbing. Security-sensitive directives never auto-fire — they require an
explicit click, matching the location v2 confirm-card rule.

## 8. Deliberately deferred (with hooks)

| Deferred | Hook that makes it a swap, not a rewrite |
|---|---|
| **Network A2A for Location** | Replace `dispatch.py`'s in-process call with an HTTP client to a Location A2A service (mirror `server_a2a.py`). The agent card, task message, consent header, and directive envelope are identical, so Location, the SSE frames, and the frontend do not change. |
| **One as the unified identity** | Flip the central chat's persona/prompt to `agent_one` (the manifest already exists at `agents/one/`) and register Kai / Nav / KYC in the same dispatcher; each returns the §4 envelope. Natural slice 2. |
| **Real Google ADK `Runner`** | The A2A boundary is independent of the executor. Adopting ADK later swaps how a specialist *runs its turn* without disturbing this contract. |

## 9. Invariants preserved

- **Consent enforcement.** Every location mutation still runs as a scope-validated
  `@hushh_tool` inside `HushhContext` in the Location specialist; the A2A boundary
  re-validates via `validate_a2a_consent_token`. One holds no location scope of its own.
- **Zero-knowledge coordinates.** One and the A2A envelope are coordinate-free by
  construction; capture / encrypt / decrypt stay in the browser; the ciphertext-only
  envelope path (`ECDH-P256-AES256-GCM`, per recipient) is unchanged. The owner-
  initiated, time-bounded, revocable public-link snapshot remains the single, already-
  documented relaxed path — not introduced or widened here.
- **No new trust surface.** Delegation rides existing consent tokens; no new plaintext,
  no coordinates in SSE payloads, logs, notifications, or audit metadata. `delegate_result`
  is coordinate-free by construction.

## 10. Testing strategy (TDD)

**Backend**

- The delegation branch routes location intents to `dispatch("agent_location", …)` and
  leaves non-location intents on the existing action-plan / text path.
- `LocationAgentA2A` enforces consent (fail-closed when the location scope is absent).
- The directive envelope is coordinate-free (no lat/lng keys in `text`, `directive`, or
  `delegate_result`) — assert at the code level, not just the prompt.
- The `delegate_result` round-trip produces the confirmation turn with correct
  `state_changed`.
- Disambiguation returns `directive.kind:"prompt"`; a selection `delegate_result`
  resumes the flow.
- Existing Kai action-plan turns and the standalone `/api/one/location/chat` flow stay
  green. Reuse fakes/patterns from `tests/test_one_location_*` and the agent-chat tests.

**Frontend**

- `specialist_directive` renders the card and never auto-fires.
- Confirm dispatches to the existing location crypto callbacks; multi-recipient encrypts
  per recipient from a single capture.
- Cancel / failure / permission-denied post the correct `delegate_result`.
- `state_changed:true` triggers the existing refresh + `consent-state-changed`.
- Existing agent-workspace and location-chat tests stay green; `npx tsc --noEmit` clean.

## 11. Path to "One unified" (slice 2+)

1. **Slice 1 (this spec):** Location via One over in-process A2A, in the central chat.
2. **Slice 2:** flip the central chat identity to `agent_one`; register Kai / Nav / KYC
   in the dispatcher (each returns the §4 envelope); add their specialist cards.
3. **Slice 3:** move specialists to network A2A (transport swap in `dispatch.py`).
4. **Later:** adopt the real Google ADK `Runner` behind the A2A boundary.

## 12. Skill plan (remainder of flow)

1. **superpowers:brainstorming** — complete (this spec).
2. User reviews this spec.
3. **superpowers:writing-plans** — TDD implementation plan for slice 1.
4. **ui-ux-pro-max** — drives the visual execution of the specialist directive cards.
5. **superpowers:test-driven-development** + **superpowers:executing-plans** — build.
