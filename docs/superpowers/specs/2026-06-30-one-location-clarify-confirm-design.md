# One Location Agent Chat — Clarify-and-Confirm interactions

- **Date:** 2026-06-30
- **Branch:** `feat/one-location-agent-chat-v2` (v2 built + reviewed; live path confirmed working)
- **Status:** Approved design, ready for implementation plan
- **Builds on:**
  - `docs/superpowers/specs/2026-06-29-one-location-agent-chat-v2-design.md` (the `clientAction`/`actionResult` crypto-handoff contract)
  - its plan `docs/superpowers/plans/2026-06-29-one-location-agent-chat-v2.md`

## Visual Map

```text
Clarify-and-confirm sits BEFORE the v2 crypto handoff (same directive pattern)

Browser (/one/location chat)                      │  Server (consent-gated)
─────────────────────────────────────────────    │  ─────────────────────────────────────
"stop sharing my location"  (no whom)             │
  POST /chat { message }                     ────►│  Gemini loop in HushhContext
                                                  │   → request_active_share_choice()  (@hushh_tool,
                                                  │       coordinate-free: loads active shares w/ real grantIds)
                                                  │   → service translates result → clientPrompt
        ◄─────────────────────────────────────┘    { response:"Which sharing do you want to stop?",
  render ClarificationCard (checkboxes + Confirm)    clientPrompt:{ kind:"select", options:[…grantId refs], … } }
  user ticks Mom + Dad → [Confirm]                 │
  POST /chat { selectionResult:{ id,             ─►│  selectionResult turn: seed loop w/ chosen refs
    selected:[{grantId:g1},{grantId:g2}],          │   → revoke_location_share(g1); revoke_location_share(g2)
    status:"answered" } }                           │      (REAL ids — model never guessed them)
        ◄─────────────────────────────────────┘    { response:"Stopped sharing with Mom and Dad.",
  refresh()                                          stateChanged:true }

For SHARE: the same path ends by emitting the existing publish_share clientAction → ActionConfirmCard
(capture/encrypt/upload). Clarification PRECEDES and feeds the v2 crypto flow; it does not replace it.
"Stop all" / public link / share-with-everyone insert a confirm (Yes/No) prompt first.
```

## 1. Goal

v2 ships the crypto handoff, public links, and platform-aware sharing, and the
live path works. But underspecified commands degrade to **text-only**
clarification today (the prompt says only "if ambiguous, ask which person"), and
bare commands like **"Share my location"** (no recipient) or **"Stop sharing my
location"** (no whom) aren't explicitly handled. Users want the agent to **ask a
clarifying question and let them pick from options or type**, and to **confirm**
before destructive/bulk actions.

This adds a structured **clarify-and-confirm** interaction layer: the agent raises
a `clientPrompt` (select or confirm) with options the **server** populates from
real ids; the user taps (or types); the choice returns as a `selectionResult`; the
agent acts on the exact ids. It reuses the v2 directive architecture end-to-end.

## 2. Context — actual state on this branch (Step 0 findings)

| Area | Path / symbol | Note |
|---|---|---|
| v2 crypto contract | `LocationChatResponse.clientAction` + request `actionResult` (`api/routes/one/location_chat.py`, `services/location_chat_service.py`) | This feature adds two sibling fields, same pattern. |
| Directive translation | `location_chat_service.py` `_directive_from_tool` / `_build_client_action` | The model decides intent; the **service** builds the directive from tool results (the model never serializes ids). We extend this for prompts. |
| `propose_*` precedent | `agents/location/tools.py` `propose_public_link` / `propose_location_view` | Coordinate-free intent tools translated into a `clientAction`. The new `request_*_choice` tools mirror this exactly. |
| v2 tool allow-list | `tools.py` `V2_LOCATION_TOOLS`; factory `get_location_chat_agent_v2()` | New tools are added here; the v2 function declarations in the service are extended. |
| Prompt | `agents/location/agent.yaml` `system_instruction` | Today: "if the match is ambiguous, ask which person." We extend it for choice/confirm. |
| Crypto gate (unchanged) | `components/one-location/redesign/action-confirm-card.tsx` + hook `pendingAction` | Clarification adds a sibling `ClarificationCard` + `pendingPrompt`; share/view/link still terminate at `ActionConfirmCard`. |
| Static chips | `components/one-location/redesign/location-chat-suggestions.tsx` (`{label,mode,value}`) | Presentational, static — not reused for dynamic agent-driven options. |
| Hook | `components/one-location/redesign/use-location-chat.ts` (`pendingAction`, `confirmAction`, `cancelAction`, `report()`) | Extended with `pendingPrompt`, `answerPrompt`, `confirmPrompt`, `cancelPrompt`. |
| v1 anti-guessing fix | prompt "never invent ids; list first" + `_require_uuid` guard | This feature strengthens it: options carry real ids, so the model selects rather than fabricates. |

