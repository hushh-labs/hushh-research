"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Bot,
  BriefcaseBusiness,
  Bug,
  ChevronDown,
  Copy,
  Mic,
  MicOff,
  Send,
  UserRound,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/ui/button";
import { AgentHistorySidebar } from "@/components/agent/agent-history-sidebar";
import { AgentPkmReviewPanel } from "@/components/agent/agent-pkm-review-panel";
import { StreamingCursor } from "@/lib/morphy-ux/streaming-cursor";
import { useAuth } from "@/hooks/use-auth";
import {
  executeAgentGatewayAction,
  type AgentActionRuntimeResult,
} from "@/lib/agent/agent-action-runtime";
import {
  addToPKM,
  clearAgentPkmContext,
  formatAgentPkmSaveSummary,
  getAutoSavePkmCards,
  getIgnoredPkmCards,
  getReviewRequiredPkmCards,
  loadAgentPkmContext,
  previewAgentPkmMemory,
  type AgentPkmContext,
  type AgentPkmPreviewCard,
} from "@/lib/agent/agent-pkm-memory";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { usePersonaState } from "@/lib/persona/persona-context";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import { AppBackgroundTaskService } from "@/lib/services/app-background-task-service";
import {
  AgentRealtimeClient,
  type AgentRealtimeVoiceState,
} from "@/lib/services/agent-realtime-client";
import {
  deleteAgentChatConversation,
  getAgentChatHistory,
  listAgentChatConversations,
  renameAgentChatConversation,
  streamAgentChat,
  type AgentChatConversation,
  type AgentChatMessage as StoredAgentChatMessage,
  type AgentChatToolEvent,
} from "@/lib/services/agent-chat-client";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";
import { deriveVoiceRouteScreen } from "@/lib/voice/route-screen-derivation";
import type { AppRuntimeState } from "@/lib/voice/voice-types";
import { getVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

type AgentMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  status?: "streaming" | "done" | "error";
  ephemeral?: boolean;
};

type AgentDebugEvent = {
  id: string;
  turnId: string;
  timestamp: string;
  event: string;
  payload: unknown;
};

type AgentPkmReview = {
  id: string;
  turnId: string;
  sourceMessage: string;
  cards: AgentPkmPreviewCard[];
  saving: boolean;
};

type AgentPkmActivity = {
  id: string;
  text: string;
  status: "streaming" | "done" | "error";
};

export type AgentChatWorkspaceVariant = "page" | "popover";

type AgentChatWorkspaceProps = {
  variant?: AgentChatWorkspaceVariant;
  className?: string;
  onMinimize?: () => void;
  onNavigationActionComplete?: (result: AgentActionRuntimeResult) => void;
};

const AGENT_GREETING =
  "Hey, I'm Agent. Ask me about markets, your portfolio, Kai analysis, or consent workflows.";

const EMPTY_PKM_CONTEXT: AgentPkmContext = {
  text: "",
  domains: [],
  totalAttributes: 0,
  updatedAt: null,
};
const AGENT_STREAM_RENDER_FRAME_MS = 32;

const EXPLICIT_PKM_SAVE_PATTERN =
  /\b(?:add|save|store|remember)\b[\s\S]{0,140}\b(?:pkm|personal knowledge|memory|memories)\b|\b(?:add|save|store|remember)\s+(?:this|that)\b/i;

function formatNow(): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date());
}

function createGreetingMessage(): AgentMessage {
  return {
    id: "agent-greeting",
    role: "assistant",
    text: AGENT_GREETING,
    timestamp: formatNow(),
    status: "done",
  };
}

function AgentMarkdown({ text }: { text: string }) {
  return (
    <div className="agent-markdown min-w-0 break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h2 className="mb-2 mt-1 text-base font-semibold leading-6 text-foreground">
              {children}
            </h2>
          ),
          h2: ({ children }) => (
            <h3 className="mb-2 mt-3 text-sm font-semibold leading-5 text-foreground">
              {children}
            </h3>
          ),
          h3: ({ children }) => (
            <h4 className="mb-1.5 mt-3 text-sm font-semibold leading-5 text-foreground">
              {children}
            </h4>
          ),
          h4: ({ children }) => (
            <h5 className="mb-1.5 mt-2 text-sm font-semibold leading-5 text-foreground">
              {children}
            </h5>
          ),
          p: ({ children }) => (
            <p className="my-2 first:mt-0 last:mb-0">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="my-2 ml-5 list-disc space-y-1">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-2 ml-5 list-decimal space-y-1">{children}</ol>
          ),
          li: ({ children }) => <li className="pl-1">{children}</li>,
          a: ({ children, href }) => (
            <a
              href={href || "#"}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {children}
            </a>
          ),
          code: ({ children, className }) => {
            const inline = !className;
            if (inline) {
              return (
                <code className="rounded border border-border/70 bg-muted px-1 py-0.5 font-mono text-[0.85em]">
                  {children}
                </code>
              );
            }
            return <code className={cn("font-mono text-xs", className)}>{children}</code>;
          },
          pre: ({ children }) => (
            <pre className="my-3 overflow-x-auto rounded-md border border-border/70 bg-muted/60 p-3 leading-5">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-3 border-l-2 border-primary/50 pl-3 text-muted-foreground">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-md border border-border/70">
              <table className="min-w-full border-collapse text-left text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-border/70 bg-muted/60 px-3 py-2 font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-border/50 px-3 py-2 align-top last:border-b-0">
              {children}
            </td>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function useAnimatedAssistantText(targetText: string, active: boolean) {
  const [displayedText, setDisplayedText] = useState(active ? "" : targetText);
  const displayedTextRef = useRef(displayedText);
  const targetTextRef = useRef(targetText);

  useEffect(() => {
    displayedTextRef.current = displayedText;
  }, [displayedText]);

  useEffect(() => {
    targetTextRef.current = targetText;

    if (!active && !targetText.startsWith(displayedTextRef.current)) {
      displayedTextRef.current = targetText;
      setDisplayedText(targetText);
    }
  }, [active, targetText]);

  useEffect(() => {
    let frame = 0;
    let lastPaintAt = 0;

    const tick = (now: number) => {
      const target = targetTextRef.current;
      const current = displayedTextRef.current;

      if (!target.startsWith(current)) {
        displayedTextRef.current = target;
        setDisplayedText(target);
        return;
      }

      if (current.length >= target.length) {
        return;
      }

      if (lastPaintAt && now - lastPaintAt < AGENT_STREAM_RENDER_FRAME_MS) {
        frame = window.requestAnimationFrame(tick);
        return;
      }

      const elapsedMs = lastPaintAt ? Math.max(12, now - lastPaintAt) : AGENT_STREAM_RENDER_FRAME_MS;
      lastPaintAt = now;
      const backlog = target.length - current.length;
      const charsPerSecond = backlog > 900 ? 2600 : backlog > 260 ? 1500 : 620;
      const step = Math.max(
        1,
        Math.min(backlog, Math.ceil((charsPerSecond * elapsedMs) / 1000))
      );
      const nextText = target.slice(0, current.length + step);
      displayedTextRef.current = nextText;
      setDisplayedText(nextText);

      if (nextText.length < target.length) {
        frame = window.requestAnimationFrame(tick);
      }
    };

    const target = targetTextRef.current;
    const current = displayedTextRef.current;
    if (target && (!target.startsWith(current) || current.length < target.length)) {
      frame = window.requestAnimationFrame(tick);
    }

    return () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [active, targetText]);

  return {
    displayedText,
    isAnimating: active || displayedText.length < targetText.length,
  };
}

function AgentThinkingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1 text-muted-foreground" aria-label="Agent is thinking">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-160ms] motion-reduce:animate-none" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-80ms] motion-reduce:animate-none" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current motion-reduce:animate-none" />
    </span>
  );
}

