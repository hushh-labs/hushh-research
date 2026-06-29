# One Location Chat UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unstyled placeholder `LocationChatPanel` with a polished, on-brand "One Location" assistant — an in-flow collapsible card on `/one/location` (with an optional focus overlay) that runs the existing control-plane chat backend.

**Architecture:** A `useLocationChat` hook owns all turn state (messages, memory-only conversationId, busy) and the single `OneLocationService.chat` call. Small presentational units — `SuggestionChips`, `ChatMessageList` (+ atoms), `ChatComposer`, `LocationChatOverlay` — render against it. `LocationChatPanel` composes them, preserving the existing `data-testid`s so current tests stay green. Frontend-only; no backend/API/contract change.

**Tech Stack:** TypeScript / Next.js (App Router) / React 18 client components / Tailwind v4 + shadcn-ui primitives / lucide-react / react-markdown + remark-gfm / **vitest** + @testing-library/react.

## Visual Map

```text
useLocationChat (hook: messages, conversationId-ref, busy, send/retry/clear)
   │
   ├─ LocationChatPanel  (in-flow card on /one/location)
   │     ├─ header: BotAvatar "One Location"  + ⤢ focus  + ↺ clear
   │     ├─ SuggestionChips        (empty state)
   │     ├─ ChatMessageList        (bubbles · markdown · typing · ✓Updated · retry)
   │     └─ ChatComposer           (textarea + send)
   │
   └─ LocationChatOverlay (KaiControlSurface drawer/dialog — same hook instance)

Turn:  user types → OneLocationService.chat → POST /api/one/location/chat
       → on stateChanged: refresh() + dispatch consent-state-changed
```

## Global Constraints

Copied verbatim from the approved spec (`docs/superpowers/specs/2026-06-29-one-location-chat-ui-design.md`). Every task implicitly includes these:

- **Frontend-only.** No backend, API route, or request/response contract change. Reuse `OneLocationService.chat({ vaultOwnerToken, message, conversationId? }) → { conversationId, response, isComplete, stateChanged }` exactly.
- **Test runner is vitest** (`import { ... } from "vitest"`, `vi.fn()`, `vi.mock`, `vi.mocked`). Not Jest.
- **Preserve existing `data-testid`s:** `location-chat-panel`, `location-chat-log`, `location-chat-input`, `location-chat-send`. The existing test `hushh-webapp/__tests__/components/location-chat-panel.test.tsx` must keep passing (it may be extended, never weakened).
- **Non-streaming.** One JSON reply per turn; show a typing indicator while awaiting, never token streaming.
- **`conversationId` is memory-only.** No localStorage / reload persistence. Held in a ref inside the hook.
- **Coordinate-free.** Render only the backend's returned text; add nothing coordinate-bearing.
- **Reuse the design system.** Use `components/one-location/redesign/tokens.ts` (`CARD_SURFACE`, `SUBCARD_SURFACE`, `MUTED_TEXT`, `EYEBROW`, `ACCENT_BLUE = "#b8894d"`), `components/ui/*`, and `components/app-ui/kai-control-surface.tsx`. No new color values beyond the gold tokens already present.
- **All new components are `"use client"`.**
- **All work on branch `feat/one-location-agent-chat`.**

## File Structure

All paths under `hushh-webapp/`. New files live beside the existing chat panel in `components/one-location/redesign/`.

| File | Responsibility |
|---|---|
| `components/one-location/redesign/use-location-chat.ts` | **New** — hook: turn state + `OneLocationService.chat` call. Exports `ChatMessage`, `UseLocationChat`, `useLocationChat`. |
| `components/one-location/redesign/location-chat-suggestions.tsx` | **New** — `SuggestionChip`, `LOCATION_SUGGESTION_CHIPS`, `SuggestionChips`. |
| `components/one-location/redesign/location-chat-atoms.tsx` | **New** — `BotAvatar`, `TypingIndicator`, `StateChangedNote`. |
| `components/one-location/redesign/location-chat-message-list.tsx` | **New** — `ChatMessageList` (bubbles, markdown, typing, retry). |
| `components/one-location/redesign/location-chat-composer.tsx` | **New** — `ChatComposer` (textarea + send). |
| `components/one-location/redesign/location-chat-overlay.tsx` | **New** — `LocationChatOverlay` wrapping `KaiControlSurface`. |
| `components/one-location/redesign/location-chat-panel.tsx` | **Rewrite** — compose hook + card + chips + composer + overlay; locked stub; preserve testids. |
| `app/one/location/page.tsx` | **Modify (lines 4227-4235)** — always render the panel; pass `vaultOwnerToken` possibly-null. |
| `__tests__/components/location-chat-panel.test.tsx` | **Rewrite** — keep the 3 existing cases, add new ones. |
| `__tests__/components/use-location-chat.test.tsx` | **New** — hook unit tests. |
| `__tests__/components/location-chat-suggestions.test.tsx` | **New** |
| `__tests__/components/location-chat-message-list.test.tsx` | **New** |
| `__tests__/components/location-chat-composer.test.tsx` | **New** |
| `__tests__/components/location-chat-overlay.test.tsx` | **New** |

---

### Task 1: `useLocationChat` hook

The single source of conversation truth: messages, memory-only conversationId (ref), busy, and the one service call. Improves on the placeholder's id scheme (a monotonic counter, not `prev.length`, which collided user/assistant ids).

**Files:**
- Create: `hushh-webapp/components/one-location/redesign/use-location-chat.ts`
- Test: `hushh-webapp/__tests__/components/use-location-chat.test.tsx`

