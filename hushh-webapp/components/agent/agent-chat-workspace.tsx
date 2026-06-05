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
  ChevronDown,
  Mic,
  Send,
  UserRound,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/ui/button";
import { AgentHistorySidebar } from "@/components/agent/agent-history-sidebar";
import { AgentPkmReviewPanel } from "@/components/agent/agent-pkm-review-panel";
import { AgentVoiceWaveInput } from "@/components/agent/agent-voice-wave-input";
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
  peekAgentPkmContext,
  previewAgentPkmMemory,
  type AgentPkmContext,
  type AgentPkmPreviewCard,
} from "@/lib/agent/agent-pkm-memory";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { usePersonaState } from "@/lib/persona/persona-context";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import { AppBackgroundTaskService } from "@/lib/services/app-background-task-service";
import {
  AGENT_VOICE_STT_TIMEOUT_MS,
  AgentVoiceClient,
  transcribeAgentVoice,
} from "@/lib/services/agent-voice-client";
import {
  useAgentVoiceState,
  type AgentVoiceStatus,
} from "@/lib/agent/agent-voice-state";
import { handleAgentVoiceTranscriptTurn } from "@/lib/agent/agent-voice-turn";
import { AgentTtsQueue, markdownToSpeechText } from "@/lib/agent/agent-voice-tts";
import {
  AGENT_VOICE_SETTINGS_CHANGED_EVENT,
  isAgentGeminiVoiceEnabled,
  readAgentVoiceSettings,
  type AgentGeminiTtsVoice,
} from "@/lib/agent/agent-voice-settings";
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
import {
  GEMINI_RUNTIME_CREDENTIAL_REF,
  PersonalKnowledgeModelService,
  RUNTIME_CREDENTIAL_MODE_REF,
  type RuntimeCredentialMode,
} from "@/lib/services/personal-knowledge-model-service";
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

type AgentVoiceTranscriptReview = {
  transcript: string;
  reason: string | null;
};

type AgentTurnSource = "typed" | "voice";

export type AgentChatWorkspaceVariant = "page" | "popover";

type AgentChatWorkspaceProps = {
  variant?: AgentChatWorkspaceVariant;
  className?: string;
  onMinimize?: () => void;
  onNavigationActionComplete?: (result: AgentActionRuntimeResult) => void;
};

const AGENT_GREETING =
  "Hey, I'm Agent. Ask me about markets, your portfolio, Kai analysis, or consent workflows.";
const AGENT_GREETING_TIMESTAMP = "Just now";

const EMPTY_PKM_CONTEXT: AgentPkmContext = {
  text: "",
  domains: [],
  totalAttributes: 0,
  updatedAt: null,
};
const AGENT_STREAM_RENDER_FRAME_MS = 32;
const VOICE_PKM_CONTEXT_DEADLINE_MS = 1_800;
const VOICE_AGENT_FIRST_EVENT_TIMEOUT_MS = 25_000;
const VOICE_AGENT_IDLE_TIMEOUT_MS = 45_000;

