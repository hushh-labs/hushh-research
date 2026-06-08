/**
 * KaiChatView — Main agent chat surface for the Kai app.
 *
 * Design: dark glassmorphism, emerald accents, no avatars, inline action cards.
 * Auth: vault token wired via setKaiVaultOwnerToken() on mount.
 * Platform: tri-flow parity via Kai plugin (web proxy + native HTTP).
 *
 * Implements Issue #595 — "Create an agent chat section inside the Kai app"
 */

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Send, Loader2, MessageSquare, WifiOff } from "lucide-react";
import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";
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

// =============================================================================
// TYPES
// =============================================================================

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

// =============================================================================
// CONSTANTS
// =============================================================================

const WELCOME_BY_TYPE: Record<string, string> = {
  new: "Hi, I'm Kai. I'm here to help you understand your investments. To get started, would you like to import your portfolio?",
  returning_no_portfolio:
    "Welcome back. I notice you haven't imported a portfolio yet — want to do that now, or ask me about a stock?",
  returning: "Welcome back. Ask me anything about your portfolio, a ticker, or your risk profile.",
};

const SUGGESTIONS = ["Analyze AAPL", "What's my risk profile?", "Show my losers"];

const MAX_INPUT_LENGTH = 4000;
const CHAR_WARN_THRESHOLD = 3500;

// =============================================================================
// MAIN VIEW
// =============================================================================