function AgentBubble({ message }: { message: AgentMessage }) {
  const isUser = message.role === "user";
  const isStreaming = message.status === "streaming";
  const isError = message.status === "error";
  const animated = useAnimatedAssistantText(message.text, !isUser && isStreaming);
  const assistantText = isUser ? message.text : animated.displayedText;
  const showStreamingAffordance = !isUser && animated.isAnimating;

  return (
    <div
      className={cn(
        "flex gap-3 animate-in fade-in slide-in-from-bottom-1 duration-200 motion-reduce:animate-none",
        isUser ? "justify-end" : "justify-start"
      )}
    >
      {!isUser ? (
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
          <Bot className="h-4 w-4" />
        </div>
      ) : null}
      <div className={cn("max-w-[78%]", isUser && "order-first")}>
        <div
          aria-live={!isUser && isStreaming ? "polite" : undefined}
          className={cn(
            "rounded-lg px-4 py-3 text-sm leading-6 shadow-sm",
            isUser
              ? "bg-primary text-primary-foreground"
              : "border border-border/70 bg-background text-foreground",
            isError && "border-destructive/40 bg-destructive/10 text-destructive"
          )}
        >
          {isUser ? (
            <span className="whitespace-pre-wrap break-words">{message.text}</span>
          ) : assistantText ? (
            <AgentMarkdown text={assistantText} />
          ) : (
            <AgentThinkingDots />
          )}
          {showStreamingAffordance ? (
            <StreamingCursor
              isStreaming={isStreaming}
              color={isError ? "error" : "primary"}
              size="md"
              className="ml-1"
            />
          ) : null}
        </div>
        <p className={cn("mt-1 text-xs text-muted-foreground", isUser && "text-right")}>
          {message.timestamp}
        </p>
      </div>
      {isUser ? (
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-border/70 bg-background text-muted-foreground">
          <UserRound className="h-4 w-4" />
        </div>
      ) : null}
    </div>
  );
}

