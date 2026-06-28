# One Location Agent Chat — v1 (control-plane, non-streaming)

- **Date:** 2026-06-27
- **Branch:** `feat/one-location-agent-chat` (off latest `origin/main`)
- **Status:** Approved design, ready for implementation plan

## Visual Map

```text
One Location Agent Chat — v1 control-plane turn (consent-gated, non-streaming)

Browser (/one/location)                         │  Server
────────────────────────────────────────────   │  ──────────────────────────────────────
chat panel                                      │
  user types "stop sharing with Mom"            │
  POST /api/one/location/chat                    │
  { user_id, message, conversation_id? }   ────► │  require_vault_owner_token
                                                │    403 if token.user_id ≠ body.user_id
                                                │  LocationChatService.handle_turn()
                                                │    1. AgentChatService.prepare_turn()
                                                │       → conversation_id + history
                                                │         (user msg persisted, AES-GCM at rest,
                                                │          metadata:{agent:"location"})
                                                │    2. fold recent history → context preamble
                                                │    3. LocationAgent.handle_message(
                                                │         preamble+message, user_id, consent_token)
                                                │         → HushhAgent.run()
                                                │           with HushhContext (scope-gated)
                                                │             → ADK LlmAgent
                                                │               → 5 control-plane @hushh_tool
                                                │                 (each re-validates its scope)
                                                │    4. AgentChatService.add_message(assistant)
        ◄───────────────────────────────────┘    { conversation_id, response,
  on state_changed:true →                          is_complete, state_changed }
    page.refresh()  +  dispatch consent-state-changed
  render assistant reply in panel               │

Coordinates never enter this path. Control-plane tools never read/return lat/lng.
Every tool call runs inside HushhContext → scope enforcement identical to the REST routes.
```

## 1. Goal

Expose the already-built `LocationAgent` (Gemini, ADK tool-calling) over an HTTP
endpoint so users can control location sharing conversationally — e.g.
"who can see me right now?", "stop sharing with Mom", "ask Dad to share his
location with me". Today `LocationAgent` exists and is fully built but **nothing
routes to it** (unlike KAI, which has `POST /api/kai/chat`).

v1 is deliberately a **control-plane** assistant: it does only what the agent can
fully complete server-side. The encryption-handoff commands ("share my location",
"approve a request") are explicitly deferred to v2.

## 2. Context — actual state on this branch (Step 0 findings)

### Already present (reuse as-is)

| Area | Symbols / paths |
|---|---|
| Location agent (LLM, tool-calling) | `consent-protocol/hushh_mcp/agents/location/agent.py` — `LocationAgent.handle_message(message, user_id, consent_token="")` → `{response, is_complete}` / `{response, error}` |
| Agent tools (9, scope-gated) | `consent-protocol/hushh_mcp/agents/location/tools.py` — `@hushh_tool` functions |
| Agent manifest | `consent-protocol/hushh_mcp/agents/location/agent.yaml` — model `gemini-3-flash-preview`, hardened system prompt, scopes `agent.one.orchestrate` + `cap.location.live.share` |
| Service (all business logic) | `consent-protocol/hushh_mcp/services/one_location_agent_service.py` |
| Consent-gated run path | `consent-protocol/hushh_mcp/hushh_adk/core.py` — `HushhAgent.run()` (sync) wraps `with HushhContext(...)`; `hushh_adk/context.py`; `hushh_adk/tools.py` |
| Durable encrypted conversation store | `consent-protocol/hushh_mcp/services/agent_chat_service.py` — generic persistence methods (`prepare_turn`, `add_message`, `get_recent_messages`, `create_conversation`); tables `agent_chat_conversations` / `agent_chat_messages` (migration `055`) |
| Auth dependency | `consent-protocol/api/middleware.py` — `require_vault_owner_token` (returns `user_id`, `token`, `token_obj`, …) |
| Existing location routes (mount point) | `consent-protocol/api/routes/one/location.py` (`prefix="/api/one"`); aggregated in `consent-protocol/api/routes/one/__init__.py`; mounted in `server.py` |
| KAI non-streaming reference pattern | `consent-protocol/api/routes/kai/chat.py` (`KaiChatRequest` / `KaiChatResponseModel`, `Depends(require_vault_owner_token)`, user_id-match 403) |
| Frontend location page + service | `hushh-webapp/app/one/location/page.tsx` (has `refresh()`); `hushh-webapp/lib/one-location/service.ts`; redesign hub under `hushh-webapp/components/one-location/redesign/` |
| Cross-surface sync event | `hushh-webapp/lib/consent/consent-events.ts` — `consent-state-changed` (`CONSENT_STATE_CHANGED_EVENT`); page already listens |
| Next.js proxy | `hushh-webapp/app/api/one/[...path]/route.ts` — forwards `/api/one/*` to Python backend |