## 3. Scope (locked)

**In scope** (interaction types: **multi-select** — which also covers single-pick —
plus **Yes/No confirm**, plus **free-text fallback**):

- Share with **no / ambiguous recipient** → recipient selection (+ public link + free text).
- Stop sharing with **no whom / which** → multi-select of active shares + **"Stop all"**.
- **Destructive / irreversible confirms** → Yes/No before public link, share-with-everyone, stop-all.
- Secondary missing slots → **duration** (1h/8h/24h/custom), **which pending request** to approve, **whose incoming** location to view.

**Out of scope:** voice selection; search/reordering of long option lists (basic
list only); persisting prompts across reload (memory-only, like `conversationId`);
any change to the v2 crypto contract; SMS/email.

## 4. Architecture

Reuse the v2 directive pattern. The model only decides **which** prompt to raise;
the **service fills the options with real ids from the DB**, so the model never
hand-serializes a `grantId`/`recipientKeyId`.

```
Underspecified turn → Gemini loop in HushhContext
  → model calls a prompt-builder @hushh_tool (coordinate-free; loads options w/ real refs)
  → service translates the tool result → clientPrompt on the response (no mutation)
Client renders ClarificationCard (composer stays open for free text)
  → user taps/confirms/cancels → selectionResult follow-up turn (no message)
  → service seeds the loop with the resolved refs (coordinate-free context line)
  → agent runs the real action tool(s) on the exact ids
      • control-plane (revoke/deny/request) → completes server-side, stateChanged:true
      • share/view/public-link → emits the existing clientAction → ActionConfirmCard → crypto
```

`clientPrompt` and `clientAction` are **mutually exclusive on one response**
(clarify first, then act). A turn carries exactly one of: `message`,
`actionResult`, or `selectionResult`.

### New / changed backend files

| File | Change |
|---|---|
| `agents/location/tools.py` | **New** prompt-builder tools (below) + add them to `V2_LOCATION_TOOLS`. |
| `agents/location/agent.yaml` | **Edit** — prompt additions for choice/confirm (§6). |
| `services/location_chat_service.py` | **Edit** — v2 declarations gain the new tools; translate prompt-tool results → `clientPrompt`; handle the `selectionResult` turn (seed loop with refs, run actions). |
| `api/routes/one/location_chat.py` | **Edit** — request gains `selectionResult`; response passes through `clientPrompt`; a turn requires one of message / actionResult / selectionResult. |

## 5. The contract

Two new optional fields, parallel to v2's `clientAction`/`actionResult`,
fully backward-compatible. (Wire JSON is camelCase via Pydantic aliases, mirroring
v2: e.g. `minSelections`, `allowFreeText`, `freeText`.)

**Backend → client (on the chat response):**

```python
class PromptOption(BaseModel):        # coordinate-free
    label: str                        # human text, e.g. "Mom (•••4821)"
    ref: dict                         # real ids only — {recipientUserId, recipientKeyId} | {grantId} | {requestId} | {hours}
    hint: str | None = None           # secondary line, e.g. "expires in 2h"

class ClientPrompt(BaseModel):        # coordinate-free
    id: str                           # correlation key
    kind: str                         # "select" | "confirm"
    purpose: str                      # "select_recipient" | "select_share" | "select_duration"
                                      #   | "select_request" | "select_incoming" | "confirm_action"
    question: str
    options: list[PromptOption] | None = None     # for kind="select"
    min_selections: int = 1           # 1 = must pick at least one
    max_selections: int | None = None # 1 = single-pick; None = unlimited (multi-select)
    allow_free_text: bool = True      # keep the composer active
    confirm_label: str | None = None  # e.g. "Stop sharing", "Yes, stop all"
    cancel_label: str | None = None
    destructive: bool = False         # red styling for revoke / all / public link
```

**Client → backend (on the next request, sibling of `actionResult`):**

