# One Location Chat — UI/UX Design (v1)

- **Date:** 2026-06-29
- **Branch:** `feat/one-location-agent-chat`
- **Status:** Approved design, ready for implementation plan
- **Builds on:** `docs/superpowers/specs/2026-06-27-one-location-agent-chat-design.md`
  (backend v1, **already shipped** through commit `3bc0a38e2`) and its plan
  `docs/superpowers/plans/2026-06-27-one-location-agent-chat.md`.

## Visual Map

```text
/one/location  (max-w-[480px] column, dark-mode aware)
┌──────────────────────────────────────────────┐
│  Now   People   Links   Inbox                 │  ← hub tabs
│  ┌────────────────────────────────────────┐   │
│  │  Privacy status · Active shares · …     │   │  ← LocationRedesignHub
│  └────────────────────────────────────────┘   │
│  ┌────────────────────────────────────────┐   │
│  │ 🤖 One Location                     ⤢ ↺ │   │  ← LocationChatPanel (in-flow card)
│  │ Ask who can see you — or change by type │   │
│  │ [Who can see me?][Stop sharing with…]   │   │  ← SuggestionChips (empty state)
│  │ ───────────────────────────────────────│   │
│  │ 🤖 Mom and Dad can see you.             │   │  ← assistant bubble (markdown)
│  │                you: stop sharing w/ Mom │   │  ← user bubble
│  │ 🤖 Stopped sharing with Mom.            │   │
│  │    ✓ Updated — your sharing list refresh │   │  ← stateChanged → refresh() + consent-state-changed
│  │ ┌─────────────────────────────────┐ [▶] │   │  ← ChatComposer (Enter sends)
│  │ │ Ask about your location sharing…│      │   │
│  └────────────────────────────────────────┘   │
└──────────────────────────────────────────────┘
        ⤢ → LocationChatOverlay (KaiControlSurface: drawer/dialog, same conversation)
```

State flows through one `useLocationChat` hook shared by the inline card and the
overlay. Only network call: `OneLocationService.chat` → `POST /api/one/location/chat`.

## 1. Goal

The One Location agent chat backend is done: `POST /api/one/location/chat`
(consent-gated, control-plane only, multi-turn, encrypted at rest) and the
`OneLocationService.chat()` client method both ship. What exists on the frontend
is a **placeholder** — `hushh-webapp/components/one-location/redesign/location-chat-panel.tsx`,
~88 lines of bare HTML (`<input>`, `<button>Send</button>`, `<p>` messages, zero
styling), stacked below the hub on `/one/location`.

This spec designs the **actual UI/UX** for that chat: a polished, on-brand
"One Location" assistant that lets users run control-plane location commands
(query / revoke / request / deny / refer) conversationally, contextual to the
location hub.

**This is a frontend-only change.** No backend, API, or contract changes. The
request/response shape, consent guarantees, and coordinate-safety invariants
from the backend spec are untouched.

## 2. Context — actual state (explore findings)

### Reuse as-is

| Area | Path / symbol |
|---|---|
| Backend chat endpoint | `POST /api/one/location/chat` (shipped) |
| Client method | `hushh-webapp/lib/one-location/service.ts` — `OneLocationService.chat({ vaultOwnerToken, message, conversationId? })` → `LocationChatResponse { conversationId, response, isComplete, stateChanged }` |
| Placeholder to replace | `hushh-webapp/components/one-location/redesign/location-chat-panel.tsx` |
| Page host | `hushh-webapp/app/one/location/page.tsx` — renders the panel below `LocationRedesignHub`, gated on `vaultOwnerToken` from `useVault()`; passes `onStateChanged` (calls `refresh()` + `dispatchConsentStateChanged`) |
| Design tokens | `hushh-webapp/components/one-location/redesign/tokens.ts` — `CARD_SURFACE`, `SUBCARD_SURFACE`, `AVATAR_BUBBLE`, `MUTED_TEXT`, `EYEBROW`, gold accent `#b8894d` / `#d4a574`, pill palettes |
| Hub primitives | `redesign/primitives.tsx` — `SectionCard`, `Avatar`, `StatusPill`, `EmptyState`, etc. |
| Responsive overlay shell | `hushh-webapp/components/app-ui/kai-control-surface.tsx` — Drawer (mobile) / Dialog (desktop), applies `--app-card-*` tokens + safe-area padding |
| Assistant chat reference | `hushh-webapp/components/agent/agent-chat-workspace.tsx` — bubbles, `react-markdown` + `remark-gfm`, `<Bot/>` (lucide); model the look, not the plumbing |
| UI primitives | `components/ui/` — `Button` (has `isLoading`), `Input`, `Textarea`, `ScrollArea`, `Skeleton`, `Sheet`, `Drawer`, `Dialog`, `Tooltip` |
| Cross-surface sync | `hushh-webapp/lib/consent/consent-events.ts` — `consent-state-changed` (already wired via `onStateChanged`) |