### Key constraints discovered (drive the design)

1. **Streaming only exists on the consent-bypassing path.** KAI's
   `/api/kai/agent/chat/stream` (`AgentChatService.stream_response`) calls Gemini
   directly — it **never enters `HushhContext`** and **never calls a `@hushh_tool`**.
   The consent-gated ADK path (`HushhAgent.run()`) is **synchronous** and has no
   streaming variant; the ADK `Runner.run_async` is not used anywhere in the repo;
   `HushhContext` (a sync context manager) would exit before the first token could
   be yielded. **Therefore v1 is non-streaming through the consent-gated path** —
   the only option that preserves consent enforcement without significant
   security-sensitive restructuring.
2. **`AgentChatService` is split into generic persistence vs. KAI-specific LLM.**
   Its persistence methods (`prepare_turn`, `add_message`, `get_recent_messages`,
   `create_conversation`) are agent-agnostic and reusable. Its `stream_response` /
   `plan_action` are KAI/Gemini-direct and **must not** be reused (they bypass
   consent). v1 reuses **persistence only**.
3. **Conversation namespacing slot exists but is unused.** The schema has
   `agent_chat_conversations.metadata JSONB`; `create_conversation` currently does
   not populate it. v1 writes `{"agent":"location"}` so location conversations are
   distinguishable from KAI's. **No new migration required.**
4. **`LocationAgent.handle_message` has no `history` parameter.** Multi-turn is
   achieved by folding recent history into the message string passed to
   `handle_message` (no signature change to the agent/base class).

## 3. Scope (locked)

**In scope (v1) — the 5 control-plane tools the agent fully completes server-side:**

| Intent | Tool | Scope |
|---|---|---|
| "who can see me / list people" | `list_location_recipients` | `cap.location.live.share` |
| "stop sharing with X" | `revoke_location_share` | `cap.location.live.revoke` |
| "ask X to share with me" | `request_location_access` | `cap.location.live.request` |
| "deny that request" | `deny_location_request` | `cap.location.live.request` |
| "refer X" | `refer_location_recipient` | `cap.location.live.refer_request` |

**Out of scope (deferred to v2) — require client-side crypto handoff:**

- `create_location_share` + `publish_location_envelope` ("share my location")
- `approve_location_request` (captures + encrypts owner position)
- `view_location_envelope` (client decrypts)

These need the client to capture, encrypt-per-recipient, and upload an envelope —
the agent cannot complete them alone (it never sees coordinates). v2 will design a
structured client-action handoff contract.

## 4. Architecture

### Backend call chain

```
POST /api/one/location/chat
  → require_vault_owner_token           (auth: VAULT_OWNER token → user_id, consent token)
  → 403 if token_data["user_id"] != body.user_id
  → LocationChatService.handle_turn(user_id, message, consent_token, conversation_id?)
       1. AgentChatService.prepare_turn(user_id, message, conversation_id)
            → conversation_id, history[]   (persists user msg, AES-GCM at rest)
       2. preamble = format_history(history)        # last N user/assistant turns
       3. result = get_location_agent().handle_message(
              message = preamble + "\n\nLatest: " + message,
              user_id = user_id,
              consent_token = consent_token,         # raw token from token_data["token"]
          )                                          # → HushhContext → ADK → 5 tools
       4. AgentChatService.add_message(conversation_id, user_id,
              role="assistant", content=result["response"], status="complete")
       5. return { conversation_id, response, is_complete, state_changed }
```

