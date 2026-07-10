# Connections as a First-Class Agent One Subagent — Findings & Proposals

**Date:** 2026-07-10
**Type:** Research + design (findings doc — no code)
**Repo:** `hushh-research` monorepo (`consent-protocol/` = Python/FastAPI backend + agents; `hushh-webapp/` = Next.js frontend + Capacitor iOS)
**Status:** Audit complete → ranked proposals → recommended first increment
**Decisions locked with product (2026-07-10):** consent posture = **confirm-before-write**; first-increment ambition = **full parity** (LLM tool-loop like Location).

---

## TL;DR

- The connections capability is **already registered and routed as a peer subagent** (`agent_connections`) — in fact it is wired *more* completely than Gmail, which the keyword classifier can't even reach.
- The real gap is **not** registration/nav/manifest. It is **capability depth**: the connections chat handler is a thin, deterministic **regex** service where **add** and **list** work, **remove is a hardcoded stub**, and **accept/reject aren't wired into chat at all** — while the full data layer (`ConnectionsService` + 9 REST routes) is real and complete.
- Location, by contrast, runs an **LLM tool-loop over 17 declared tools** with per-tool consent scopes. That is the parity target.
- **Recommended first increment:** rebuild `ConnectionsChatService` as an LLM tool-loop (Location's pattern) exposing the already-real `ConnectionsService` methods as consent-scoped tools, with **confirm-before-write** on every graph mutation. This closes the parity gap using capabilities that already exist end-to-end.

---

## Part 1 — Current-State Map (verified in code)

### 1.1 How Agent One chat is reached in navigation

**The chat surface component is `AgentChatWorkspace`** (`hushh-webapp/components/agent/agent-chat-workspace.tsx`), rendered two ways:

- **Primary — popover overlay (not a route):** `AgentPopoverSurface` renders `<AgentChatWorkspace variant="popover" .../>` inside a `role="dialog" aria-label="One"` section — `components/agent/agent-popover-provider.tsx:429` (dialog section from `:381`, `aria-label="One"` at `:402`). This global overlay is the everyday "Agent One" surface.
- **Legacy — full-page route `/agent`:** `app/agent/page.tsx:4` → `AgentScreen` (`components/agent/agent-screen.tsx:12`) → `<AgentChatWorkspace variant="page" />` (`agent-screen.tsx:41`). Route constant `ROUTES.AGENT = "/agent"` (`lib/navigation/routes.ts:46`). Actively suppressed elsewhere (`agent-bar.tsx:574`, `agent-popover-provider.tsx:253,265`) — a fallback surface.

**Note:** `/one` (`app/one/page.tsx:40`) renders `OneDashboardPage`, **not** the chat. The chat is reached *from* `/one` (and every authed surface) via the popover.

**Entry points that open the chat:**

- **Agent bar (primary):** the persistent pill above the bottom nav. Text button `onClick={openAgentChat}` (`components/agent/agent-bar.tsx:713`) → `agentPopover?.openAgent()` (`agent-bar.tsx:343-346`). Mounted globally in `app/providers.tsx:371` and `:450`.
- **Voice → chat handoffs:** `agentPopover?.openAgent({ handoff })` for sensitive/confirm-required voice actions (`agent-bar.tsx:240, 293, 312`).
- **Bottom navbar does NOT open the chat.** `components/navbar.tsx` only reads `agentPopover.expanded` to *hide* the navbar while chat is open (`navbar.tsx:257-263`); its search bubble opens the separate Kai command bar (`navbar.tsx:507`).
- **No top-bar / nav-popover entry.** The only production callers of `openAgent()` are in `AgentBar`.

**Branding string:** the codebase says **"Ask your agent anything"** (not "everything") — `agent-bar.tsx:72` (hint for `/one`) and `:75` (`AGENT_BAR_DEFAULT_HINT`), owned by `AgentBar`, rendered at `agent-bar.tsx:727`.

**Component tree (nav click → chat):**

```
app/providers.tsx
  └─ AgentPopoverProvider                 (providers.tsx:328)
       ├─ AgentBar                         (providers.tsx:371/:450; agent-bar.tsx:87)
       │    └─ "Ask your agent anything"   (agent-bar.tsx:710-729)
       │         └─ openAgentChat → agentPopover.openAgent()  (agent-bar.tsx:343-346)
       └─ AgentPopoverSurface              (agent-popover-provider.tsx:226)
            └─ openAgent() sets expanded=true  (agent-popover-provider.tsx:148-166)
                 └─ <section role="dialog" aria-label="One">  (agent-popover-provider.tsx:381-411)
                      └─ AgentChatWorkspace variant="popover"  (agent-popover-provider.tsx:429)
```

### 1.2 Chat message → subagent plumbing

**Frontend send path:**
- UI submit `handleSubmit` (`agent-chat-workspace.tsx:3505`) → `runAgentTurn` (`:2203`) → `streamAgentChat` (`:2926`).
- Client wrapper `lib/services/agent-chat-client.ts:131` → `ApiService.streamAgentChat` (`:146`).
- HTTP: `POST /api/kai/agent/chat/stream` (SSE) — `lib/services/api-service.ts:2790`. Body carries `delegateAgentId` / `delegateResult` (`api-service.ts:2786-2787`).
- (`app/api/one/[...path]/route.ts:36` is the JSON proxy for *other* One routes; chat streaming uses the `kai` proxy.)

**Backend runtime dispatch:**
- Entry: `consent-protocol/api/routes/kai/agent_chat.py:301` `@router.post("/agent/chat/stream")` → `stream_agent_chat(...)` (lives under the `kai` route module but is the Agent One runtime). A non-streaming sibling path also lands in this module (`resolve_delegate_target` at `agent_chat.py:143`).
- Delegate selection precedence (`agent_chat.py:312-329`): (1) explicit `delegate_result` `:321`; (2) explicit `delegate_agent_id` `:324`; (3) keyword classifier `:326-327` → `resolve_delegate_target` (`:143`) → `classify_specialist_domain` (`:150`) → gate on `is_wired_specialist` (`:160`, fail-closed).
- **The router** is a keyword table: `consent-protocol/hushh_mcp/agents/orchestrator/tools.py:150` `classify_specialist_domain`, driven by `_SPECIALIST_ROUTES` (`tools.py:31-190`).
- **Dispatch seam:** `a2a_dispatch(delegate_agent_id, task)` (`agent_chat.py:400`), streamed back via `specialist_result_to_frames` (`:163`, `:448`). Registry: `adk_bridge/dispatch.py:26` `dispatch()` over `_REGISTRY` (`:15`); `is_wired_specialist` (`:22`). Contract: `adk_bridge/contract.py` (`A2ATask:14`, `SpecialistTurnResult:36`).
- Fallback when no specialist matches: Gemini planner path (`agent_chat.py:491-782`).

### 1.3 Reference pattern — how Location & Gmail are subagents

**Location (the clean, fully-wired reference):**
- A2A handler: `adk_bridge/location_agent.py:31` `LocationAgentA2A`; `handle()` `:40` wraps `LocationChatService.handle_turn` (`:57`); factory `get_location_a2a()` `:85`.
- Registered: `adk_bridge/__init__.py:24` `register_specialist("agent_location", ...)`.
- Consent scope: `adk_bridge/delegation.py:17` (`agent_location` → `AGENT_ONE_ORCHESTRATE`).
- Router cues: `orchestrator/tools.py:159-171` ("location", "where is", "share my location", …).
- **Declarative manifest:** `hushh_mcp/agents/location/agent.yaml` — `tools:` block of **17 tools**, each `name` + `py_func` (`hushh_mcp.agents.location.tools.*`) + `required_scope` (e.g. `agent.one.orchestrate`, `cap.location.live.share`, view/request/revoke/refer).
- **Runtime tool-loop:** `services/location_chat_service.py:133-383` (`_function_declarations_v2`, used `:595`) — the LLM sees function declarations and calls them; per-tool consent via `@hushh_tool` / `HushhContext`.

**Gmail (partial reference — cautionary):**
- A2A handler `adk_bridge/gmail_agent.py:23`; registered `adk_bridge/__init__.py:23`; scope `delegation.py:20`.
- Two read-only tools in `services/gmail_chat_service.py` (`list_receipts` `:56/:219`, `sync_status` `:75/:226`).
- **Gaps:** no `agent.yaml`; **not reachable via the classifier** — "gmail"/"email" cues route to `agent_email`, not `agent_gmail` (`orchestrator/tools.py:174-189`). So `agent_gmail` is only reachable via an explicit `delegate_agent_id`. → *Location is the pattern to copy, not Gmail.*

### 1.4 Connections as an agent — what exists TODAY

**It is wired as a peer subagent (verified, not orphaned):**
- A2A handler: `adk_bridge/connections_agent.py:24-73` `ConnectionsAgentA2A` → `ConnectionsChatService.handle_turn` (`:43-49`); translates `clientPrompt` → `A2ADirective(kind="prompt")` (`:52-54`); singleton `get_connections_a2a()` (`:69-73`).
- Registered: `adk_bridge/__init__.py:8` (import), `:21` (`register_specialist("agent_connections", …)`).
- Consent scope: `adk_bridge/delegation.py:16` (`AGENT_ONE_ORCHESTRATE`).
- Classifier route: `orchestrator/tools.py:137-146` — domain `"connections"` → `agent_connections`, cues "trusted connection(s)", "who do i trust", "people i trust". (Legacy tool `delegate_to_connections_agent` at `tools.py:215-219`.)
- Exposed to One tree: tool `ask_connections_agent` (`one_adk/agent_tree.py:263-265`; roster `:373`); manifest mapping `one_adk/action_tools.py:49`.

**But the chat handler is a thin deterministic regex service** (`services/connections_chat_service.py`, no LLM):

| Capability | Chat status | Evidence |
|---|---|---|
| **Send request** | REAL — but phrasing-locked | `_add` `:86-99` → `create_request`; disambiguation via `select` clientPrompt `:90-91`, completed in `_complete_selection` `:174-178`. Matches **only** `_ADD_RE` = "add \<name\> to/into (my) trusted connections" (`:32-35`). "connect me with X" matches nothing. |
| **List** | REAL | `_list` `:106-111` → `list_connections`; `_LIST_RE` `:40-43`. |
| **Remove** | **STUBBED** | `_remove` `:101-104` returns hardcoded "You can manage connections from the Connect page now." — never calls `remove_connection`. Disambiguated remove also stubbed: `_complete_selection` `op=="remove"` `:170-173`. |
| **Accept / reject** | **NOT WIRED** | No regex, no branch; falls through to `_HELP` `:45-48, :83`. |

**Can a user do it via Agent One chat today, end to end?**
- **Send:** partially — "add \<name\> to my trusted connections" works end to end; "connect me with \<name\>" does not route or match.
- **List:** yes ("who do I trust" / "list my trusted connections").
- **Remove:** no — routes correctly but returns the stub deflection.
- **Accept/reject:** not reachable via chat at all.

**The real capabilities already exist (fully implemented):**
- `ConnectionsService` (`services/connections_service.py`), Postgres-backed (`connection_requests`, `connections`, mirrored `trusted_connections`): `create_request` `:74-147` (directory resolve `_resolve_query` `:58-71`, `IdentityUnresolvedError` on ambiguity, idempotent), `accept_request` `:184-226` (creates canonical `connections` row + two mirrored trusted edges), `reject_request` `:278-294`, `cancel_request` `:296-312`, `list_requests` `:315-350`, `search_directory` `:352-431` (annotated connected/pending_in/pending_out/none), `list_connections` `:433-458`, `remove_connection` `:460-500`, `link_circle_invite` `:228-276` (dormant).
- **9 REST routes** (`api/routes/one/connections.py`, prefix `/api/one`, Firebase-auth): `GET /connections/directory` `:34`, `GET /connections` `:47`, `GET /connections/requests` `:55`, `POST /connections/requests` `:66`, `POST /connections/link-circle-invite` `:84`, `POST /connections/requests/{id}/accept` `:97`, `.../reject` `:108`, `.../cancel` `:119`, `DELETE /connections/{id}` `:130`.
- **Frontend client** wrapping all of it: `hushh-webapp/lib/services/connections-service.ts` (`searchDirectory` `:54`, `listConnections` `:71`, `listRequests` `:80`, `sendRequest` `:92`, `accept` `:105`, `reject` `:113`, `cancel` `:121`, `removeConnection` `:129`) — this is the "Connect page" the chat stub defers to.

> **Model note:** the 2026-07-05 spec described a *directional* trust model (no accept). The shipped system evolved to a **two-way request/accept graph** (`connection_requests` + `connections`) that *mirrors* into the older `trusted_connections` table on accept (`connections_service.py:184-226`). The doc below uses the shipped two-way model.

---

## Part 1.4 — Parity Gaps (connections vs. Location)

| Dimension | Location | Connections | Gap? |
|---|---|---|---|
| A2A handler registered | ✅ `location_agent.py` / `__init__.py:24` | ✅ `connections_agent.py` / `__init__.py:21` | **No gap** |
| Consent scope mapped | ✅ `delegation.py:17` | ✅ `delegation.py:16` | **No gap** |
| Classifier-routable | ✅ `tools.py:159-171` | ✅ `tools.py:137-146` | **No gap** (better than Gmail) |
| Exposed in One tree | ✅ | ✅ `agent_tree.py:263` | **No gap** |
| Backing data/service layer | ✅ | ✅ `ConnectionsService` (complete) | **No gap** |
| **Handler intelligence** | **LLM tool-loop** over declared functions (`location_chat_service.py:133-383`) | **Regex** matcher (`connections_chat_service.py`) | **GAP — core** |
| **Declarative manifest** (`agent.yaml`) | ✅ 17 tools w/ per-tool scopes | ❌ none | **GAP** |
| **Per-tool consent scopes** | ✅ (`cap.location.*`) | ❌ only the coarse `agent.one.orchestrate` | **GAP** |
| **CRUD coverage in chat** | Full for its domain | add/list only; remove stubbed; accept/reject absent | **GAP** |
| **NL phrasing robustness** | High (LLM) | Brittle (single regex) | **GAP** |

**Conclusion:** connections is a *fully registered* peer already. The parity work is entirely in the **handler** (regex → LLM tool-loop), **manifest** (add `agent.yaml`), **per-tool consent**, and **CRUD completeness** — not in routing/nav/registration.

---

## Part 2 — Possibilities (ranked)

Ranked by value ÷ effort, given the locked decisions (confirm-before-write, full-parity first). Each: **Value / Scope / Dependencies / Risks.**

### P1 — Full CRUD parity via an LLM tool-loop handler ★ recommended first
Replace the regex `ConnectionsChatService` with a Location-style tool-loop: declare `send_request`, `list_connections`, `list_requests`, `accept_request`, `reject_request`, `cancel_request`, `remove_connection`, `search_directory` as functions over the *already-real* `ConnectionsService`; add an `agents/connections/agent.yaml` manifest.
- **Value:** High. Turns a partial front-door into a true peer subagent; fixes remove + accept/reject; makes "connect me with Priya", "who are my connections", "accept Priya's request", "remove X" all work. Unblocks every later idea.
- **Scope:** Medium. All plumbing exists; the work is the handler rewrite + manifest + tool declarations + confirm-before-write wiring. No new tables, no new REST routes, no frontend change (SSE path is generic).
- **Dependencies:** `ConnectionsService` (done), directory resolution (done), `clientPrompt`/`A2ADirective` confirm mechanism (exists — used by `_complete_selection` and Location).
- **Risks:** LLM calling a *write* tool without confirmation → mitigated by confirm-before-write gate (see Part 3). Directory ambiguity → already handled via `IdentityUnresolvedError`. Regression on the two working phrasings → covered by keeping/porting their tests.

### P2 — Natural-language connection discovery
"find people I know at Acme", "who do I know in Bangalore", "show pending requests". Backed by `search_directory` (`connections_service.py:352-431`, already annotates relationship state) + `list_requests`.
- **Value:** High — discovery is the natural front half of "connect me with…". Directly leverages the annotated directory.
- **Scope:** Small once P1 exists (add read-only `search_directory` / `list_requests` tools + result formatting). Larger if it needs richer directory metadata (company/location filters beyond what the directory currently annotates).
- **Dependencies:** P1 (tool-loop). Directory field coverage (verify what `search_directory` exposes before promising "at Acme"-type filters).
- **Risks:** Over-promising filters the directory can't back; privacy — must inherit directory eligibility rules (it already does).

### P3 — Cross-subagent composition (connections × location × gmail)
"share my location with my new connection", "email my connections". One's planner already delegates across specialists; here the *object* of a location/gmail action is resolved via connections.
- **Value:** High, differentiating — this is the "graph as substrate" payoff.
- **Scope:** Medium-Large. Needs a shared identity-resolution seam (connection → user_id/recipient) callable across agents, plus multi-step planner orchestration and a combined consent story (location share consent *and* connection consent).
- **Dependencies:** P1; Location's share tools (`agent.yaml`); Gmail is currently read-only (`gmail_chat_service.py`) and classifier-unreachable — "email my connections" needs a *sending* Gmail/email capability that doesn't exist yet.
- **Risks:** Fan-out actions (email/share to *all* connections) are high-blast-radius — must be confirm-before-write with explicit recipient enumeration. Compounded consent bugs across agents.

### P4 — Proactive / agentic suggestions
Surface pending incoming requests on chat open ("Priya asked to connect — accept?"); suggest connections ("you and Alex both know Sam"). Uses `list_requests(direction=incoming)` and graph adjacency.
- **Value:** Medium-High — makes the graph feel alive; drives accept-rate.
- **Scope:** Medium. Needs a proactive surface (greeting/notification hook in the workspace), a suggestion source (2nd-degree adjacency query — new read), and rate/relevance controls.
- **Dependencies:** P1; a place to inject proactive messages (agent-bar hint or workspace greeting — `agent-chat-workspace.tsx:635-638`); possibly a new adjacency query on `connections`.
- **Risks:** Notification fatigue; suggesting people the user doesn't want surfaced (privacy). Should be opt-in and consent-gated.

### P5 — Per-tool consent scopes for connections
Introduce `cap.connections.request / .accept / .remove / .read` (mirroring `cap.location.*`) instead of the single coarse `agent.one.orchestrate`.
- **Value:** Medium — principled consent, enables fine-grained agent-initiated permissions and auditability; prerequisite for *unattended* agentic writes later.
- **Scope:** Medium. New scope constants, token issuance, manifest wiring, enforcement in each tool.
- **Dependencies:** P1 (manifest/tool-loop is where scopes attach).
- **Risks:** Migration/token-reissue friction; over-engineering if confirm-before-write already covers the safety need for v1. **Defer unless P3/P6 (agent-initiated, less-interactive writes) land.**

### P6 — Circle-invite / external-invite conversational flow
Activate the dormant `link_circle_invite` (`connections_service.py:228-276`) so One can mint/claim invites for people not yet on the platform ("invite my colleague Sam").
- **Value:** Medium — extends connections beyond existing directory users (growth loop).
- **Scope:** Large — invite issuance, claim, delivery (email/SMS), and the not-yet-a-user identity path.
- **Dependencies:** P1; an invite-delivery channel; product decision on external invites.
- **Risks:** Spam/abuse vectors; identity of non-users; largest new surface. **Lowest priority.**

---

## Part 3 — Consent / permission model for agent-initiated actions

**Locked posture: confirm-before-write.** Every graph *mutation* the agent proposes requires an explicit in-chat confirmation before it executes.

- **Reads** (`list_connections`, `list_requests`, `search_directory`) → run directly under `agent.one.orchestrate` (already the scope).
- **Writes** (`send_request`, `accept_request`, `reject_request`, `cancel_request`, `remove_connection`) → the tool-loop resolves identity, then emits a **`clientPrompt` / `A2ADirective(kind="prompt")`** describing the exact action ("Send a connection request to *Priya R.*?" / "Remove *Alex T.* from your connections?"). The write executes only on the user's confirming turn — reusing the existing selection-completion pattern (`connections_chat_service.py:174-178`, `connections_agent.py:52-54`).
- **Identity ambiguity** stays orthogonal: multi-match → disambiguation prompt first (`IdentityUnresolvedError`), then the confirm prompt.
- **Fan-out actions** (P3 "email/share to all connections") → confirm must **enumerate recipients**, never a blind "all".
- **Fine-grained scopes (P5)** are *not required* for v1 — confirm-before-write is the safety boundary. Introduce `cap.connections.*` only when we want *less-interactive* or *proactive* writes (P3/P4/P6).

---

## Recommended first increment

**Build P1: rebuild `ConnectionsChatService` as a Location-style LLM tool-loop over the existing `ConnectionsService`, with confirm-before-write on every mutation, plus an `agents/connections/agent.yaml` manifest.**

Why this first:
1. **Highest leverage, lowest new surface.** The data layer, REST routes, registration, consent scope, classifier route, and One-tree exposure are *all already done*. The only missing piece is an intelligent handler — so this is mostly a rewrite of one service against APIs that already work end to end.
2. **It fixes the actual, verified gaps** — remove (stubbed), accept/reject (absent), and brittle phrasing ("connect me with X") — in one coherent change instead of piecemeal regex patches.
3. **It's the unlock for everything else.** P2 (discovery), P3 (cross-agent), and P4 (proactive) all assume a real tool-loop with confirmable writes. P1 is their foundation.
4. **It matches the locked decisions** (full parity + confirm-before-write) exactly, and copies the *proven* reference (Location), not the half-wired one (Gmail).

**Concrete v1 tool set (all over existing `ConnectionsService`):** `search_directory` (read), `list_connections` (read), `list_requests` (read), `send_request` (write→confirm), `accept_request` (write→confirm), `reject_request` (write→confirm), `remove_connection` (write→confirm). Keep the two currently-working phrasings green via ported regex-era tests as a regression guard.

**Explicitly deferred:** P5 (fine-grained scopes — confirm-before-write suffices for v1), P6 (external invites), and the sending side of Gmail needed for P3's "email my connections".