### Constraints discovered (drive the design)

1. **The bottom edge is already crowded.** There is a bottom nav
   (`--app-bottom-fixed-ui: 88px`) **and** a global KAI command bar
   (`components/kai/kai-search-bar.tsx`, `fixed inset-x-0`). A sticky/floating
   location composer pinned to the bottom would collide with both → **rejected.**
   The chat lives **in document flow**, in the hub column.
2. **A bottom-right floating bot already exists** — `components/agent/agent-popover-provider.tsx`
   (the global KAI assistant, `z-[460]`, genie animation). The location chat must
   be its **own** surface and must not fight that corner. The backend spec also
   explicitly excludes routing location intents through KAI.
3. **Backend is non-streaming.** Single JSON reply per turn. The UI shows a
   typing indicator while awaiting, not token streaming.
4. **`conversationId` is memory-only** (backend spec). No localStorage / reload
   persistence. One conversation per page session.
5. **Coordinate-free by construction.** Control-plane replies never contain
   lat/lng; the UI renders whatever text the backend returns and adds nothing
   coordinate-bearing.

## 3. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Surface form | In-flow collapsible card in the hub column (not floating/sticky) | Bottom chrome is occupied by nav + KAI bar; in-flow has zero collision/z-index risk and stays contextual |
| Focus mode | Optional ⤢ expand into `KaiControlSurface` overlay sharing the same conversation | Calm by default, full-focus on demand; reuses the proven responsive shell |
| Identity | Branded **"One Location"** — same visual family as the KAI assistant (Bot icon, gold accent, bubble treatment), warm-but-functional tone | User choice; coherent with the assistant family while staying a distinct backend surface |
| Response mode | Non-streaming; typing-dots indicator while awaiting | Backend is non-streaming |
| Conversation memory | Memory-only `conversationId`, single conversation per session | Backend spec; YAGNI on history |
| Reuse | `tokens.ts` + `components/ui/*` + `KaiControlSurface`; model bubbles on `agent-chat-workspace` | Consistency, less to build |

## 4. Component architecture

Split the placeholder into focused units. State lifts into a hook so the in-flow
card and the focus overlay render the **same** live conversation.

```
useLocationChat(vaultOwnerToken, onStateChanged)        ← hook: messages, conversationId,
  │   send(message), busy, error, retry, clear              busy/error, calls OneLocationService.chat
  │
  ├─ LocationChatCard            ← in-flow container (collapsed ↔ expanded), header w/ ⤢ + clear
  │    ├─ ChatMessageList        ← role="log"; bubbles; TypingIndicator; ErrorBubble; StateChangedNote
  │    ├─ SuggestionChips        ← 4 control-plane prompts; visible in empty/collapsed state
  │    └─ ChatComposer           ← Input/Textarea + Send; Enter-to-send; disabled while busy
  │
  └─ LocationChatOverlay         ← wraps KaiControlSurface (Drawer mobile / Dialog desktop),
                                    renders ChatMessageList + ChatComposer against the same hook
```

- **Each unit is presentational** except the hook (state + the single service
  call) and `LocationChatCard` (owns collapsed/expanded + overlay-open booleans).
- `LocationChatOverlay` and `LocationChatCard` both consume one `useLocationChat`
  instance (lifted in the panel root) → switching surfaces preserves messages +
  `conversationId`.
- File placement: all under `hushh-webapp/components/one-location/redesign/`
  (the chat hook may live in `redesign/` or a co-located `use-location-chat.ts`).

## 5. States & visual behaviour

### Collapsed (resting)
Gold **Bot avatar + "One Location"** title, one-line subtitle
("Ask who can see you — or make changes just by typing"), a tappable composer
row placeholder ("Ask about your location sharing…"), and **suggestion chips**:

| Chip | Sends |
|---|---|
| Who can see me? | "Who can see me right now?" |
| Stop sharing with… | prefills "Stop sharing with " (focus composer, no auto-send) |
| Ask someone to share | prefills "Ask … to share their location with me" |
| Deny a request | "Deny the latest location request" |

Chips that name a person prefill and focus the composer rather than auto-send;
unambiguous chips send immediately.

### Expanded (conversation)
- Bubbles: user right-aligned (neutral surface), assistant left-aligned with the
  gold Bot avatar.
- Assistant text rendered with **light markdown** (`react-markdown` + `remark-gfm`);
  user text is plain.
- Composer pinned at the card bottom; **Enter** sends, Shift+Enter newline.
- Header: ⤢ focus (opens overlay) + clear (resets the in-memory conversation).
- Auto-scroll to the latest message.

### Loading
A typing-dots assistant bubble while the turn is in flight; composer + Send
disabled (`Button isLoading`).

### "Something changed"
On `stateChanged: true`:
1. Call the existing `onStateChanged` → `refresh()` + `dispatchConsentStateChanged`.
2. Render a subtle inline note beneath the reply: **"✓ Updated — your sharing
   list refreshed."**
3. Brief highlight pulse on the hub so the mutation is *seen* landing.

### Error
Friendly assistant-style bubble: "Sorry — that couldn't be processed. Try
rephrasing." with a **Retry** that re-sends the last user message. Errors are
already opaque from the backend; the UI adds no internal detail.

### Vault locked
The panel only renders with a `vaultOwnerToken` (current gating). Instead of
rendering nothing, show a gentle stub: "Unlock your vault to use the assistant."

## 6. Theming & accessibility

- **Tokens:** `CARD_SURFACE` / `SUBCARD_SURFACE`, `AVATAR_BUBBLE`, `MUTED_TEXT`,
  `EYEBROW`, gold `#b8894d` / `#d4a574`; `--app-card-radius-*`; SF Pro scale.
  Dark mode via the existing class-based vars — no new colors introduced.
- **Primitives:** `Button`, `Input`/`Textarea`, `ScrollArea`, `Skeleton`,
  `Tooltip`; overlay via `KaiControlSurface`.
- **A11y:** `role="log"` + `aria-live="polite"` on the message list; aria-labels
  on composer + Send + chips; **Esc** closes the overlay; focus moves into the
  composer on expand/overlay-open; chips are real `<button>`s; respects
  `prefers-reduced-motion` (pulse/typing animations degrade gracefully).
- **Safe areas:** the overlay inherits `KaiControlSurface`'s safe-area handling;
  the in-flow card needs none (document flow).

## 7. Testing strategy

Reuse the existing test setup (Jest + React Testing Library). **Preserve the
current `data-testid`s** (`location-chat-panel`, `location-chat-log`,
`location-chat-input`, `location-chat-send`) so the existing panel test
(`hushh-webapp/__tests__/components/location-chat-panel.test.tsx`) keeps passing.

New/updated coverage:
- Sends a message, renders the assistant reply (existing behavior, restyled).
- `conversationId` from turn 1 is reused on turn 2 (existing assertion).
- `onStateChanged` fires when `stateChanged: true`; the inline "Updated" note
  renders.
- Suggestion chip: unambiguous chip sends; person-naming chip prefills + focuses
  without sending.
- Loading state disables composer/Send; typing indicator shows.
- Error path renders the error bubble + Retry re-sends the last message.
- Overlay open/close preserves the conversation (shared hook); Esc closes it.
- The existing page test (`one-location-agent-page.test.tsx`) stays green;
  `npx tsc --noEmit` clean.

## 8. Out of scope (explicit)

- Streaming (true or cosmetic token-by-token) — backend is non-streaming.
- Voice input — KAI has it; defer for location.
- Past-conversations history list / sidebar.
- Cross-reload persistence of `conversationId` (stays memory-only).
- Any backend / API / contract change.
- The v2 crypto-handoff commands (share / approve / view) and their UI.
- Routing location intents through the global KAI assistant.

## 9. Skill plan (remainder of flow)

1. **superpowers:brainstorming** — complete (this spec).
2. User reviews this spec.
3. **superpowers:writing-plans** — implementation plan (TDD task breakdown).
4. **ui-ux-pro-max** — drives the visual execution during the build phase.
5. **superpowers:test-driven-development** + **superpowers:executing-plans** —
   build on `feat/one-location-agent-chat`.