`state_changed` is `true` when the turn invoked a mutating tool (revoke / request /
deny / refer). v1 derivation: default `false`; set `true` unless the turn was a
pure query. (Exact detection mechanism — e.g. a flag surfaced from the tool layer
vs. a conservative heuristic — is a plan-phase decision; when uncertain, default
to `true` so the UI refreshes rather than goes stale.)

### Tool restriction (defense-in-depth)

`LocationAgent` exposes all 9 tools. v1 must prevent the LLM from invoking
share / approve / view. The mechanism (allow-list parameter threaded into the
agent vs. a thin v1 subclass exposing only 5 tools) is decided in the plan; the
**requirement** is: the share/approve/view tools are not callable in v1, enforced
in code, not only by the system prompt.

### New / changed backend files

| File | Change |
|---|---|
| `consent-protocol/api/routes/one/location_chat.py` | **New** — router (no own prefix; inherits `/api/one`), `LocationChatRequest` / `LocationChatResponse` models, the POST route. Mirrors `kai/chat.py` conventions. |
| `consent-protocol/hushh_mcp/services/location_chat_service.py` | **New** — `LocationChatService.handle_turn(...)` composing `AgentChatService` (persistence) + `LocationAgent` (turn) + history folding + tool restriction. |
| `consent-protocol/api/routes/one/__init__.py` | **Edit** — include the new sub-router. |
| `consent-protocol/hushh_mcp/services/agent_chat_service.py` | **Edit** — populate `metadata` (`{"agent":"location"}`, default `{}` / `{"agent":"kai"}` for existing callers) in `create_conversation`. Backward-compatible. |

### Request / response models

```python
class LocationChatRequest(BaseModel):
    user_id: str            # min 1, max 128 (Firebase UID)
    message: str            # min 1, max 4000
    conversation_id: str | None = None   # max 128

class LocationChatResponse(BaseModel):
    conversation_id: str
    response: str           # natural-language reply (coordinate-free by construction)
    is_complete: bool
    state_changed: bool     # frontend should refresh location state when true
```

## 5. Frontend

| File | Change |
|---|---|
| `hushh-webapp/lib/one-location/service.ts` | **Edit** — add `chat(message, conversationId?)` → `POST /api/one/location/chat` (via existing proxy, `Authorization: Bearer <vaultOwnerToken>`). |
| `hushh-webapp/components/one-location/redesign/` | **New** chat panel component (an "Ask" affordance in the hub). Presentational; delegates to handlers from the page. |
| `hushh-webapp/app/one/location/page.tsx` | **Edit** — wire the panel; hold `conversationId` in memory-only React state; on `state_changed:true` call existing `refresh()` and dispatch `consent-state-changed` (source e.g. `one_location_chat`) so the Access Manager stays in sync. |

No new client state library; follow existing page state patterns. `conversationId`
is memory-only (never persisted).

## 6. Consent & coordinate-safety guarantees (non-negotiable, preserved)

- The turn runs inside `HushhContext`; every tool re-validates its scope via
  `validate_token_with_db` — **identical enforcement to the REST routes**.
- The agent never receives or returns coordinates; control-plane tools don't touch
  them. The hardened `agent.yaml` system prompt (refuses bearer links, plaintext
  coords, unapproved referrals) is **unchanged**.
- Conversation content is **AES-256-GCM encrypted at rest** via `AgentChatService`.
  Control-plane messages are coordinate-free by construction.
- Errors return **opaque** messages (mirroring existing routes); no internal detail
  leaks. Agent failures already degrade to a safe canned response in
  `handle_message`.

## 7. Testing strategy (TDD)

**Backend**
- Route: rejects missing/invalid token (401); rejects user_id mismatch (403).
- `LocationChatService`: threads conversation_id + history across turns; persists
  user and assistant messages with `metadata.agent == "location"`.
- Tool restriction: share / approve / view tools are not invocable in v1
  (asserted at the code level, not just prompt).