function AgentDebugPanel({
  events,
  onCopyLatest,
}: {
  events: AgentDebugEvent[];
  onCopyLatest: () => void;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-background/80 p-3 text-xs">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="font-medium text-foreground">Tool debug</div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-2"
          onClick={onCopyLatest}
          disabled={events.length === 0}
        >
          <Copy className="h-3.5 w-3.5" />
          Copy debug
        </Button>
      </div>
      {events.length === 0 ? (
        <p className="text-muted-foreground">No tool calls for the latest turn.</p>
      ) : (
        <div className="max-h-64 space-y-2 overflow-y-auto">
          {events.map((event) => (
            <div key={event.id} className="rounded-md border border-border/60 bg-card p-2">
              <div className="mb-1 flex items-center justify-between gap-3">
                <span className="font-medium text-foreground">{event.event}</span>
                <span className="text-muted-foreground">
                  {new Intl.DateTimeFormat(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                    second: "2-digit",
                  }).format(new Date(event.timestamp))}
                </span>
              </div>
              <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-4 text-muted-foreground">
                {JSON.stringify(event.payload, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AgentPkmActivityLine({ item }: { item: AgentPkmActivity }) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 pl-11 pr-2 text-xs",
        item.status === "error" ? "text-destructive/80" : "text-muted-foreground"
      )}
      aria-live="polite"
    >
      {item.status === "streaming" ? (
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-current" />
      ) : (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-60" />
      )}
      <span className="min-w-0 break-words">{item.text}</span>
    </div>
  );
}

function storedMessageToAgentMessage(message: StoredAgentChatMessage): AgentMessage | null {
  if (message.role !== "user" && message.role !== "assistant") return null;
  const createdAt = message.created_at ? new Date(message.created_at) : null;
  return {
    id: message.id,
    role: message.role,
    text: message.content,
    timestamp:
      createdAt && !Number.isNaN(createdAt.getTime())
        ? new Intl.DateTimeFormat(undefined, {
            hour: "numeric",
            minute: "2-digit",
          }).format(createdAt)
        : formatNow(),
    status: message.status === "error" ? "error" : "done",
  };
}

function shouldMinimizeForNavigationResult(result: AgentActionRuntimeResult): boolean {
  return Boolean(
    result.routeAfter &&
      result.status !== "failed" &&
      result.status !== "invalid" &&
      result.status !== "noop"
  );
}

export function AgentChatWorkspace({
  variant = "page",
  className,
  onMinimize,
  onNavigationActionComplete,
}: AgentChatWorkspaceProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isPopover = variant === "popover";
  const { user, loading: authLoading } = useAuth();
  const {
    isVaultUnlocked,
    vaultKey,
    vaultOwnerToken,
    tokenExpiresAt,
    getVaultOwnerToken,
  } = useVault();
  const {
    activePersona,
    primaryNavPersona,
    personaTransitionTarget,
    riaSetupAvailable,
    riaSwitchAvailable,
  } = usePersonaState();
  const analysisParams = useKaiSession((state) => state.analysisParams);
  const busyOperations = useKaiSession((state) => state.busyOperations);
  const setAnalysisParams = useKaiSession((state) => state.setAnalysisParams);
  const [input, setInput] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<AgentChatConversation[]>([]);
  const [messages, setMessages] = useState<AgentMessage[]>(() => [createGreetingMessage()]);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isHistorySidebarCollapsed, setIsHistorySidebarCollapsed] = useState(false);
  const [historyActionPendingId, setHistoryActionPendingId] = useState<string | null>(null);
  const [isVoiceConnecting, setIsVoiceConnecting] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeFrontendToolCount, setActiveFrontendToolCount] = useState(0);
  const [activePkmToolCount, setActivePkmToolCount] = useState(0);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugEvents, setDebugEvents] = useState<AgentDebugEvent[]>([]);
  const [latestDebugTurnId, setLatestDebugTurnId] = useState<string | null>(null);
  const [pkmReviews, setPkmReviews] = useState<AgentPkmReview[]>([]);
  const [pkmActivity, setPkmActivity] = useState<AgentPkmActivity[]>([]);
  const [voiceState, setVoiceState] = useState<AgentRealtimeVoiceState>("idle");
  const [hasPortfolioData, setHasPortfolioData] = useState(false);
  const [backgroundTaskState, setBackgroundTaskState] = useState(() =>
    AppBackgroundTaskService.getState()
  );
  const voiceClientRef = useRef<AgentRealtimeClient | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const voiceUserMessageIdRef = useRef<string | null>(null);
  const voiceAssistantMessageIdRef = useRef<string | null>(null);
  const historyLoadKeyRef = useRef<string | null>(null);
  const streamAbortControllerRef = useRef<AbortController | null>(null);
  const pkmAbortControllersRef = useRef<Set<AbortController>>(new Set());
  const latestVisibleTurnIdRef = useRef<string | null>(null);

  const voiceActive = voiceState !== "idle";
  const isToolWorking = activeFrontendToolCount > 0;
  const isPkmMemoryWorking = activePkmToolCount > 0;
  const tokenIsFresh = !tokenExpiresAt || Date.now() < tokenExpiresAt;
  const abortAgentTurnWork = useCallback(() => {
    streamAbortControllerRef.current?.abort();
    streamAbortControllerRef.current = null;
    for (const controller of pkmAbortControllersRef.current) {
      controller.abort();
    }
    pkmAbortControllersRef.current.clear();
  }, []);

  useEffect(() => {
    if (user?.uid && isVaultUnlocked && vaultKey) {
      return;
    }
    clearAgentPkmContext(user?.uid);
  }, [isVaultUnlocked, user?.uid, vaultKey]);
  const routeQuery = searchParams?.toString() || "";
  const pathnameWithQuery = routeQuery ? `${pathname || ""}?${routeQuery}` : pathname || "";
  const routeInfo = useMemo(
    () => deriveVoiceRouteScreen(pathname || "", routeQuery),
    [pathname, routeQuery]
  );
  const activeAnalysisTask = useMemo(() => {
    if (!user?.uid) return null;
    return (
      backgroundTaskState.tasks.find(
        (task) =>
          task.userId === user.uid &&
          task.kind === "stock_analysis_stream" &&
          task.status === "running" &&
          !task.dismissedAt
      ) || null
    );
  }, [backgroundTaskState.tasks, user?.uid]);
  const runningImportTask = useMemo(() => {
    if (!user?.uid) return null;
    return (
      backgroundTaskState.tasks.find(
        (task) =>
          task.userId === user.uid &&
          task.kind === "portfolio_import_stream" &&
          task.status === "running" &&
          !task.dismissedAt
      ) || null
    );
  }, [backgroundTaskState.tasks, user?.uid]);
  const activeAnalysisTicker = useMemo(() => {
    const ticker = activeAnalysisTask?.metadata?.ticker;
    return typeof ticker === "string" && ticker.trim() ? ticker.trim() : null;
  }, [activeAnalysisTask]);
  const hasChatAccess = Boolean(
    !authLoading && user?.uid && isVaultUnlocked && vaultOwnerToken && tokenIsFresh
  );
  const availablePersonas = useMemo(() => {
    const personas = new Set<typeof activePersona>([activePersona]);
    if (riaSwitchAvailable) personas.add("ria");
    personas.add(primaryNavPersona);
    return Array.from(personas);
  }, [activePersona, primaryNavPersona, riaSwitchAvailable]);
  const appRuntimeState = useMemo<AppRuntimeState>(
    () => ({
      auth: {
        signed_in: Boolean(user?.uid),
        user_id: user?.uid ?? null,
      },
      vault: {
        unlocked: isVaultUnlocked,
        token_available: Boolean(vaultOwnerToken),
        token_valid: tokenIsFresh,
      },
      route: {
        pathname: pathnameWithQuery,
        screen: routeInfo.screen,
        subview: routeInfo.subview ?? null,
      },
      runtime: {
        analysis_active:
          Boolean(busyOperations["stock_analysis_active"]) ||
          Boolean(busyOperations["stock_analysis_stream"]) ||
          Boolean(activeAnalysisTask),
        analysis_ticker: activeAnalysisTicker || analysisParams?.ticker || null,
        analysis_run_id: activeAnalysisTask?.taskId || null,
        import_active:
          Boolean(busyOperations["portfolio_import_stream"]) || Boolean(runningImportTask),
        import_run_id: runningImportTask?.taskId || null,
        busy_operations: Object.keys(busyOperations).filter((key) => busyOperations[key]),
      },
      portfolio: {
        has_portfolio_data: hasPortfolioData,
      },
      persona: {
        active: activePersona,
        primary_nav: primaryNavPersona,
        available: availablePersonas,
        transition_target: personaTransitionTarget,
        ria_switch_available: riaSwitchAvailable,
        ria_setup_available: riaSetupAvailable,
      },
      voice: {
        available: false,
        tts_playing: voiceActive,
        last_tool_name: null,
        last_ticker: null,
      },
    }),
    [
      activePersona,
      activeAnalysisTask,
      activeAnalysisTicker,
      analysisParams,
      availablePersonas,
      busyOperations,
      hasPortfolioData,
      isVaultUnlocked,
      pathnameWithQuery,
      personaTransitionTarget,
      primaryNavPersona,
      riaSetupAvailable,
      riaSwitchAvailable,
      runningImportTask,
      routeInfo.screen,
      routeInfo.subview,
      tokenIsFresh,
      user?.uid,
      vaultOwnerToken,
      voiceActive,
    ]
  );
  const appRuntimeStateRef = useRef(appRuntimeState);
  useEffect(() => {
    appRuntimeStateRef.current = appRuntimeState;
  }, [appRuntimeState]);
  const canSend =
    hasChatAccess &&
    !isChatLoading &&
    !isLoadingHistory &&
    !isVoiceConnecting &&
    !isStreaming &&
    !voiceActive &&
    input.trim().length > 0;
  const canToggleVoice = hasChatAccess && (!isVoiceConnecting || voiceActive);
  const historyInteractionDisabled =
    isLoadingHistory ||
    isChatLoading ||
    isToolWorking ||
    isVoiceConnecting ||
    isStreaming ||
    voiceActive;
  const statusText = useMemo(
    () => {
      if (authLoading) return "Checking access";
      if (!user?.uid) return "Sign in required";
      if (!isVaultUnlocked || !vaultOwnerToken || !tokenIsFresh) return "Vault locked";
      if (voiceState === "connecting") return "Voice connecting";
      if (voiceState === "listening") return "Listening";
      if (voiceState === "thinking") return "Thinking";
      if (voiceState === "speaking") return "Speaking";
      if (isLoadingHistory) return "Loading";
      if (isVoiceConnecting) return "Voice connecting";
      if (isToolWorking) return "Working";
      if (isPkmMemoryWorking) return "Saving memory";
      if (isChatLoading) return "Thinking";
      if (isStreaming) return "Streaming";
      return "Ready";
    },
    [
      authLoading,
      isChatLoading,
      isLoadingHistory,
      isPkmMemoryWorking,
      isToolWorking,
      isStreaming,
      isVoiceConnecting,
      isVaultUnlocked,
      tokenIsFresh,
      user?.uid,
      vaultOwnerToken,
      voiceState,
    ]
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, pkmReviews]);

  useEffect(() => {
    return () => {
      abortAgentTurnWork();
      voiceClientRef.current?.close();
      voiceClientRef.current = null;
    };
  }, [abortAgentTurnWork]);

  useEffect(() => {
    const unsubscribe = AppBackgroundTaskService.subscribe((state) => {
      setBackgroundTaskState(state);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user?.uid) {
      setHasPortfolioData(false);
      return;
    }

    const cache = CacheService.getInstance();
    const computeHasPortfolioData = () => {
      const cachedPortfolio =
        cache.get<Record<string, unknown>>(CACHE_KEYS.PORTFOLIO_DATA(user.uid)) ??
        cache.get<Record<string, unknown>>(CACHE_KEYS.DOMAIN_DATA(user.uid, "financial"));
      const nestedPortfolio =
        cachedPortfolio?.portfolio &&
        typeof cachedPortfolio.portfolio === "object" &&
        !Array.isArray(cachedPortfolio.portfolio)
          ? (cachedPortfolio.portfolio as Record<string, unknown>)
          : null;
      const holdings =
        (Array.isArray(cachedPortfolio?.holdings) && cachedPortfolio.holdings) ||
        (Array.isArray(nestedPortfolio?.holdings) && nestedPortfolio.holdings) ||
        [];
      setHasPortfolioData(holdings.length > 0);
    };

    computeHasPortfolioData();
    const unsubscribe = cache.subscribe((event) => {
      if (
        event.type === "set" ||
        event.type === "invalidate" ||
        event.type === "invalidate_user" ||
        event.type === "clear"
      ) {
        computeHasPortfolioData();
      }
    });
    return () => unsubscribe();
  }, [user?.uid]);

  useEffect(() => {
    abortAgentTurnWork();
    voiceClientRef.current?.close();
    voiceClientRef.current = null;
    setIsChatLoading(false);
    setIsLoadingHistory(false);
    setIsVoiceConnecting(false);
    setIsStreaming(false);
    setActiveFrontendToolCount(0);
    setActivePkmToolCount(0);
    setDebugEvents([]);
    setLatestDebugTurnId(null);
    setPkmReviews([]);
    setPkmActivity([]);
    setVoiceState("idle");
    setConversationId(null);
    setConversations([]);
    setHistoryActionPendingId(null);
    setMessages([createGreetingMessage()]);
    historyLoadKeyRef.current = null;
    latestVisibleTurnIdRef.current = null;
    voiceUserMessageIdRef.current = null;
    voiceAssistantMessageIdRef.current = null;
  }, [abortAgentTurnWork, user?.uid, isVaultUnlocked]);

  const updateMessage = (
    messageId: string,
    update: (message: AgentMessage) => AgentMessage
  ) => {
    setMessages((current) =>
      current.map((message) => (message.id === messageId ? update(message) : message))
    );
  };

  const appendMessage = (message: AgentMessage) => {
    setMessages((current) => [...current, message]);
  };

  const appendDebugEvent = useCallback(
    (turnId: string, event: string, payload: unknown) => {
      setDebugEvents((current) => [
        ...current.slice(-79),
        {
          id: `${turnId}-${event}-${Date.now()}-${current.length}`,
          turnId,
          timestamp: new Date().toISOString(),
          event,
          payload,
        },
      ]);
    },
    []
  );

  const latestDebugEvents = useMemo(
    () =>
      latestDebugTurnId
        ? debugEvents.filter((event) => event.turnId === latestDebugTurnId)
        : [],
    [debugEvents, latestDebugTurnId]
  );

  const handleCopyLatestDebug = useCallback(() => {
    if (!latestDebugTurnId || latestDebugEvents.length === 0) return;
    const payload = {
      turn_id: latestDebugTurnId,
      events: latestDebugEvents,
    };
    void navigator.clipboard
      .writeText(JSON.stringify(payload, null, 2))
      .then(() => toast.success("Agent debug copied."))
      .catch(() => toast.error("Could not copy Agent debug."));
  }, [latestDebugEvents, latestDebugTurnId]);

  const addErrorMessage = (text: string) => {
    appendMessage({
      id: `msg-${Date.now()}-assistant-error`,
      role: "assistant",
      text,
      timestamp: formatNow(),
      status: "error",
    });
  };

  useEffect(() => {
    if (!hasChatAccess || !user?.uid || !vaultOwnerToken) return;
    const loadKey = `${user.uid}:${vaultOwnerToken.slice(0, 12)}`;
    if (historyLoadKeyRef.current === loadKey) return;
    historyLoadKeyRef.current = loadKey;
    let cancelled = false;

    const loadRecentConversation = async () => {
      setIsLoadingHistory(true);
      try {
        const conversations = await listAgentChatConversations({
          userId: user.uid,
          vaultOwnerToken,
          limit: 20,
        });
        if (cancelled) return;
        setConversations(conversations);
        const latest = conversations[0];
        if (!latest) {
          setConversationId(null);
          setMessages([createGreetingMessage()]);
          return;
        }
        const history = await getAgentChatHistory({
          conversationId: latest.id,
          vaultOwnerToken,
          limit: 50,
        });
        if (cancelled) return;
        const restored = history
          .map(storedMessageToAgentMessage)
          .filter((message): message is AgentMessage => Boolean(message));
        setConversationId(latest.id);
        setMessages(restored.length > 0 ? restored : [createGreetingMessage()]);
      } catch {
        if (!cancelled) {
          historyLoadKeyRef.current = null;
        }
      } finally {
        if (!cancelled) {
          setIsLoadingHistory(false);
        }
      }
    };

    void loadRecentConversation();
    return () => {
      cancelled = true;
    };
  }, [hasChatAccess, user?.uid, vaultOwnerToken]);

  const restoreConversationMessages = useCallback(
    async (nextConversationId: string, token: string) => {
      const history = await getAgentChatHistory({
        conversationId: nextConversationId,
        vaultOwnerToken: token,
        limit: 50,
      });
      const restored = history
        .map(storedMessageToAgentMessage)
        .filter((message): message is AgentMessage => Boolean(message));
      latestVisibleTurnIdRef.current = null;
      setConversationId(nextConversationId);
      setMessages(restored.length > 0 ? restored : [createGreetingMessage()]);
      setPkmActivity([]);
      setDebugEvents([]);
      setLatestDebugTurnId(null);
      setPkmReviews([]);
    },
    []
  );

  const loadConversationList = useCallback(async () => {
    if (!user?.uid) return [];
    const token = getVaultOwnerToken();
    if (!token) return [];
    const nextConversations = await listAgentChatConversations({
      userId: user.uid,
      vaultOwnerToken: token,
      limit: 20,
    });
    setConversations(nextConversations);
    return nextConversations;
  }, [getVaultOwnerToken, user?.uid]);

  const handleCreateNewChat = useCallback(() => {
    abortAgentTurnWork();
    latestVisibleTurnIdRef.current = null;
    setConversationId(null);
    setMessages([createGreetingMessage()]);
    setInput("");
    setDebugEvents([]);
    setLatestDebugTurnId(null);
    setPkmReviews([]);
    setPkmActivity([]);
  }, [abortAgentTurnWork]);

  const handleSelectConversation = useCallback(
    async (nextConversationId: string) => {
      if (nextConversationId === conversationId || historyInteractionDisabled) return;
      const token = getVaultOwnerToken();
      if (!token) {
        toast.error("Vault access expired. Unlock again to continue.");
        return;
      }
      abortAgentTurnWork();
      setIsLoadingHistory(true);
      try {
        await restoreConversationMessages(nextConversationId, token);
      } catch {
        toast.error("Could not load Agent chat.");
      } finally {
        setIsLoadingHistory(false);
      }
    },
    [
      conversationId,
      abortAgentTurnWork,
      getVaultOwnerToken,
      historyInteractionDisabled,
      restoreConversationMessages,
    ]
  );

  const handleRenameConversation = useCallback(
    async (targetConversationId: string, title: string) => {
      const token = getVaultOwnerToken();
      if (!token) {
        toast.error("Vault access expired. Unlock again to continue.");
        return;
      }
      setHistoryActionPendingId(targetConversationId);
      try {
        const renamed = await renameAgentChatConversation({
          conversationId: targetConversationId,
          title,
          vaultOwnerToken: token,
        });
        setConversations((current) =>
          current.map((conversation) =>
            conversation.id === targetConversationId ? renamed : conversation
          )
        );
        void loadConversationList().catch(() => undefined);
        toast.success("Agent chat renamed.");
      } catch {
        toast.error("Could not rename Agent chat.");
      } finally {
        setHistoryActionPendingId(null);
      }
    },
    [getVaultOwnerToken, loadConversationList]
  );

  const handleDeleteConversation = useCallback(
    async (targetConversationId: string) => {
      if (historyInteractionDisabled) return;
      const token = getVaultOwnerToken();
      if (!token || !user?.uid) {
        toast.error("Vault access expired. Unlock again to continue.");
        return;
      }
      if (conversationId === targetConversationId) {
        abortAgentTurnWork();
      }
      setHistoryActionPendingId(targetConversationId);
      try {
        await deleteAgentChatConversation({
          conversationId: targetConversationId,
          vaultOwnerToken: token,
        });
        const nextConversations = await listAgentChatConversations({
          userId: user.uid,
          vaultOwnerToken: token,
          limit: 20,
        });
        setConversations(nextConversations);
        if (conversationId === targetConversationId) {
          const nextConversation = nextConversations[0];
          if (nextConversation) {
            await restoreConversationMessages(nextConversation.id, token);
          } else {
            handleCreateNewChat();
          }
        }
        toast.success("Agent chat deleted.");
      } catch {
        toast.error("Could not delete Agent chat.");
      } finally {
        setHistoryActionPendingId(null);
      }
    },
    [
      conversationId,
      abortAgentTurnWork,
      getVaultOwnerToken,
      handleCreateNewChat,
      historyInteractionDisabled,
      restoreConversationMessages,
      user?.uid,
    ]
  );

  const handleDismissPkmReview = useCallback(
    (reviewId: string) => {
      const review = pkmReviews.find((item) => item.id === reviewId);
      if (review) {
        appendDebugEvent(review.turnId, "pkm_review_dismissed", {
          review_id: review.id,
          candidate_count: review.cards.length,
        });
      }
      setPkmReviews((current) => current.filter((item) => item.id !== reviewId));
    },
    [appendDebugEvent, pkmReviews]
  );

  const handleSavePkmReview = useCallback(
    async (reviewId: string) => {
      const review = pkmReviews.find((item) => item.id === reviewId);
      const token = getVaultOwnerToken();
      if (!review || !user?.uid || !vaultKey || !token) {
        toast.error("Unlock your vault before saving to PKM.");
        return;
      }

      setPkmReviews((current) =>
        current.map((item) => (item.id === reviewId ? { ...item, saving: true } : item))
      );
      setActivePkmToolCount((count) => count + 1);
      appendDebugEvent(review.turnId, "pkm_review_save_start", {
        review_id: review.id,
        candidate_count: review.cards.length,
      });

      try {
        const result = await addToPKM({
          userId: user.uid,
          cards: review.cards,
          sourceMessage: review.sourceMessage,
          vaultKey,
          vaultOwnerToken: token,
          source: "agent_chat_review",
        });
        appendDebugEvent(review.turnId, "pkm_review_save_result", result);
        if (result.saved > 0) {
          setPkmActivity((current) => [
            ...current.slice(-4),
            {
              id: `pkm-review-saved-${Date.now()}`,
              text: formatAgentPkmSaveSummary(result),
              status: "done",
            },
          ]);
          setPkmReviews((current) => current.filter((item) => item.id !== reviewId));
          void loadAgentPkmContext({
            userId: user.uid,
            vaultOwnerToken: token,
            vaultKey,
            forceRefresh: true,
          }).catch(() => undefined);
          toast.success("Saved to PKM.");
          return;
        }

        setPkmReviews((current) =>
          current.map((item) => (item.id === reviewId ? { ...item, saving: false } : item))
        );
        toast.error(formatAgentPkmSaveSummary(result));
      } catch (error) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : "Failed to save PKM memory.";
        appendDebugEvent(review.turnId, "pkm_review_save_failed", { message });
        setPkmReviews((current) =>
          current.map((item) => (item.id === reviewId ? { ...item, saving: false } : item))
        );
        toast.error(message);
      } finally {
        setActivePkmToolCount((count) => Math.max(0, count - 1));
      }
    },
    [appendDebugEvent, getVaultOwnerToken, pkmReviews, user?.uid, vaultKey]
  );

  const ensureVoiceUserMessage = () => {
    if (voiceUserMessageIdRef.current) return voiceUserMessageIdRef.current;
    const id = `msg-${Date.now()}-voice-user`;
    voiceUserMessageIdRef.current = id;
    appendMessage({
      id,
      role: "user",
      text: "",
      timestamp: formatNow(),
      status: "streaming",
    });
    return id;
  };

  const ensureVoiceAssistantMessage = () => {
    if (voiceAssistantMessageIdRef.current) return voiceAssistantMessageIdRef.current;
    const id = `msg-${Date.now()}-voice-assistant`;
    voiceAssistantMessageIdRef.current = id;
    appendMessage({
      id,
      role: "assistant",
      text: "",
      timestamp: formatNow(),
      status: "streaming",
    });
    return id;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = input.trim();
    if (!text || !hasChatAccess || !user?.uid) return;

    const userId = user.uid;
    const token = getVaultOwnerToken();
    const timestamp = formatNow();
    const turnId = Date.now();
    const debugTurnId = `agent_turn_${turnId}`;
    const assistantMessageId = `msg-${turnId}-assistant`;
    const executedToolCalls = new Set<string>();
    let toolStatusMessageId: string | null = null;
    let pkmStatusItemId: string | null = null;
    let assistantHasToken = false;
    let turnPkmContext = EMPTY_PKM_CONTEXT;
    let pkmAddToolHandled = false;
    let pendingAssistantDelta = "";
    let assistantFlushFrame: number | null = null;

    const flushAssistantDelta = () => {
      assistantFlushFrame = null;
      const delta = pendingAssistantDelta;
      pendingAssistantDelta = "";
      if (!delta) return;
      assistantHasToken = true;
      updateMessage(assistantMessageId, (message) => ({
        ...message,
        text: message.ephemeral ? delta : `${message.text}${delta}`,
        status: "streaming",
        ephemeral: false,
      }));
    };

    const queueAssistantDelta = (delta: string) => {
      pendingAssistantDelta += delta;
      if (assistantFlushFrame !== null) return;
      assistantFlushFrame = window.requestAnimationFrame(flushAssistantDelta);
    };

    const cancelAssistantFlush = () => {
      if (assistantFlushFrame !== null) {
        window.cancelAnimationFrame(assistantFlushFrame);
        assistantFlushFrame = null;
      }
      pendingAssistantDelta = "";
    };

    const upsertToolStatusMessage = (
      messageText: string,
      status: AgentMessage["status"] = "streaming"
    ) => {
      const cleanText = messageText.trim() || "Working on that in Kai...";
      if (toolStatusMessageId) {
        if (toolStatusMessageId === assistantMessageId && assistantHasToken) {
          toolStatusMessageId = `msg-${turnId}-tool-status`;
          appendMessage({
            id: toolStatusMessageId,
            role: "assistant",
            text: cleanText,
            timestamp: formatNow(),
            status,
            ephemeral: true,
          });
          return;
        }
        updateMessage(toolStatusMessageId, (message) => ({
          ...message,
          text: cleanText,
          status,
          ephemeral: true,
        }));
        return;
      }
      if (assistantHasToken) {
        toolStatusMessageId = `msg-${turnId}-tool-status`;
        appendMessage({
          id: toolStatusMessageId,
          role: "assistant",
          text: cleanText,
          timestamp: formatNow(),
          status,
          ephemeral: true,
        });
        return;
      }
      toolStatusMessageId = assistantMessageId;
      updateMessage(assistantMessageId, (message) => ({
        ...message,
        text: cleanText,
        status,
        ephemeral: true,
      }));
    };

    const upsertPkmStatusMessage = (
      messageText: string,
      status: AgentPkmActivity["status"] = "streaming"
    ) => {
      if (latestVisibleTurnIdRef.current !== debugTurnId) return;
      const cleanText = messageText.trim();
      if (!cleanText) {
        if (pkmStatusItemId) {
          setPkmActivity((current) => current.filter((item) => item.id !== pkmStatusItemId));
          pkmStatusItemId = null;
        }
        return;
      }
      if (pkmStatusItemId) {
        setPkmActivity((current) =>
          current.map((item) =>
            item.id === pkmStatusItemId
              ? {
                  ...item,
                  text: cleanText,
                  status,
                }
              : item
          )
        );
        return;
      }
      const nextStatusItemId = `pkm-status-${turnId}`;
      pkmStatusItemId = nextStatusItemId;
      setPkmActivity((current) => [
        ...current.slice(-4),
        {
          id: nextStatusItemId,
          text: cleanText,
          status,
        },
      ]);
    };

    const toolResultStatus = (result: AgentActionRuntimeResult): AgentMessage["status"] => {
      if (result.status === "blocked" || result.status === "failed" || result.status === "invalid") {
        return "error";
      }
      return "done";
    };

    const executePkmAddTool = async (toolEvent: AgentChatToolEvent) => {
      if (!vaultKey || !token) {
        appendDebugEvent(debugTurnId, "pkm_tool_skipped", {
          reason: !vaultKey ? "vault_key_unavailable" : "vault_owner_token_unavailable",
          tool: toolEvent,
        });
        upsertPkmStatusMessage("Unlock your vault before saving to PKM.", "error");
        return;
      }

      const sourceText =
        typeof toolEvent.slots.source_text === "string" && toolEvent.slots.source_text.trim()
          ? toolEvent.slots.source_text.trim()
          : text;

      setActivePkmToolCount((count) => count + 1);
      appendDebugEvent(debugTurnId, "pkm_tool_preview_start", {
        tool: "pkm.add",
        current_domains: turnPkmContext.domains,
        source_text: sourceText,
      });
      upsertPkmStatusMessage("Checking PKM and saving what fits...", "streaming");

      try {
        const preview = await previewAgentPkmMemory({
          userId,
          message: sourceText,
          currentDomains: turnPkmContext.domains,
          vaultOwnerToken: token,
        });
        const autoSaveCards = getAutoSavePkmCards(preview.cards);
        const reviewCards = getReviewRequiredPkmCards(preview.cards);
        const ignoredCards = getIgnoredPkmCards(preview.cards);

        appendDebugEvent(debugTurnId, "pkm_tool_preview_result", {
          model: preview.model,
          used_fallback: preview.used_fallback,
          total_cards: preview.cards.length,
          auto_save_count: autoSaveCards.length,
          review_count: reviewCards.length,
          ignored_count: ignoredCards.length,
          preview_summary: preview.preview_summary || null,
          cards: preview.cards,
        });

        if (autoSaveCards.length > 0) {
          appendDebugEvent(debugTurnId, "pkm_tool_save_start", {
            candidate_count: autoSaveCards.length,
          });
          const saveResult = await addToPKM({
            userId,
            cards: autoSaveCards,
            sourceMessage: sourceText,
            vaultKey,
            vaultOwnerToken: token,
            source: "agent_chat_tool",
          });
          appendDebugEvent(debugTurnId, "pkm_tool_save_result", saveResult);
          upsertPkmStatusMessage(
            formatAgentPkmSaveSummary(saveResult),
            saveResult.saved > 0 ? "done" : "error"
          );
          if (saveResult.saved > 0) {
            void loadAgentPkmContext({
              userId,
              vaultOwnerToken: token,
              vaultKey,
              forceRefresh: true,
            }).catch(() => undefined);
            toast.success("Saved to PKM.");
          }
        }

        if (reviewCards.length > 0 && latestVisibleTurnIdRef.current === debugTurnId) {
          setPkmReviews((current) => [
            ...current.filter((review) => review.turnId !== debugTurnId),
            {
              id: `${debugTurnId}-pkm-review`,
              turnId: debugTurnId,
              sourceMessage: sourceText,
              cards: reviewCards,
              saving: false,
            },
          ]);
          appendDebugEvent(debugTurnId, "pkm_tool_review_required", {
            candidate_count: reviewCards.length,
            cards: reviewCards,
          });
          if (autoSaveCards.length === 0) {
            upsertPkmStatusMessage(
              "Agent found PKM memory that needs your review before saving.",
              "done"
            );
          }
        }

        if (autoSaveCards.length === 0 && reviewCards.length === 0) {
          upsertPkmStatusMessage("I didn't find durable PKM memory to save from that.", "done");
        }
      } catch (error) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : "Agent could not save that PKM memory.";
        appendDebugEvent(debugTurnId, "pkm_tool_failed", {
          message,
          tool: toolEvent,
        });
        upsertPkmStatusMessage("Agent could not save that PKM memory.", "error");
      } finally {
        setActivePkmToolCount((count) => Math.max(0, count - 1));
      }
    };

    const executeFrontendTool = async (toolEvent: AgentChatToolEvent) => {
      if (!toolEvent.actionId) return;
      appendDebugEvent(debugTurnId, "frontend_execute_start", toolEvent);

      if (toolEvent.actionId === "pkm.add") {
        pkmAddToolHandled = true;
        await executePkmAddTool(toolEvent);
        return;
      }

      setActiveFrontendToolCount((count) => count + 1);
      try {
        const result = await executeAgentGatewayAction({
          actionId: toolEvent.actionId,
          slots: toolEvent.slots,
          userId,
          router,
          appRuntimeState: appRuntimeStateRef.current,
          surfaceMetadata: getVoiceSurfaceMetadata(),
          hasPortfolioData,
          busyOperations,
          setAnalysisParams,
        });
        appendDebugEvent(debugTurnId, "tool_result", result);
        upsertToolStatusMessage(result.resultSummary, toolResultStatus(result));
        if (shouldMinimizeForNavigationResult(result)) {
          onNavigationActionComplete?.(result);
        }
      } catch (error) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : "Agent tool execution failed.";
        appendDebugEvent(debugTurnId, "tool_result", {
          status: "failed",
          message,
          tool: toolEvent,
        });
        upsertToolStatusMessage(message, "error");
      } finally {
        setActiveFrontendToolCount((count) => Math.max(0, count - 1));
      }
    };

    const executeToolIfNeeded = (toolEvent: AgentChatToolEvent) => {
      const callKey = toolEvent.callId || `${toolEvent.actionId || "unknown"}-${turnId}`;
      if (executedToolCalls.has(callKey)) return;
      if (toolEvent.execution !== "frontend" || !toolEvent.actionId) return;
      executedToolCalls.add(callKey);
      void executeFrontendTool(toolEvent);
    };

    const runPkmMemoryCapture = async (
      pkmContext: AgentPkmContext,
      signal: AbortSignal
    ) => {
      if (signal.aborted) return;
      if (!vaultKey || !token) {
        appendDebugEvent(debugTurnId, "pkm_memory_skipped", {
          reason: !vaultKey ? "vault_key_unavailable" : "vault_owner_token_unavailable",
        });
        return;
      }

      setActivePkmToolCount((count) => count + 1);
      appendDebugEvent(debugTurnId, "pkm_memory_preview_start", {
        tool: "addToPKM",
        execution: "frontend",
        current_domains: pkmContext.domains,
      });
      upsertPkmStatusMessage("Checking whether this belongs in PKM...", "streaming");

      try {
        const preview = await previewAgentPkmMemory({
          userId,
          message: text,
          currentDomains: pkmContext.domains,
          vaultOwnerToken: token,
        });
        if (signal.aborted) return;
        const cards = preview.cards;
        const autoSaveCards = getAutoSavePkmCards(cards);
        const reviewCards = getReviewRequiredPkmCards(cards);
        const ignoredCards = getIgnoredPkmCards(cards);

        appendDebugEvent(debugTurnId, "pkm_memory_preview_result", {
          model: preview.model,
          used_fallback: preview.used_fallback,
          total_cards: cards.length,
          auto_save_count: autoSaveCards.length,
          review_count: reviewCards.length,
          ignored_count: ignoredCards.length,
          preview_summary: preview.preview_summary || null,
          cards,
        });

        if (autoSaveCards.length > 0) {
          upsertPkmStatusMessage("Saving durable memory to PKM...", "streaming");
          appendDebugEvent(debugTurnId, "pkm_memory_save_start", {
            candidate_count: autoSaveCards.length,
          });
          const saveResult = await addToPKM({
            userId,
            cards: autoSaveCards,
            sourceMessage: text,
            vaultKey,
            vaultOwnerToken: token,
            source: "agent_chat_auto",
          });
          if (signal.aborted) return;
          appendDebugEvent(debugTurnId, "pkm_memory_save_result", saveResult);
          upsertPkmStatusMessage(
            formatAgentPkmSaveSummary(saveResult),
            saveResult.saved > 0 ? "done" : "error"
          );
          if (saveResult.saved > 0) {
            void loadAgentPkmContext({
              userId,
              vaultOwnerToken: token,
              vaultKey,
              forceRefresh: true,
            }).catch(() => undefined);
          }
        }

        if (reviewCards.length > 0 && latestVisibleTurnIdRef.current === debugTurnId) {
          if (signal.aborted) return;
          setPkmReviews((current) => [
            ...current.filter((review) => review.turnId !== debugTurnId),
            {
              id: `${debugTurnId}-pkm-review`,
              turnId: debugTurnId,
              sourceMessage: text,
              cards: reviewCards,
              saving: false,
            },
          ]);
          appendDebugEvent(debugTurnId, "pkm_memory_review_required", {
            candidate_count: reviewCards.length,
            cards: reviewCards,
          });
          if (autoSaveCards.length === 0) {
            upsertPkmStatusMessage(
              "Agent found PKM memory that needs your review before saving.",
              "done"
            );
          }
        }

        if (autoSaveCards.length === 0 && reviewCards.length === 0) {
          upsertPkmStatusMessage("", "done");
        }
      } catch (error) {
        if (signal.aborted) return;
        const message =
          error instanceof Error && error.message
            ? error.message
            : "Agent could not update PKM memory for this turn.";
        appendDebugEvent(debugTurnId, "pkm_memory_failed", {
          message,
        });
        upsertPkmStatusMessage("Agent could not update PKM memory for this turn.", "error");
      } finally {
        setActivePkmToolCount((count) => Math.max(0, count - 1));
      }
    };

    setMessages((current) => [
      ...current,
      {
        id: `msg-${turnId}-user`,
        role: "user",
        text,
        timestamp,
      },
      {
        id: assistantMessageId,
        role: "assistant",
        text: "",
        timestamp,
        status: "streaming",
      },
    ]);
    setInput("");
    latestVisibleTurnIdRef.current = debugTurnId;
    setPkmActivity([]);
    setIsChatLoading(true);
    setIsStreaming(true);
    setLatestDebugTurnId(debugTurnId);

    if (!token) {
      updateMessage(assistantMessageId, (message) => ({
        ...message,
        text: "Vault access expired. Unlock again to continue.",
        status: "error",
      }));
      setIsChatLoading(false);
      setIsStreaming(false);
      return;
    }

    const streamAbortController = new AbortController();
    streamAbortControllerRef.current?.abort();
    streamAbortControllerRef.current = streamAbortController;

    try {
      let agentPkmContext = EMPTY_PKM_CONTEXT;
      try {
        agentPkmContext = await loadAgentPkmContext({
          userId,
          vaultOwnerToken: token,
          vaultKey,
          message: text,
        });
        turnPkmContext = agentPkmContext;
        if (streamAbortController.signal.aborted) return;
        if (agentPkmContext.text) {
          appendDebugEvent(debugTurnId, "pkm_context_loaded", {
            domain_count: agentPkmContext.domains.length,
            total_attributes: agentPkmContext.totalAttributes,
            detail_count: agentPkmContext.detailCount || 0,
            source: agentPkmContext.source || "metadata",
            mode: agentPkmContext.mode || "summary",
            updated_at: agentPkmContext.updatedAt,
          });
        }
      } catch (error) {
        appendDebugEvent(debugTurnId, "pkm_context_load_failed", {
          message:
            error instanceof Error && error.message
              ? error.message
              : "Failed to load compact PKM context.",
        });
      }

      await streamAgentChat({
        userId,
        message: text,
        conversationId,
        vaultOwnerToken: token,
        pkmContext: agentPkmContext.text || undefined,
        signal: streamAbortController.signal,
        handlers: {
          onStart: ({ conversationId: nextConversationId }) => {
            if (streamAbortController.signal.aborted) return;
            if (nextConversationId) {
              setConversationId(nextConversationId);
            }
          },
          onToolStart: (toolEvent) => {
            if (streamAbortController.signal.aborted) return;
            appendDebugEvent(debugTurnId, "tool_start", toolEvent);
          },
          onToolWaiting: (toolEvent) => {
            if (streamAbortController.signal.aborted) return;
            appendDebugEvent(debugTurnId, "tool_waiting", toolEvent);
            upsertToolStatusMessage(
              toolEvent.message || "Working on that in Kai...",
              "streaming"
            );
            executeToolIfNeeded(toolEvent);
          },
          onToolResult: (toolEvent) => {
            if (streamAbortController.signal.aborted) return;
            appendDebugEvent(debugTurnId, "tool_result", toolEvent);
            if (toolEvent.execution === "blocked" || toolEvent.status === "blocked") {
              upsertToolStatusMessage(
                toolEvent.message || "That action is blocked in Agent.",
                "error"
              );
            }
          },
          onToken: (delta) => {
            if (streamAbortController.signal.aborted) return;
            queueAssistantDelta(delta);
          },
          onComplete: ({ conversationId: nextConversationId }) => {
            if (streamAbortController.signal.aborted) return;
            flushAssistantDelta();
            if (nextConversationId) {
              setConversationId(nextConversationId);
            }
            updateMessage(assistantMessageId, (message) => ({
              ...message,
              status: "done",
            }));
            setIsChatLoading(false);
            setIsStreaming(false);
          },
          onError: (message) => {
            if (streamAbortController.signal.aborted) return;
            flushAssistantDelta();
            updateMessage(assistantMessageId, (current) => ({
              ...current,
              text: current.text || message,
              status: "error",
            }));
            setIsChatLoading(false);
            setIsStreaming(false);
          },
        },
      });
      if (streamAbortController.signal.aborted) return;
      flushAssistantDelta();
      updateMessage(assistantMessageId, (message) => {
        if (message.status === "error") return message;
        return {
          ...message,
          text: message.text || "I couldn't generate a response. Please try again.",
          status: "done",
        };
      });
      if (!pkmAddToolHandled && !EXPLICIT_PKM_SAVE_PATTERN.test(text)) {
        const pkmAbortController = new AbortController();
        pkmAbortControllersRef.current.add(pkmAbortController);
        void runPkmMemoryCapture(turnPkmContext, pkmAbortController.signal).finally(() => {
          pkmAbortControllersRef.current.delete(pkmAbortController);
        });
      }
      void loadConversationList().catch(() => undefined);
      setIsChatLoading(false);
      setIsStreaming(false);
    } catch (error) {
      if (streamAbortController.signal.aborted) return;
      flushAssistantDelta();
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Agent chat request failed.";
      updateMessage(assistantMessageId, (current) => ({
        ...current,
        text: current.text || message,
        status: "error",
      }));
      void loadConversationList().catch(() => undefined);
      setIsChatLoading(false);
      setIsStreaming(false);
    } finally {
      cancelAssistantFlush();
      if (streamAbortControllerRef.current === streamAbortController) {
        streamAbortControllerRef.current = null;
      }
    }
  };

  const handleToggleVoice = async () => {
    if (!hasChatAccess || !user?.uid) return;

    if (voiceActive) {
      await voiceClientRef.current?.stopMicrophone();
      return;
    }

    const token = getVaultOwnerToken();
    if (!token) {
      addErrorMessage("Vault access expired. Unlock again to continue.");
      return;
    }

    voiceUserMessageIdRef.current = null;
    voiceAssistantMessageIdRef.current = null;
    setIsVoiceConnecting(true);
    setVoiceState("connecting");

    try {
      if (!voiceClientRef.current) {
        voiceClientRef.current = new AgentRealtimeClient();
      }
      await voiceClientRef.current.connect({
        userId: user.uid,
        vaultOwnerToken: token,
      });
      await voiceClientRef.current.startMicrophone({
        onInputTranscriptDelta: (delta) => {
          const id = ensureVoiceUserMessage();
          updateMessage(id, (message) => ({
            ...message,
            text: `${message.text}${delta}`,
            status: "streaming",
          }));
        },
        onInputTranscriptDone: (text) => {
          const cleanText = text.trim();
          if (!cleanText) return;
          const id = ensureVoiceUserMessage();
          updateMessage(id, (message) => ({
            ...message,
            text: cleanText || message.text,
            status: "done",
          }));
        },
        onResponseStart: () => {
          setIsStreaming(true);
          ensureVoiceAssistantMessage();
        },
        onResponseDelta: (delta) => {
          const id = ensureVoiceAssistantMessage();
          updateMessage(id, (message) => ({
            ...message,
            text: `${message.text}${delta}`,
            status: "streaming",
          }));
        },
        onResponseDone: (text) => {
          const id = ensureVoiceAssistantMessage();
          updateMessage(id, (message) => ({
            ...message,
            text: text.trim() || message.text,
            status: "done",
          }));
          setIsStreaming(false);
          voiceUserMessageIdRef.current = null;
          voiceAssistantMessageIdRef.current = null;
        },
        onVoiceState: (state) => {
          setVoiceState(state);
        },
        onError: (message) => {
          addErrorMessage(message);
          setIsVoiceConnecting(false);
          setIsStreaming(false);
        },
      });
      setIsVoiceConnecting(false);
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Voice session failed.";
      addErrorMessage(message);
      setIsVoiceConnecting(false);
      setIsStreaming(false);
      setVoiceState("idle");
      voiceClientRef.current?.close();
      voiceClientRef.current = null;
    }
  };

  const accessMessage = authLoading
    ? "Checking access..."
    : !user?.uid
      ? "Sign in to use Agent."
      : !isVaultUnlocked || !vaultOwnerToken || !tokenIsFresh
        ? "Unlock your vault to use Agent."
        : null;
  const swipeStartYRef = useRef<number | null>(null);
  const handleHeaderPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!onMinimize || event.pointerType === "mouse") return;
    swipeStartYRef.current = event.clientY;
  };
  const handleHeaderPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!onMinimize || swipeStartYRef.current === null) return;
    const deltaY = event.clientY - swipeStartYRef.current;
    swipeStartYRef.current = null;
    if (deltaY > 72) {
      onMinimize();
    }
  };

  return (
    <div
      className={cn(
        "agent-chat-workspace flex min-h-0 w-full flex-col",
        isPopover ? "h-full overflow-hidden" : "gap-5",
        className
      )}
      data-agent-chat-workspace={variant}
    >
      <div
        className={cn(
          "flex shrink-0 touch-pan-y items-center justify-between gap-4 border-b border-primary/35",
          isPopover ? "px-4 py-3 sm:px-5" : "pb-5"
        )}
        onPointerDown={handleHeaderPointerDown}
        onPointerUp={handleHeaderPointerEnd}
        onPointerCancel={() => {
          swipeStartYRef.current = null;
        }}
      >
        <div className="flex min-w-0 items-center gap-4">
          <div
            className={cn(
              "grid shrink-0 place-items-center rounded-full border border-primary/30 bg-primary/10 text-primary",
              isPopover ? "h-12 w-12" : "h-24 w-16"
            )}
            aria-hidden
          >
            <BriefcaseBusiness className={isPopover ? "h-5 w-5" : "h-6 w-6"} />
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-primary">
              Agent
            </p>
            <h1
              className={cn(
                "font-semibold leading-none text-foreground",
                isPopover ? "mt-1 text-2xl sm:text-3xl" : "mt-3 text-4xl sm:text-5xl"
              )}
            >
              Agent
            </h1>
            <p
              className={cn(
                "mt-2 max-w-2xl text-muted-foreground",
                isPopover ? "text-sm" : "text-base"
              )}
            >
              A Kai-focused chat surface for markets, portfolio, analysis, and consent workflows.
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant={debugOpen ? "secondary" : "outline"}
            size="icon"
            className="h-9 w-9"
            onClick={() => setDebugOpen((current) => !current)}
            aria-label={debugOpen ? "Hide Agent debug" : "Show Agent debug"}
            aria-pressed={debugOpen}
            title={debugOpen ? "Hide Agent debug" : "Show Agent debug"}
          >
            <Bug className="h-4 w-4" />
          </Button>
          <span className="hidden rounded-md border border-border/70 bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground sm:inline-flex">
            {statusText}
          </span>
          {onMinimize ? (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-9 w-9"
              onClick={onMinimize}
              aria-label="Minimize Agent"
              title="Minimize Agent"
            >
              <ChevronDown className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </div>

      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-3 lg:flex-row",
          isPopover ? "overflow-hidden p-3 sm:p-4" : ""
        )}
      >
        <AgentHistorySidebar
          conversations={conversations}
          activeConversationId={conversationId}
          collapsed={isHistorySidebarCollapsed}
          loading={isLoadingHistory && conversations.length === 0}
          disabled={!hasChatAccess || historyInteractionDisabled}
          actionPendingId={historyActionPendingId}
          className={isPopover ? "max-lg:max-h-48 lg:h-full" : undefined}
          onToggleCollapsed={() => setIsHistorySidebarCollapsed((current) => !current)}
          onCreateNew={handleCreateNewChat}
          onSelectConversation={handleSelectConversation}
          onRenameConversation={handleRenameConversation}
          onDeleteConversation={handleDeleteConversation}
        />

        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/70 bg-card shadow-sm">
          <div
            className={cn(
              "min-h-0 flex-1 space-y-5 overflow-y-auto p-4 sm:p-5",
              !isPopover && "max-h-[min(68vh,680px)]"
            )}
          >
            {accessMessage ? (
              <div className="rounded-lg border border-border/70 bg-background px-4 py-5 text-sm text-muted-foreground">
                {accessMessage}
              </div>
            ) : null}

            {debugOpen ? (
              <AgentDebugPanel
                events={latestDebugEvents}
                onCopyLatest={handleCopyLatestDebug}
              />
            ) : null}

            {messages.map((message) => (
              <AgentBubble key={message.id} message={message} />
            ))}

            {pkmActivity.map((item) => (
              <AgentPkmActivityLine key={item.id} item={item} />
            ))}

            {pkmReviews.map((review) => (
              <AgentPkmReviewPanel
                key={review.id}
                cards={review.cards}
                saving={review.saving}
                onSave={() => void handleSavePkmReview(review.id)}
                onDismiss={() => handleDismissPkmReview(review.id)}
              />
            ))}
            <div ref={messagesEndRef} />
          </div>

          <form
            onSubmit={handleSubmit}
            className="flex shrink-0 items-center gap-2 border-t border-border/70 bg-background/80 p-3"
          >
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={
                !hasChatAccess ||
                isLoadingHistory ||
                isVoiceConnecting ||
                voiceActive
              }
              placeholder="Ask Agent about markets, portfolio, analysis..."
              className="h-11 min-w-0 flex-1 rounded-md border border-border/70 bg-background px-4 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/60"
            />
            <Button
              type="button"
              variant={voiceActive ? "secondary" : "outline"}
              size="icon"
              disabled={!canToggleVoice}
              onClick={handleToggleVoice}
              aria-label={voiceActive ? "Stop voice session" : "Start voice session"}
              aria-pressed={voiceActive}
              title={voiceActive ? "Stop voice session" : "Start voice session"}
            >
              {voiceActive ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </Button>
            <Button type="submit" size="icon" disabled={!canSend} aria-label="Send message">
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </section>
      </div>
    </div>
  );
}
