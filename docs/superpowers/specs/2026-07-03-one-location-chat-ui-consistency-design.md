# One + Location chat — UI consistency & visible selections (design)

- **Date:** 2026-07-03
- **Branch:** `feat/one-location-chat-ui-consistency` (off latest `origin/main`)
- **Status:** Approved design (pending user spec review)
- **Builds on:** `docs/superpowers/specs/2026-07-02-one-a2a-location-central-chat-design.md`
  (the A2A delegation slice that surfaced Location inside the central chat).

## Visual Map

```text
User taps a card option (recipient / duration / confirm)
  │  browser: describeSelection(prompt, sel) → display  (coordinate/id-free)
  │           append SelectionChip ("Abdul Zalil · 8h") + clear the card
  ▼
  central One chat:  POST /agent/chat/stream { delegate_result: { …, display } }
  Location chat:     POST /api/one/location/chat { selectionResult: { …, display } }
  │
  ▼  LocationChatService._handle_selection_result  (persist role="user")
       content  = raw seed            → LLM keeps exact ids ("do not guess")
       metadata = { kind:"selection", display }  → ENCRYPTED at rest
  │
  ▼  history reload → API returns UI-safe { kind, display } only
       browser renders the chip from metadata.display — never the raw seed

Both chats share the same cards (primary palette) and the same SelectionChip.
```

## 1. Problem

Two chat surfaces now run the same Location flow but look and behave differently:

- **Central "One" chat** (`agent-chat-workspace.tsx`) — brand `primary` palette, solid
  primary user pills. It also shows an ugly raw user bubble:
  `I selected: recipientUserId=5dM8Qij…; recipientKeyId=Wl… Use exactly these ids —
  do not guess — and proceed.` and `I selected: hours=8. …`.
- **Standalone Location subagent chat** (`components/one-location/redesign/*`) — cream
  `#b8894d` / `#d4a574` palette, asymmetric-corner bubbles, cream cards. It never shows
  the raw id-dump because it uses local message state and ignores the persisted seed.

Two defects follow:

1. **Inconsistent styling** between the two surfaces (and even *within* the central
   chat: its `primary`-themed specialist wrappers embed the cream location cards).
2. **Ugly / leaky selection text** in the central chat — raw recipient/key ids surface
   as a `role="user"` bubble, and reappear on every history reload.

## 2. Root cause (verified)

- The raw string is **backend-generated**, not built in the webapp:
  `consent-protocol/hushh_mcp/services/location_chat_service.py`,
  `_selection_seed_text(selection_result)` (defined ~L336–350) returns
  `f"I selected: {refs}. Use exactly these ids — do not guess — and proceed."`.
- That one string does **double duty**: it is (a) the instruction seed handed to the
  LLM, and (b) persisted as a `role="user"` message in the shared chat store
  (`_handle_selection_result`, ~L708 builds it, ~L713–719 persists it).
- The standalone location chat never re-hydrates that persisted seed, so it stays
  hidden there; the central chat *does* re-hydrate the shared conversation, so it leaks.
- The location confirmation/selection cards are **shared** between surfaces: the central
  chat's `SpecialistPromptCard` / `SpecialistDirectiveCard`
  (`components/agent/specialist-directive-card.tsx`) wrap the location
  `ClarificationCard` / `ActionConfirmCard`
  (`components/one-location/redesign/`). Retheming those primitives fixes both surfaces.

## 3. Decisions (locked with user)

1. **Target style:** both chats converge on the **central `primary` look**. The Location
   subagent surface is rethemed away from cream to match the central chat.
2. **Selection display:** when a user picks an option, show **both** a right-aligned
   **user selection chip** *and* **collapse the source card** to a read-only selected
   state.
3. **Fix depth:** **robust backend + frontend**. Backend persists structured selection
   metadata + a human-readable display string; the raw LLM seed stays internal-only.
4. **Collapsed card form (default):** collapsed cards shrink to a **single compact
   line** (icon + chosen value), not a full-height card. Adjustable on review.

## 4. Architecture — changes by layer

### 4.1 Backend

`consent-protocol/hushh_mcp/services/location_chat_service.py`

- Split the current `_selection_seed_text` responsibility into two:
  - **`_selection_seed_text` (LLM seed)** — wording unchanged
    (`recipientUserId=…; … do not guess …`). Continues to feed the model's turn context.
    It is **no longer** the persisted user-visible content.
  - **Persisted user message** — store a short human-readable `display` string as the
    message `content`, plus structured `selection` metadata on the message:
    `{ type, refs, label }` (e.g. `type:"recipient"`, `label:"Abdul Zalil"`).
- The `display`/`label` originates on the frontend (the card already knows the friendly
  label; the backend only had opaque ids). It arrives on the delegate/selection payload.
- `_handle_selection_result` (~L708–719): persist `role="user"` with
  `content = display`, `metadata.selection = { type, refs, label }`. The LLM still
  receives the raw seed for its reasoning; it is never persisted as visible content.