```python
class SelectionResult(BaseModel):     # coordinate-free
    id: str                           # echoes ClientPrompt.id
    kind: str                         # "select" | "confirm"
    selected: list[dict] | None = None # chosen options' refs (for select)
    confirmed: bool | None = None     # for confirm (yes/no)
    free_text: str | None = None      # if the user typed instead of tapping
    status: str                       # "answered" | "cancelled"
```

- **Free-text fallback:** if the user types into the composer while a prompt is
  pending, the client sends a `selectionResult` with `free_text` set (the agent
  re-resolves the typed answer) — not a plain `message`.
- TS mirror types (`PromptOption`, `ClientPrompt`, `SelectionResult`) live beside
  `ClientAction`/`ActionResult`; `LocationChatResponse` gains `clientPrompt?`.

## 6. New prompt-builder tools + prompt wording

All are coordinate-free `@hushh_tool`s that load real options from the service and
return a directive the service turns into a `clientPrompt`. Added to
`V2_LOCATION_TOOLS` and the v2 function declarations.

| Tool | Scope | Options (refs) |
|---|---|---|
| `request_recipient_choice()` | `cap.location.live.share` | verified recipients → `{recipientUserId, recipientKeyId}`; service appends a synthetic **"Public link"** option; recipients with no key are flagged in `hint` |
| `request_active_share_choice()` | `cap.location.live.revoke` | active outgoing shares → `{grantId}`; service appends a synthetic **"Stop all"** option |
| `request_duration_choice()` | `cap.location.live.share` | `{hours:1}`, `{hours:8}`, `{hours:24}` + free text for custom |
| `request_request_choice()` | `cap.location.live.request` | pending incoming requests → `{requestId}` |
| `request_incoming_choice()` | `cap.location.live.view` | active incoming shares → `{grantId}` (for "show me where someone is") |
| `request_confirmation(summary, destructive)` | `agent.one.orchestrate` | no options; `kind:"confirm"`, carries the summary to confirm |

`publish_location_envelope` / `view_location_envelope` remain **non-LLM-callable**,
unchanged.