const EXPLICIT_PKM_SAVE_PATTERN =
  /\b(?:add|save|store|remember)\b[\s\S]{0,140}\b(?:pkm|personal knowledge|memory|memories)\b|\b(?:add|save|store|remember)\s+(?:this|that)\b/i;

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>((resolve) => {
        timeoutId = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

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
    timestamp: AGENT_GREETING_TIMESTAMP,
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
              rel="noopener noreferrer"
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
  const [pkmReviews, setPkmReviews] = useState<AgentPkmReview[]>([]);
  const [pkmActivity, setPkmActivity] = useState<AgentPkmActivity[]>([]);
  const [voiceState, setVoiceState] = useState<AgentVoiceStatus>("idle");
  const [voiceTranscriptReview, setVoiceTranscriptReview] =
    useState<AgentVoiceTranscriptReview | null>(null);
  const [selectedVoice, setSelectedVoice] = useState<AgentGeminiTtsVoice>(() =>
    readAgentVoiceSettings().ttsVoice
  );
  const [hasPortfolioData, setHasPortfolioData] = useState(false);
  const [backgroundTaskState, setBackgroundTaskState] = useState(() =>
    AppBackgroundTaskService.getState()
  );
  const voiceClientRef = useRef<AgentVoiceClient | null>(null);
  const voiceTtsQueueRef = useRef<AgentTtsQueue | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const historyLoadKeyRef = useRef<string | null>(null);
  const streamAbortControllerRef = useRef<AbortController | null>(null);
  const voiceSttAbortControllerRef = useRef<AbortController | null>(null);
  const voiceSessionEpochRef = useRef(0);
  const voiceTtsSpeakingRef = useRef(false);
  const pkmAbortControllersRef = useRef<Set<AbortController>>(new Set());
  const latestVisibleTurnIdRef = useRef<string | null>(null);

  const voiceActive = voiceState !== "idle";
  const voiceMuted = voiceState === "muted";
  const voiceLevel = useAgentVoiceState((state) => state.level);
  const setGlobalVoiceActive = useAgentVoiceState((state) => state.setActive);
  const setGlobalVoiceStatus = useAgentVoiceState((state) => state.setStatus);
  const setGlobalVoiceLevel = useAgentVoiceState((state) => state.setLevel);
  const resetGlobalVoiceState = useAgentVoiceState((state) => state.reset);
  const isToolWorking = activeFrontendToolCount > 0;
  const isPkmMemoryWorking = activePkmToolCount > 0;
  const tokenIsFresh = !tokenExpiresAt || Date.now() < tokenExpiresAt;
  const agentVoiceEnabled = isAgentGeminiVoiceEnabled();
  const abortAgentTurnWork = useCallback(() => {
    streamAbortControllerRef.current?.abort();
    streamAbortControllerRef.current = null;
    voiceSttAbortControllerRef.current?.abort();
    voiceSttAbortControllerRef.current = null;
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
        available: voiceActive,
        tts_playing: voiceState === "speaking",
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
      voiceState,
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
  const canToggleVoice =
    agentVoiceEnabled && hasChatAccess && (!isVoiceConnecting || voiceActive);
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
      if (!agentVoiceEnabled && voiceActive) return "Voice disabled";
      if (voiceState === "connecting") return "Voice connecting";
      if (voiceState === "listening") return "Listening";
      if (voiceState === "muted") return "Muted";
      if (voiceState === "transcribing") return "Transcribing";
      if (voiceState === "thinking") return "Thinking";
      if (voiceState === "speaking") return "Speaking";
      if (voiceState === "error") return "Voice error";
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
      agentVoiceEnabled,
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
      voiceActive,
    ]
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, pkmReviews]);

  useEffect(() => {
    return () => {
      voiceSessionEpochRef.current += 1;
      abortAgentTurnWork();
      void voiceClientRef.current?.stop();
      voiceClientRef.current = null;
      voiceTtsQueueRef.current?.cancel();
      voiceTtsQueueRef.current = null;
      resetGlobalVoiceState();
    };
  }, [abortAgentTurnWork, resetGlobalVoiceState]);

  useEffect(() => {
    const syncVoiceSettings = () => {
      setSelectedVoice(readAgentVoiceSettings().ttsVoice);
    };
    window.addEventListener(AGENT_VOICE_SETTINGS_CHANGED_EVENT, syncVoiceSettings);
    window.addEventListener("storage", syncVoiceSettings);
    return () => {
      window.removeEventListener(AGENT_VOICE_SETTINGS_CHANGED_EVENT, syncVoiceSettings);
      window.removeEventListener("storage", syncVoiceSettings);
    };
  }, []);

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
    void voiceClientRef.current?.stop();
    voiceClientRef.current = null;
    voiceTtsQueueRef.current?.cancel();
    voiceTtsQueueRef.current = null;
    setIsChatLoading(false);
    setIsLoadingHistory(false);
    setIsVoiceConnecting(false);
    setIsStreaming(false);
    setActiveFrontendToolCount(0);
    setActivePkmToolCount(0);
    setPkmReviews([]);
    setPkmActivity([]);
    setVoiceState("idle");
    setVoiceTranscriptReview(null);
    resetGlobalVoiceState();
    setConversationId(null);
    setConversations([]);
    setHistoryActionPendingId(null);
    setMessages([createGreetingMessage()]);
    historyLoadKeyRef.current = null;
    latestVisibleTurnIdRef.current = null;
  }, [abortAgentTurnWork, resetGlobalVoiceState, user?.uid, isVaultUnlocked]);

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
    (_turnId: string, _event: AgentDebugEvent["event"], _payload: AgentDebugEvent["payload"]) => {
      // Debug events are intentionally kept internal while the Agent debug UI is disabled.
    },
    []
  );

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

  const runAgentTurn = async (
    textInput: string,
    options: { source: AgentTurnSource } = { source: "typed" }
  ) => {
    const text = textInput.trim();
    if (!text || !hasChatAccess || !user?.uid) return;

    const userId = user.uid;
    const token = getVaultOwnerToken();
    const isVoiceTurn = options.source === "voice";
    let voiceAssistantMarkdown = "";
    let voiceReceiptSpoken = false;
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
    if (isVoiceTurn && token) {
      voiceTtsQueueRef.current?.cancel();
      voiceTtsQueueRef.current = new AgentTtsQueue({
        userId,
        vaultOwnerToken: token,
        voice: selectedVoice,
        onStateChange: (state) => {
          if (state === "speaking") {
            voiceTtsSpeakingRef.current = true;
            voiceClientRef.current?.setCapturePaused(true);
            setAgentVoiceStatus("speaking");
            return;
          }
          voiceTtsSpeakingRef.current = false;
          voiceClientRef.current?.setCapturePaused(false);
          if (voiceClientRef.current?.isActive) {
            setAgentVoiceStatus(voiceClientRef.current.isMuted ? "muted" : "listening");
          }
        },
      });
      voiceTtsQueueRef.current.resetStream();
      setAgentVoiceStatus("thinking");
    }

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

    const queueVoiceAssistantDelta = (delta: string) => {
      if (!isVoiceTurn || !voiceTtsQueueRef.current) return;
      voiceAssistantMarkdown += delta;
      voiceTtsQueueRef.current.pushMarkdownSnapshot(voiceAssistantMarkdown);
    };

    const speakVoiceReceipt = (messageText: string) => {
      if (!isVoiceTurn || !voiceTtsQueueRef.current) return;
      const cleanReceipt = markdownToSpeechText(messageText);
      if (!cleanReceipt) return;
      const currentAssistantSpeech = markdownToSpeechText(voiceAssistantMarkdown);
      if (currentAssistantSpeech.includes(cleanReceipt)) {
        voiceReceiptSpoken = true;
        return;
      }
      voiceReceiptSpoken = true;
      voiceTtsQueueRef.current.speakNow(cleanReceipt);
    };

    const cancelAssistantFlush = () => {
      if (assistantFlushFrame !== null) {
        window.cancelAnimationFrame(assistantFlushFrame);
        assistantFlushFrame = null;
      }
      pendingAssistantDelta = "";
    };

    const finishCanceledTurn = () => {
      flushAssistantDelta();
      updateMessage(assistantMessageId, (message) => ({
        ...message,
        text: message.text || (isVoiceTurn ? "Voice turn canceled." : "Agent turn canceled."),
        status: "done",
      }));
      setIsChatLoading(false);
      setIsStreaming(false);
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
        if (voiceReceiptSpoken === false) {
          speakVoiceReceipt(result.resultSummary);
        }
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
    if (options.source === "typed") {
      setInput("");
    }
    latestVisibleTurnIdRef.current = debugTurnId;
    setPkmActivity([]);
    setIsChatLoading(true);
    setIsStreaming(true);

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
    let voiceStreamTimeoutMessage: string | null = null;
    let voiceStreamWatchdog: ReturnType<typeof setTimeout> | null = null;

    const clearVoiceStreamWatchdog = () => {
      if (voiceStreamWatchdog !== null) {
        clearTimeout(voiceStreamWatchdog);
        voiceStreamWatchdog = null;
      }
    };

    const armVoiceStreamWatchdog = (timeoutMs: number, message: string) => {
      if (!isVoiceTurn || streamAbortController.signal.aborted) return;
      clearVoiceStreamWatchdog();
      voiceStreamWatchdog = setTimeout(() => {
        voiceStreamTimeoutMessage = message;
        streamAbortController.abort();
      }, timeoutMs);
    };

    const finishVoiceTimedOutTurn = (message: string) => {
      flushAssistantDelta();
      updateMessage(assistantMessageId, (current) => ({
        ...current,
        text: current.text || message,
        status: "error",
      }));
      voiceTtsQueueRef.current?.speakNow(message);
      setIsChatLoading(false);
      setIsStreaming(false);
      setAgentVoiceStatus(voiceClientRef.current?.isActive ? "error" : "idle", message);
    };

    const loadTurnPkmContext = async (): Promise<AgentPkmContext> => {
      if (!vaultKey) return EMPTY_PKM_CONTEXT;
      if (!isVoiceTurn) {
        return loadAgentPkmContext({
          userId,
          vaultOwnerToken: token,
          vaultKey,
          message: text,
        });
      }

      const cachedContext = peekAgentPkmContext({
        userId,
        message: text,
      });
      if (cachedContext?.text) {
        void loadAgentPkmContext({
          userId,
          vaultOwnerToken: token,
          vaultKey,
          message: text,
        }).catch(() => undefined);
        return cachedContext;
      }

      const contextPromise = loadAgentPkmContext({
        userId,
        vaultOwnerToken: token,
        vaultKey,
        message: text,
      });
      const result = await withDeadline(contextPromise, VOICE_PKM_CONTEXT_DEADLINE_MS);
      if (!result.timedOut) return result.value;

      appendDebugEvent(debugTurnId, "pkm_context_deferred_for_voice_latency", {
        deadline_ms: VOICE_PKM_CONTEXT_DEADLINE_MS,
      });
      void contextPromise.catch((error) => {
        appendDebugEvent(debugTurnId, "pkm_context_deferred_load_failed", {
          message:
            error instanceof Error && error.message
              ? error.message
              : "Failed to refresh PKM context in the background.",
        });
      });
      return EMPTY_PKM_CONTEXT;
    };

    try {
      let agentPkmContext = EMPTY_PKM_CONTEXT;
      try {
        agentPkmContext = await loadTurnPkmContext();
        turnPkmContext = agentPkmContext;
        if (streamAbortController.signal.aborted) {
          if (voiceStreamTimeoutMessage) {
            finishVoiceTimedOutTurn(voiceStreamTimeoutMessage);
          } else {
            finishCanceledTurn();
          }
          return;
        }
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

      let runtimeCredentialMode: RuntimeCredentialMode = "hushh_managed_vertex";
      let runtimeCredential: string | null = null;
      if (vaultKey && token) {
        try {
          const savedMode = await PersonalKnowledgeModelService.loadRuntimeSecret({
            userId,
            vaultKey,
            vaultOwnerToken: token,
            credentialRef: RUNTIME_CREDENTIAL_MODE_REF,
          });
          runtimeCredentialMode = savedMode === "byok" ? "byok" : "hushh_managed_vertex";
          if (runtimeCredentialMode === "byok") {
            try {
              runtimeCredential = await PersonalKnowledgeModelService.loadRuntimeSecret({
                userId,
                vaultKey,
                vaultOwnerToken: token,
                credentialRef: GEMINI_RUNTIME_CREDENTIAL_REF,
              });
            } catch (error) {
              runtimeCredential = null;
              appendDebugEvent(debugTurnId, "runtime_credential_load_failed", {
                mode: runtimeCredentialMode,
                provider: "gemini",
                credential_ref: GEMINI_RUNTIME_CREDENTIAL_REF,
                message:
                  error instanceof Error && error.message
                    ? error.message
                    : "Failed to load the Gemini runtime key.",
              });
            }
          }
          appendDebugEvent(debugTurnId, "runtime_credentials_prepared", {
            mode: runtimeCredentialMode,
            provider: "gemini",
            credential_ref: GEMINI_RUNTIME_CREDENTIAL_REF,
            credential_resolved: Boolean(runtimeCredential),
          });
        } catch (error) {
          runtimeCredentialMode = "hushh_managed_vertex";
          runtimeCredential = null;
          appendDebugEvent(debugTurnId, "runtime_credential_mode_load_failed", {
            message:
              error instanceof Error && error.message
                ? error.message
                : "Failed to load runtime credential settings.",
          });
        }
      } else {
        appendDebugEvent(debugTurnId, "runtime_credentials_skipped", {
          reason: "vault_locked_or_unavailable",
          mode: runtimeCredentialMode,
        });
      }

      armVoiceStreamWatchdog(
        VOICE_AGENT_FIRST_EVENT_TIMEOUT_MS,
        "Agent voice response timed out before it started. Please try again."
      );
      await streamAgentChat({
        userId,
        message: text,
        conversationId,
        vaultOwnerToken: token,
        pkmContext: agentPkmContext.text || undefined,
        runtimeCredential,
        runtimeCredentialMode,
        signal: streamAbortController.signal,
        handlers: {
          onStart: ({ conversationId: nextConversationId }) => {
            if (streamAbortController.signal.aborted) return;
            armVoiceStreamWatchdog(
              VOICE_AGENT_IDLE_TIMEOUT_MS,
              "Agent voice response stalled. Please try again."
            );
            if (nextConversationId) {
              setConversationId(nextConversationId);
            }
          },
          onToolStart: (toolEvent) => {
            if (streamAbortController.signal.aborted) return;
            armVoiceStreamWatchdog(
              VOICE_AGENT_IDLE_TIMEOUT_MS,
              "Agent voice tool call stalled. Please try again."
            );
            appendDebugEvent(debugTurnId, "tool_start", toolEvent);
          },
          onToolWaiting: (toolEvent) => {
            if (streamAbortController.signal.aborted) return;
            armVoiceStreamWatchdog(
              VOICE_AGENT_IDLE_TIMEOUT_MS,
              "Agent voice tool call stalled. Please try again."
            );
            appendDebugEvent(debugTurnId, "tool_waiting", toolEvent);
            upsertToolStatusMessage(
              toolEvent.message || "Working on that in Kai...",
              "streaming"
            );
            speakVoiceReceipt(toolEvent.message || "Working on that in Kai...");
            executeToolIfNeeded(toolEvent);
          },
          onToolResult: (toolEvent) => {
            if (streamAbortController.signal.aborted) return;
            armVoiceStreamWatchdog(
              VOICE_AGENT_IDLE_TIMEOUT_MS,
              "Agent voice tool result stalled. Please try again."
            );
            appendDebugEvent(debugTurnId, "tool_result", toolEvent);
            if (toolEvent.execution === "blocked" || toolEvent.status === "blocked") {
              upsertToolStatusMessage(
                toolEvent.message || "That action is blocked in Agent.",
                "error"
              );
              speakVoiceReceipt(toolEvent.message || "That action is blocked in Agent.");
            }
          },
          onToken: (delta) => {
            if (streamAbortController.signal.aborted) return;
            armVoiceStreamWatchdog(
              VOICE_AGENT_IDLE_TIMEOUT_MS,
              "Agent voice response stalled. Please try again."
            );
            queueAssistantDelta(delta);
            queueVoiceAssistantDelta(delta);
          },
          onComplete: ({ conversationId: nextConversationId }) => {
            if (streamAbortController.signal.aborted) return;
            clearVoiceStreamWatchdog();
            flushAssistantDelta();
            if (isVoiceTurn) {
              voiceTtsQueueRef.current?.flushStream();
            }
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
            clearVoiceStreamWatchdog();
            flushAssistantDelta();
            if (isVoiceTurn) {
              voiceTtsQueueRef.current?.speakNow(message);
            }
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
      if (streamAbortController.signal.aborted) {
        if (voiceStreamTimeoutMessage) {
          finishVoiceTimedOutTurn(voiceStreamTimeoutMessage);
        } else {
          finishCanceledTurn();
        }
        return;
      }
      clearVoiceStreamWatchdog();
      flushAssistantDelta();
      if (isVoiceTurn) {
        voiceTtsQueueRef.current?.flushStream();
      }
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
      if (streamAbortController.signal.aborted) {
        if (voiceStreamTimeoutMessage) {
          finishVoiceTimedOutTurn(voiceStreamTimeoutMessage);
        } else {
          finishCanceledTurn();
        }
        return;
      }
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
      if (isVoiceTurn) {
        voiceTtsQueueRef.current?.speakNow(message);
      }
      void loadConversationList().catch(() => undefined);
      setIsChatLoading(false);
      setIsStreaming(false);
    } finally {
      clearVoiceStreamWatchdog();
      cancelAssistantFlush();
      if (streamAbortControllerRef.current === streamAbortController) {
        streamAbortControllerRef.current = null;
      }
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await runAgentTurn(input, { source: "typed" });
  };

  const setAgentVoiceStatus = (status: AgentVoiceStatus, message?: string | null) => {
    setVoiceState(status);
    setGlobalVoiceStatus(status, message ?? null);
  };

  const handleCancelVoice = useCallback(async () => {
    voiceSessionEpochRef.current += 1;
    abortAgentTurnWork();
    voiceTtsQueueRef.current?.cancel();
    voiceTtsQueueRef.current = null;
    voiceTtsSpeakingRef.current = false;
    await voiceClientRef.current?.stop();
    voiceClientRef.current = null;
    setIsVoiceConnecting(false);
    setIsChatLoading(false);
    setIsStreaming(false);
    setVoiceTranscriptReview(null);
    setVoiceState("idle");
    resetGlobalVoiceState();
  }, [abortAgentTurnWork, resetGlobalVoiceState]);

  const handleVoiceTranscriptAccepted = (transcript: string) => {
    setVoiceTranscriptReview(null);
    if (!voiceClientRef.current?.isActive) return;
    void runAgentTurn(transcript, { source: "voice" }).finally(() => {
      voiceClientRef.current?.setMuted(false);
    });
  };

  const handleVoiceTranscriptRetry = () => {
    setVoiceTranscriptReview(null);
    voiceClientRef.current?.setMuted(false);
  };

  const handleToggleVoice = async () => {
    if (!agentVoiceEnabled) {
      addErrorMessage("Agent Gemini voice is disabled for this environment.");
      return;
    }
    if (!hasChatAccess || !user?.uid) return;

    if (voiceActive) {
      voiceClientRef.current?.toggleMuted();
      if (voiceTtsSpeakingRef.current) {
        setAgentVoiceStatus("speaking");
      }
      return;
    }

    const token = getVaultOwnerToken();
    if (!token) {
      addErrorMessage("Vault access expired. Unlock again to continue.");
      return;
    }

    setIsVoiceConnecting(true);
    setGlobalVoiceActive(true);
    voiceSessionEpochRef.current += 1;
    voiceTtsSpeakingRef.current = false;
    setAgentVoiceStatus("connecting");

    try {
      if (!voiceClientRef.current) {
        voiceClientRef.current = new AgentVoiceClient();
      }
      await voiceClientRef.current.start({
        onStatus: (status, message) => {
          setAgentVoiceStatus(status, message);
          if (status !== "connecting") {
            setIsVoiceConnecting(false);
          }
        },
        onLevel: (level) => {
          setGlobalVoiceLevel(level);
        },
        onUtterance: async ({ audio }) => {
          const voiceSessionEpoch = voiceSessionEpochRef.current;
          const sttAbortController = new AbortController();
          voiceSttAbortControllerRef.current?.abort();
          voiceSttAbortControllerRef.current = sttAbortController;
          setAgentVoiceStatus("transcribing");
          try {
            const result = await transcribeAgentVoice({
              userId: user.uid,
              vaultOwnerToken: token,
              audio,
              signal: sttAbortController.signal,
              timeoutMs: AGENT_VOICE_STT_TIMEOUT_MS,
            });
            if (
              sttAbortController.signal.aborted ||
              voiceSessionEpoch !== voiceSessionEpochRef.current ||
              !voiceClientRef.current?.isActive
            ) {
              return;
            }

            await handleAgentVoiceTranscriptTurn({
              result,
              runTurn: async (transcript) => {
                if (
                  sttAbortController.signal.aborted ||
                  voiceSessionEpoch !== voiceSessionEpochRef.current ||
                  !voiceClientRef.current?.isActive
                ) {
                  return;
                }
                await runAgentTurn(transcript, { source: "voice" });
              },
              requestReview: (transcript, reason) => {
                if (
                  sttAbortController.signal.aborted ||
                  voiceSessionEpoch !== voiceSessionEpochRef.current ||
                  !voiceClientRef.current?.isActive
                ) {
                  return;
                }
                voiceClientRef.current?.setMuted(true);
                setVoiceTranscriptReview({ transcript, reason });
              },
            });
          } catch (error) {
            if (
              sttAbortController.signal.aborted ||
              voiceSessionEpoch !== voiceSessionEpochRef.current
            ) {
              return;
            }
            if (isAbortError(error)) {
              throw new Error("Voice transcription timed out. Please try again.");
            }
            throw error;
          } finally {
            if (voiceSttAbortControllerRef.current === sttAbortController) {
              voiceSttAbortControllerRef.current = null;
            }
          }
        },
        onError: (message) => {
          addErrorMessage(message);
          setIsVoiceConnecting(false);
          setAgentVoiceStatus("error", message);
        },
      });
      setIsVoiceConnecting(false);
    } catch (error) {
      voiceSttAbortControllerRef.current?.abort();
      voiceSttAbortControllerRef.current = null;
      voiceTtsSpeakingRef.current = false;
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Voice session failed.";
      addErrorMessage(message);
      setIsVoiceConnecting(false);
      setAgentVoiceStatus("idle");
      resetGlobalVoiceState();
      await voiceClientRef.current?.stop();
      voiceClientRef.current = null;
    }
  };

  useEffect(() => {
    if (!voiceActive) return;
    if (agentVoiceEnabled && user?.uid && isVaultUnlocked && vaultOwnerToken && tokenIsFresh) {
      return;
    }
    void handleCancelVoice();
  }, [
    agentVoiceEnabled,
    handleCancelVoice,
    isVaultUnlocked,
    tokenIsFresh,
    user?.uid,
    vaultOwnerToken,
    voiceActive,
  ]);

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
              Kai
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

        <section className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/70 bg-card shadow-sm">
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

          {voiceTranscriptReview ? (
            <div className="absolute inset-0 z-20 grid place-items-end bg-background/30 p-4 backdrop-blur-[1px] sm:place-items-center">
              <div
                className="w-full max-w-sm rounded-md border border-primary/30 bg-background p-4 shadow-xl"
                role="dialog"
                aria-modal="true"
                aria-label="Confirm voice transcript"
              >
                <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">
                  Confirm voice transcript
                </p>
                <p className="mt-2 text-sm text-foreground">
                  {voiceTranscriptReview.transcript || "I could not hear a clear transcript."}
                </p>
                {voiceTranscriptReview.reason ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {voiceTranscriptReview.reason}
                  </p>
                ) : null}
                <div className="mt-3 flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleVoiceTranscriptRetry}
                  >
                    Retry
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!voiceTranscriptReview.transcript.trim()}
                    onClick={() =>
                      handleVoiceTranscriptAccepted(voiceTranscriptReview.transcript)
                    }
                  >
                    Continue
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          <form
            onSubmit={handleSubmit}
            className="flex shrink-0 items-center gap-2 border-t border-border/70 bg-background/80 p-3"
          >
            {voiceActive ? (
              <AgentVoiceWaveInput
                status={voiceState}
                level={voiceLevel}
                muted={voiceMuted}
                disabled={!hasChatAccess || isVoiceConnecting}
                onToggleMute={handleToggleVoice}
                onCancel={() => {
                  void handleCancelVoice();
                }}
              />
            ) : (
              <>
                <input
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  disabled={!hasChatAccess || isLoadingHistory || isVoiceConnecting}
                  placeholder="Ask Agent about markets, portfolio, analysis..."
                  className="h-11 min-w-0 flex-1 rounded-md border border-border/70 bg-background px-4 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/60"
                />
                {agentVoiceEnabled ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    disabled={!canToggleVoice}
                    onClick={handleToggleVoice}
                    aria-label="Start voice mode"
                    title="Start voice mode"
                  >
                    <Mic className="h-4 w-4" />
                  </Button>
                ) : null}
                <Button type="submit" size="icon" disabled={!canSend} aria-label="Send message">
                  <Send className="h-4 w-4" />
                </Button>
              </>
            )}
          </form>
        </section>
      </div>
    </div>
  );
}
