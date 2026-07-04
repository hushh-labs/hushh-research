# Email Agent — A2A with the central One chat (design)

**Date:** 2026-07-04
**Branch:** `feat/email-a2a`
**Status:** Approved design, ready for implementation planning
**Related:** `docs/future/email-agent-nudges-plan.md` (Phase 2 — A2A)

## Goal

Wire the **Gmail/email agent** into the central **One** chat ("ask your agent
everything") as a delegable specialist, mirroring how the **location agent** is
wired. From the One chat a user can ask inbox questions and One transparently
delegates to the email agent, which answers and round-trips back to One.

Two phases:

- **Phase 2a (this slice):** email as a **read-only delegable specialist**.
  Small; mirrors the location read path. No DB, no frontend, no new OAuth scope.
- **Phase 2b (designed here, built later):** the **durable A2A request/approve
  flow** — another agent (or One on the owner's behalf) requests the email agent
  to fetch / draft / send / schedule → the owner approves/denies → email
  executes. Mirrors the marketplace durable-request stack.

## Non-goals

- **Cross-specialist chaining** (email → location/finance directly). Only One
  orchestrates; specialists return to One, which decides any onward hop. This
  matches how location works and is explicitly out of scope.
- **Consolidating the standalone Gmail chat panel.** The existing Gmail-page
  chat (`components/gmail/gmail-chat-panel.tsx` → `POST /api/one/email/chat`)
  stays as-is and coexists with the One wiring — exactly as location keeps both
  its standalone chat and its One adapter.
- **Network A2A.** The in-process dispatch seam is designed to swap to network
  later without touching callers; doing it now is out of scope.

## Background: the established A2A architecture (reference)

The central One agent is `app/agent/page.tsx` → `AgentScreen` →
`AgentChatWorkspace`, streaming from `POST /api/kai/agent/chat/stream`
(`consent-protocol/api/routes/kai/agent_chat.py`, `stream_agent_chat`).

Delegation is a **fail-closed intercept** in that route:

1. `resolve_delegate_target(message)` → `classify_specialist_domain`
   (deterministic keyword classifier in
   `hushh_mcp/agents/orchestrator/tools.py`, `_SPECIALIST_ROUTES`) → a specialist
   `agent_id`, then requires `is_wired_specialist(agent_id)`.
2. If wired, the route validates the A2A consent token, builds an `A2ATask`, and
   `await a2a_dispatch(agent_id, task)` over the in-process seam
   (`hushh_mcp/adk_bridge/dispatch.py` registry).
3. Each specialist is a thin adapter (`hushh_mcp/adk_bridge/<agent>.py`) that
   wraps an existing per-domain chat service **unchanged** and returns a generic
   `SpecialistTurnResult`.
4. The route re-emits that as SSE frames (`token`, optional
   `specialist_directive`, `complete`).
5. For actions needing local secrets/crypto, the frontend renders a directive
   card; on confirm the browser executes and POSTs a `DelegateResult` back as a
   follow-up turn (`delegate_result`) which dispatches to the same specialist.

Key contract types (`hushh_mcp/adk_bridge/contract.py`):

```python
@dataclass(frozen=True)
class A2ATask:                       # One → specialist
    user_id: str
    consent_token: str
    conversation_id: str | None
    message: str | None = None
    delegate_result: dict | None = None
    timezone: str | None = None
    planned_action: dict | None = None

@dataclass(frozen=True)
class SpecialistTurnResult:          # specialist → One
    conversation_id: str
    text: str
    directive: A2ADirective | None
    is_complete: bool
    state_changed: bool
    model: str
```

Registered specialists today (`hushh_mcp/adk_bridge/__init__.py`):
`agent_location`, `agent_connected_systems`, `agent_nav`,
`agent_personal_information`. **No `agent_email`.**

The email agent today is **standalone**: `hushh_mcp/services/email_chat_service.py`
(read-only tools `list_needs_reply`, `search_inbox`; gates on `VAULT_OWNER` +
the `gmail.readonly` OAuth connection; no `HushhContext`) is reached only by
`api/routes/one/email_chat.py` from `gmail-chat-panel.tsx`. It has no A2A
adapter, no registration, no classifier cue, no consent-scope mapping.

Crucially, `EmailChatService.handle_turn` already returns the specialist
contract shape:

```python
return {"conversationId": ..., "response": reply,
        "isComplete": not errored, "stateChanged": False}
```

## Phase 2a — Email as a read-only delegable specialist

### Backend changes (4 files, mirroring location)

1. **`hushh_mcp/adk_bridge/email_agent.py`** *(new)* —
   `EmailAgentA2A.handle(task)` wraps
   `EmailChatService.handle_turn(user_id, message, consent_token, conversation_id)`
   and maps its dict → `SpecialistTurnResult`:
   - `conversationId` → `conversation_id`
   - `response` → `text`
   - `isComplete` → `is_complete`
   - `stateChanged` → `state_changed`
   - `model = "one+email"`
   - `directive = None` (email is read-only; emits no `clientAction`/`clientPrompt`)

   Singleton `get_email_a2a()`. This is a strictly simpler `location_agent.py`
   — no directive/selection mapping.

2. **`hushh_mcp/adk_bridge/__init__.py`** — register in
   `_register_builtin_specialists()`:
   `register_specialist("agent_email", lambda task: get_email_a2a().handle(task))`
   plus the import of `get_email_a2a`.

3. **`hushh_mcp/agents/orchestrator/tools.py`** — add an
   `("email", "agent_email", (cues…))` entry to `_SPECIALIST_ROUTES`. Cues are
   **qualified/possessive**, not bare nouns:
   `"needs a reply"`, `"my inbox"`, `"my email"`, `"unread"`, `"reply to"`,
   `"emails from"`, `"gmail"`. Placed deliberately so marketplace/finance keep
   their existing cues; email only wins on inbox-specific phrasing.

4. **`hushh_mcp/adk_bridge/delegation.py`** — add
   `"agent_email": ConsentScope.AGENT_ONE_ORCHESTRATE` to
   `SPECIALIST_A2A_SCOPE_MAP` (same least-privilege scope location/marketplace
   use; no email-specific scope exists in `constants.py`).

### Consent reconciliation

Email today gates only on `VAULT_OWNER` + the `gmail.readonly` OAuth connection
(no `HushhContext`). Via One, the delegated path runs behind the One stream
route's own `require_vault_owner_token` dependency, and the existing
Gmail-connection + owner check inside `EmailChatService` is unchanged and still
enforced. So the delegated path is gated **equally, never weaker** — in fact
`VAULT_OWNER` is a stronger gate than the mapped `AGENT_ONE_ORCHESTRATE` scope.

Note on the scope map: `SPECIALIST_A2A_SCOPE_MAP["agent_email"]` records the
least-privilege scope for the specialist, but — mirroring `location_agent.py`
and the other read specialists — the email adapter does **not** itself call
`validate_a2a_consent_token` (only the `nav`/`kai` adapters do today), and
`EmailChatService` accepts `consent_token` without consuming it. The map entry
is the declared contract; the live gate is the route's `VAULT_OWNER` dependency.
Wiring `validate_a2a_consent_token` into the read adapters is a separate,
cross-specialist hardening, out of scope for Phase 2a.

### Frontend

**None.** `agent_email` has no client directive, so a delegated turn renders as
normal streamed assistant text in `AgentChatWorkspace`. `DelegateResult`'s union
type does not need widening. The standalone Gmail chat panel is untouched.

### Round-trip (read-only email)

1. User types in the One chat → `POST /api/kai/agent/chat/stream` with `message`.
2. `stream_agent_chat`: `resolve_delegate_target` → `classify_specialist_domain`
   matches an email cue → `agent_email`; `is_wired_specialist` now true.
3. Route (behind its `require_vault_owner_token` dependency) calls
   `prepare_turn` (persists user msg, gets `conversation_id` + history), builds
   `A2ATask(user_id, consent_token, conversation_id, message)`, and
   `await a2a_dispatch("agent_email", task)`. (`consent_token` is carried on the
   task for contract parity; the read adapter does not re-validate it — see
   Consent reconciliation.)
4. `EmailAgentA2A.handle` → `EmailChatService.handle_turn` runs its existing
   Gemini tool loop (`list_needs_reply`, `search_inbox`) over the
   `gmail.readonly` connection → returns text.
5. Route → `specialist_result_to_frames` streams `token` (the answer) +
   `complete`. No `specialist_directive` frame. Assistant message saved
   server-side.
6. Follow-up turns in the same conversation re-resolve to `agent_email` and
   continue the thread — the conversational "back and forth".

### Routing precision (the one real risk)

The keyword classifier is shared and email vocabulary overlaps with finance
("invoice"), marketplace ("access request"), and nav ("open email").
Mitigations:

- Qualified, possessive cues (`"my inbox"`, `"needs a reply"`) — not bare nouns.
- Deliberate ordering so marketplace/finance keep their cues; email wins only on
  inbox-specific phrasing.
- Reuse the existing nav-intent guard so "open/go to my email" navigates instead
  of delegating.
- Fail-closed: no positive email cue → stays with One's planner (today's
  behavior), never a silent misroute.

### Testing (Phase 2a)

Mirror `tests/test_email_chat_service.py` (no live LLM/Gmail/DB):

1. `classify_specialist_domain`: email cues → `agent_email`; overlapping
   finance/marketplace phrases still route to their agents; nav phrases
   ("open my email") don't delegate.
2. `EmailAgentA2A.handle`: dict → `SpecialistTurnResult` mapping via a fake
   `EmailChatService`.

Manual: from `/agent`, ask "what needs a reply?" → verify delegation and the
streamed answer. No frontend typecheck impact (no FE changes).

## Phase 2b — durable A2A (designed now, built later)

The "another agent asks the email agent to *do* something → approve/deny →
execute" flow. Mirrors the marketplace durable-request stack
(`marketplace_access_requests` + `MarketplaceRequestService` +
`api/routes/one/marketplace_requests.py` + `InformationChatService` durable
tools). **Not built in this slice.**

**Core principle:** the durable request row *is* the consent gate. A requesting
agent (or One on the owner's behalf) files a `pending` request; the owner
approves; **only then** does email execute the side-effect. This keeps mutations
off the LLM's hot path — approval is an explicit owner action, exactly like
marketplace.

Motivating actions (all selected): **fetch inbox info for another agent,
draft reply, send reply, schedule meeting.**

### Data model — `email_agent_requests` (new migration)

Mirror `marketplace_access_requests`:

- `id`, `owner_user_id`, `requester_agent_id` (e.g. `agent_kai`, `agent_one`),
  `requester_label`
- `action` ∈ `{fetch, draft_reply, send_reply, schedule_meeting}`
- `params` (JSON — e.g. thread id, draft body, meeting time)
- `status` ∈ `{pending, approved, denied, expired, completed}`
- `result` (JSON — populated on completion), `message`, `created_at`,
  `resolved_at`, `completed_at`

### Service — `EmailAgentRequestService`

Mirror `hushh_mcp/services/marketplace_request_service.py`: `create_request(...)`,
`list_requests(owner, status?)`, owner-scoped `approve`/`deny`/`complete` with
the same `.eq(id).eq(owner_user_id).eq(status,"pending")` guard preventing
cross-user / double resolution.

### Routes — `api/routes/one/email_requests.py`

Mirror `marketplace_requests.py`, all `require_vault_owner_token`:
`POST /requests`, `GET /requests?status=`, `POST /requests/{id}/approve`,
`POST /requests/{id}/deny`.

### Mutating tools on `EmailChatService`

Mirror `information_chat_service.py`: `list_email_requests`,
`approve_email_request(id)`, `deny_email_request(id)` — added to a
`_MUTATING_TOOLS` set so a turn that resolves a request sets `stateChanged=True`,
driving the frontend inbox refetch (mirror `use-marketplace-chat.ts`
`onStateChanged`). This lets One approve/act on an email request **server-side
over A2A** with no browser round-trip.

### Per-action consent escalation (called out, not hidden)

| Action | Scope needed | New OAuth? |
|---|---|---|
| `fetch` (cross-agent read) | existing `gmail.readonly` + durable approval | No |
| `draft_reply` (draft only, no send) | existing `gmail.readonly` + durable approval | No |
| `send_reply` (real side-effect) | **`gmail.send`** + durable approval | **Yes (re-consent)** |
| `schedule_meeting` | **Calendar scope** + durable approval | **Yes (new consent)** |

The durable-request scaffold (table/service/routes/tools) is action-agnostic, so
`fetch` and `draft_reply` can ship first (no new OAuth); `send_reply` and
`schedule_meeting` follow once their extra scopes are wired.

### Optional client directive

Only if an action needs an in-chat confirm card (e.g. "send this draft?"). That
would add an `email_agent.py` directive mapping + a runtime (like
`lib/agent/specialist-directive-runtime.ts`) + a card variant + widening
`DelegateResult`'s union. Deferred until an action actually needs UI
confirmation beyond the approve/deny inbox.

## Build sequence

- **Phase 2a (this slice):** 4 backend files + tests. No DB, no frontend, no new
  OAuth. Ships email as a read-only delegable specialist in the One chat.
- **Phase 2b (next slice):** durable-request stack — migration,
  `EmailAgentRequestService`, routes, mutating tools, frontend refetch wiring.
  `fetch` + `draft_reply` first (no new OAuth); `send_reply` (needs
  `gmail.send`) and `schedule_meeting` (needs Calendar scope) gated behind their
  new consents.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Classifier misroutes (email cues overlap finance/marketplace/nav) | Qualified possessive cues, deliberate ordering, nav-intent guard, fail-closed to One's planner; unit-tested against overlapping phrases |
| Consent gap (email uses no `HushhContext` today) | Delegated path runs behind the One route's `VAULT_OWNER` dependency + the existing `gmail.readonly` + owner check — gated equally, never weaker (`VAULT_OWNER` ≥ the mapped `AGENT_ONE_ORCHESTRATE`). Read adapters don't re-validate the A2A token; that's deferred cross-specialist hardening. |
| Phase 2b send/schedule are irreversible side-effects | Durable `pending` row is the gate; execution only after explicit owner approval; new OAuth scopes are hard prerequisites |
| Scope creep into cross-specialist chaining | Explicitly out of scope; only One orchestrates, matching location |

## Reference files to mirror

| Concern | Reference |
|---|---|
| A2A adapter | `hushh_mcp/adk_bridge/location_agent.py` |
| Registration | `hushh_mcp/adk_bridge/__init__.py` |
| Contract | `hushh_mcp/adk_bridge/contract.py` |
| Dispatch seam | `hushh_mcp/adk_bridge/dispatch.py` |
| Consent scope | `hushh_mcp/adk_bridge/delegation.py` |
| Classifier | `hushh_mcp/agents/orchestrator/tools.py` (`_SPECIALIST_ROUTES`) |
| Orchestrator route | `api/routes/kai/agent_chat.py` (`resolve_delegate_target`, `specialist_result_to_frames`) |
| Underlying chat svc | `hushh_mcp/services/email_chat_service.py` (already contract-shaped) |
| Durable record svc/route (2b) | `hushh_mcp/services/marketplace_request_service.py`, `api/routes/one/marketplace_requests.py` |
| Durable tools (2b) | `hushh_mcp/services/information_chat_service.py` |
| Frontend refetch (2b) | `components/one-marketplace/use-marketplace-chat.ts` (`onStateChanged`) |
