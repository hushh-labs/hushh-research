// components/agent/agent-bar.tsx
// Persistent, screen-aware agent launcher bar.
//
// A single sleek bar that spans across just above the bottom navbar + search on
// every authenticated screen. It replaces the old draggable floating "Agent"
// pill so the agent is always present and context-aware: the hint text adapts to
// the current screen so the bar can guide the user from onboarding to any part
// of the app. The text surface opens Agent Chat; the voice icon starts One
// Voice conversation.

"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { AudioLines, MessageCircle, Moon, Sun, X } from "lucide-react";
import { useTheme } from "next-themes";

import { useOptionalAgentPopover } from "@/components/agent/agent-popover-provider";
import { AgentVoiceWaveform } from "@/components/agent/agent-voice-waveform";
import { useAuth } from "@/hooks/use-auth";
import {
  executeAgentGatewayAction,
  executeTrustedActivationGatewayAction,
  type AgentActionRuntimeResult,
} from "@/lib/agent/agent-action-runtime";
import { useAgentRuntimeStateOptional } from "@/lib/agent/agent-runtime-context";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";
import { ApiService } from "@/lib/services/api-service";
import {
  getAgentVoiceStatusLabel,
  useAgentVoiceState,
} from "@/lib/agent/agent-voice-state";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { validateMorphyAxAssessment } from "@/lib/morphy-ax";
import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import { useKaiBottomChromeElementTranslation } from "@/lib/navigation/kai-bottom-chrome-visibility";
import {
  ROUTES,
  isFoundationPublicRoute,
  isOneSetupRoute,
  isRiaRoute,
} from "@/lib/navigation/routes";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import { usePersonaState } from "@/lib/persona/persona-context";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";
import { getVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { waitForVoiceActionSettlement } from "@/lib/voice/voice-action-settlement";
import { deriveVoiceRouteScreen } from "@/lib/voice/route-screen-derivation";
import { getKaiActionById } from "@/lib/voice/kai-action-gateway";
import { useAccent, writeAccent } from "@/lib/theme/accent";
import { createRealtimeVoiceTransport } from "@/lib/voice/one-voice-transport-factory";
import type { OneVoiceContextSnapshot } from "@/lib/voice/screen-context-builder";
import type {
  OneVoiceSessionEvent,
  RealtimeVoiceTransport,
} from "@/lib/voice/one-voice-transport";
import type {
  AgentVoiceEventOptions,
  AgentVoiceStatus,
} from "@/lib/agent/agent-voice-state";
import { redactSensitiveVoiceTranscript } from "@/lib/voice/voice-sensitive-redaction";

type PrewarmedGeminiRelay = {
  relayUrl: string;
  expiresAtMs: number;
  snapshotId: string;
  accessTier: string;
};

type PendingVoiceConfirmation = {
  directiveId: string;
  actionId: string;
  slots?: Record<string, unknown>;
  route: string | null;
};

function readBrowserVoiceRoute() {
  if (typeof window === "undefined") return undefined;
  const query = window.location.search.replace(/^\?/, "");
  const derived = deriveVoiceRouteScreen(window.location.pathname, query);
  return {
    pathname: `${window.location.pathname}${window.location.search}`,
    screen: derived.screen,
    subview: derived.subview ?? null,
  };
}

async function settleAgentBarAction(
  result: AgentActionRuntimeResult,
): Promise<AgentActionRuntimeResult> {
  if (
    !result.routeAfter ||
    (result.status !== "started" && result.status !== "succeeded")
  ) {
    return result;
  }

  const settlement = await waitForVoiceActionSettlement({
    actionId: result.actionId,
    mode: "execute_and_wait",
    actionStatus: result.status,
    routeBefore: {
      pathname: result.routeBefore || "",
      screen: result.screenBefore || "",
      subview: null,
    },
    expectedRoute: result.routeAfter,
    expectedScreen: result.screenAfter,
    getCurrentRoute: readBrowserVoiceRoute,
    getCurrentSurfaceMetadata: getVoiceSurfaceMetadata,
    timeoutMs: 1800,
  });

  if (settlement.settled_by === "timeout") {
    return {
      ...result,
      status: "started",
      reason: "route_settlement_timeout",
      routeAfter: settlement.route_after || result.routeAfter,
      screenAfter: settlement.screen_after || result.screenAfter,
      resultSummary: "The action started, but the next screen is still settling.",
    };
  }

  return {
    ...result,
    status: "succeeded",
    routeAfter: settlement.route_after || result.routeAfter,
    screenAfter: settlement.screen_after || result.screenAfter,
  };
}

// Precaution: if a live voice session sits idle (no user speech, no agent
// speech, no tool/navigation activity) this long, close it automatically
// instead of leaving an open mic/session hanging indefinitely. The timer is
// reset on every bit of session activity (speech, thinking, tool results,
// navigation), so this is a true "silence" window, not a hard cap. Mirrors the
// idle-timeout pattern in `agent-chat-workspace.tsx`, scoped to the full
// ambient session since Gemini Live has no per-turn stream to watch.
const AGENT_BAR_VOICE_IDLE_TIMEOUT_MS = 10_000;

// Screen-aware hint copy. First matching prefix wins, so order longest/most
// specific routes before their parents. Falls back to a generic prompt.
const AGENT_BAR_HINTS: ReadonlyArray<{ prefix: string; hint: string }> = [
  { prefix: ROUTES.KAI_ANALYSIS, hint: "Ask about this analysis" },
  { prefix: ROUTES.KAI_PORTFOLIO, hint: "Ask about your portfolio" },
  { prefix: ROUTES.KAI_HOME, hint: "Ask about the markets" },
  { prefix: ROUTES.LEGACY_KAI_ANALYSIS, hint: "Ask about this analysis" },
  { prefix: ROUTES.LEGACY_KAI_PORTFOLIO, hint: "Ask about your portfolio" },
  { prefix: ROUTES.LEGACY_KAI_HOME, hint: "Ask about the markets" },
  { prefix: ROUTES.RIA_HOME, hint: "Ask about your practice" },
  { prefix: ROUTES.PKM, hint: "Ask about your memories" },
  { prefix: ROUTES.PROFILE_PKM, hint: "Ask about your memories" },
  { prefix: ROUTES.CONSENTS, hint: "Ask about your consents" },
  { prefix: ROUTES.PROFILE, hint: "Ask about your account" },
  { prefix: ROUTES.ONE_HOME, hint: "Ask your agent anything" },
];

const AGENT_BAR_DEFAULT_HINT = "Ask your agent anything";

function actionableContextKey(context: OneVoiceContextSnapshot): string {
  // Excludes only voice revision/presentation state. Every remaining piece
  // participates in tool availability, route policy, or recovery posture.
  return JSON.stringify({
    route: context.revisions.route,
    ui: context.revisions.ui,
    cache: context.revisions.cache,
    persona: context.revisions.persona,
    onboarding: context.onboarding,
    pendingSettlement: context.pending_settlement,
  });
}

function resolveAgentBarHint(pathname: string | null): string {
  if (!pathname) return AGENT_BAR_DEFAULT_HINT;
  for (const { prefix, hint } of AGENT_BAR_HINTS) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return hint;
    }
  }
  return AGENT_BAR_DEFAULT_HINT;
}