**`agent.yaml` prompt additions** (extend, don't rewrite, the v2 prompt):
- "When a required detail is missing or ambiguous — who to share with, which share
  to stop, how long, which request — do NOT guess. Call the matching
  `request_*_choice` tool to ask, then act only on the ids the user picks."
- "Before any irreversible or bulk action — creating a public link, sharing with
  everyone, or stopping all shares — call `request_confirmation` and proceed only
  if the user confirms."
- Reinforces "never invent ids": the choice tools now supply the real ids.

## 7. Flow walkthroughs

**A. "Share my location" (no recipient, no duration)**
1. `request_recipient_choice()` → `clientPrompt{select_recipient, max_selections:null}` (recipients + Public link + free text).
2. User picks Mom → `selectionResult{selected:[{recipientUserId,recipientKeyId}]}`.
3. `request_duration_choice()` → 1h/8h/24h/custom (skipped if the user already implied a duration).
4. User picks 1h → `create_location_share(Mom,1h)` → existing **`publish_share` `clientAction`** → existing **`ActionConfirmCard`** → capture/encrypt/upload.

**B. "Stop sharing my location" (no whom)**
1. `request_active_share_choice()` → `clientPrompt{select_share, multi}` (Mom, Dad, … + **"Stop all"**).
2a. User picks Mom + Dad → `revoke_location_share(g1)`, `revoke_location_share(g2)` → `stateChanged:true`.
2b. User picks **"Stop all"** → `request_confirmation("Stop sharing with everyone?", destructive:true)` → Yes → revoke each active grant.

**C. Ambiguous name** ("stop sharing with Mom", two matches) → `request_active_share_choice()` filtered to matches → pick the right one.

**D. Destructive confirms** — public link & share-with-everyone route through `request_confirmation` before the action / `clientAction`.

**Cancel** at any prompt → `selectionResult{status:"cancelled"}` → agent acknowledges, nothing mutates.

## 8. Frontend

- **New `ClarificationCard`** (sibling of `ActionConfirmCard`, same gold tokens),
  rendered in the panel + overlay message stream when `pendingPrompt` is set:
  - `kind:"select"` → pill options; single-tap auto-selects when `max_selections:1`;
    checkboxes + a **Confirm** button when multi; `destructive` → red confirm.
  - `kind:"confirm"` → Yes/No buttons.
  - data-testids: `clarification-card`, `clarification-option`, `clarification-confirm`, `clarification-cancel`.
- **`useLocationChat` gains** `pendingPrompt: ClientPrompt | null`, `answerPrompt(refs[])`,
  `confirmPrompt(bool)`, `cancelPrompt()` — each POSTs a `selectionResult` follow-up
  turn (mirrors the existing `report()` for `actionResult`); on response it may set
  `pendingPrompt`, `pendingAction`, or neither.
- **Free-text fallback:** while `pendingPrompt` is set, typing in the composer sends
  a `selectionResult{free_text}` (not a plain message); the card clears.
- `clientPrompt` and `clientAction` never coexist on one response, so at most one
  card shows. `clear()` resets `pendingPrompt` too.
- Files: `clarification-card.tsx` (**new**); `use-location-chat.ts`,
  `location-chat-panel.tsx`, `location-chat-overlay.tsx`, `lib/one-location/types.ts`,
  `lib/one-location/service.ts` (**edit**).

## 9. Invariant ledger (all preserved)

| Invariant | Status | Detail |
|---|---|---|
| Coordinate-free directives | **Preserved** | `clientPrompt`, `PromptOption.ref`, `selectionResult` carry only ids/labels — never lat/lng. |
| Consent enforcement via `HushhContext` + per-tool scope | **Preserved** | Prompt-builder + action tools are `@hushh_tool`s; the `selectionResult` turn re-enters `HushhContext` to run resolved actions. |
| Service owns real ids (anti-guessing) | **Strengthened** | Options built server-side from DB reads; the model selects, never fabricates ids. |
| v2 crypto path unchanged | **Preserved** | share/view/public-link still terminate at `clientAction` + `ActionConfirmCard`; clarification only precedes it. |
| Explicit confirm for destructive/bulk | **Added** | public link, share-with-everyone, stop-all gated by a `confirm` prompt. |
| AES-256-GCM conversation at rest | **Preserved** | prompt/selection content is coordinate-free and safe to persist. |
| Opaque errors | **Preserved** | tool/selection failures map to safe agent messages. |

## 10. Testing strategy (TDD, extends v2 suites)

**Backend**
- Each `request_*_choice` tool returns coordinate-free options with **real refs**; no coordinate keys anywhere.
- Service translates a prompt-tool result into `clientPrompt` (correct `kind`/`purpose`/`options`/`max_selections`).
- A `selectionResult` turn seeds the loop so the agent acts on the **exact** ids (assert `revoke_location_share` called with the chosen `grantId`, never a guessed one).
- `request_confirmation` → `confirm` prompt; "stop all" requires a confirm; `cancelled` → no mutation.
- Prompt-builder tools are in `V2_LOCATION_TOOLS` but **never** expose `publish/view_envelope`.
- A turn requires exactly one of message / actionResult / selectionResult (route 422 otherwise).

**Frontend**
- `ClarificationCard` renders select (single + multi) and confirm; tapping sends the correct `selectionResult` refs; multi-select Confirm; `destructive` styling.
- Free-text-while-pending sends `free_text`; cancel sends `status:"cancelled"`.
- `pendingPrompt` and `pendingAction` never render together; `clear()` resets both.
- vitest + `tsc --noEmit` clean; existing v2 chat tests stay green.

## 11. Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Interaction types | Multi-select (covers single-pick) + Yes/No confirm + free-text fallback | User choice |
| Return contract | Structured `selectionResult` with real refs | Deterministic; multi-select-friendly; kills id-guessing |
| Who builds options | Server-side prompt-builder tools (service fills refs) | Model never serializes ids; mirrors v2 `propose_*` |
| Composition | Clarify precedes the v2 crypto `clientAction`; `ActionConfirmCard` stays the crypto gate | Reuse v2; no double-contract |
| Destructive/bulk | Explicit `confirm` prompt (stop-all, public link, share-with-everyone) | Safety |
| Surface | New `ClarificationCard`; mutually exclusive with `ActionConfirmCard` | One card at a time |

## 12. Skill plan (remainder of flow)

1. **superpowers:brainstorming** — complete (this spec).
2. User reviews this spec.
3. **superpowers:writing-plans** — implementation plan (TDD task breakdown).
4. **superpowers:subagent-driven-development** — build on `feat/one-location-agent-chat-v2`.