`consent-protocol/api/routes/kai/agent_chat.py`

- Extend the delegate-result request model with the optional `display` /`selection`
  fields (coordinate-free; recipient/duration labels only). Backward-compatible: if
  absent, fall back to a best-effort display derived from refs.

**Invariant:** no coordinates enter the display string or metadata; the coordinate-free
guarantee from the A2A slice is preserved.

### 4.2 Frontend

`hushh-webapp/lib/services/agent-chat-client.ts`

- Add `display` / `selection` to the delegate-result request body.
- When hydrating history, expose the persisted `selection` metadata so the workspace can
  render a chip rather than raw text.

`hushh-webapp/components/agent/agent-chat-workspace.tsx`

- On option tap (existing handlers at the specialist-directive render block, ~L3506–3621):
  1. Append a **user-side selection chip** message locally (from the card's own label).
  2. **Collapse** the source card to its compact selected state.
  3. Call `sendDelegateResult({ selected: refs, display, status })` including `display`.
- On history reload: render any message carrying `selection` metadata as a chip; never
  render the raw `I selected:` text (guard even for legacy stored messages).

`hushh-webapp/components/agent/selection-chip.tsx` **(new)**

- Small presentational right-aligned chip summarizing the choice
  (`Abdul Zalil · 8 hours`). Reused by both surfaces.

`hushh-webapp/components/one-location/redesign/*` (retheme to `primary`)

- `location-chat-message-list.tsx` — user/assistant bubbles from cream → primary tokens
  (match `agent-chat-workspace.tsx` bubble styling).
- `location-chat-atoms.tsx` — `BotAvatar`, `StateChangedNote` to primary/neutral.
- `clarification-card.tsx`, `action-confirm-card.tsx` — container, option chips, and
  buttons from `#b8894d`/`#d4a574` → `primary` (drop the cream palette on these
  surfaces). Add the compact **collapsed selected state** and emit the selection
  chip on tap, matching the central chat.
- `use-location-chat.ts` — on selection, append the chip locally (parity with central).

### 4.3 Shared vs surface-specific

The retheme of `clarification-card.tsx` / `action-confirm-card.tsx` fixes the central
chat automatically (its wrappers embed these). `selection-chip.tsx` and the
collapsed-card behavior are shared. Only the message-list bubbles and atoms are
surface-specific and rethemed per surface.

## 5. Selection data flow

```text
User taps "Abdul Zalil" in ClarificationCard
  → append user chip bubble ("Abdul Zalil"); collapse card to compact selected line
  → sendDelegateResult({ selected:[refs], display:"Abdul Zalil", status:"answered" })
  → backend: LLM receives raw seed (internal, not persisted);
             persists user message content = "Abdul Zalil",
             metadata.selection = { type:"recipient", refs, label:"Abdul Zalil" }
  → assistant streams next prompt ("how long?") → repeat for duration ("8 hours")
  → ActionConfirmCard → "Share" → browser crypto → completion confirmation
On history reload: selection messages render as chips from metadata (no raw ids).
```

The who → how-long → confirm sequence leaves a stack of compact collapsed cards +
chips, so the transcript reads naturally on both surfaces.

## 6. Out of scope

- No change to the A2A delegation contract, consent flow, or the browser crypto path.
- No new specialists (Nav/KYC/Kai) — but `selection-chip.tsx` and the collapsed-card
  pattern are built specialist-generic so they plug in later.
- No coordinate-handling changes; zero-knowledge invariants unchanged.

## 7. Testing strategy

**Backend**

- Persisted selection message `content` is the human-readable display string and its
  `metadata.selection` holds `{ type, refs, label }`; it contains **no** `recipientUserId=`
  / `recipientKeyId=` / `do not guess` text.
- The LLM still receives the raw seed for its turn (reasoning unaffected).
- No coordinates in display string or metadata (assert at code level).
- Existing standalone `/api/one/location/chat` and central delegate-result flows stay green.

**Frontend**

- Tapping an option appends a chip, collapses the source card, and never renders raw ids.
- History reload renders chips from `selection` metadata (including a legacy stored
  `I selected:` message, which must not render raw).
- Both surfaces use `primary` tokens — no `#b8894d` / `#d4a574` remains on the chat
  bubbles, atoms, or the two cards.
- `sendDelegateResult` includes `display`; existing crypto/confirm callbacks unchanged.
- `npx tsc --noEmit` clean; existing agent-workspace and location-chat tests stay green.

## 8. Skill plan (remainder)

1. **superpowers:brainstorming** — complete (this spec).
2. User reviews this spec.
3. **superpowers:writing-plans** — TDD implementation plan.
4. **ui-ux-pro-max** — drives the visual retheme + chip/collapsed-card execution.
5. **superpowers:test-driven-development** + **superpowers:executing-plans** — build.