**Interfaces:**
- Consumes: `OneLocationService.chat` from `@/lib/one-location/service`.
- Produces:
  - `interface ChatMessage { id: string; role: "user" | "assistant"; text: string; stateChanged?: boolean; errored?: boolean }`
  - `interface UseLocationChat { messages: ChatMessage[]; busy: boolean; send: (message: string) => Promise<void>; retry: () => Promise<void>; clear: () => void }`
  - `function useLocationChat(params: { vaultOwnerToken: string; onStateChanged?: () => void }): UseLocationChat`
  - `const LOCATION_CHAT_ERROR_TEXT: string` (exported; reused by tests and panel).

- [ ] **Step 1: Write the failing test**

Create `hushh-webapp/__tests__/components/use-location-chat.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import {
  LOCATION_CHAT_ERROR_TEXT,
  useLocationChat,
} from "@/components/one-location/redesign/use-location-chat";
import { OneLocationService } from "@/lib/one-location/service";

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: { chat: vi.fn() },
}));
vi.mock("@/lib/capacitor", () => ({
  HushhLocation: {
    getPermissionState: vi.fn(),
    getCurrentPosition: vi.fn(),
    watchPosition: vi.fn(),
    clearWatch: vi.fn(),
    openAppSettings: vi.fn(),
    openLocationSettings: vi.fn(),
    requestLocationPermission: vi.fn(),
  },
}));

const mockChat = vi.mocked(OneLocationService.chat);

describe("useLocationChat", () => {
  beforeEach(() => mockChat.mockReset());

  it("appends user + assistant messages and reuses conversationId across turns", async () => {
    mockChat.mockResolvedValue({
      conversationId: "conv-42",
      response: "Mom and Dad.",
      isComplete: true,
      stateChanged: false,
    });
    const { result } = renderHook(() =>
      useLocationChat({ vaultOwnerToken: "t" }),
    );

    await act(async () => {
      await result.current.send("who can see me");
    });

    expect(result.current.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "who can see me"],
      ["assistant", "Mom and Dad."],
    ]);
    expect(mockChat.mock.calls[0][0].conversationId).toBeNull();

    await act(async () => {
      await result.current.send("second");
    });
    expect(mockChat.mock.calls[1][0].conversationId).toBe("conv-42");
  });

  it("flags stateChanged and notifies onStateChanged", async () => {
    mockChat.mockResolvedValue({
      conversationId: "c",
      response: "Done.",
      isComplete: true,
      stateChanged: true,
    });
    const onStateChanged = vi.fn();
    const { result } = renderHook(() =>
      useLocationChat({ vaultOwnerToken: "t", onStateChanged }),
    );

    await act(async () => {
      await result.current.send("revoke mom");
    });

    const assistant = result.current.messages[1];
    expect(assistant.stateChanged).toBe(true);
    expect(onStateChanged).toHaveBeenCalledTimes(1);
  });

  it("renders an errored assistant bubble and retry replaces it with a reply", async () => {
    mockChat.mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() =>
      useLocationChat({ vaultOwnerToken: "t" }),
    );

    await act(async () => {
      await result.current.send("do it");
    });
    expect(result.current.messages[1]).toMatchObject({
      role: "assistant",
      text: LOCATION_CHAT_ERROR_TEXT,
      errored: true,
    });

    mockChat.mockResolvedValueOnce({
      conversationId: "c",
      response: "Fixed.",
      isComplete: true,
      stateChanged: false,
    });
    await act(async () => {
      await result.current.retry();
    });

    // still one user bubble; errored bubble replaced by the reply
    expect(result.current.messages.map((m) => m.text)).toEqual(["do it", "Fixed."]);
    expect(mockChat).toHaveBeenCalledTimes(2);
    expect(mockChat.mock.calls[1][0].message).toBe("do it");
  });

  it("clear() empties messages and resets conversationId", async () => {
    mockChat.mockResolvedValue({
      conversationId: "c",
      response: "ok",
      isComplete: true,
      stateChanged: false,
    });
    const { result } = renderHook(() =>
      useLocationChat({ vaultOwnerToken: "t" }),
    );
    await act(async () => {
      await result.current.send("hi");
    });
    act(() => result.current.clear());
    expect(result.current.messages).toEqual([]);

    await act(async () => {
      await result.current.send("again");
    });
    expect(mockChat.mock.calls[1][0].conversationId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npx vitest run __tests__/components/use-location-chat.test.tsx`
Expected: FAIL — cannot resolve `@/components/one-location/redesign/use-location-chat`.

- [ ] **Step 3: Write minimal implementation**

Create `hushh-webapp/components/one-location/redesign/use-location-chat.ts`:

```ts
"use client";

import { useCallback, useRef, useState } from "react";

import { OneLocationService } from "@/lib/one-location/service";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  stateChanged?: boolean;
  errored?: boolean;
}

export interface UseLocationChat {
  messages: ChatMessage[];
  busy: boolean;
  send: (message: string) => Promise<void>;
  retry: () => Promise<void>;
  clear: () => void;
}

export const LOCATION_CHAT_ERROR_TEXT =
  "Sorry — that couldn't be processed. Try rephrasing.";

export function useLocationChat(params: {
  vaultOwnerToken: string;
  onStateChanged?: () => void;
}): UseLocationChat {
  const { vaultOwnerToken, onStateChanged } = params;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const conversationIdRef = useRef<string | null>(null);
  const lastSentRef = useRef<string | null>(null);
  const seqRef = useRef(0);

  const nextId = useCallback(() => `m-${seqRef.current++}`, []);

  const run = useCallback(
    async (message: string) => {
      setBusy(true);
      // Retry case: drop a trailing errored assistant bubble before re-asking.
      setMessages((prev) =>
        prev.length && prev[prev.length - 1].errored ? prev.slice(0, -1) : prev,
      );
      try {
        const result = await OneLocationService.chat({
          vaultOwnerToken,
          message,
          conversationId: conversationIdRef.current,
        });
        conversationIdRef.current = result.conversationId;
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: "assistant",
            text: result.response,
            stateChanged: result.stateChanged,
          },
        ]);
        if (result.stateChanged) onStateChanged?.();
      } catch {
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: "assistant",
            text: LOCATION_CHAT_ERROR_TEXT,
            errored: true,
          },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [vaultOwnerToken, onStateChanged, nextId],
  );

  const send = useCallback(
    async (raw: string) => {
      const message = raw.trim();
      if (!message || busy) return;
      lastSentRef.current = message;
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "user", text: message },
      ]);
      await run(message);
    },
    [busy, run, nextId],
  );

  const retry = useCallback(async () => {
    if (busy || !lastSentRef.current) return;
    await run(lastSentRef.current);
  }, [busy, run]);

  const clear = useCallback(() => {
    setMessages([]);
    conversationIdRef.current = null;
    lastSentRef.current = null;
  }, []);

  return { messages, busy, send, retry, clear };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp && npx vitest run __tests__/components/use-location-chat.test.tsx`
Expected: PASS (4 passed). If `renderHook` is not exported from `@testing-library/react`, the project is on an older RTL — import it from `@testing-library/react-hooks` instead; verify with `grep '"@testing-library/react"' package.json`.

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/components/one-location/redesign/use-location-chat.ts hushh-webapp/__tests__/components/use-location-chat.test.tsx
git commit -m "feat(one-location): useLocationChat hook for chat turn state"
```

---

### Task 2: Suggestion chips

The empty-state quick prompts drawn from the 5 control-plane intents. Unambiguous chips send; person-naming chips prefill the composer and focus it.

**Files:**
- Create: `hushh-webapp/components/one-location/redesign/location-chat-suggestions.tsx`
- Test: `hushh-webapp/__tests__/components/location-chat-suggestions.test.tsx`

**Interfaces:**
- Produces:
  - `interface SuggestionChip { label: string; mode: "send" | "prefill"; value: string }`
  - `const LOCATION_SUGGESTION_CHIPS: SuggestionChip[]`
  - `function SuggestionChips(props: { onSend: (value: string) => void; onPrefill: (value: string) => void }): JSX.Element`

- [ ] **Step 1: Write the failing test**

Create `hushh-webapp/__tests__/components/location-chat-suggestions.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import {
  LOCATION_SUGGESTION_CHIPS,
  SuggestionChips,
} from "@/components/one-location/redesign/location-chat-suggestions";

