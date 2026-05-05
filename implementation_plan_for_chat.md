# Implementation Plan — Issue #595: Agent Chat Section in Kai App

**Issue:** [hushh-research#595](https://github.com/hushh-labs/hushh-research/issues/595) — "Create a agent chat section inside the Kai app"
**Assignee:** RGlodAkshat
**Status:** Open, no description, no linked PRs
**Author of plan:** Claude (Sonnet 4.6)
**Date:** 2026-05-05

---

## 1. Goal

Expose the existing Kai chat backend through a first-class conversational UI inside the Kai app. Today users interact with Kai only through a search bar and voice command bar — there is no chat surface, even though the entire chat pipeline (intent classification, Gemini LLM, conversation history, learned-attribute capture) is already implemented server-side.

This plan covers everything needed to ship a production-ready chat tab without touching the backend.

---

## 2. Current State Audit

### 2.1 Backend — already complete, do not touch

| Capability | Location | Notes |
|---|---|---|
| `POST /api/kai/chat` | `consent-protocol/api/routes/kai/chat.py` | Accepts `{user_id, message, conversation_id?}`, returns `{conversation_id, response, component_type?, component_data?, learned_attributes[], tokens_used?}` |
| `GET /api/kai/chat/history/{conversation_id}` | same file | Returns full message log |
| `GET /api/kai/chat/conversations/{user_id}` | same file | Returns list of past conversations |
| `GET /api/kai/chat/initial-state/{user_id}` | same file | Returns `{is_new_user, has_portfolio, has_financial_data, welcome_type, total_attributes, available_domains}` |
| `POST /api/kai/chat/analyze-loser` | same file | Triggered when user clicks loser card from chat |
| Chat service | `consent-protocol/hushh_mcp/services/kai_chat_service.py` | Intent classification, Gemini integration, auto-learning |
| Auth | All endpoints require `Authorization: Bearer <VAULT_OWNER token>` |  |

**Intent enum (already classified by backend):**
`PORTFOLIO_IMPORT`, `STOCK_ANALYSIS`, `RISK_ASSESSMENT`, `PROFILE_QUERY`, `CONSENT_MANAGEMENT`, `GREETING`, `GENERAL_CHAT`.

**`component_type` values returned by backend (frontend must render):**
- `"import_prompt"` — user should be nudged to import portfolio
- `"analysis_summary"` — show a mini decision card for a ticker
- `"profile_summary"` — show what Kai knows about the user
- `null` — plain text response only

### 2.2 Frontend service / plugin layer — already complete

| Function | File | Status |
|---|---|---|
| `chat()` | `hushh-webapp/lib/services/kai-service.ts:345` | Wired to plugin |
| `getInitialChatState()` | `hushh-webapp/lib/services/kai-service.ts:218` | Wired to plugin |
| `Kai.chat()` | `hushh-webapp/lib/capacitor/kai.ts:77` | Plugin contract defined |
| `Kai.getInitialChatState()` | `hushh-webapp/lib/capacitor/kai.ts:60` | Plugin contract defined |

**Gap:** The plugin contract returns only `{response, conversationId, timestamp}`. The backend returns `component_type`, `component_data`, `learned_attributes`, `tokens_used` which are dropped at the plugin boundary. This must be widened (see §4.1).

### 2.3 Frontend UI — does not exist

- No `/kai/chat` route
- No chat tab in `KAI_ROUTE_TABS`
- No `KaiChatView` component
- No `*chat*` files anywhere under `hushh-webapp/`

This is the entire gap to close.

---

## 3. Architecture Decisions

### 3.1 Where the chat lives in IX

- **New tab "Chat"** added to `KAI_ROUTE_TABS` (currently `Market | Portfolio | Connect | Analysis`).
- Position: between `Portfolio` and `Connect` so the natural left-to-right flow becomes "see market → see your money → talk to Kai → connect → review past analyses". Final order: `Market | Portfolio | Chat | Connect | Analysis`.
- Route: `/kai/chat` registered in `routes.ts` as `KAI_CHAT`.

### 3.2 State model

Local React state — **do NOT introduce Zustand/Redux for this**. The conversation is per-session and the backend is the source of truth.

```ts
type ChatRole = "user" | "kai";

interface ChatBubble {
  id: string;            // client-side uuid
  role: ChatRole;
  text: string;
  timestamp: string;
  componentType?: "import_prompt" | "analysis_summary" | "profile_summary" | null;
  componentData?: Record<string, unknown>;
  learnedAttributes?: Array<{ domain: string; key: string; value: string }>;
  pending?: boolean;     // true while waiting for backend
}

interface ChatState {
  messages: ChatBubble[];
  conversationId: string | null;
  input: string;
  sending: boolean;
  initialState: InitialChatState | null;
  error: string | null;
}
```

### 3.3 Auth — VAULT_OWNER token via `useVault()`

The chat view must be wrapped in `KaiOnboardingGuard` (same as other Kai views) which guarantees the vault is unlocked. Inside the view we call `useVault()` to get the token, then pass it through `setKaiVaultOwnerToken()` once on mount, exactly like other Kai views do.

### 3.4 Component-type rendering

Each `component_type` maps to a small inline card rendered **below** the Kai bubble that produced it:

| `component_type` | Card | Action button |
|---|---|---|
| `"import_prompt"` | "Import your portfolio to unlock personalized analysis" | Routes to `/kai/import` |
| `"analysis_summary"` | Ticker + decision (BUY/HOLD/REDUCE) + confidence | Routes to `/kai/analysis?ticker=…` |
| `"profile_summary"` | List of `learned_attributes` grouped by domain | None (informational) |

These reuse `SurfaceCard` from `components/app-ui/surfaces` and `Button` from `lib/morphy-ux/button` — same primitives every other Kai view uses.

### 3.5 Tri-flow parity

The chat view must work identically on web, iOS, Android. Because we go through `Kai.chat()` (Capacitor plugin) and **never** call `fetch()` directly, parity is automatic. Native plugin authors will need to update the iOS/Android Kai plugin to forward `component_type`, `component_data`, `learned_attributes`, `tokens_used` from the HTTP response back through the bridge — flag this in the PR description so platform owners pick it up.

---

## 4. Step-by-Step Implementation

### Step 0 — Branch

```bash
git checkout -b feat/kai-chat-595
```

### Step 1 — Widen plugin & service return types

**File:** `hushh-webapp/lib/capacitor/kai.ts`

Update the `chat()` method on the `KaiPlugin` interface (around line 77) to:

```ts
chat(options: {
  userId: string;
  message: string;
  conversationId?: string;
  vaultOwnerToken: string;
}): Promise<{
  response: string;
  conversation_id: string;
  component_type?: "import_prompt" | "analysis_summary" | "profile_summary" | null;
  component_data?: Record<string, unknown> | null;
  learned_attributes?: Array<{ domain: string; key: string; value: string }>;
  tokens_used?: number | null;
  timestamp: string;
}>;
```

**File:** `hushh-webapp/lib/services/kai-service.ts`

Update the `chat()` function (around line 345) to surface the additional fields, transforming snake_case to camelCase:

```ts
export interface KaiChatResponse {
  response: string;
  conversationId: string;
  componentType: "import_prompt" | "analysis_summary" | "profile_summary" | null;
  componentData: Record<string, unknown> | null;
  learnedAttributes: Array<{ domain: string; key: string; value: string }>;
  tokensUsed: number | null;
  timestamp: string;
}

export async function chat(params: {
  userId: string;
  message: string;
  conversationId?: string;
}): Promise<KaiChatResponse> {
  const vaultOwnerToken = requireVaultOwnerToken();
  const result = await Kai.chat({
    userId: params.userId,
    message: params.message,
    conversationId: params.conversationId,
    vaultOwnerToken,
  });
  const raw = result as any;
  return {
    response: raw.response ?? "",
    conversationId: raw.conversation_id ?? raw.conversationId ?? "",
    componentType: raw.component_type ?? null,
    componentData: raw.component_data ?? null,
    learnedAttributes: raw.learned_attributes ?? [],
    tokensUsed: raw.tokens_used ?? null,
    timestamp: raw.timestamp ?? new Date().toISOString(),
  };
}
```

### Step 2 — Register route

**File:** `hushh-webapp/lib/navigation/routes.ts` (line 39 area)

Add immediately after `KAI_DASHBOARD`:

```ts
KAI_CHAT: "/kai/chat",
```

### Step 3 — Add tab to Kai navigation

**File:** `hushh-webapp/lib/navigation/kai-route-tabs.ts`

Replace the array body so the order becomes `market | dashboard | chat | connect | analysis`:

```ts
export const KAI_ROUTE_TABS = [
  { id: "market", label: "Market", href: ROUTES.KAI_HOME, prefetchHref: ROUTES.KAI_HOME },
  { id: "dashboard", label: "Portfolio", href: ROUTES.KAI_DASHBOARD, prefetchHref: ROUTES.KAI_DASHBOARD },
  { id: "chat", label: "Chat", href: ROUTES.KAI_CHAT, prefetchHref: ROUTES.KAI_CHAT },
  { id: "connect", label: "Connect", href: ROUTES.MARKETPLACE, prefetchHref: ROUTES.MARKETPLACE },
  { id: "analysis", label: "Analysis", href: `${ROUTES.KAI_ANALYSIS}?tab=history`, prefetchHref: ROUTES.KAI_ANALYSIS },
] as const;
```

Update `activeKaiRouteTabFromPath` to recognize the chat path (insert before the dashboard branch):

```ts
if (pathname === ROUTES.KAI_CHAT || pathname.startsWith(`${ROUTES.KAI_CHAT}/`)) return "chat";
```

### Step 4 — Page shell

**New file:** `hushh-webapp/app/(app)/kai/chat/page.tsx`

```tsx
"use client";

import { KaiOnboardingGuard } from "@/components/kai/onboarding/kai-onboarding-guard";
import { KaiChatView } from "@/components/kai/views/kai-chat-view";

export default function KaiChatPage() {
  return (
    <KaiOnboardingGuard>
      <KaiChatView />
    </KaiOnboardingGuard>
  );
}
```

### Step 5 — Chat view component

**New file:** `hushh-webapp/components/kai/views/kai-chat-view.tsx`

This is the largest piece. Outline:

```tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Send, Loader2 } from "lucide-react";
import { useVault } from "@/lib/hooks/use-vault";
import { AuthService } from "@/lib/services/auth-service";
import {
  chat,
  getInitialChatState,
  setKaiVaultOwnerToken,
  type KaiChatResponse,
} from "@/lib/services/kai-service";
import { ROUTES, buildKaiAnalysisPreviewRoute } from "@/lib/navigation/routes";
import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import {
  SurfaceCard,
  SurfaceCardContent,
  SurfaceCardHeader,
  SurfaceCardTitle,
} from "@/components/app-ui/surfaces";
import { APP_MEASURE_STYLES } from "@/components/app-ui/app-page-shell";
import { cn } from "@/lib/utils";

type ChatRole = "user" | "kai";

interface ChatBubble {
  id: string;
  role: ChatRole;
  text: string;
  timestamp: string;
  componentType?: KaiChatResponse["componentType"];
  componentData?: KaiChatResponse["componentData"];
  learnedAttributes?: KaiChatResponse["learnedAttributes"];
  pending?: boolean;
}

const WELCOME_BY_TYPE: Record<string, string> = {
  new: "Hi, I'm Kai. I'm here to help you understand your investments. To get started, would you like to import your portfolio?",
  returning_no_portfolio:
    "Welcome back. I notice you haven't imported a portfolio yet — want to do that now, or ask me about a stock?",
  returning: "Welcome back. Ask me anything about your portfolio, a ticker, or your risk profile.",
};

export function KaiChatView() {
  const router = useRouter();
  const { token: vaultOwnerToken } = useVault();
  const [messages, setMessages] = useState<ChatBubble[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Wire token into kai-service
  useEffect(() => {
    setKaiVaultOwnerToken(vaultOwnerToken ?? undefined);
    return () => setKaiVaultOwnerToken(undefined);
  }, [vaultOwnerToken]);

  // Welcome message on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const userId = AuthService.requireUserId();
        const initial = await getInitialChatState(userId);
        if (cancelled) return;
        const text = WELCOME_BY_TYPE[initial.welcomeType] ?? WELCOME_BY_TYPE.returning;
        setMessages([
          {
            id: crypto.randomUUID(),
            role: "kai",
            text,
            timestamp: new Date().toISOString(),
            componentType: initial.isNewUser || !initial.hasPortfolio ? "import_prompt" : null,
          },
        ]);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load chat");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Autoscroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const canSend = input.trim().length > 0 && !sending;

  async function handleSend() {
    if (!canSend) return;
    const userId = AuthService.requireUserId();
    const userBubble: ChatBubble = {
      id: crypto.randomUUID(),
      role: "user",
      text: input.trim(),
      timestamp: new Date().toISOString(),
    };
    const pendingKai: ChatBubble = {
      id: crypto.randomUUID(),
      role: "kai",
      text: "",
      timestamp: new Date().toISOString(),
      pending: true,
    };
    setMessages((m) => [...m, userBubble, pendingKai]);
    setInput("");
    setSending(true);
    setError(null);

    try {
      const reply = await chat({
        userId,
        message: userBubble.text,
        conversationId: conversationId ?? undefined,
      });
      setConversationId(reply.conversationId);
      setMessages((m) =>
        m.map((b) =>
          b.id === pendingKai.id
            ? {
                ...b,
                text: reply.response,
                timestamp: reply.timestamp,
                componentType: reply.componentType,
                componentData: reply.componentData ?? undefined,
                learnedAttributes: reply.learnedAttributes,
                pending: false,
              }
            : b
        )
      );
    } catch (e) {
      setMessages((m) => m.filter((b) => b.id !== pendingKai.id));
      setError(e instanceof Error ? e.message : "Kai couldn't respond. Try again.");
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className={cn(APP_MEASURE_STYLES, "flex h-[calc(100dvh-4rem)] flex-col gap-3 py-4")}>
      <div ref={scrollRef} className="flex-1 overflow-y-auto rounded-xl border border-white/5 bg-black/20 p-4 space-y-3">
        {messages.map((b) => (
          <ChatRow key={b.id} bubble={b} router={router} />
        ))}
        {error && <div className="text-sm text-red-400">{error}</div>}
      </div>

      <div className="flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask Kai about a stock, your portfolio, or your risk profile…"
          rows={2}
          className="flex-1 resize-none rounded-xl border border-white/10 bg-black/30 p-3 text-sm focus:border-emerald-500/50 focus:outline-none"
          disabled={sending}
        />
        <MorphyButton onClick={handleSend} disabled={!canSend}>
          {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        </MorphyButton>
      </div>
    </div>
  );
}

function ChatRow({ bubble, router }: { bubble: ChatBubble; router: ReturnType<typeof useRouter> }) {
  const isUser = bubble.role === "user";
  return (
    <div className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}>
      <div className={cn("flex max-w-[85%] flex-col gap-2", isUser && "items-end")}>
        <div
          className={cn(
            "rounded-2xl px-4 py-2 text-sm leading-relaxed",
            isUser ? "bg-emerald-600/30 text-white" : "bg-white/5 text-white/90"
          )}
        >
          {bubble.pending ? <Loader2 className="size-4 animate-spin opacity-70" /> : bubble.text}
        </div>
        {bubble.componentType === "import_prompt" && (
          <ImportPromptCard onClick={() => router.push(ROUTES.KAI_IMPORT)} />
        )}
        {bubble.componentType === "analysis_summary" && bubble.componentData && (
          <AnalysisSummaryCard
            data={bubble.componentData}
            onOpen={(ticker) => router.push(buildKaiAnalysisPreviewRoute({ ticker }))}
          />
        )}
        {bubble.componentType === "profile_summary" && bubble.learnedAttributes && (
          <ProfileSummaryCard attrs={bubble.learnedAttributes} />
        )}
      </div>
    </div>
  );
}

function ImportPromptCard({ onClick }: { onClick: () => void }) {
  return (
    <SurfaceCard>
      <SurfaceCardHeader>
        <SurfaceCardTitle>Import your portfolio</SurfaceCardTitle>
      </SurfaceCardHeader>
      <SurfaceCardContent className="flex items-center justify-between gap-3">
        <span className="text-xs text-white/70">CSV or PDF from Schwab, Fidelity, or Robinhood.</span>
        <MorphyButton onClick={onClick}>Import</MorphyButton>
      </SurfaceCardContent>
    </SurfaceCard>
  );
}

function AnalysisSummaryCard({
  data,
  onOpen,
}: {
  data: Record<string, unknown>;
  onOpen: (ticker: string) => void;
}) {
  const ticker = String(data.ticker ?? "").toUpperCase();
  const decision = String(data.decision ?? "").toUpperCase() as "BUY" | "HOLD" | "REDUCE";
  const confidence = Number(data.confidence ?? 0);
  const tone =
    decision === "BUY" ? "text-emerald-400" : decision === "REDUCE" ? "text-red-400" : "text-amber-300";
  return (
    <SurfaceCard>
      <SurfaceCardContent className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">{ticker}</div>
          <div className={cn("text-xs", tone)}>
            {decision} · {(confidence * 100).toFixed(0)}% confidence
          </div>
        </div>
        <MorphyButton onClick={() => onOpen(ticker)}>Open analysis</MorphyButton>
      </SurfaceCardContent>
    </SurfaceCard>
  );
}

function ProfileSummaryCard({
  attrs,
}: {
  attrs: Array<{ domain: string; key: string; value: string }>;
}) {
  const grouped = useMemo(() => {
    const out: Record<string, Array<{ key: string; value: string }>> = {};
    for (const a of attrs) {
      out[a.domain] = out[a.domain] ?? [];
      out[a.domain].push({ key: a.key, value: a.value });
    }
    return out;
  }, [attrs]);
  return (
    <SurfaceCard>
      <SurfaceCardHeader>
        <SurfaceCardTitle>What I know about you</SurfaceCardTitle>
      </SurfaceCardHeader>
      <SurfaceCardContent className="space-y-2 text-xs">
        {Object.entries(grouped).map(([domain, items]) => (
          <div key={domain}>
            <div className="text-white/60 uppercase tracking-wide">{domain}</div>
            <ul className="ml-3 list-disc">
              {items.map((it) => (
                <li key={it.key}>
                  <span className="text-white/80">{it.key}:</span> {it.value}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </SurfaceCardContent>
    </SurfaceCard>
  );
}
```

### Step 6 — Native plugin updates (flag in PR, do not block on)

**iOS** (`ios/App/App/plugins/Kai.swift` or equivalent) and **Android** (`android/app/src/main/java/.../KaiPlugin.kt`) currently parse only `response`, `conversation_id`, `timestamp` from the `/api/kai/chat` HTTP response. They need to also forward `component_type`, `component_data`, `learned_attributes`, `tokens_used`. Until that lands, native users will see plain text only — no inline cards. Web works fully via the Next.js proxy regardless.

Add a checkbox to the PR description so platform owners pick this up.

---

## 5. Testing

### 5.1 Unit / component tests
Place under `hushh-webapp/components/kai/views/__tests__/kai-chat-view.test.tsx`:

1. Renders the welcome message for `welcomeType: "new"` and shows the import-prompt card.
2. Sending a message appends a user bubble immediately, then a Kai bubble after `chat()` resolves.
3. Failure path: when `chat()` throws, the pending Kai bubble is removed and an error banner is shown.
4. `analysis_summary` `component_type` renders `AnalysisSummaryCard` and clicking "Open analysis" calls the router with the right ticker.

Mock `kai-service` and `useVault` per the existing test conventions in `components/kai/views/__tests__/`.

### 5.2 Manual smoke test
- New user: chat tab loads → import prompt visible → type "analyze AAPL" → response arrives → analysis card → click → routes to `/kai/analysis?ticker=AAPL`.
- Returning user with portfolio: welcome reflects `returning` copy → ask "what do you know about me" → profile-summary card renders.
- Vault locked: route should redirect through `KaiOnboardingGuard` to unlock — verify this by clearing the vault and visiting `/kai/chat` directly.
- Network error: kill backend, send a message, confirm the pending bubble disappears and an error appears.
- Mobile: build the Capacitor app, verify text-only fallback works (cards may be missing until §4 step 6 ships).

### 5.3 CI gates
Run before pushing:
```bash
cd hushh-webapp
pnpm lint
pnpm typecheck
pnpm test -- kai-chat-view
```

---

## 6. Edge Cases & Decisions

| Case | Decision |
|---|---|
| User sends very long message (>4000 chars) | Backend caps at 4000 — frontend should also cap and show a counter when input >3500 chars. Add a `maxLength={4000}` to textarea. |
| Empty message | Send button disabled by `canSend` check. |
| Multi-line input | Shift+Enter inserts newline, Enter sends. |
| Conversation persistence across navigation | Out of scope for v1 — `conversationId` lives in component state and is dropped on tab change. v2 can hydrate from `GET /api/kai/chat/conversations/{user_id}`. |
| Streaming responses | Backend `/api/kai/chat` is **not** SSE today. If we want streaming later we'd add a new endpoint mirroring the `_streaming.py` envelope contract used by `/analyze/stream`. Out of scope for this issue. |
| Voice input | Out of scope — `kai-command-bar-global` already has voice; we can wire it to the chat input in a follow-up. |
| Markdown rendering in Kai responses | v1 ships plain text (whitespace-pre-wrap). If responses contain markdown, add `react-markdown` in v2. |
| Learned attributes UX | v1 stores them silently in the bubble for the `profile_summary` card. v2 could show a transient toast "Kai learned: risk profile = balanced". |
| `component_type: "import_prompt"` shown twice | If the backend repeatedly returns it, dedupe by hiding the card if the previous Kai bubble already showed one within the last 3 messages. Optional polish. |

---

## 7. Files Touched / Created — Final Manifest

**Modified (3):**
1. `hushh-webapp/lib/navigation/routes.ts` — add `KAI_CHAT`
2. `hushh-webapp/lib/navigation/kai-route-tabs.ts` — add Chat tab + path matcher
3. `hushh-webapp/lib/services/kai-service.ts` — widen `chat()` return type
4. `hushh-webapp/lib/capacitor/kai.ts` — widen `KaiPlugin.chat` return type

**Created (3):**
1. `hushh-webapp/app/(app)/kai/chat/page.tsx` — page shell
2. `hushh-webapp/components/kai/views/kai-chat-view.tsx` — main view
3. `hushh-webapp/components/kai/views/__tests__/kai-chat-view.test.tsx` — component tests

**No backend changes. No database migrations. No new dependencies.**

---

## 8. Estimated Effort

| Phase | Time |
|---|---|
| Routes + tab wiring | 15 min |
| Type widening (plugin + service) | 20 min |
| Page shell | 10 min |
| `KaiChatView` core (bubbles, input, send) | 2 hr |
| `component_type` cards (3 variants) | 1 hr |
| Tests | 1 hr |
| Manual QA across web + mobile | 30 min |
| **Total** | **~5 hours** |

---

## 9. Out of Scope (explicitly)

- Streaming chat responses (would require new SSE endpoint)
- Voice input integration with chat
- Markdown / rich-text in Kai bubbles
- Conversation history sidebar (load past conversations)
- Native iOS/Android plugin parity for `component_type` (flagged for platform owners)
- Persistence of `conversationId` across page reloads
- Analytics events on chat send/receive

These are tracked as follow-ups but are not required to close issue #595.

---

## 10. UI / UX Design

A clean, focused, conversation-first surface that feels native to the existing Kai dark glassmorphism aesthetic. The design intentionally avoids visual noise — Kai is a financial agent and the user's trust hinges on the UI feeling calm, deliberate, and uncluttered.

### 10.1 Design Principles

1. **Conversation is the hero.** No sidebars, no avatars cluttering the message area. Just two columns of bubbles with breathing room.
2. **Inline action cards beat modals.** Whenever Kai suggests something (import portfolio, open analysis), the CTA is rendered as a card directly under the message — never as a popup that interrupts flow.
3. **One input, one button.** The composer is a single textarea + send affordance. No emoji picker, no attachment button (yet), no inline formatting toolbar. We can earn those later.
4. **Status is honest.** Pending, error, and "Kai is thinking" states are first-class and never lie. If the backend is down, the user sees that, not a fake spinner.
5. **The dark theme is the brand.** Match the rest of the Kai app — emerald accents on near-black backgrounds with subtle white-on-glass surfaces.

### 10.2 Color Palette & Tokens

All values come from the existing Tailwind theme used across `components/kai/views/*` — do not introduce new colors.

| Token | Usage | Tailwind class |
|---|---|---|
| Page background | Outer shell | `bg-black` (inherited from app shell) |
| Conversation surface | Scroll container | `bg-black/20 border border-white/5 rounded-xl` |
| Kai bubble | Assistant message | `bg-white/5 text-white/90` |
| User bubble | User message | `bg-emerald-600/30 text-white` |
| Input field | Composer textarea | `bg-black/30 border border-white/10` |
| Input focus ring | Active composer | `focus:border-emerald-500/50` |
| Inline card | Component-type cards | `SurfaceCard` (existing) |
| Decision: BUY | Bullish accent | `text-emerald-400` |
| Decision: HOLD | Neutral accent | `text-amber-300` |
| Decision: REDUCE | Bearish accent | `text-red-400` |
| Error banner | Failure state | `text-red-400 bg-red-500/10 border-red-500/20` |
| Muted text | Timestamps, helper copy | `text-white/60` |

### 10.3 Layout — Desktop (≥768px)

```
+-----------------------------------------------------------------------+
|  [Market]  [Portfolio]  [● Chat]  [Connect]  [Analysis]      <- tabs |
+-----------------------------------------------------------------------+
|                                                                       |
|  +-----------------------------------------------------------------+  |
|  |                                                                 |  |
|  |  +------------------------------------------+                   |  |
|  |  | Hi, I'm Kai. I'm here to help you        |                   |  |
|  |  | understand your investments. To get      |                   |  |
|  |  | started, would you like to import        |                   |  |
|  |  | your portfolio?                          |                   |  |
|  |  +------------------------------------------+                   |  |
|  |  +------------------------------------------+                   |  |
|  |  | [card] Import your portfolio             |                   |  |
|  |  |        CSV/PDF · Schwab, Fidelity        |                   |  |
|  |  |                              [ Import ]  |                   |  |
|  |  +------------------------------------------+                   |  |
|  |                                                                 |  |
|  |                          +-------------------------------------+|  |
|  |                          | Should I sell my AAPL position?     ||  |
|  |                          +-------------------------------------+|  |
|  |                                                                 |  |
|  |  +-------------------+                                          |  |
|  |  | Kai is thinking…  |   <- pending bubble (animated)           |  |
|  |  +-------------------+                                          |  |
|  |                                                                 |  |
|  |                                            10:42 AM  [scroll v] |  |
|  +-----------------------------------------------------------------+  |
|                                                                       |
|  +-----------------------------------------------------------------+  |
|  | Ask Kai about a stock, your portfolio, or your risk profile…   |  |
|  |                                                                 |  |
|  |                                                       [ ▶ Send] |  |
|  +-----------------------------------------------------------------+  |
+-----------------------------------------------------------------------+
```

**Width:** Conversation column max-width 720px, centered (uses existing `APP_MEASURE_STYLES`).
**Height:** Fills viewport minus tab nav (`h-[calc(100dvh-4rem)]`).
**Bubble width:** Max 85% of column. Kai aligned left, user right.
**Spacing:** `space-y-3` between bubbles, `gap-2` between bubble and its action card.

### 10.4 Layout — Mobile (<768px)

```
+--------------------------------+
| ☰  Kai                       … |
+--------------------------------+
| [Market][Port][●Chat][Conn][An]|  <- horizontal scroll tabs
+--------------------------------+
|                                |
| +----------------------------+ |
| | Welcome back. Ask me about |  |
| | a ticker or your portfolio |  |
| +----------------------------+ |
|                                |
|       +----------------------+ |
|       | What's my risk      | |
|       | profile?            | |
|       +----------------------+ |
|                                |
| +----------------------------+ |
| | Based on your portfolio,   | |
| | you're a balanced investor.|  |
| +----------------------------+ |
| +----------------------------+ |
| | [card] What I know about   | |
| | you                        | |
| | • Risk: Balanced           | |
| | • Horizon: 10+ years       | |
| +----------------------------+ |
|                                |
+--------------------------------+
| Type a message…           [▶]  |
+--------------------------------+
```

**Mobile-specific:**
- Composer sticks to bottom with `safe-area-inset-bottom` padding for iOS notch/home bar
- Textarea expands up to 4 rows then scrolls internally
- Send button collapses to icon-only at <380px
- Tab strip is horizontally scrollable; "Chat" tab auto-scrolls into center on mount

### 10.5 Component Anatomy

#### Message bubble
```
Padding:        px-4 py-2
Radius:         rounded-2xl
Max width:      85% of column
Font:           text-sm leading-relaxed
Tail:           none (clean modern look — no chat-tail SVG)
Shadow:         none (flat, glass-on-glass)
Timestamp:      Hidden by default; shown on hover/tap as text-[10px] text-white/40 below bubble
```

#### Pending bubble ("Kai is thinking")
- Same dimensions as a normal Kai bubble
- Contents: a `Loader2` icon (`size-4 animate-spin opacity-70`) — no text
- Replaced in-place once the response arrives (no layout jump)

#### Inline action card
- Uses existing `SurfaceCard` / `SurfaceCardHeader` / `SurfaceCardContent`
- Always full-width within the bubble's 85% column
- Single primary action button right-aligned
- Compact: `p-3` not `p-6`

#### Composer
```
Container:      flex items-end gap-2
Textarea:       flex-1, resize-none, rows={2}, max 4 rows
Send button:    morphy-ux Button, square 44×44 on mobile, auto on desktop
                Icon-only when sending OR when input is empty
                "Send" label appears at >=md when input has content
Disabled state: opacity-50, cursor-not-allowed
Keyboard:       Enter sends, Shift+Enter newline, Esc clears
```

### 10.6 Interaction States

| State | Visual |
|---|---|
| Idle (no messages yet) | Welcome bubble + (if applicable) import prompt card |
| User typing | Send button transitions from disabled→enabled, character count appears at >3500 chars |
| Sending | Send button shows `Loader2` spinner, textarea disabled, pending Kai bubble appears |
| Response received | Pending bubble morphs into real bubble with smooth opacity transition (200ms) |
| Error | Pending bubble removed, red banner appears above composer with retry hint, last user message stays in input for easy re-send |
| Network offline | Banner: "You're offline. Messages will send when you're back." (use `navigator.onLine`) |
| Vault locked | KaiOnboardingGuard intercepts before render — user never reaches the chat in this state |

### 10.7 Empty / Welcome States

Welcome message varies by `welcomeType` from `getInitialChatState()`:

| `welcomeType` | Bubble copy | Inline card |
|---|---|---|
| `new` | "Hi, I'm Kai. I'm here to help you understand your investments. To get started, would you like to import your portfolio?" | `import_prompt` |
| `returning_no_portfolio` | "Welcome back. I notice you haven't imported a portfolio yet — want to do that now, or ask me about a stock?" | `import_prompt` |
| `returning` | "Welcome back. Ask me anything about your portfolio, a ticker, or your risk profile." | none |

### 10.8 Quick-Reply Chips (optional polish, v1.1)

Below the welcome bubble for new users, render 3 tappable chips that pre-fill the composer:

```
[ Analyze AAPL ]   [ What's my risk? ]   [ Show my losers ]
```

```tsx
<div className="flex flex-wrap gap-2">
  {SUGGESTIONS.map(s => (
    <button
      key={s}
      onClick={() => setInput(s)}
      className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/80 hover:bg-white/10"
    >
      {s}
    </button>
  ))}
</div>
```

This is **optional for v1** — ship without if time-constrained, add in v1.1.

### 10.9 Animations

Keep them subtle. No bouncing, no slides longer than 200ms.

| Element | Animation | Duration |
|---|---|---|
| New bubble appearing | `opacity 0 → 1`, `translateY(4px → 0)` | 180ms ease-out |
| Pending → real bubble | Cross-fade content | 200ms |
| Send button state change | Color/icon swap | 120ms |
| Auto-scroll to bottom | `behavior: "smooth"` | browser default |
| Typing indicator | `Loader2 animate-spin` (Tailwind) | continuous |

No skeleton loaders — the welcome bubble loads in <100ms after vault unlock, so a skeleton would flash and disappear.

### 10.10 Accessibility

- Conversation container is `role="log" aria-live="polite" aria-relevant="additions"` so new messages are announced by screen readers.
- Each bubble has `aria-label="Kai said: …"` or `"You said: …"`.
- Composer textarea has visible label (sr-only) `"Message Kai"`.
- Send button has `aria-label="Send message"` and `aria-disabled` reflects the disabled state.
- All interactive elements reachable via Tab; focus ring visible (`focus-visible:ring-2 ring-emerald-500/50`).
- Color contrast: every text/background pair tested against WCAG AA (the emerald-on-black combos are already validated in other Kai views).

### 10.11 Responsive Breakpoints

| Breakpoint | Behavior |
|---|---|
| `<380px` | Send button icon-only; composer padding reduced to `p-2` |
| `380–640px` | Standard mobile layout; bubbles 90% width |
| `640–768px` | Tablet portrait; column max-width 600px |
| `≥768px` | Desktop layout; column max-width 720px, centered |
| `≥1280px` | No further widening — extra space stays as breathing room |

### 10.12 Visual Reference (component tree)

```
<KaiChatView>
  <div [APP_MEASURE_STYLES, flex flex-col h-full]>
    <ConversationScroll [flex-1 overflow-y-auto]>
      {messages.map(b =>
        <ChatRow [justify-start | justify-end]>
          <div [flex flex-col gap-2 max-w-[85%]]>
            <Bubble [bg-white/5 | bg-emerald-600/30]>
              {b.text or <Spinner/>}
            </Bubble>
            {b.componentType === "import_prompt" && <ImportPromptCard/>}
            {b.componentType === "analysis_summary" && <AnalysisSummaryCard/>}
            {b.componentType === "profile_summary" && <ProfileSummaryCard/>}
          </div>
        </ChatRow>
      )}
      {error && <ErrorBanner/>}
    </ConversationScroll>

    <Composer [flex items-end gap-2]>
      <textarea [flex-1]/>
      <SendButton/>
    </Composer>
  </div>
</KaiChatView>
```

### 10.13 What we are deliberately NOT building (yet)

| Anti-pattern | Why we skip |
|---|---|
| User avatars | Adds noise; this is a 1:1 conversation |
| Reaction emojis | Not relevant to financial advice |
| Message editing/deletion | Conversations are part of the audit trail; we don't let users rewrite history |
| Threaded replies | Linear conversation is the right mental model for an agent |
| Typing animation that types out characters one-by-one | Backend doesn't stream this endpoint; faking it would mislead users about latency |
| Sound effects on send/receive | Financial app context — silence respects user environment |
| Rich onboarding tour for the chat tab | The welcome bubble + suggestion chips ARE the onboarding |

This is a deliberate choice: ship a focused, professional surface for v1. Every item in this anti-pattern list is a battle we don't need to fight to close issue #595.

---

## 11. Acceptance Criteria

A reviewer should be able to confirm all of the following:

1. Visiting `/kai/chat` while logged in renders a chat surface with a welcome message tailored to user state.
2. Typing a message and pressing Enter sends it and a Kai response appears within ~5 s.
3. The Chat tab is visible in the Kai nav between Portfolio and Connect on web, iOS, and Android.
4. `component_type: "import_prompt"` renders a card linking to `/kai/import`.
5. `component_type: "analysis_summary"` renders a decision card linking to `/kai/analysis?ticker=…`.
6. Vault-locked users are routed through onboarding before reaching the chat.
7. `pnpm lint && pnpm typecheck && pnpm test` pass green.
8. No new permission scopes, env vars, or backend endpoints introduced.
