"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Bot, BriefcaseBusiness, Bug, Copy, Mic, MicOff, Send, UserRound } from "lucide-react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import {
  executeAgentGatewayAction,
  type AgentActionRuntimeResult,
} from "@/lib/agent/agent-action-runtime";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { usePersonaState } from "@/lib/persona/persona-context";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import { AppBackgroundTaskService } from "@/lib/services/app-background-task-service";
import {
  AgentRealtimeClient,
  type AgentRealtimeVoiceState,
} from "@/lib/services/agent-realtime-client";
import {
  getAgentChatHistory,
  listAgentChatConversations,
  streamAgentChat,
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

const AGENT_GREETING =
  "Hey, I'm Agent. Ask me about markets, your portfolio, Kai analysis, or consent workflows.";

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

function AgentBubble({ message }: { message: AgentMessage }) {
  const isUser = message.role === "user";
  const isStreaming = message.status === "streaming";
  const isError = message.status === "error";

  return (
    <div className={cn("flex gap-3", isUser ? "justify-end" : "justify-start")}>
      {!isUser ? (
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
          <Bot className="h-4 w-4" />
        </div>
      ) : null}
      <div className={cn("max-w-[78%]", isUser && "order-first")}>
        <div
          className={cn(
            "rounded-lg px-4 py-3 text-sm leading-6 shadow-sm",
            isUser
              ? "bg-primary text-primary-foreground"
              : "border border-border/70 bg-background text-foreground",
            isError && "border-destructive/40 bg-destructive/10 text-destructive"
          )}
        >
          {message.text}
          {isStreaming ? (
            <span className="ml-1 inline-block h-4 w-1 animate-pulse bg-current align-middle" />
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

export function AgentScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  const {
    isVaultUnlocked,
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
  const [messages, setMessages] = useState<AgentMessage[]>(() => [createGreetingMessage()]);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isVoiceConnecting, setIsVoiceConnecting] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeToolCount, setActiveToolCount] = useState(0);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugEvents, setDebugEvents] = useState<AgentDebugEvent[]>([]);
  const [latestDebugTurnId, setLatestDebugTurnId] = useState<string | null>(null);
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

  const voiceActive = voiceState !== "idle";
  const isToolWorking = activeToolCount > 0;
  const tokenIsFresh = !tokenExpiresAt || Date.now() < tokenExpiresAt;
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
    !isToolWorking &&
    !isVoiceConnecting &&
    !isStreaming &&
    !voiceActive &&
    input.trim().length > 0;
  const canToggleVoice = hasChatAccess && (!isVoiceConnecting || voiceActive);
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
      if (isChatLoading) return "Thinking";
      if (isStreaming) return "Streaming";
      return "Ready";
    },
    [
      authLoading,
      isChatLoading,
      isLoadingHistory,
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
  }, [messages]);

  useEffect(() => {
    return () => {
      voiceClientRef.current?.close();
      voiceClientRef.current = null;
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
    voiceClientRef.current?.close();
    voiceClientRef.current = null;
    setIsChatLoading(false);
    setIsLoadingHistory(false);
    setIsVoiceConnecting(false);
    setIsStreaming(false);
    setActiveToolCount(0);
    setDebugEvents([]);
    setLatestDebugTurnId(null);
    setVoiceState("idle");
    setConversationId(null);
    setMessages([createGreetingMessage()]);
    historyLoadKeyRef.current = null;
    voiceUserMessageIdRef.current = null;
    voiceAssistantMessageIdRef.current = null;
  }, [user?.uid, isVaultUnlocked]);

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

  const storedMessageToAgentMessage = (message: StoredAgentChatMessage): AgentMessage | null => {
    if (message.role !== "user" && message.role !== "assistant") return null;
    const createdAt = message.created_at ? new Date(message.created_at) : null;
    return {
      id: message.id,
      role: message.role,
      text: message.content,
      timestamp: createdAt && !Number.isNaN(createdAt.getTime())
        ? new Intl.DateTimeFormat(undefined, {
            hour: "numeric",
            minute: "2-digit",
          }).format(createdAt)
        : formatNow(),
      status: message.status === "error" ? "error" : "done",
    };
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
          limit: 1,
        });
        const latest = conversations[0];
        if (!latest) return;
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
        if (restored.length > 0) {
          setMessages(restored);
        }
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
    let assistantHasToken = false;

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
      toolStatusMessageId = assistantMessageId;
      updateMessage(assistantMessageId, (message) => ({
        ...message,
        text: cleanText,
        status,
        ephemeral: true,
      }));
    };

    const toolResultStatus = (result: AgentActionRuntimeResult): AgentMessage["status"] => {
      if (result.status === "blocked" || result.status === "failed" || result.status === "invalid") {
        return "error";
      }
      return "done";
    };

    const executeFrontendTool = async (toolEvent: AgentChatToolEvent) => {
      if (!toolEvent.actionId) return;
      setActiveToolCount((count) => count + 1);
      appendDebugEvent(debugTurnId, "frontend_execute_start", toolEvent);
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
        setActiveToolCount((count) => Math.max(0, count - 1));
      }
    };

    const executeToolIfNeeded = (toolEvent: AgentChatToolEvent) => {
      const callKey = toolEvent.callId || `${toolEvent.actionId || "unknown"}-${turnId}`;
      if (executedToolCalls.has(callKey)) return;
      if (toolEvent.execution !== "frontend" || !toolEvent.actionId) return;
      executedToolCalls.add(callKey);
      void executeFrontendTool(toolEvent);
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

    try {
      await streamAgentChat({
        userId,
        message: text,
        conversationId,
        vaultOwnerToken: token,
        handlers: {
          onStart: ({ conversationId: nextConversationId }) => {
            if (nextConversationId) {
              setConversationId(nextConversationId);
            }
          },
          onToolStart: (toolEvent) => {
            appendDebugEvent(debugTurnId, "tool_start", toolEvent);
          },
          onToolWaiting: (toolEvent) => {
            appendDebugEvent(debugTurnId, "tool_waiting", toolEvent);
            upsertToolStatusMessage(
              toolEvent.message || "Working on that in Kai...",
              "streaming"
            );
            executeToolIfNeeded(toolEvent);
          },
          onToolResult: (toolEvent) => {
            appendDebugEvent(debugTurnId, "tool_result", toolEvent);
            if (toolEvent.execution === "blocked" || toolEvent.status === "blocked") {
              upsertToolStatusMessage(
                toolEvent.message || "That action is blocked in Agent.",
                "error"
              );
            }
          },
          onToken: (delta) => {
            assistantHasToken = true;
            updateMessage(assistantMessageId, (message) => ({
              ...message,
              text: message.ephemeral ? delta : `${message.text}${delta}`,
              status: "streaming",
              ephemeral: false,
            }));
          },
          onComplete: ({ conversationId: nextConversationId }) => {
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
      updateMessage(assistantMessageId, (message) => {
        if (message.status === "error") return message;
        return {
          ...message,
          text: message.text || "I couldn't generate a response. Please try again.",
          status: "done",
        };
      });
      setIsChatLoading(false);
      setIsStreaming(false);
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Agent chat request failed.";
      updateMessage(assistantMessageId, (current) => ({
        ...current,
        text: current.text || message,
        status: "error",
      }));
      setIsChatLoading(false);
      setIsStreaming(false);
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

  return (
    <AppPageShell
      width="reading"
      className="px-[var(--page-inline-gutter-standard)] py-[var(--page-block-padding)]"
      nativeTest={{
        routeId: "/agent",
        marker: "native-route-agent",
        authState: "authenticated",
        dataState: "loaded",
      }}
    >
      <NativeRouteMarker
        routeId="/agent"
        marker="native-route-agent"
        authState="authenticated"
        dataState="loaded"
      />
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="Agent"
          title="Agent"
          description="A Kai-focused chat surface for markets, portfolio, analysis, and consent workflows."
          icon={BriefcaseBusiness}
          accent="kai"
          actions={
            <div className="flex items-center gap-2">
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
              <span className="rounded-md border border-border/70 bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground">
                {statusText}
              </span>
            </div>
          }
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion className="mt-5">
        <section className="overflow-hidden rounded-lg border border-border/70 bg-card shadow-sm">
          <div className="max-h-[min(68vh,680px)] space-y-5 overflow-y-auto p-4 sm:p-5">
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
            <div ref={messagesEndRef} />
          </div>

          <form
            onSubmit={handleSubmit}
            className="flex items-center gap-2 border-t border-border/70 bg-background/80 p-3"
          >
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={
                !hasChatAccess ||
                isChatLoading ||
                isToolWorking ||
                isVoiceConnecting ||
                isStreaming ||
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
      </AppPageContentRegion>
    </AppPageShell>
  );
}