export function KaiChatView() {
  const router = useRouter();
  const { user } = useAuth();
  const { vaultOwnerToken } = useVault();

  const [messages, setMessages] = useState<ChatBubble[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isNewUser, setIsNewUser] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // --- Wire vault token into kai-service (memory-only, XSS safe) ---
  useEffect(() => {
    setKaiVaultOwnerToken(vaultOwnerToken ?? undefined);
    return () => setKaiVaultOwnerToken(undefined);
  }, [vaultOwnerToken]);

  // --- Online/offline detection ---
  useEffect(() => {
    const update = () => setIsOffline(!navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    setIsOffline(!navigator.onLine);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  // --- Welcome message on mount ---
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const userId = user?.uid;
        if (!userId) return;
        const initial = await getInitialChatState(userId);
        if (cancelled) return;
        setIsNewUser(initial.isNewUser);
        const welcomeText: string =
          WELCOME_BY_TYPE[initial.welcomeType] ??
          "Welcome back. Ask me anything about your portfolio or a ticker.";
        const showImportCard = initial.isNewUser || !initial.hasPortfolio;
        setMessages([
          {
            id: crypto.randomUUID(),
            role: "kai",
            text: welcomeText,
            timestamp: new Date().toISOString(),
            componentType: showImportCard ? "import_prompt" : null,
          },
        ]);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load chat. Try refreshing.");
      } finally {
        if (!cancelled) setInitialLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.uid]);

  // --- Autoscroll to latest message ---
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  // --- Auto-resize textarea ---
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

  const canSend = input.trim().length > 0 && !sending && !isOffline;

  // --- Send handler ---
  async function handleSend() {
    if (!canSend) return;
    const userId = user?.uid;
    if (!userId) return;
    const userBubble: ChatBubble = {
      id: crypto.randomUUID(),
      role: "user",
      text: input.trim(),
      timestamp: new Date().toISOString(),
    };
    const pendingId = crypto.randomUUID();
    const pendingKai: ChatBubble = {
      id: pendingId,
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
          b.id === pendingId
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
      // Remove pending bubble, restore input so user can retry
      setMessages((m) => m.filter((b) => b.id !== pendingId));
      setInput(userBubble.text);
      setError(
        e instanceof Error
          ? e.message
          : "Kai couldn't respond. Check your connection and try again."
      );
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === "Escape") {
      setInput("");
    }
  }

  const charCount = input.length;
  const showCharCount = charCount > CHAR_WARN_THRESHOLD;

  return (
    <div
      className="mx-auto flex w-full flex-col px-[var(--page-inline-gutter-standard)]"
      style={{
        ...APP_MEASURE_STYLES.reading,
        height: "calc(100dvh - 7rem)",
        paddingTop: "1rem",
        paddingBottom: "1rem",
        gap: "0.75rem",
      }}
    >
      {/* ------------------------------------------------------------------ */}
      {/* CONVERSATION SCROLL AREA                                            */}
      {/* ------------------------------------------------------------------ */}
      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Kai conversation"
        className="flex-1 overflow-y-auto rounded-2xl border border-white/5 bg-black/20 p-4 space-y-3"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
      >
        {/* Loading skeleton */}
        {initialLoading && (
          <div className="flex items-center gap-2 text-white/40 text-sm">
            <Loader2 className="size-4 animate-spin" />
            <span>Starting conversation…</span>
          </div>
        )}

        {/* Message bubbles */}
        {messages.map((b) => (
          <ChatRow key={b.id} bubble={b} router={router} />
        ))}

        {/* Suggestion chips — shown only after welcome for new/no-portfolio users */}
        {!initialLoading &&
          messages.length === 1 &&
          isNewUser &&
          messages[0]?.role === "kai" && (
            <div className="flex flex-wrap gap-2 pl-1">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => setInput(s)}
                  className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/80 transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

        {/* Error banner */}
        {error && (
          <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-2.5 text-sm text-red-400">
            {error}
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* OFFLINE BANNER                                                       */}
      {/* ------------------------------------------------------------------ */}
      {isOffline && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-400">
          <WifiOff className="size-3.5 shrink-0" />
          <span>You're offline. Messages will send when you're back.</span>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* COMPOSER                                                             */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex items-end gap-2">
        {/* sr-only label for accessibility */}
        <label htmlFor="kai-chat-input" className="sr-only">
          Message Kai
        </label>

        <div className="relative flex-1">
          <textarea
            id="kai-chat-input"
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value.slice(0, MAX_INPUT_LENGTH))}
            onKeyDown={handleKeyDown}
            placeholder="Ask Kai about a stock, your portfolio, or your risk profile…"
            rows={2}
            disabled={sending}
            className="w-full resize-none rounded-xl border border-white/10 bg-black/30 p-3 pr-4 text-sm leading-relaxed text-white placeholder:text-white/30 transition-colors focus:border-emerald-500/50 focus:outline-none disabled:opacity-50"
            style={{ maxHeight: 120, minHeight: 56 }}
          />
          {showCharCount && (
            <span
              className={cn(
                "absolute bottom-2 right-3 text-[10px]",
                charCount >= MAX_INPUT_LENGTH ? "text-red-400" : "text-white/40"
              )}
            >
              {charCount}/{MAX_INPUT_LENGTH}
            </span>
          )}
        </div>

        <MorphyButton
          onClick={handleSend}
          disabled={!canSend}
          aria-label="Send message"
          aria-disabled={!canSend}
          className="shrink-0"
        >
          {sending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Send className="size-4" />
          )}
          <span className="hidden md:inline ml-1">{sending ? "" : "Send"}</span>
        </MorphyButton>
      </div>
    </div>
  );
}

// =============================================================================
// CHAT ROW
// =============================================================================

function ChatRow({
  bubble,
  router,
}: {
  bubble: ChatBubble;
  router: ReturnType<typeof useRouter>;
}) {
  const isUser = bubble.role === "user";
  const bubbleLabel = isUser
    ? `You said: ${bubble.text}`
    : bubble.pending
    ? "Kai is thinking"
    : `Kai said: ${bubble.text}`;

  return (
    <div
      className={cn(
        "flex w-full transition-opacity duration-200",
        isUser ? "justify-end" : "justify-start"
      )}
      style={{ animation: "fadeSlideIn 180ms ease-out" }}
    >
      <div className={cn("flex max-w-[85%] flex-col gap-2", isUser && "items-end")}>
        {/* Bubble */}
        <div
          aria-label={bubbleLabel}
          className={cn(
            "rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
            isUser
              ? "bg-emerald-600/30 text-white"
              : "bg-white/5 text-white/90"
          )}
          style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
        >
          {bubble.pending ? (
            <Loader2 className="size-4 animate-spin opacity-70" aria-label="Kai is thinking" />
          ) : (
            bubble.text
          )}
        </div>

        {/* Inline component cards */}
        {!bubble.pending && bubble.componentType === "import_prompt" && (
          <ImportPromptCard onClick={() => router.push(ROUTES.KAI_IMPORT)} />
        )}
        {!bubble.pending &&
          bubble.componentType === "analysis_summary" &&
          bubble.componentData && (
            <AnalysisSummaryCard
              data={bubble.componentData}
              onOpen={(ticker) => router.push(buildKaiAnalysisPreviewRoute({ ticker }))}
            />
          )}
        {!bubble.pending &&
          bubble.componentType === "profile_summary" &&
          bubble.learnedAttributes &&
          bubble.learnedAttributes.length > 0 && (
            <ProfileSummaryCard attrs={bubble.learnedAttributes} />
          )}
      </div>
    </div>
  );
}

// =============================================================================
// INLINE ACTION CARDS
// =============================================================================

function ImportPromptCard({ onClick }: { onClick: () => void }) {
  return (
    <SurfaceCard>
      <SurfaceCardHeader>
        <div className="flex items-center gap-2">
          <MessageSquare className="size-4 text-emerald-400" />
          <SurfaceCardTitle>Import your portfolio</SurfaceCardTitle>
        </div>
      </SurfaceCardHeader>
      <SurfaceCardContent className="flex items-center justify-between gap-3">
        <span className="text-xs text-white/60">
          CSV or PDF from Schwab, Fidelity, or Robinhood.
        </span>
        <MorphyButton onClick={onClick} size="sm">
          Import
        </MorphyButton>
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
    decision === "BUY"
      ? "text-emerald-400"
      : decision === "REDUCE"
      ? "text-red-400"
      : "text-amber-300";

  return (
    <SurfaceCard>
      <SurfaceCardContent className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">{ticker || "—"}</div>
          <div className={cn("text-xs", tone)}>
            {decision} · {(confidence * 100).toFixed(0)}% confidence
          </div>
        </div>
        <MorphyButton
          onClick={() => onOpen(ticker)}
          disabled={!ticker}
          size="sm"
        >
          Open analysis
        </MorphyButton>
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
      out[a.domain]!.push({ key: a.key, value: a.value });
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
            <div className="uppercase tracking-wide text-white/50">{domain}</div>
            <ul className="ml-3 list-disc space-y-0.5">
              {items.map((it) => (
                <li key={it.key}>
                  <span className="text-white/80">{it.key}:</span>{" "}
                  <span className="text-white/70">{it.value}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </SurfaceCardContent>
    </SurfaceCard>
  );
}