describe("SuggestionChips", () => {
  it("exposes exactly the four control-plane prompts", () => {
    expect(LOCATION_SUGGESTION_CHIPS.map((c) => c.label)).toEqual([
      "Who can see me?",
      "Stop sharing with…",
      "Ask someone to share",
      "Deny a request",
    ]);
  });

  it("sends unambiguous chips and prefills person-naming chips", () => {
    const onSend = vi.fn();
    const onPrefill = vi.fn();
    render(<SuggestionChips onSend={onSend} onPrefill={onPrefill} />);

    fireEvent.click(screen.getByRole("button", { name: "Who can see me?" }));
    expect(onSend).toHaveBeenCalledWith("Who can see me right now?");

    fireEvent.click(screen.getByRole("button", { name: "Stop sharing with…" }));
    expect(onPrefill).toHaveBeenCalledWith("Stop sharing with ");
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npx vitest run __tests__/components/location-chat-suggestions.test.tsx`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write minimal implementation**

Create `hushh-webapp/components/one-location/redesign/location-chat-suggestions.tsx`:

```tsx
"use client";

import { cn } from "@/lib/utils";

export interface SuggestionChip {
  label: string;
  mode: "send" | "prefill";
  value: string;
}

export const LOCATION_SUGGESTION_CHIPS: SuggestionChip[] = [
  { label: "Who can see me?", mode: "send", value: "Who can see me right now?" },
  { label: "Stop sharing with…", mode: "prefill", value: "Stop sharing with " },
  {
    label: "Ask someone to share",
    mode: "prefill",
    value: "Ask … to share their location with me",
  },
  {
    label: "Deny a request",
    mode: "send",
    value: "Deny the latest location request",
  },
];

export function SuggestionChips(props: {
  onSend: (value: string) => void;
  onPrefill: (value: string) => void;
}) {
  const { onSend, onPrefill } = props;
  return (
    <div className="flex flex-wrap gap-2" data-testid="location-chat-suggestions">
      {LOCATION_SUGGESTION_CHIPS.map((chip) => (
        <button
          key={chip.label}
          type="button"
          onClick={() =>
            chip.mode === "send" ? onSend(chip.value) : onPrefill(chip.value)
          }
          className={cn(
            "rounded-full border border-[color:var(--app-card-border-standard)]",
            "bg-[color:var(--app-card-surface-compact)] px-3 py-1.5 text-xs font-medium",
            "text-foreground transition-colors hover:border-[#d4a574]/50 hover:text-[#b8894d]",
          )}
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp && npx vitest run __tests__/components/location-chat-suggestions.test.tsx`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/components/one-location/redesign/location-chat-suggestions.tsx hushh-webapp/__tests__/components/location-chat-suggestions.test.tsx
git commit -m "feat(one-location): location chat suggestion chips"
```

---

### Task 3: Chat atoms

Small presentational pieces shared by the list and overlay: the gold bot avatar, the typing indicator, and the "state changed" confirmation note.

**Files:**
- Create: `hushh-webapp/components/one-location/redesign/location-chat-atoms.tsx`
- Test: covered indirectly in Task 4 (the message list). No standalone test file (these are trivial presentational atoms with no logic; testing them through the list is sufficient — splitting a test here would be redundant).

**Interfaces:**
- Produces:
  - `function BotAvatar(props: { size?: number }): JSX.Element`
  - `function TypingIndicator(): JSX.Element` (renders `data-testid="location-chat-typing"`)
  - `function StateChangedNote(): JSX.Element` (renders the text `Updated — your sharing list refreshed.`)

- [ ] **Step 1: Write the implementation**

Create `hushh-webapp/components/one-location/redesign/location-chat-atoms.tsx`:

```tsx
"use client";

import { Bot, Check } from "lucide-react";

export function BotAvatar(props: { size?: number }) {
  const size = props.size ?? 32;
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full bg-[#d4a574]/15 text-[#b8894d]"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <Bot style={{ width: size * 0.55, height: size * 0.55 }} />
    </span>
  );
}

export function TypingIndicator() {
  return (
    <span
      data-testid="location-chat-typing"
      className="inline-flex items-center gap-1"
      aria-label="One Location is typing"
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 motion-reduce:animate-none"
          style={{ animationDelay: `${i * 120}ms` }}
        />
      ))}
    </span>
  );
}

export function StateChangedNote() {
  return (
    <p className="mt-1 flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
      <Check className="h-3.5 w-3.5 shrink-0" />
      Updated — your sharing list refreshed.
    </p>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd hushh-webapp && npx tsc --noEmit`
Expected: no new errors referencing `location-chat-atoms.tsx`.

- [ ] **Step 3: Commit**

```bash
git add hushh-webapp/components/one-location/redesign/location-chat-atoms.tsx
git commit -m "feat(one-location): location chat presentational atoms"
```

---

### Task 4: Chat message list

Renders the conversation: user bubbles (plain), assistant bubbles (light markdown), the typing indicator while busy, the "Updated" note on state-changing turns, and a Retry on errored turns.

**Files:**
- Create: `hushh-webapp/components/one-location/redesign/location-chat-message-list.tsx`
- Test: `hushh-webapp/__tests__/components/location-chat-message-list.test.tsx`

**Interfaces:**
- Consumes: `ChatMessage` (Task 1); `BotAvatar`, `TypingIndicator`, `StateChangedNote` (Task 3).
- Produces: `function ChatMessageList(props: { messages: ChatMessage[]; busy: boolean; onRetry?: () => void }): JSX.Element` — root has `data-testid="location-chat-log"`, `role="log"`, `aria-live="polite"`.

- [ ] **Step 1: Write the failing test**

Create `hushh-webapp/__tests__/components/location-chat-message-list.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ChatMessageList } from "@/components/one-location/redesign/location-chat-message-list";

describe("ChatMessageList", () => {
  it("renders user and assistant text and the state-changed note", () => {
    render(
      <ChatMessageList
        busy={false}
        messages={[
          { id: "1", role: "user", text: "stop sharing with Mom" },
          { id: "2", role: "assistant", text: "Stopped sharing with Mom.", stateChanged: true },
        ]}
      />,
    );

    expect(screen.getByText("stop sharing with Mom")).toBeTruthy();
    expect(screen.getByText("Stopped sharing with Mom.")).toBeTruthy();
    expect(screen.getByText(/Updated — your sharing list refreshed\./)).toBeTruthy();
  });

  it("shows the typing indicator while busy", () => {
    render(<ChatMessageList busy messages={[]} />);
    expect(screen.getByTestId("location-chat-typing")).toBeTruthy();
  });

  it("renders Retry on errored messages and calls onRetry", () => {
    const onRetry = vi.fn();
    render(
      <ChatMessageList
        busy={false}
        onRetry={onRetry}
        messages={[
          { id: "1", role: "user", text: "do it" },
          { id: "2", role: "assistant", text: "Sorry — failed.", errored: true },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npx vitest run __tests__/components/location-chat-message-list.test.tsx`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write minimal implementation**

Create `hushh-webapp/components/one-location/redesign/location-chat-message-list.tsx`:

```tsx
"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";
import type { ChatMessage } from "./use-location-chat";
import { BotAvatar, StateChangedNote, TypingIndicator } from "./location-chat-atoms";

export function ChatMessageList(props: {
  messages: ChatMessage[];
  busy: boolean;
  onRetry?: () => void;
}) {
  const { messages, busy, onRetry } = props;
  return (
    <div
      data-testid="location-chat-log"
      role="log"
      aria-live="polite"
      className="flex flex-col gap-3"
    >
      {messages.map((message) =>
        message.role === "user" ? (
          <div key={message.id} className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl rounded-br-md bg-[#d4a574]/15 px-3.5 py-2 text-sm text-foreground">
              {message.text}
            </div>
          </div>
        ) : (
          <div key={message.id} className="flex items-start gap-2">
            <BotAvatar size={28} />
            <div className="min-w-0 max-w-[85%]">
              <div
                className={cn(
                  "rounded-2xl rounded-tl-md bg-[color:var(--app-card-surface-compact)] px-3.5 py-2 text-sm text-foreground",
                  "[&_p]:m-0 [&_p+p]:mt-2 [&_ul]:my-1 [&_ul]:pl-4 [&_li]:list-disc",
                  message.errored && "text-muted-foreground",
                )}
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {message.text}
                </ReactMarkdown>
              </div>
              {message.stateChanged ? <StateChangedNote /> : null}
              {message.errored ? (
                <button
                  type="button"
                  onClick={onRetry}
                  className="mt-1 text-xs font-semibold text-[#b8894d] hover:underline"
                >
                  Retry
                </button>
              ) : null}
            </div>
          </div>
        ),
      )}
      {busy ? (
        <div className="flex items-center gap-2">
          <BotAvatar size={28} />
          <div className="rounded-2xl rounded-tl-md bg-[color:var(--app-card-surface-compact)] px-3.5 py-2.5">
            <TypingIndicator />
          </div>
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp && npx vitest run __tests__/components/location-chat-message-list.test.tsx`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/components/one-location/redesign/location-chat-message-list.tsx hushh-webapp/__tests__/components/location-chat-message-list.test.tsx
git commit -m "feat(one-location): location chat message list with markdown + retry"
```

---

### Task 5: Chat composer

The input row: a textarea (Enter sends, Shift+Enter newline) plus a Send button. Keeps the canonical `data-testid`s so the panel's input/send are stable.

**Files:**
- Create: `hushh-webapp/components/one-location/redesign/location-chat-composer.tsx`
- Test: `hushh-webapp/__tests__/components/location-chat-composer.test.tsx`

**Interfaces:**
- Produces: `function ChatComposer(props: { value: string; onChange: (value: string) => void; onSend: () => void; busy: boolean; inputRef?: React.Ref<HTMLTextAreaElement> }): JSX.Element` — textarea has `data-testid="location-chat-input"`, button has `data-testid="location-chat-send"`.

- [ ] **Step 1: Write the failing test**

Create `hushh-webapp/__tests__/components/location-chat-composer.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ChatComposer } from "@/components/one-location/redesign/location-chat-composer";

describe("ChatComposer", () => {
  it("sends on Enter but not on Shift+Enter", () => {
    const onSend = vi.fn();
    render(
      <ChatComposer value="hi" onChange={() => {}} onSend={onSend} busy={false} />,
    );
    const input = screen.getByTestId("location-chat-input");

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("clicking Send fires onSend; busy disables both controls", () => {
    const onSend = vi.fn();
    const { rerender } = render(
      <ChatComposer value="hi" onChange={() => {}} onSend={onSend} busy={false} />,
    );
    fireEvent.click(screen.getByTestId("location-chat-send"));
    expect(onSend).toHaveBeenCalledTimes(1);

    rerender(
      <ChatComposer value="hi" onChange={() => {}} onSend={onSend} busy />,
    );
    expect((screen.getByTestId("location-chat-send") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("location-chat-input") as HTMLTextAreaElement).disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npx vitest run __tests__/components/location-chat-composer.test.tsx`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write minimal implementation**

Create `hushh-webapp/components/one-location/redesign/location-chat-composer.tsx`:

```tsx
"use client";

import type { Ref } from "react";
import { SendHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ChatComposer(props: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  busy: boolean;
  inputRef?: Ref<HTMLTextAreaElement>;
}) {
  const { value, onChange, onSend, busy, inputRef } = props;
  return (
    <div className="flex items-end gap-2">
      <textarea
        ref={inputRef}
        data-testid="location-chat-input"
        value={value}
        disabled={busy}
        rows={1}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSend();
          }
        }}
        placeholder="Ask about your location sharing…"
        aria-label="Ask the One Location assistant"
        className={cn(
          "max-h-32 min-h-10 flex-1 resize-none rounded-2xl px-3.5 py-2.5 text-sm",
          "border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)]",
          "text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-[#d4a574]/40",
        )}
      />
      <Button
        type="button"
        size="icon"
        data-testid="location-chat-send"
        disabled={busy}
        onClick={onSend}
        aria-label="Send"
        className="h-10 w-10 shrink-0 rounded-full"
      >
        <SendHorizontal className="h-4 w-4" />
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp && npx vitest run __tests__/components/location-chat-composer.test.tsx`
Expected: PASS (2 passed). If `Button` does not accept a `size="icon"` variant, drop the `size` prop (keep the `h-10 w-10 rounded-full` classes) — confirm variants in `components/ui/button.tsx`.

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/components/one-location/redesign/location-chat-composer.tsx hushh-webapp/__tests__/components/location-chat-composer.test.tsx
git commit -m "feat(one-location): location chat composer (textarea + send)"
```

---

### Task 6: Focus overlay

A focused view of the same conversation in `KaiControlSurface` (Drawer on mobile / Dialog on desktop). It is presentational — it receives messages and composer state from the panel, so the inline card and the overlay always show the same conversation.

**Files:**
- Create: `hushh-webapp/components/one-location/redesign/location-chat-overlay.tsx`
- Test: `hushh-webapp/__tests__/components/location-chat-overlay.test.tsx`

**Interfaces:**
- Consumes: `KaiControlSurface` (`@/components/app-ui/kai-control-surface`); `ChatMessageList` (Task 4); `ChatComposer` (Task 5); `ChatMessage` (Task 1).
- Produces: `function LocationChatOverlay(props: { open: boolean; onOpenChange: (open: boolean) => void; messages: ChatMessage[]; busy: boolean; value: string; onChange: (value: string) => void; onSend: () => void; onRetry?: () => void }): JSX.Element`

- [ ] **Step 1: Write the failing test**

Create `hushh-webapp/__tests__/components/location-chat-overlay.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { LocationChatOverlay } from "@/components/one-location/redesign/location-chat-overlay";

// Force the desktop (Dialog) branch for deterministic rendering in jsdom.
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

describe("LocationChatOverlay", () => {
  it("renders the conversation when open", () => {
    render(
      <LocationChatOverlay
        open
        onOpenChange={() => {}}
        busy={false}
        value=""
        onChange={() => {}}
        onSend={() => {}}
        messages={[{ id: "1", role: "assistant", text: "Mom and Dad." }]}
      />,
    );
    expect(screen.getByText("Mom and Dad.")).toBeTruthy();
    expect(screen.getByTestId("location-chat-input")).toBeTruthy();
  });

  it("renders nothing visible when closed", () => {
    render(
      <LocationChatOverlay
        open={false}
        onOpenChange={() => {}}
        busy={false}
        value=""
        onChange={() => {}}
        onSend={() => {}}
        messages={[{ id: "1", role: "assistant", text: "hidden" }]}
      />,
    );
    expect(screen.queryByText("hidden")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npx vitest run __tests__/components/location-chat-overlay.test.tsx`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write minimal implementation**

Create `hushh-webapp/components/one-location/redesign/location-chat-overlay.tsx`:

```tsx
"use client";

import { KaiControlSurface } from "@/components/app-ui/kai-control-surface";
import { ChatComposer } from "./location-chat-composer";
import { ChatMessageList } from "./location-chat-message-list";
import type { ChatMessage } from "./use-location-chat";

export function LocationChatOverlay(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messages: ChatMessage[];
  busy: boolean;
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onRetry?: () => void;
}) {
  const { open, onOpenChange, messages, busy, value, onChange, onSend, onRetry } =
    props;
  return (
    <KaiControlSurface
      open={open}
      onOpenChange={onOpenChange}
      eyebrow="One Location"
      title="Location assistant"
      description="Ask who can see you, or make changes by typing."
      footer={
        <ChatComposer
          value={value}
          onChange={onChange}
          onSend={onSend}
          busy={busy}
        />
      }
    >
      <ChatMessageList messages={messages} busy={busy} onRetry={onRetry} />
    </KaiControlSurface>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp && npx vitest run __tests__/components/location-chat-overlay.test.tsx`
Expected: PASS (2 passed). If the Dialog content portal isn't found, ensure `vi.mock("@/hooks/use-mobile", ...)` is hoisted above imports (vitest hoists `vi.mock` automatically); as a fallback add a `matchMedia` polyfill in the test.

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/components/one-location/redesign/location-chat-overlay.tsx hushh-webapp/__tests__/components/location-chat-overlay.test.tsx
git commit -m "feat(one-location): location chat focus overlay (KaiControlSurface)"
```

---

### Task 7: Rewrite `LocationChatPanel` (compose everything)

Wire the hook, header (BotAvatar + "One Location" + ⤢ focus + clear), message list, suggestion chips (empty state), composer, and overlay into one card. Preserve the canonical testids and the existing 3 behaviors. Add a locked stub for a null token.

**Files:**
- Rewrite: `hushh-webapp/components/one-location/redesign/location-chat-panel.tsx`
- Rewrite: `hushh-webapp/__tests__/components/location-chat-panel.test.tsx`

**Interfaces:**
- Consumes: `useLocationChat`, `LOCATION_CHAT_ERROR_TEXT` (T1); `SuggestionChips` (T2); `BotAvatar` (T3); `ChatMessageList` (T4); `ChatComposer` (T5); `LocationChatOverlay` (T6); tokens (`CARD_SURFACE`, `MUTED_TEXT`).
- Produces: `function LocationChatPanel(props: { vaultOwnerToken: string | null; onStateChanged?: () => void }): JSX.Element` — root `data-testid="location-chat-panel"`.

- [ ] **Step 1: Write the failing/updated test**

Replace the contents of `hushh-webapp/__tests__/components/location-chat-panel.test.tsx` with:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { LocationChatPanel } from "@/components/one-location/redesign/location-chat-panel";
import { OneLocationService } from "@/lib/one-location/service";

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: { chat: vi.fn() },
}));
vi.mock("@/lib/capacitor", () => ({
  HushhLocation: {
    getPermissionState: vi.fn(),
    getCurrentPosition: vi.fn(),
    watchPosition: vi.fn(),
    clearWatch: vi.fn(),
    openAppSettings: vi.fn(),
    openLocationSettings: vi.fn(),
    requestLocationPermission: vi.fn(),
  },
}));
// Keep the overlay on its desktop (Dialog) branch if it mounts during a test.
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

const mockChat = vi.mocked(OneLocationService.chat);

describe("LocationChatPanel", () => {
  beforeEach(() => mockChat.mockReset());

  it("sends a message and renders the assistant reply", async () => {
    mockChat.mockResolvedValue({
      conversationId: "conv-1",
      response: "Stopped sharing with Mom.",
      isComplete: true,
      stateChanged: true,
    });

    render(<LocationChatPanel vaultOwnerToken="vault-token" />);

    fireEvent.change(screen.getByTestId("location-chat-input"), {
      target: { value: "stop sharing with Mom" },
    });
    fireEvent.click(screen.getByTestId("location-chat-send"));

    await waitFor(() =>
      expect(screen.getByText("Stopped sharing with Mom.")).toBeTruthy(),
    );
    expect(mockChat).toHaveBeenCalledWith({
      vaultOwnerToken: "vault-token",
      message: "stop sharing with Mom",
      conversationId: null,
    });
  });

  it("calls onStateChanged when the response reports a state change", async () => {
    mockChat.mockResolvedValue({
      conversationId: "conv-1",
      response: "Done.",
      isComplete: true,
      stateChanged: true,
    });
    const onStateChanged = vi.fn();

    render(<LocationChatPanel vaultOwnerToken="t" onStateChanged={onStateChanged} />);
    fireEvent.change(screen.getByTestId("location-chat-input"), {
      target: { value: "revoke all" },
    });
    fireEvent.click(screen.getByTestId("location-chat-send"));

    await waitFor(() => expect(onStateChanged).toHaveBeenCalledTimes(1));
  });

  it("reuses the conversationId returned by the first turn", async () => {
    mockChat.mockResolvedValue({
      conversationId: "conv-42",
      response: "ok",
      isComplete: true,
      stateChanged: false,
    });

    render(<LocationChatPanel vaultOwnerToken="t" />);
    const input = screen.getByTestId("location-chat-input");
    const send = screen.getByTestId("location-chat-send");

    fireEvent.change(input, { target: { value: "first" } });
    fireEvent.click(send);
    await waitFor(() => expect(mockChat).toHaveBeenCalledTimes(1));

    fireEvent.change(input, { target: { value: "second" } });
    fireEvent.click(send);
    await waitFor(() => expect(mockChat).toHaveBeenCalledTimes(2));

    expect(mockChat.mock.calls[1][0].conversationId).toBe("conv-42");
  });

  it("shows suggestion chips before any message and sends one on click", async () => {
    mockChat.mockResolvedValue({
      conversationId: "c",
      response: "Mom and Dad.",
      isComplete: true,
      stateChanged: false,
    });
    render(<LocationChatPanel vaultOwnerToken="t" />);

    fireEvent.click(screen.getByRole("button", { name: "Who can see me?" }));

    await waitFor(() =>
      expect(mockChat.mock.calls[0][0].message).toBe("Who can see me right now?"),
    );
  });

  it("renders a locked stub when there is no vault token", () => {
    render(<LocationChatPanel vaultOwnerToken={null} />);
    expect(screen.getByTestId("location-chat-panel")).toBeTruthy();
    expect(screen.getByText(/unlock your vault/i)).toBeTruthy();
    expect(screen.queryByTestId("location-chat-input")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hushh-webapp && npx vitest run __tests__/components/location-chat-panel.test.tsx`
Expected: FAIL — the new chip/locked-stub assertions fail against the current placeholder.

- [ ] **Step 3: Write the implementation**

Replace the entire contents of `hushh-webapp/components/one-location/redesign/location-chat-panel.tsx` with:

```tsx
"use client";

import { useRef, useState } from "react";
import { Maximize2, RotateCcw } from "lucide-react";

import { cn } from "@/lib/utils";
import { BotAvatar } from "./location-chat-atoms";
import { ChatComposer } from "./location-chat-composer";
import { ChatMessageList } from "./location-chat-message-list";
import { LocationChatOverlay } from "./location-chat-overlay";
import { SuggestionChips } from "./location-chat-suggestions";
import { CARD_SURFACE, MUTED_TEXT } from "./tokens";
import { useLocationChat } from "./use-location-chat";

export function LocationChatPanel(props: {
  vaultOwnerToken: string | null;
  onStateChanged?: () => void;
}) {
  const { vaultOwnerToken, onStateChanged } = props;
  const [input, setInput] = useState("");
  const [overlayOpen, setOverlayOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const chat = useLocationChat({
    vaultOwnerToken: vaultOwnerToken ?? "",
    onStateChanged,
  });

  const submit = () => {
    const message = input.trim();
    if (!message) return;
    setInput("");
    void chat.send(message);
  };

  const sendValue = (value: string) => {
    setInput("");
    void chat.send(value);
  };

  const prefill = (value: string) => {
    setInput(value);
    inputRef.current?.focus();
  };

  if (!vaultOwnerToken) {
    return (
      <section data-testid="location-chat-panel" className={cn(CARD_SURFACE, "p-4")}>
        <div className="flex items-center gap-3">
          <BotAvatar />
          <div>
            <p className="text-sm font-semibold text-foreground">One Location</p>
            <p className={MUTED_TEXT}>Unlock your vault to use the assistant.</p>
          </div>
        </div>
      </section>
    );
  }

  const hasMessages = chat.messages.length > 0;

  return (
    <section data-testid="location-chat-panel" className={cn(CARD_SURFACE, "p-4")}>
      <header className="mb-3 flex items-center gap-3">
        <BotAvatar />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">One Location</p>
          <p className={MUTED_TEXT}>
            Ask who can see you — or make changes by typing.
          </p>
        </div>
        {hasMessages ? (
          <button
            type="button"
            onClick={chat.clear}
            aria-label="Clear conversation"
            className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setOverlayOpen(true)}
          aria-label="Open focused chat"
          className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        >
          <Maximize2 className="h-4 w-4" />
        </button>
      </header>

      {hasMessages || chat.busy ? (
        <div className="mb-3">
          <ChatMessageList
            messages={chat.messages}
            busy={chat.busy}
            onRetry={chat.retry}
          />
        </div>
      ) : (
        <div className="mb-3">
          <SuggestionChips onSend={sendValue} onPrefill={prefill} />
        </div>
      )}

      <ChatComposer
        value={input}
        onChange={setInput}
        onSend={submit}
        busy={chat.busy}
        inputRef={inputRef}
      />

      <LocationChatOverlay
        open={overlayOpen}
        onOpenChange={setOverlayOpen}
        messages={chat.messages}
        busy={chat.busy}
        value={input}
        onChange={setInput}
        onSend={submit}
        onRetry={chat.retry}
      />
    </section>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hushh-webapp && npx vitest run __tests__/components/location-chat-panel.test.tsx`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
git add hushh-webapp/components/one-location/redesign/location-chat-panel.tsx hushh-webapp/__tests__/components/location-chat-panel.test.tsx
git commit -m "feat(one-location): compose styled One Location chat panel"
```

---

### Task 8: Page wiring — render panel even when locked

The page currently renders the panel only when `vaultOwnerToken` is truthy. Render it unconditionally so the locked stub shows; the panel handles the null-token case itself.

**Files:**
- Modify: `hushh-webapp/app/one/location/page.tsx` (lines 4227-4235)
- Verify: `hushh-webapp/__tests__/components/one-location-agent-page.test.tsx` stays green.

**Interfaces:**
- Consumes: `LocationChatPanel` (now accepts `vaultOwnerToken: string | null`).

- [ ] **Step 1: Replace the conditional render**

In `hushh-webapp/app/one/location/page.tsx`, replace this block (currently lines 4227-4235):

```tsx
          {vaultOwnerToken ? (
            <LocationChatPanel
              vaultOwnerToken={vaultOwnerToken}
              onStateChanged={() => {
                void refresh();
                dispatchConsentStateChanged({ source: "one_location_chat" });
              }}
            />
          ) : null}
```

with:

```tsx
          <LocationChatPanel
            vaultOwnerToken={vaultOwnerToken ?? null}
            onStateChanged={() => {
              void refresh();
              dispatchConsentStateChanged({ source: "one_location_chat" });
            }}
          />
```

Note: if `vaultOwnerToken`'s type is already `string | null`, `?? null` is a harmless no-op kept for clarity. If it is `string | undefined`, `?? null` normalizes it to the prop's `string | null` type.

- [ ] **Step 2: Typecheck**

Run: `cd hushh-webapp && npx tsc --noEmit`
Expected: no type errors in `app/one/location/page.tsx` or the new chat files.

- [ ] **Step 3: Run the existing page test**

Run: `cd hushh-webapp && npx vitest run __tests__/components/one-location-agent-page.test.tsx`
Expected: PASS (still green — the panel addition/locked stub must not break it). If the page test asserts the panel is absent when locked, update that assertion to expect the locked stub (`getByText(/unlock your vault/i)`), since the new intended behavior is to show it.

- [ ] **Step 4: Commit**

```bash
git add hushh-webapp/app/one/location/page.tsx
git commit -m "feat(one-location): always render chat panel (locked stub when vault locked)"
```

---

## Final Verification

- [ ] All new + updated suites green:
  `cd hushh-webapp && npx vitest run __tests__/components/use-location-chat.test.tsx __tests__/components/location-chat-suggestions.test.tsx __tests__/components/location-chat-message-list.test.tsx __tests__/components/location-chat-composer.test.tsx __tests__/components/location-chat-overlay.test.tsx __tests__/components/location-chat-panel.test.tsx`
- [ ] Existing page test green: `cd hushh-webapp && npx vitest run __tests__/components/one-location-agent-page.test.tsx`
- [ ] Types clean: `cd hushh-webapp && npx tsc --noEmit`
- [ ] Lint clean on touched files: `cd hushh-webapp && npx eslint components/one-location/redesign/ app/one/location/page.tsx`
- [ ] Constraint audit: no new file imports `AgentChatService` or any KAI chat service; the only network call is `OneLocationService.chat`; no coordinate keys anywhere; `conversationId` lives only in a ref (no localStorage); the 4 canonical `data-testid`s are present.
- [ ] Manual smoke (optional): run the app, open `/one/location`, click "Who can see me?", confirm a reply; type "stop sharing with <name>", confirm the "✓ Updated" note and that the hub's shares list refreshes; click ⤢ to confirm the overlay shows the same conversation.

## Self-Review Notes (author)

- **Spec coverage:** surface/placement card (T7) + page render (T8); collapsed state w/ chips (T2, T7); conversation + markdown + typing (T3, T4); ⤢ focus overlay sharing state (T6, T7); state-changed feedback + refresh/consent dispatch (T1 hook + T4 note + existing page wiring); error + retry (T1, T4); locked stub (T7, T8); theming via tokens + a11y `role="log"`/aria-labels/Esc-via-KaiControlSurface (T3–T7). Out-of-scope items (streaming, voice, history, persistence) are simply not built.
- **Runner correction:** plan uses vitest throughout (the backend plan's Jest references did not apply to the frontend).
- **Type consistency:** `ChatMessage` (T1) is the single shared message type consumed by T4/T6/T7; `useLocationChat` returns `{ messages, busy, send, retry, clear }` used identically in T7; composer testids (`location-chat-input`/`location-chat-send`) defined in T5 and asserted in T5 + T7; `LOCATION_SUGGESTION_CHIPS` values in T2 match the chip-send assertion in T7.
- **Testid preservation:** `location-chat-panel` (T7 root), `location-chat-log` (T4), `location-chat-input`/`location-chat-send` (T5) — the 3 original tests are carried forward verbatim in T7.
- **ui-ux-pro-max:** the spec names it for visual execution; class choices here are a working, on-brand baseline. Running `ui-ux-pro-max` to refine spacing/polish during/after T7 is encouraged and won't change any interface.
```