- Scope enforcement: a tool called without the matching scope fails closed.
- Coordinate-free: assert no coordinate keys appear in stored messages or response.
- Error opacity: agent exception → safe message, no internal detail.
- Reuse existing fakes/patterns from `consent-protocol/tests/test_one_location_*`.

**Frontend**
- `service.chat()` request shape (path, headers, body) — mirror
  `hushh-webapp/__tests__/services/location-agent-service.test.ts`.
- Panel renders, sends a message, displays the reply.
- `state_changed:true` triggers `refresh()` + `consent-state-changed` dispatch.

## 8. Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| v1 capability | Control-plane (query/revoke/request/deny/refer) | Avoids crypto handoff; ships clean |
| Endpoint path | `POST /api/one/location/chat` | Canonical `/api/one` namespace; `kai/location.py` chat is an unmounted legacy prototype |
| Response mode | Non-streaming JSON, consent-gated ADK path | Only option preserving consent without security-sensitive restructuring; control-plane replies are short |
| Conversation memory | Multi-turn, reuse `AgentChatService` persistence | Durable, encrypted-at-rest; persistence layer is agent-agnostic |
| Namespacing | `metadata:{agent:"location"}` | Schema slot exists; **no migration** |
| Frontend surface | Chat panel on `/one/location` | Contextual; reuses page refresh + cross-surface sync |
| Tool restriction | Code-enforced v1 allow-list (5 tools) | Defense-in-depth over the system prompt |

## 9. Out of scope (explicitly)

- Streaming responses (true or cosmetic).
- The encryption-handoff commands (share / approve / view) and their client-action
  contract — **v2**.
- Routing location intents through the global KAI assistant.
- New DB migrations.
- Listing / managing location conversation history in the UI.

## 10. Skill plan (remainder of flow)

1. **superpowers:brainstorming** — complete (this spec).
2. User reviews this spec.
3. **superpowers:writing-plans** — implementation plan.
4. **superpowers:test-driven-development** + **superpowers:executing-plans** —
   build on `feat/one-location-agent-chat`.

## 11. Addendum (2026-06-28) — execution path correction

Manual testing surfaced that the consent-gated **ADK execution path does not
work** with the pinned `google-adk==1.28.1`. `hushh_adk/core.py`'s `HushhAgent`
was written against an incompatible ADK API: it imports `google.adk.model`
(does not exist), calls `super().run(input=...)` (ADK `LlmAgent` has no sync
`run()` — only `run_async(InvocationContext)` via a `Runner`), and passes
`system_instruction` (the pydantic field is `instruction`). The `try/except`
around the import silently flips `_ADK_AVAILABLE` to `False`, so a **stub** runs
whose `.run()` raises — `LocationAgent.handle_message` therefore always returned
its safe fallback. This path had never executed (KAI's working chat uses the
Gemini-direct path, not ADK).

**Decision (user):** keep v1 scope/contract identical, but **bypass the dead ADK
wrapper**. `LocationChatService` now runs a **Gemini function-calling loop**
using the backend's server-side client (`operons.kai.llm`), executed **inside a
`HushhContext`**. The 5 control-plane `@hushh_tool` callables remain the
function implementations, so they still enforce DB-backed scope validation —
`vault.owner` satisfies `cap.location.*` via `scope_matches` (master key).
Consent guarantees and coordinate-safety are unchanged.

Supersedes where they conflict:
- §4 "Response mode … consent-gated **ADK** path" → consent-gated **direct-Gemini**
  path (still non-streaming, still inside `HushhContext`).
- §4 turn path no longer calls `LocationAgent.handle_message`; it calls the
  Gemini client directly and dispatches tools itself.
- §4 `stateChanged` is now **precise**: `true` only when a mutating (non-query)
  tool actually ran successfully (the runner observes the tool calls).
- Adds a graceful "assistant unavailable" reply (errored, `stateChanged:false`)
  when the Gemini client is not configured.

Unchanged: endpoint, request/response shape, 5-tool allow-list, multi-turn
persistence via `AgentChatService`, frontend, and all privacy/consent invariants.