export function AgentBar() {
  const agentBarShellRef = useRef<HTMLDivElement | null>(null);
  const pathname = usePathname();
  const router = useRouter();
  const agentPopover = useOptionalAgentPopover();
  // Shared single source of truth for the agent's active state. The bar uses it
  // for tier-aware presentation and to detect the home/onboarding surfaces
  // consistently with the chat workspace, instead of recomputing locally.
  const runtime = useAgentRuntimeStateOptional();
  const { user } = useAuth();
  const { resolvedTheme, setTheme } = useTheme();
  const { vaultOwnerToken } = useVault();
  const { switchPersona } = usePersonaState();
  const busyOperations = useKaiSession((state) => state.busyOperations);
  const setAnalysisParams = useKaiSession((state) => state.setAnalysisParams);
  const appendMirrorEvent = useOneConversationSession(
    (state) => state.appendMirrorEvent,
  );
  const createHandoff = useOneConversationSession(
    (state) => state.createHandoff,
  );
  const mirrorSessionId = useOneConversationSession((state) => state.sessionId);

  // In-bar conversation (Gemini Live full-duplex) state. This lives entirely in
  // the bar: tapping conversation mode does NOT open the chat popover. Instead
  // the bar highlights and an ambient waveform animates in place, reacting to
  // the user's voice (listening) and the agent's reply (speaking).
  const [conversationActive, setConversationActive] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] =
    useState<PendingVoiceConfirmation | null>(null);
  const pendingConfirmationRef = useRef<PendingVoiceConfirmation | null>(null);
  const voiceStatus = useAgentVoiceState((s) => s.status);
  const voiceMessage = useAgentVoiceState((s) => s.message);
  const voiceLevel = useAgentVoiceState((s) => s.level);
  const setVoiceStatus = useAgentVoiceState((s) => s.setStatus);
  const setVoiceLevel = useAgentVoiceState((s) => s.setLevel);
  const resetVoice = useAgentVoiceState((s) => s.reset);
  const liveClientRef = useRef<RealtimeVoiceTransport | null>(null);
  const lastTranscriptRef = useRef<{ text: string; atMs: number } | null>(null);
  const prewarmedRelayRef = useRef<PrewarmedGeminiRelay | null>(null);
  // Idle-close precaution: any live-session activity (speech, thinking, tool
  // results, navigation) reschedules this timer; if it ever fires, the
  // session has been silent for AGENT_BAR_VOICE_IDLE_TIMEOUT_MS and is closed
  // automatically so an ambient/onboarding session never lingers open.
  const idleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last actionable context pushed into the live session. Do not dedupe on
  // snapshot_id: it intentionally changes on every voice-state transition.
  const lastPushedContextRef = useRef<string | null>(null);
  const actionAbortControllerRef = useRef<AbortController | null>(null);
  // Tracks whether the active session ended with an error, so the bar can keep
  // showing the error status (instead of snapping shut) until it is dismissed.
  const erroredRef = useRef(false);
  // Ref indirection lets the idle-timer callback always call the CURRENT
  // stopConversation without needing it in handleTransportEvent's deps
  // (stopConversation is declared further down, after handleTransportEvent).
  const stopConversationRef = useRef<() => void>(() => {});

  const clearVoiceIdleTimer = useCallback(() => {
    if (idleTimeoutRef.current) {
      clearTimeout(idleTimeoutRef.current);
      idleTimeoutRef.current = null;
    }
  }, []);

  // Precaution: reschedule on every real activity signal (state transition,
  // final transcript, directive, handoff, error); if none arrive for
  // AGENT_BAR_VOICE_IDLE_TIMEOUT_MS the session closes itself. input_level /
  // output_level are intentionally excluded - they poll continuously on a
  // fixed interval regardless of actual sound, so treating them as activity
  // would make the idle timeout never fire.
  const scheduleVoiceIdleTimer = useCallback(() => {
    clearVoiceIdleTimer();
    idleTimeoutRef.current = setTimeout(() => {
      idleTimeoutRef.current = null;
      stopConversationRef.current();
    }, AGENT_BAR_VOICE_IDLE_TIMEOUT_MS);
  }, [clearVoiceIdleTimer]);

  const abandonPendingConfirmation = useCallback(
    (reason: string, summary: string, clearUi = true) => {
      const pending = pendingConfirmationRef.current;
      if (!pending) return;
      pendingConfirmationRef.current = null;
      if (clearUi) setPendingConfirmation(null);
      liveClientRef.current?.reportActionSettlement?.({
        directiveId: pending.directiveId,
        actionId: pending.actionId,
        status: "blocked",
        summary,
        reason,
      });
    },
    [],
  );

  const handleTransportEvent = useCallback(
    (event: OneVoiceSessionEvent) => {
      if (
        event.type === "state" ||
        event.type === "transcript_final" ||
        event.type === "assistant_text" ||
        event.type === "client_directive" ||
        event.type === "handoff"
      ) {
        scheduleVoiceIdleTimer();
      }
      const eventOptions: AgentVoiceEventOptions = {
        sessionId: "sessionId" in event ? (event.sessionId ?? null) : null,
        sourceId:
          "sourceId" in event ? (event.sourceId ?? null) : event.provider,
        sourceSeq: "sourceSeq" in event ? (event.sourceSeq ?? null) : null,
      };
      if (event.type === "state") {
        const status: AgentVoiceStatus =
          event.state === "opening"
            ? "connecting"
            : event.state === "listening"
              ? "listening"
              : event.state === "understanding" ||
                  event.state === "intent_preview" ||
                  event.state === "needs_consent" ||
                  event.state === "acting" ||
                  event.state === "navigation_settling"
                ? "thinking"
                : event.state === "result" || event.state === "follow_up"
                  ? "speaking"
                  : event.state === "error_recovery"
                    ? "error"
                    : "idle";
        if (status !== "idle") {
          setVoiceStatus(status, event.message ?? null, eventOptions);
        }
        return;
      }
      if (event.type === "input_level") {
        const current = useAgentVoiceState.getState().status;
        if (current === "listening" || current === "connecting") {
          setVoiceLevel(event.level);
        }
        return;
      }
      if (event.type === "output_level") {
        if (useAgentVoiceState.getState().status === "speaking") {
          setVoiceLevel(event.level);
        }
        return;
      }
      if (event.type === "error") {
        actionAbortControllerRef.current?.abort();
        abandonPendingConfirmation(
          "transport_error",
          "The confirmation was cancelled because the voice session hit an error.",
        );
        erroredRef.current = true;
        setVoiceStatus("error", event.message, eventOptions);
        return;
      }
      if (event.type === "assistant_text") {
        appendMirrorEvent({
          role: "assistant",
          text: event.text,
          source: "gemini_live",
          turnId: event.turnId ?? null,
        });
        return;
      }
      if (event.type === "transcript_final") {
        actionAbortControllerRef.current?.abort();
        // Mirror the user's transcript into the conversation session. One's
        // agent tree decides everything server-side; there is no client-side
        // planner to feed here.
        const transcript = event.text.trim();
        const previous = lastTranscriptRef.current;
        if (
          previous &&
          previous.text === transcript &&
          Date.now() - previous.atMs < 1500
        ) {
          return;
        }
        lastTranscriptRef.current = { text: transcript, atMs: Date.now() };
        appendMirrorEvent({
          role: "user",
          text: redactSensitiveVoiceTranscript(transcript, runtime?.screen),
          source: "gemini_live",
          turnId: event.turnId ?? null,
        });
        setVoiceStatus("thinking", "Understanding", eventOptions);
        return;
      }
      if (event.type === "client_directive") {
        // One's tools decided this (single decision-maker); the client only
        // executes through the same governed gateway the app uses.
        if (event.directive.kind === "navigate") {
          // Direct navigation directives predate generated action contracts.
          // Do not let a legacy ADK tool bypass the active route's verified
          // control inventory; every live route transition now enters through
          // an `action` directive and executeAgentGatewayAction.
          console.warn("[AgentBar] Rejected legacy direct navigation directive.");
          return;
        }
        if (event.directive.kind === "action") {
          const actionId =
            typeof event.directive.payload?.actionId === "string"
              ? event.directive.payload.actionId
              : null;
          if (actionId) {
            const directiveId =
              typeof event.directive.payload?.directiveId === "string"
                ? event.directive.payload.directiveId
                : null;
            const slots =
              event.directive.payload?.slots &&
              typeof event.directive.payload.slots === "object"
                ? (event.directive.payload.slots as Record<string, unknown>)
                : undefined;
            const needsConfirmation =
              event.directive.payload?.needsConfirmation === true;
            if (runtime?.morphyAxEnabled) {
              const decision = validateMorphyAxAssessment(
                {
                  schema_version: "morphy_ax_assessment.v1",
                  source: "one",
                  disposition: needsConfirmation
                    ? "confirm_visible_action"
                    : "execute_visible_action",
                  candidate_action_id: actionId,
                  missing_input: null,
                  ambiguous: false,
                  confidence: 1,
                  expected_outcome: needsConfirmation
                    ? "confirmation"
                    : "action",
                },
                runtime.morphyAxSnapshot,
              );
              const admitted = needsConfirmation
                ? decision.status === "confirmation_required"
                : decision.status === "permitted";
              if (!admitted) {
                if (directiveId) {
                  liveClientRef.current?.reportActionSettlement?.({
                    directiveId,
                    actionId,
                    status: "blocked",
                    summary:
                      "The requested action is not available on this screen.",
                    reason: `morphy_ax_${decision.status}`,
                  });
                }
                return;
              }
            }
            if (needsConfirmation) {
              if (!directiveId) return;
              // Keep sensitive arguments transient in component memory. The
              // confirmation card never renders slots (including OTP values).
              abandonPendingConfirmation(
                "confirmation_superseded",
                "A newer confirmation replaced the pending action.",
              );
              const pending = { directiveId, actionId, slots, route: pathname };
              pendingConfirmationRef.current = pending;
              setPendingConfirmation(pending);
              liveClientRef.current?.interrupt?.();
              setVoiceStatus("thinking", "Confirmation needed", eventOptions);
              return;
            }
            const runtimeState = runtime?.appRuntimeState;
            if (!runtimeState) {
              if (directiveId) {
                liveClientRef.current?.reportActionSettlement?.({
                  directiveId,
                  actionId,
                  status: "failed",
                  summary: "The app was not ready to run that action.",
                  reason: "missing_runtime_state",
                });
              }
              return;
            }
            void (async () => {
              try {
                actionAbortControllerRef.current?.abort();
                actionAbortControllerRef.current = new AbortController();
                const executionResult = await executeAgentGatewayAction({
                  actionId,
                  slots,
                  userId: user?.uid ?? "",
                  router,
                  appRuntimeState: runtimeState,
                  surfaceMetadata: getVoiceSurfaceMetadata(),
                  allowedActionIds:
                    runtime?.oneVoiceContextSnapshot.available_action_ids ??
                    null,
                  hasPortfolioData:
                    runtimeState.portfolio.has_portfolio_data ||
                    runtime?.oneVoiceContextSnapshot.cache.portfolio_ready ===
                      true,
                  busyOperations,
                  setAnalysisParams,
                  switchPersona,
                  executionContext: { directiveId },
                  signal: actionAbortControllerRef.current.signal,
                });
                const result = await settleAgentBarAction(executionResult);
                if (directiveId) {
                  liveClientRef.current?.reportActionSettlement?.({
                    directiveId,
                    actionId,
                    status: result.status,
                    summary: result.resultSummary,
                    reason: result.reason,
                    routeAfter: result.routeAfter,
                    screenAfter: result.screenAfter,
                  });
                }
              } catch {
                if (directiveId) {
                  liveClientRef.current?.reportActionSettlement?.({
                    directiveId,
                    actionId,
                    status: "failed",
                    summary: "The app could not complete that action.",
                    reason: "client_execution_failed",
                  });
                }
              }
            })();
            return;
          }
          // Specialist directive (location share/check-in/SOS, device
          // permission re-ask, connected-systems update, etc.) rather than a
          // run_app_action directive: these need vault-owner crypto/native
          // calls that only exist in the chat surface's directive runtime.
          // Without this branch the directive silently dropped (no actionId),
          // which is why asking One over voice to re-ask location permission
          // did nothing even though the specialist correctly proposed it.
          const delegateAgentId =
            typeof event.directive.payload?.delegateAgentId === "string"
              ? event.directive.payload.delegateAgentId
              : null;
          const directiveType =
            typeof event.directive.payload?.type === "string"
              ? event.directive.payload.type
              : "this";
          const handoff = createHandoff({
            reason: "action_requires_chat",
            transcript: null,
            assistantText: `One line this up for you: ${directiveType}. Confirm here to continue.`,
            specialistDirective: delegateAgentId
              ? {
                  delegateAgentId,
                  directive: {
                    kind: "action",
                    payload: event.directive.payload ?? {},
                  },
                  message: "",
                  stateChanged: false,
                }
              : null,
          });
          liveClientRef.current?.interrupt?.();
          agentPopover?.openAgent({ handoff });
          return;
        }
        return;
      }
      if (event.type === "handoff") {
        const transcript =
          typeof event.payload?.transcript === "string"
            ? event.payload.transcript
            : null;
        const assistantText =
          typeof event.payload?.assistantText === "string"
            ? event.payload.assistantText
            : null;
        const actionId =
          typeof event.payload?.actionId === "string"
            ? event.payload.actionId
            : null;
        const handoff = createHandoff({
          reason: "action_requires_chat",
          transcript,
          assistantText: assistantText || event.reason,
          actionId,
        });
        liveClientRef.current?.interrupt?.();
        agentPopover?.openAgent({ handoff });
        return;
      }
      if (event.type === "closed") {
        actionAbortControllerRef.current?.abort();
        clearVoiceIdleTimer();
        abandonPendingConfirmation(
          "session_closed",
          "The confirmation was cancelled when the voice session closed.",
        );
        liveClientRef.current = null;
        if (erroredRef.current) return;
        setConversationActive(false);
      }
    },
    [
      agentPopover,
      abandonPendingConfirmation,
      appendMirrorEvent,
      busyOperations,
      clearVoiceIdleTimer,
      createHandoff,
      pathname,
      router,
      runtime,
      scheduleVoiceIdleTimer,
      setAnalysisParams,
      setVoiceLevel,
      setVoiceStatus,
      switchPersona,
      user?.uid,
    ],
  );

  const stopConversation = useCallback(() => {
    actionAbortControllerRef.current?.abort();
    clearVoiceIdleTimer();
    erroredRef.current = false;
    abandonPendingConfirmation(
      "session_cancelled",
      "The confirmation was cancelled when the voice session ended.",
    );
    liveClientRef.current?.stop();
    liveClientRef.current = null;
    prewarmedRelayRef.current = null;
    setConversationActive(false);
    resetVoice();
  }, [abandonPendingConfirmation, clearVoiceIdleTimer, resetVoice]);

  const settlePendingConfirmation = useCallback(
    (confirmed: boolean) => {
      const pending = pendingConfirmationRef.current;
      if (!pending) return;
      pendingConfirmationRef.current = null;
      setPendingConfirmation(null);
      if (!confirmed) {
        liveClientRef.current?.reportActionSettlement?.({
          directiveId: pending.directiveId,
          actionId: pending.actionId,
          status: "blocked",
          summary: "The person cancelled the confirmation.",
          reason: "user_cancelled",
        });
        setVoiceStatus("listening", "Listening");
        return;
      }
      const runtimeState = runtime?.appRuntimeState;
      if (!runtimeState) {
        liveClientRef.current?.reportActionSettlement?.({
          directiveId: pending.directiveId,
          actionId: pending.actionId,
          status: "failed",
          summary: "The app was not ready to confirm that action.",
          reason: "missing_runtime_state",
        });
        return;
      }
      setVoiceStatus("thinking", "Confirming");
      const action = getKaiActionById(pending.actionId);
      const execute =
        action?.activation_policy === "trusted_activation_required"
          ? executeTrustedActivationGatewayAction
          : executeAgentGatewayAction;
      if (action?.activation_policy === "trusted_activation_required") {
        clearVoiceIdleTimer();
      }

      actionAbortControllerRef.current?.abort();
      actionAbortControllerRef.current = new AbortController();

      // For trusted-activation actions this call synchronously invokes the
      // mounted popup handler before the first promise boundary. Do not move it
      // inside an async wrapper or timer.
      const settlement = execute({
        actionId: pending.actionId,
        slots: pending.slots,
        userId: user?.uid ?? "",
        router,
        appRuntimeState: runtimeState,
        surfaceMetadata: getVoiceSurfaceMetadata(),
        allowedActionIds:
          runtime?.oneVoiceContextSnapshot.available_action_ids ?? null,
        hasPortfolioData:
          runtimeState.portfolio.has_portfolio_data ||
          runtime?.oneVoiceContextSnapshot.cache.portfolio_ready === true,
        busyOperations,
        setAnalysisParams,
        switchPersona,
        executionContext: { directiveId: pending.directiveId },
        signal: actionAbortControllerRef.current.signal,
      });
      void settlement
        .then(settleAgentBarAction)
        .then((result) => {
          scheduleVoiceIdleTimer();
          liveClientRef.current?.reportActionSettlement?.({
            directiveId: pending.directiveId,
            actionId: pending.actionId,
            status: result.status,
            summary: result.resultSummary,
            reason: result.reason,
            routeAfter: result.routeAfter,
            screenAfter: result.screenAfter,
          });
        })
        .catch(() => {
          scheduleVoiceIdleTimer();
          liveClientRef.current?.reportActionSettlement?.({
            directiveId: pending.directiveId,
            actionId: pending.actionId,
            status: "failed",
            summary: "The app could not complete the confirmed action.",
            reason: "client_execution_failed",
          });
        });
    },
    [
      busyOperations,
      clearVoiceIdleTimer,
      router,
      runtime,
      scheduleVoiceIdleTimer,
      setAnalysisParams,
      setVoiceStatus,
      switchPersona,
      user?.uid,
    ],
  );

  useEffect(() => {
    stopConversationRef.current = stopConversation;
  }, [stopConversation]);

  useEffect(() => {
    const pending = pendingConfirmationRef.current;
    if (!pending || pending.route === pathname) return;
    abandonPendingConfirmation(
      "route_changed",
      "The confirmation was cancelled because the screen changed.",
    );
  }, [abandonPendingConfirmation, pathname]);

  const openAgentChat = useCallback(() => {
    if (conversationActive) return;
    agentPopover?.openAgent();
  }, [agentPopover, conversationActive]);

  const startConversation = useCallback(() => {
    // Toggle off when a session (live OR an error still on screen) exists.
    if (liveClientRef.current || erroredRef.current || conversationActive) {
      stopConversation();
      return;
    }
    erroredRef.current = false;
    setConversationActive(true);
    scheduleVoiceIdleTimer();
    const context = runtime?.oneVoiceContextSnapshot ?? null;
    const prewarmedRelay = prewarmedRelayRef.current;
    // The prewarmed ticket is context-free (context rides in app_context
    // frames after connect), so only tier match and freshness gate reuse.
    const relayUrl =
      prewarmedRelay &&
      prewarmedRelay.accessTier === runtime?.tier &&
      prewarmedRelay.expiresAtMs > Date.now()
        ? prewarmedRelay.relayUrl
        : null;
    prewarmedRelayRef.current = null;
    const client = createRealtimeVoiceTransport({
      onEvent: handleTransportEvent,
    });
    liveClientRef.current = client;
    // The client pushes the starting snapshot as app_context on setupComplete.
    lastPushedContextRef.current = context
      ? actionableContextKey(context)
      : null;
    void client.start({
      context,
      accessTier: runtime?.tier ?? null,
      relayUrl,
      sessionMirrorId: mirrorSessionId,
      allowedActionIds: context?.available_action_ids ?? null,
      consentToken: vaultOwnerToken ?? null,
    });
  }, [
    conversationActive,
    runtime?.oneVoiceContextSnapshot,
    runtime?.tier,
    mirrorSessionId,
    handleTransportEvent,
    scheduleVoiceIdleTimer,
    stopConversation,
    vaultOwnerToken,
  ]);

  // Continuous voice context: when the user navigates while a live session is
  // active, push the fresh redacted snapshot into the session so One always
  // knows the current screen and its action contracts. For onboarding tiers
  // the relay lets One proactively offer the next step after a screen change.
  useEffect(() => {
    if (!conversationActive) {
      lastPushedContextRef.current = null;
      return;
    }
    const context = runtime?.oneVoiceContextSnapshot;
    const client = liveClientRef.current;
    if (!context || !client?.updateContext) return;
    const contextKey = actionableContextKey(context);
    if (lastPushedContextRef.current === contextKey) return;
    if (client.updateContext(context)) {
      lastPushedContextRef.current = contextKey;
    }
  }, [conversationActive, runtime?.oneVoiceContextSnapshot]);

  // Sign-in / vault unlock while a voice session is already open: without
  // this, a call started signed-out or locked never learns the token exists
  // and specialist tools (location, gmail, etc.) fail closed for the rest of
  // the call even after the user authenticates in the same session.
  const pushedConsentTokenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!conversationActive) {
      pushedConsentTokenRef.current = null;
      return;
    }
    const client = liveClientRef.current;
    if (!client?.updateConsentToken) return;
    if (pushedConsentTokenRef.current === (vaultOwnerToken ?? null)) return;
    if (client.updateConsentToken(vaultOwnerToken ?? null)) {
      pushedConsentTokenRef.current = vaultOwnerToken ?? null;
    }
  }, [conversationActive, vaultOwnerToken]);

  const handleVoiceStartClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      startConversation();
    },
    [startConversation],
  );

  useEffect(() => {
    const context = runtime?.oneVoiceContextSnapshot ?? null;
    const accessTier = runtime?.tier ?? null;
    if (!context || !accessTier || conversationActive || erroredRef.current) {
      return;
    }
    if (
      typeof document !== "undefined" &&
      document.visibilityState !== "visible"
    ) {
      return;
    }
    if (
      typeof window !== "undefined" &&
      window.__HUSHH_NATIVE_TEST__?.enabled === true
    ) {
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      // Context (screen, consent token) rides in post-connect app_context
      // frames, so the prewarmed URL only carries the opaque relay ticket.
      void ApiService.getOneAdkLiveRelayUrl({ signal: controller.signal })
        .then((relayUrl) => {
          if (controller.signal.aborted) return;
          prewarmedRelayRef.current = {
            relayUrl,
            expiresAtMs: Date.now() + 45_000,
            snapshotId: context.snapshot_id,
            accessTier,
          };
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            prewarmedRelayRef.current = null;
          }
        });
    }, 300);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [conversationActive, runtime?.oneVoiceContextSnapshot, runtime?.tier]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") return;
      prewarmedRelayRef.current = null;
      if (liveClientRef.current || conversationActive) {
        stopConversation();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [conversationActive, stopConversation]);

  // Tear down the live session if the bar unmounts (route change, sign-out).
  // Also clear the shared voice store so a stale status (e.g. "error",
  // "listening") does not leak to other consumers after the bar is gone.
  useEffect(() => {
    return () => {
      if (idleTimeoutRef.current) {
        clearTimeout(idleTimeoutRef.current);
        idleTimeoutRef.current = null;
      }
      abandonPendingConfirmation(
        "component_unmounted",
        "The confirmation was cancelled when the voice surface closed.",
        false,
      );
      liveClientRef.current?.stop();
      liveClientRef.current = null;
      prewarmedRelayRef.current = null;
      resetVoice();
    };
  }, [abandonPendingConfirmation, resetVoice]);

  const chromeState = useMemo(() => getKaiChromeState(pathname), [pathname]);
  // The root intro screen ("/") has no bottom nav, exactly like the onboarding
  // flow, so the bar must anchor above the safe area (not against the absent
  // nav inset) and must not ride the scroll-hide translation there. Prefer the
  // shared runtime's derived signals so the bar and chat workspace agree on the
  // home/onboarding surface; fall back to local computation when the provider
  // is unavailable.
  const isHomeRoute = runtime?.isHomeRoute ?? (pathname ?? "") === ROUTES.HOME;
  // The sign-in screen ("/login") is a signed-out onboarding surface with no
  // bottom nav (same as "/"), so the bar must anchor above the safe area and
  // must not ride a scroll-hide translation there.
  const isLoginRoute = (pathname ?? "").startsWith(ROUTES.LOGIN);
  const isFoundationPublic = isFoundationPublicRoute(pathname ?? "");
  const useOnboardingChrome =
    (runtime?.onboardingActive ?? chromeState.useOnboardingChrome) ||
    isHomeRoute ||
    isLoginRoute ||
    isFoundationPublic;

  // RIA sub-agent = Apple-style ALWAYS-PINNED ask-bar (matches the pinned nav).
  // This is route-scoped, not persona-scoped: /one must keep the build-48
  // shared ask bar even if the last active persona is RIA.
  const isRiaChrome = isRiaRoute(pathname ?? "");

  // The bar is mounted above the scroll root, so it cannot rely on inherited
  // route-shell geometry. Bind its transform directly to the shared motion
  // state without pulling scroll frames through the voice tree.
  useKaiBottomChromeElementTranslation(
    agentBarShellRef,
    !useOnboardingChrome && !isRiaChrome,
  );

  const hint = useMemo(() => resolveAgentBarHint(pathname), [pathname]);

  // The agent window owns its own open/close animation. Keep the bar visually
  // hidden across the FULL lifecycle (opening, expanded, and the closing
  // animation) so it never remounts abruptly mid-close. Crucially, "closing"
  // must be treated as hidden too: on minimize the provider sets
  // expanded=false + motionState="closing" simultaneously, so checking only
  // `expanded || opening` would flip the bar back on instantly and make it
  // snap above the bottom bar before the popover finished animating out.
  const agentWindowActive =
    agentPopover?.expanded ||
    agentPopover?.motionState === "opening" ||
    agentPopover?.motionState === "closing";

  // Hard unmount gates: route/auth contexts where the bar must not exist at all.
  //
  // The agent bar rides most surfaces, degrading gracefully by auth/vault level
  // (locked-vault users get an in-place unlock prompt; unlocked users get the
  // full agent). We also unmount where an agent launcher genuinely must not
  // exist (legacy dedicated agent route or appearance lab) or on transient
  // auth transitions where the
  // app shell is not the host.
  const path = pathname ?? "";
  // The waveform action circle is white only on the 2c dark dashboard (where a
  // white circle pops); on every other surface (welcome, profile, kai, …) it is
  // the indigo accent, per design.md §5.5.
  const onDashboard =
    path === ROUTES.ONE_HOME || path === `${ROUTES.ONE_HOME}/`;
  // The logged-out welcome ("/") and the sign-in screen ("/login") both host
  // the dogfooding onboarding voice greeter instead of unmounting the bar
  // outright: it doubles as the pre-auth conversation starter and stays
  // route-aware for whatever the signed-out flow visits next. On login the
  // tier is anon_browsing, so the login route is opted in explicitly.
  const onboardingGreeterMode =
    (isHomeRoute && runtime?.tier === "anon_onboarding") ||
    (isLoginRoute && !user);
  const focusedOnboardingVoiceOnly =
    isOneSetupRoute(pathname ?? "") ||
    (pathname ?? "").startsWith(ROUTES.PHONE_MANDATE);
  const ambientVoiceOnly =
    (isFoundationPublic && !isHomeRoute) || focusedOnboardingVoiceOnly;

  // Signed-out dogfooding: greet the person the moment the onboarding welcome
  // ("/") loads, instead of waiting for a tap. This reuses the exact same
  // startConversation() path as the manual mic button - same relay ticket,
  // same ADK live session, same server-composed proactive greeting already
  // documented in docs/reference/one/one-voice-runtime-architecture.md - so
  // there is no new greeting mechanism, just an earlier call site. Guarded to
  // fire once per mount and only for the anon_onboarding welcome tier. Must
  // run before the unmountBar early return below (hooks cannot follow a
  // conditional return).
  const autoGreetedRef = useRef(false);
  useEffect(() => {
    if (!onboardingGreeterMode) {
      autoGreetedRef.current = false;
      return;
    }
    if (autoGreetedRef.current) return;
    if (conversationActive || liveClientRef.current || erroredRef.current)
      return;
    autoGreetedRef.current = true;
    startConversation();
    // Intentionally excludes startConversation/conversationActive from deps:
    // this must fire exactly once per onboarding mount, not re-run whenever
    // those identities change (they change on every voice status transition).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboardingGreeterMode]);

  const unmountBar =
    !agentPopover ||
    // Focused onboarding routes retain voice but use the voice-only rendering
    // branch above, so Agent Chat never appears over setup or phone entry.
    path === ROUTES.AGENT ||
    // "/login" keeps the bar (signed-out onboarding greeter, parity with "/");
    // only the logout transition unmounts it.
    path.startsWith(ROUTES.LOGOUT) ||
    runtime?.oneVoiceContextSnapshot.ui.interaction_layer?.agent_continuity ===
      "suppressed";

  if (unmountBar) {
    return null;
  }

  // While the agent window is active, keep the bar mounted but visually faded
  // and non-interactive. When the window finishes closing it eases back in over
  // the same envelope instead of popping in from a fresh mount.
  const barHidden = Boolean(agentWindowActive);
  const activeInteractionLayer =
    runtime?.oneVoiceContextSnapshot.ui.interaction_layer ?? null;
  const barAmbient = activeInteractionLayer?.agent_continuity === "ambient";
  const elevatedForInteractionLayer = Boolean(
    pendingConfirmation ||
    activeInteractionLayer?.agent_continuity === "interactive",
  );
  const pendingAction = pendingConfirmation
    ? getKaiActionById(pendingConfirmation.actionId)
    : null;
  const pendingActionNeedsTrustedActivation =
    pendingAction?.activation_policy === "trusted_activation_required";
  const pendingActionLabel = pendingAction?.label || "Continue this action";

  // In the error state, prefer the specific reason (e.g. mic blocked, no device)
  // over the generic "Voice error" so the user knows how to recover.
  const voiceStatusLabel =
    voiceStatus === "error" && voiceMessage
      ? voiceMessage
      : getAgentVoiceStatusLabel(voiceStatus);
  const nativeVoiceMode = !conversationActive
    ? "idle"
    : voiceStatus === "connecting"
      ? "opening"
      : voiceStatus === "listening"
        ? "listening"
        : voiceStatus === "thinking"
          ? "understanding"
          : voiceStatus === "speaking"
            ? "speaking"
            : voiceStatus === "error"
              ? "error"
              : "opening";

  const appAccent = useAccent();

  const themeToggleButton = (
    <button
      type="button"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      aria-label="Toggle theme"
      title="Toggle theme"
      className="relative grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full text-accent-strong transition-colors duration-200 hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
    >
      <Sun className="hidden h-[17px] w-[17px] dark:block" />
      <Moon className="h-[17px] w-[17px] dark:hidden" />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden rounded-full"
      >
        <MaterialRipple variant="gradient" effect="fill" />
      </span>
    </button>
  );

  const accentToggleButton = (
    <button
      type="button"
      onClick={() => writeAccent(appAccent === "blue" ? "gold" : "blue")}
      aria-label="Toggle accent color"
      title="Toggle accent color"
      className="relative grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full transition-colors duration-200 hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
    >
      <span
        className={cn(
          "relative z-10 block h-[18px] w-[18px] rounded-full shadow-sm ring-1 ring-border/50 transition-colors duration-200",
          appAccent === "gold" ? "bg-[#d4af37]" : "bg-[#007AFF]"
        )}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden rounded-full"
      >
        <MaterialRipple variant="gradient" effect="fill" />
      </span>
    </button>
  );

  // During onboarding, show the theme and accent toggles
  const showToggles = onboardingGreeterMode || isOneSetupRoute(pathname || "");
  // Pill contents for the frosted bar, one JSX source across all modes so
  // the voice/theme controls and test ids never fork.
  const pillContents = conversationActive ? (
    // The ENTIRE bar is the tap target to end the conversation: tapping
    // anywhere stops it. The X icon on the left is a bare marker (no chip
    // background) showing this is the "tap to end" affordance. On the
    // pre-auth greeter (home route auto-greet) the theme toggle stays
    // docked alongside it so it never disappears mid-connect.
    <>
      <button
        type="button"
        data-native-voice-control-id="one_voice_agent_bar_end"
        data-testid="one-voice-agent-bar-end"
        onClick={stopConversation}
        aria-label="End conversation"
        title="Tap to end conversation"
        className="relative flex min-w-0 flex-1 items-center gap-3 overflow-hidden rounded-full pl-1 pr-2 text-left"
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden rounded-full"
        >
          <MaterialRipple variant="gradient" effect="fill" />
        </span>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-accent-strong">
          <X className="h-[18px] w-[18px]" />
        </span>
        <span
          className="flex min-w-0 flex-1 items-center gap-3"
          role="status"
          aria-live="polite"
          aria-label={voiceStatusLabel}
        >
          <AgentVoiceWaveform
            level={voiceLevel}
            status={voiceStatus}
            barCount={28}
            className="h-6 flex-1"
          />
          <span
            className={cn(
              "shrink-0 text-[12px] font-medium",
              voiceStatus === "error"
                ? "min-w-0 max-w-[60%] flex-1 truncate text-right text-destructive/80"
                : "tabular-nums text-foreground/60",
            )}
            title={voiceStatus === "error" ? voiceStatusLabel : undefined}
          >
            {voiceStatusLabel}
          </span>
        </span>
      </button>
      {showToggles ? (
        <div className="flex shrink-0 items-center gap-1">
          {accentToggleButton}
          {themeToggleButton}
        </div>
      ) : null}
    </>
  ) : onboardingGreeterMode || ambientVoiceOnly ? (
    // Signed-out welcome ("/") + sign-in ("/login"): the bar IS the
    // conversation starter (voice-only pre-auth) with the theme toggle
    // infused at the right, in the same accent tone as the mic icon.
    <>
      <button
        type="button"
        data-native-voice-control-id="one_voice_agent_bar_start"
        data-testid="one-voice-agent-bar-start-icon"
        onClick={handleVoiceStartClick}
        aria-label="Start conversation with One"
        title="Start conversation"
        className={cn(
          "relative flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden rounded-full pl-2 text-left",
          "transition-colors duration-200",
        )}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-accent-strong">
          <AudioLines className="h-[18px] w-[18px]" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-[#17130C]/80 dark:text-white/85">
          Talk to One
        </span>
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden rounded-full"
        >
          <MaterialRipple variant="gradient" effect="fill" />
        </span>
      </button>
      {/* Theme toggle, infused right-aligned, accent-toned like the mic. */}
      {showToggles ? (
        <div className="flex shrink-0 items-center gap-1">
          {accentToggleButton}
          {themeToggleButton}
        </div>
      ) : null}
    </>
  ) : (
    // Signed-in: same anatomy as the onboarding greeter (voice-first row on
    // the left, one quiet action chip on the right) so the bar reads as ONE
    // canonical control across the app. The right slot swaps by lifecycle:
    // theme toggle during onboarding, agent-chat message icon once onboarded.
    <>
      <button
        type="button"
        data-native-voice-control-id="one_voice_agent_bar_start"
        data-testid="one-voice-agent-bar-start-icon"
        onClick={handleVoiceStartClick}
        aria-label="Start conversation"
        title="Start conversation"
        className={cn(
          "relative flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden rounded-full pl-2 text-left",
          "transition-colors duration-200",
        )}
      >
        <span
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-accent-strong",
            onDashboard && "text-accent-strong",
          )}
        >
          <AudioLines className="h-[18px] w-[18px]" />
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[14px] font-medium",
            "text-muted-foreground",
          )}
        >
          {hint}
        </span>
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden rounded-full"
        >
          <MaterialRipple variant="gradient" effect="fill" />
        </span>
      </button>
      {/* Agent chat: a persistently visible filled/bordered button (not just
          a hover-state icon) so it reads as tappable at rest, matching the
          weight of a real button rather than a quiet icon-only affordance. */}
      <button
        type="button"
        data-testid="one-voice-agent-bar-start"
        onClick={openAgentChat}
        aria-label={`Open Agent Chat. ${hint}`}
        title="Open Agent Chat"
        className="relative grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full border border-[color:var(--app-accent-border)] bg-[color:var(--app-accent-tint)] text-accent-strong transition-colors duration-200 hover:bg-[color:var(--app-accent-surface)]"
      >
        <MessageCircle className="h-[17px] w-[17px]" />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden rounded-full"
        >
          <MaterialRipple variant="gradient" effect="fill" />
        </span>
      </button>
      {/* Theme toggle stays available on signed-in surfaces too, matching the
          pre-auth greeter row. */}
      {showToggles ? (
        <div className="flex shrink-0 items-center gap-1">
          {accentToggleButton}
          {themeToggleButton}
        </div>
      ) : null}
    </>
  );

  return (
    <div
      ref={agentBarShellRef}
      data-agent-bar-shell
      className={cn(
        "pointer-events-none fixed inset-x-0 flex flex-col items-center gap-3 px-4 transform-gpu",
        elevatedForInteractionLayer ? "z-[540]" : "z-[118]",
      )}
      style={
        {
          // --app-bottom-inset includes the measured nav, safe area, and lift.
          // The motion hook above translates this fixed sibling imperatively;
          // it does not re-render the voice tree as the page scrolls.
          bottom: useOnboardingChrome
            ? "calc(env(safe-area-inset-bottom, 0px) + 0.75rem)"
            : "calc(var(--app-bottom-inset) + 0.5rem)",
        } as CSSProperties
      }
      aria-hidden={barHidden}
    >
      {pendingConfirmation ? (
        <div
          role="dialog"
          aria-label="Confirm voice action"
          className="pointer-events-auto w-full max-w-[min(calc(100vw-3rem),392px)] rounded-3xl border border-black/10 bg-white/95 p-4 text-[#1d1d1f] shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-[#1c1c1e]/95 dark:text-[#f5f5f7]"
        >
          <p className="text-[13px] font-medium text-muted-foreground">
            {pendingActionNeedsTrustedActivation
              ? "Continue securely with"
              : "One is ready to"}
          </p>
          <p className="mt-1 text-[16px] font-semibold">{pendingActionLabel}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            {pendingActionNeedsTrustedActivation
              ? "This tap opens the provider window and keeps One active here."
              : "Sensitive values are hidden. Nothing runs until you confirm."}
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => settlePendingConfirmation(false)}
              className="h-10 rounded-full bg-black/[0.05] text-[14px] font-semibold dark:bg-white/[0.08]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => settlePendingConfirmation(true)}
              className="h-10 rounded-full bg-primary text-[14px] font-semibold text-primary-foreground"
            >
              {pendingActionNeedsTrustedActivation
                ? pendingActionLabel
                : "Confirm"}
            </button>
          </div>
        </div>
      ) : null}
      <div
        data-testid="one-voice-agent-bar"
        data-voice-mode={nativeVoiceMode}
        data-morphy-ax-presentation={runtime?.morphyAxPresentation ?? "idle"}
        className={cn(
          // z-0 (not just `relative`) is required so this pill forms its own
          // local stacking context: the `.one-bar-aurora -z-10` glow span
          // below then resolves ONE level behind THIS element, not behind
          // the whole `z-[118]` fixed wrapper it's nested in. Without z-0 the
          // active Gemini Live glow renders invisible/clipped behind other
          // page content instead of hugging the pill.
          "pointer-events-auto relative z-0 flex w-full items-center gap-2",
          // Onboarding: sit within the content card width; elsewhere wider.
          useOnboardingChrome
            ? "max-w-[min(calc(100vw-3rem),392px)]"
            : "max-w-[min(calc(100vw-2rem),34rem)]",
          "h-12 rounded-full pl-3 pr-1.5",
          // Single, consolidated transition covering surface color plus the
          // open/close fade+lift. Smoothly eases the bar in/out with the agent
          // window lifecycle so it never snaps back into place after closing.
          "transition-[opacity,transform,background-color,box-shadow] duration-300 ease-[cubic-bezier(0.16,0.84,0.28,1)] will-change-[opacity,transform]",
          // CANONICAL agent surface (from main): the exact material of the
          // opened agent window (white/95 + blur-xl + shadow-2xl, dark
          // #1c1c1e/95) so bar and window read as one continuous object.
          "backdrop-blur-xl",
          "bg-white/95 text-[#1d1d1f] shadow-2xl",
          "dark:bg-[#1c1c1e]/95 dark:text-[#f5f5f7]",
          // RIA: warm cream ask-bar pill (#F7F3EC) per the (1) design.
          isRiaChrome &&
            "!bg-[#f7f3ec] !text-[color:var(--ria-ink)] !shadow-none !backdrop-blur-none !ring-1 !ring-[color:var(--ria-divider-outer)]",
          barHidden
            ? "pointer-events-none translate-y-1 scale-[0.98] opacity-0"
            : "translate-y-0 scale-100 opacity-100",
          barAmbient && "pointer-events-none opacity-70",
        )}
      >
        {/* Aurora rim only while a live conversation is active, so motion
            always means something. Pre-auth keeps the same Foundation tone as
            the onboarding surface; no rainbow competes with One. */}
        {conversationActive ? (
          <span
            aria-hidden
            className={cn(
              "one-bar-aurora -z-10 transition-opacity duration-500",
              useOnboardingChrome
                ? "one-bar-aurora--onboarding"
                : "one-bar-aurora--active",
            )}
          />
        ) : null}
        {pillContents}
      </div>
    </div>
  );
}
