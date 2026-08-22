// components/agent/agent-bar.tsx
// Persistent, screen-aware agent launcher bar.
//
// A single sleek bar that spans across just above the bottom navbar + search on
// every authenticated screen. It replaces the old draggable floating "Agent"
// pill with the single voice entry point. Typed intent belongs to the bottom
// navigation Search control, which routes normal language into the same agent
// window without duplicating a second search affordance here.

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
import { AudioLines, MessageCircle, Monitor, Moon, Sun, X } from "lucide-react";
import { useTheme } from "next-themes";

import { useOptionalAgentPopover } from "@/components/agent/agent-popover-provider";
import { AgentVoiceWaveform } from "@/components/agent/agent-voice-waveform";
import { VoiceActionCard } from "@/components/agent/voice-action-card";
import { VoiceWalkthroughPanel } from "@/components/agent/voice-walkthrough-panel";
import { useAuth } from "@/hooks/use-auth";
import {
  executeAgentGatewayAction,
  executeTrustedActivationGatewayAction,
  type AgentActionRuntimeResult,
} from "@/lib/agent/agent-action-runtime";
import { settleAgentGatewayAction } from "@/lib/agent/agent-gateway-action-settlement";
import { useAgentRuntimeStateOptional } from "@/lib/agent/agent-runtime-context";
import { requiresHardTapConfirmation } from "@/lib/agent/confirmation-tap-policy";
import {
  readVoicePreferences,
  subscribeVoicePreferences,
} from "@/lib/agent/voice-preferences";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";
import { ApiService } from "@/lib/services/api-service";
import {
  getAgentVoiceStatusLabel,
  useAgentVoiceState,
} from "@/lib/agent/agent-voice-state";
import { AGENT_CONVERSATION_REQUEST_EVENT } from "@/lib/agent/agent-voice-settings";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { validateMorphyAxAssessment } from "@/lib/morphy-ax";
import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import {
  KAI_MARKET_PATH,
  ROUTES,
  isFoundationPublicRoute,
  isOneSetupRoute,
} from "@/lib/navigation/routes";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import { usePersonaState } from "@/lib/persona/persona-context";
import {
  appInteractionCoordinator,
  useActiveActionRun,
  useAppLifecycle,
  type DirectiveSettlement,
  type VoiceSessionLease,
} from "@/lib/interaction/interaction-intent-coordinator";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";
import {
  onGeminiRuntimeConfigurationChanged,
  resolveGeminiRuntimeConnection,
} from "@/lib/connections/gemini-runtime-configuration";
import { getVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { deriveVoiceRouteScreen } from "@/lib/voice/route-screen-derivation";
import { getKaiActionById } from "@/lib/voice/kai-action-gateway";
import { classifySpokenConfirmation } from "@/lib/voice/spoken-confirmation";
import {
  clearJourneyApproval,
  isCoveredByJourneyApproval,
  recordJourneyApproval,
} from "@/lib/voice/journey-approval-grant";
import {
  resolveJourneyPlanForGoal,
  resolveNavigationJourney,
  type JourneyPlan,
} from "@/lib/voice/navigation-journey";
import { useAccent, writeAccent } from "@/lib/theme/accent";
import {
  nextThemePreference,
  resolveThemePreference,
} from "@/lib/theme/theme-preference";
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
  leaseId: string;
  ledgerSessionId: string;
  actionRunId: string;
  transport: RealtimeVoiceTransport | null;
  contextRevision: string;
  receipt?: string;
  /** Set once the person has gone quiet on this card past the nudge window. */
  nudgedAt?: number | null;
  /**
   * The journey this directive opens, when it opens one. Present means the
   * card shows the whole plan and one approval covers its batchable steps.
   */
  plan?: JourneyPlan | null;
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

function routeMatchesVoiceContext(
  context: OneVoiceContextSnapshot,
  result: AgentActionRuntimeResult,
): boolean {
  const expectedRoute = String(result.routeAfter || "").split("?")[0];
  const expectedScreen = String(result.screenAfter || "").trim();
  return (
    (!expectedRoute || context.route.route_family === expectedRoute) &&
    (!expectedScreen || context.route.screen === expectedScreen)
  );
}

async function waitForDestinationVoiceContext(input: {
  readContext: () => OneVoiceContextSnapshot | null;
  result: AgentActionRuntimeResult;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<OneVoiceContextSnapshot | null> {
  const deadline = Date.now() + (input.timeoutMs ?? 1800);
  while (Date.now() <= deadline && !input.signal?.aborted) {
    const context = input.readContext();
    if (context && routeMatchesVoiceContext(context, input.result)) {
      return context;
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 25));
  }
  return null;
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

  return settleAgentGatewayAction(result, {
    getCurrentRoute: readBrowserVoiceRoute,
    getCurrentSurfaceMetadata: getVoiceSurfaceMetadata,
    timeoutMs: 1800,
  });
}


// A confirmation card waits for an explicit tap; this only decides when to
// nudge someone who's gone quiet on it. Nudging is a same-card text change,
// not a re-ask -- it never re-sends anything to the backend, and it fires at
// most once per card (see pendingConfirmationNudgeTimerRef).
const PENDING_CONFIRMATION_NUDGE_MS = 12_000;

// Screen-aware hint copy. First matching prefix wins, so order longest/most
// specific routes before their parents. Falls back to a generic prompt.
const AGENT_BAR_HINTS: ReadonlyArray<{ prefix: string; hint: string }> = [
  { prefix: ROUTES.KAI_ANALYSIS, hint: "Ask about this analysis" },
  { prefix: ROUTES.KAI_PORTFOLIO, hint: "Ask about your portfolio" },
  { prefix: KAI_MARKET_PATH, hint: "Ask about the markets" },
  { prefix: ROUTES.LEGACY_KAI_ANALYSIS, hint: "Ask about this analysis" },
  { prefix: ROUTES.LEGACY_KAI_PORTFOLIO, hint: "Ask about your portfolio" },
  { prefix: ROUTES.LEGACY_KAI_HOME, hint: "Ask about the markets" },
  { prefix: ROUTES.RIA_HOME, hint: "Ask about your practice" },
  { prefix: ROUTES.PKM, hint: "Ask about your memories" },
  { prefix: ROUTES.PROFILE_PKM, hint: "Ask about your memories" },
  { prefix: ROUTES.CONSENTS, hint: "Ask about your consents" },
  { prefix: ROUTES.LEGACY_CONSENTS, hint: "Ask about your consents" },
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

function directiveFingerprint(input: {
  actionId: string;
  goalId: string | null;
  needsConfirmation: boolean;
  slots: Record<string, unknown> | undefined;
}): string {
  // Directive ledgers must never retain action inputs. Slot names/types are
  // enough to reject conflicting reuse of an ID without retaining OTPs or
  // other sensitive values in client memory beyond the execution itself.
  const slots: Array<[string, string]> = Object.entries(input.slots ?? {})
    .map(
      ([key, value]): [string, string] => [
        key,
        Array.isArray(value) ? "array" : typeof value,
      ],
    )
    .sort((left, right) => left[0].localeCompare(right[0]));
  return JSON.stringify({
    actionId: input.actionId,
    goalId: input.goalId,
    needsConfirmation: input.needsConfirmation,
    slots,
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

export function AgentBar({ layout = "fixed" }: { layout?: "fixed" | "slot" }) {
  const agentBarShellRef = useRef<HTMLDivElement | null>(null);
  const pathname = usePathname();
  const router = useRouter();
  const agentPopover = useOptionalAgentPopover();
  // Shared single source of truth for the agent's active state. The bar uses it
  // for tier-aware presentation and to detect the home/onboarding surfaces
  // consistently with the chat workspace, instead of recomputing locally.
  const runtime = useAgentRuntimeStateOptional();
  const { user, loading: authLoading } = useAuth();
  const { theme, setTheme } = useTheme();
  const { vaultOwnerToken, vaultKey, isVaultUnlocked } = useVault();
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
  // The journey approval lives in module scope, not component state: it has
  // to survive the navigation it exists to span, and a ref does not survive a
  // remount. See lib/voice/journey-approval-grant.ts.
  const clearJourneyGrant = useCallback((reason: string) => {
    clearJourneyApproval(reason);
  }, []);
  const activeActionRun = useActiveActionRun();
  // Read directly rather than through AgentRuntimeState's snapshot: that
  // snapshot is deliberately the subset of preferences the backend relay
  // needs to see, and walk-through mode is a purely client-side rendering
  // choice with nothing for the relay to act on.
  const [walkthroughModeEnabled, setWalkthroughModeEnabled] = useState(
    () => readVoicePreferences(user?.uid).walkthroughMode,
  );
  useEffect(() => {
    setWalkthroughModeEnabled(readVoicePreferences(user?.uid).walkthroughMode);
    if (!user?.uid) return;
    return subscribeVoicePreferences(user.uid, (next) =>
      setWalkthroughModeEnabled(next.walkthroughMode),
    );
  }, [user?.uid]);
  const pendingConfirmationRef = useRef<PendingVoiceConfirmation | null>(null);
  const voiceStatus = useAgentVoiceState((s) => s.status);
  const voiceMessage = useAgentVoiceState((s) => s.message);
  const voiceLevel = useAgentVoiceState((s) => s.level);
  const setVoiceStatus = useAgentVoiceState((s) => s.setStatus);
  const setVoiceLevel = useAgentVoiceState((s) => s.setLevel);
  const resetVoice = useAgentVoiceState((s) => s.reset);
  const liveClientRef = useRef<RealtimeVoiceTransport | null>(null);
  const latestVoiceContextRef = useRef<OneVoiceContextSnapshot | null>(
    runtime?.oneVoiceContextSnapshot ?? null,
  );
  // UI state updates after async credential resolution. This lease reserves
  // microphone/transport ownership synchronously at the actual tap boundary.
  const voiceLeaseRef = useRef<VoiceSessionLease | null>(null);
  const activeRuntimeModeRef = useRef<"hushh_managed_vertex" | "byok" | null>(null);
  const lastTranscriptRef = useRef<{ text: string; atMs: number } | null>(null);
  const prewarmedRelayRef = useRef<PrewarmedGeminiRelay | null>(null);

  // Test-only dispatch entry point: invokes the same pure execution boundary a
  // real Gemini tool-call reaches, but skips the confirmation card and journey
  // grant machinery that wraps it in normal use. Automation supplies the
  // actionId/slots a voice turn would have produced; this proves the action
  // itself works end-to-end without simulating audio/STT.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const bridge = window.__HUSHH_NATIVE_TEST__;
    if (!bridge?.enabled) return undefined;

    const dispatch = async (actionId: string, slots?: Record<string, unknown>) => {
      bridge.dispatchAgentActionStatus = `running:${actionId}`;
      bridge.dispatchAgentActionError = "";
      const runtimeState = runtime?.appRuntimeState;
      if (!runtimeState) {
        const message = "App runtime state is not ready.";
        bridge.dispatchAgentActionStatus = `error:${actionId}`;
        bridge.dispatchAgentActionError = message;
        throw new Error(message);
      }
      try {
        const result = await executeAgentGatewayAction({
          actionId,
          slots: slots ?? {},
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
        });
        bridge.dispatchAgentActionStatus = `ok:${actionId}`;
        return result;
      } catch (error) {
        bridge.dispatchAgentActionStatus = `error:${actionId}`;
        bridge.dispatchAgentActionError =
          error instanceof Error ? error.message : "native action dispatch failed";
        throw error;
      }
    };

    bridge.dispatchAgentAction = dispatch;

    return () => {
      const currentBridge = window.__HUSHH_NATIVE_TEST__;
      if (currentBridge && currentBridge.dispatchAgentAction === dispatch) {
        currentBridge.dispatchAgentAction = null;
      }
    };
  }, [runtime, user?.uid, router, busyOperations, setAnalysisParams, switchPersona]);
  const relayMintInFlightRef = useRef(false);
  const relayMintCooldownUntilRef = useRef(0);
  const relayMintBackoffMsRef = useRef(5_000);
  // Voice stays active regardless of silence -- only explicit user action
  // (disabling voice, ending the call) closes the session now. This ref and
  // the schedule/clear helpers below are kept as inert no-ops rather than
  // removed outright, since callers throughout this file still call them at
  // every activity/resolution point; scheduleVoiceIdleTimer just no longer
  // arms anything.
  const idleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Nudges a confirmation card once if the person hasn't tapped Confirm/Cancel
  // within PENDING_CONFIRMATION_NUDGE_MS. Cleared the instant the card
  // resolves or is superseded, so it can never fire against a stale card.
  const pendingConfirmationNudgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
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
  const handleTransportEventRef = useRef<(event: OneVoiceSessionEvent) => void>(
    () => {},
  );
  // Same indirection, same reason: a spoken yes is read inside
  // handleTransportEvent, and settlePendingConfirmation is declared well below
  // it.
  const settlePendingConfirmationRef = useRef<(confirmed: boolean) => void>(
    () => {},
  );

  useEffect(() => {
    latestVoiceContextRef.current = runtime?.oneVoiceContextSnapshot ?? null;
  }, [runtime?.oneVoiceContextSnapshot]);

  const clearVoiceIdleTimer = useCallback(() => {
    if (idleTimeoutRef.current) {
      clearTimeout(idleTimeoutRef.current);
      idleTimeoutRef.current = null;
    }
  }, []);

  const clearPendingConfirmationNudgeTimer = useCallback(() => {
    if (pendingConfirmationNudgeTimerRef.current) {
      clearTimeout(pendingConfirmationNudgeTimerRef.current);
      pendingConfirmationNudgeTimerRef.current = null;
    }
  }, []);

  // No auto-close on silence: voice stays active until the user explicitly
  // disables it. Kept as a callback (rather than removing every call site)
  // so activity/resolution points elsewhere don't need to change.
  const scheduleVoiceIdleTimer = useCallback(() => {
    clearVoiceIdleTimer();
  }, [clearVoiceIdleTimer]);

  const abandonPendingConfirmation = useCallback(
    (reason: string, summary: string, clearUi = true) => {
      const pending = pendingConfirmationRef.current;
      if (!pending) return;
      pendingConfirmationRef.current = null;
      clearPendingConfirmationNudgeTimer();
      if (clearUi) {
        setPendingConfirmation(null);
      }
      if (voiceLeaseRef.current?.id !== pending.leaseId) return;
      pending.transport?.reportActionSettlement?.({
        directiveId: pending.directiveId,
        actionId: pending.actionId,
        contextRevision: pending.contextRevision,
        status: "blocked",
        summary,
        reason,
        receipt: pending.receipt,
      });
      appInteractionCoordinator.settleDirective(
        pending.ledgerSessionId,
        pending.directiveId,
        {
          status: "blocked",
          summary,
          reason,
        },
      );
      appInteractionCoordinator.updateActionRun(pending.actionRunId, {
        phase: "cancelled",
        message: summary,
      });
    },
    [clearPendingConfirmationNudgeTimer],
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
        clearJourneyGrant("transport_error");
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
        // A confirmation that is waiting gets first refusal on this utterance.
        //
        // This is what makes the flow hands-free without giving up the
        // consent it collects: the tap is replaced by a spoken yes, and the
        // yes still runs through settlePendingConfirmation -- the same path,
        // the same ledger, the same receipt. What changed is the trigger, not
        // the proof.
        //
        // The reading is done HERE, from the person's own transcript, and not
        // by the model. The model is the thing being authorized; letting it
        // also report whether you agreed would have it witness its own
        // authorization. Anything that is not unmistakably an answer falls
        // through to be treated as ordinary speech, exactly as before.
        if (pendingConfirmationRef.current) {
          const answer = classifySpokenConfirmation(event.text);
          // The only record that a spoken yes was even considered. Without it
          // a confirmation settled by tap and one settled by voice are the
          // same success in every log, so "I had to click" could not be told
          // apart from "the classifier declined the utterance" -- and the
          // whole hands-free claim rested on not knowing the difference.
          // Word count only; the transcript itself never goes to telemetry.
          console.info(
            `[VOICE_CONFIRM] action=${pendingConfirmationRef.current.actionId} ` +
              `classified=${answer} words=${event.text.trim().split(/\s+/).length}`,
          );
          if (answer === "affirm" || answer === "decline") {
            appendMirrorEvent({
              role: "user",
              text: redactSensitiveVoiceTranscript(
                event.text.trim(),
                runtime?.screen,
              ),
              source: "gemini_live",
              turnId: event.turnId ?? null,
            });
            settlePendingConfirmationRef.current(answer === "affirm");
            return;
          }
        }
        actionAbortControllerRef.current?.abort();
        // A fresh request supersedes the plan the person approved for the last
        // one. Approval was for a named list, not for whatever One does next.
        clearJourneyGrant("new_user_intent");
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
        // A pending confirmation card holds through arbitrary speech -- it is
        // only replaced when the model actually proposes a new action
        // directive (handled where client_directive is processed below).
        // Tearing it down on every transcript made verbal replies to the
        // card (or unrelated chatter) kill it before One could react.
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
            // Capture the issuer. A later session must never receive a
            // settlement produced by this transport's async action work.
            const directiveTransport = liveClientRef.current;
            const directiveId =
              typeof event.directive.payload?.directiveId === "string"
                ? event.directive.payload.directiveId
                : null;
            const slots =
              event.directive.payload?.slots &&
              typeof event.directive.payload.slots === "object"
                ? (event.directive.payload.slots as Record<string, unknown>)
                : undefined;
            const contextRevision =
              typeof event.directive.payload?.contextRevision === "string"
                ? event.directive.payload.contextRevision
                : null;
            // The relay decides this from the contract and stamps it on the
            // directive. Read it rather than deciding again here.
            //
            // Both sides were hardcoded true. Changing only this one made
            // every allow_direct action run in the browser and then fail
            // settlement, because the directive being settled had been parked
            // server-side as needing a confirmation that never came. They are
            // one invariant with two expressions; reading the stamped value is
            // what stops them drifting apart again.
            //
            // Absent or malformed means confirm. A directive that cannot say
            // it is safe to run directly does not get to run directly.
            const needsConfirmation =
              event.directive.payload?.needsConfirmation !== false;
            const goalId =
              typeof event.directive.payload?.goalId === "string"
                ? event.directive.payload.goalId
                : null;
            // The relay only stamps goalId on a directive it minted for an
            // authored journey. Honor it when the id matches THAT action's own
            // journey and we are standing on its declared destination -- read
            // from the contract, so a second journey needs no change here.
            const directiveJourney = actionId
              ? resolveNavigationJourney(actionId)
              : null;
            const isSettledJourneyDirective = Boolean(
              directiveJourney &&
                goalId === directiveJourney.goalId &&
                runtime?.appRuntimeState.route.screen ===
                  directiveJourney.destinationScreen,
            );
            if (!directiveId || !contextRevision) {
              console.warn(
                "[AgentBar] Rejected action directive without server confirmation binding.",
              );
              return;
            }
            const directiveLedgerSessionId =
              eventOptions.sessionId ?? voiceLeaseRef.current?.id ?? "unknown";
            const directiveLeaseId = voiceLeaseRef.current?.id ?? null;
            if (!directiveLeaseId) {
              return;
            }
            let actionRunId: string | null = null;
            // A step covered by a journey approval never arms a confirmation
            // card, so there is no pendingConfirmation to carry its receipt.
            // The ledger still requires one to settle: a receipt-less success
            // is refused as "settlement receipt required", the directive never
            // closes, and the goal loops. The approval was real -- it was given
            // for the whole plan up front -- so this holds the receipt minted
            // for it without a second card.
            let journeyGrantReceipt: string | undefined;
            const reportDirectiveSettlement = (settlement: DirectiveSettlement) => {
              if (
                voiceLeaseRef.current?.id !== directiveLeaseId
              ) {
                return;
              }
              directiveTransport?.reportActionSettlement?.({
                directiveId,
                actionId,
                contextRevision,
                ...settlement,
                receipt: pendingConfirmationRef.current?.receipt ?? journeyGrantReceipt,
              });
              appInteractionCoordinator.settleDirective(
                directiveLedgerSessionId,
                directiveId,
                settlement,
              );
              if (actionRunId) {
                appInteractionCoordinator.finishActionRunFromSettlement(
                  actionRunId,
                  settlement,
                );
              }
            };
            const directiveLease = appInteractionCoordinator.beginDirective({
              sessionId: directiveLedgerSessionId,
              directiveId,
              fingerprint: directiveFingerprint({
                actionId,
                goalId,
                needsConfirmation,
                slots,
              }),
            });
            if (directiveLease.state === "duplicate") {
              if (directiveLease.settlement) {
                directiveTransport?.reportActionSettlement?.({
                  directiveId,
                  actionId,
                  contextRevision,
                  ...directiveLease.settlement,
                });
              }
              return;
            }
            if (directiveLease.state === "conflict") {
              reportDirectiveSettlement({
                status: "blocked",
                summary: "The directive did not match its original request.",
                reason: "directive_id_conflict",
              });
              return;
            }
            const action = getKaiActionById(actionId);
            if (!action) {
              reportDirectiveSettlement({
                status: "invalid",
                summary: "That action is not available in this app.",
                reason: "unknown_action",
              });
              return;
            }
            // An unbound, replayed, conflicting, or unknown frame must not
            // be able to cancel a legitimate confirmation already on screen.
            // Only a newly admitted action proposal supersedes it.
            abandonPendingConfirmation(
              "superseded_by_new_directive",
              "The prior confirmation was replaced by a newer action proposal.",
            );
            const actionRun = appInteractionCoordinator.startActionRun({
              actionId,
              label: action.label,
              source: "voice",
              directiveId,
              goalId,
              message: `Preparing ${action.label}`,
            });
            actionRunId = actionRun.id;
            if (runtime?.morphyAxEnabled && !isSettledJourneyDirective) {
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
                {
                  reportDirectiveSettlement({
                    status: "blocked",
                    summary:
                      "The requested action is not available on this screen.",
                    reason: `morphy_ax_${decision.status}`,
                  });
                }
                return;
              }
            }
            // A step the person already approved as part of this journey's
            // plan runs without asking again. The grant names the goal AND the
            // action, so a directive that drifts to a different goal or a step
            // outside the approved list still gets its own card.
            const coveredByJourneyGrant = isCoveredByJourneyApproval(
              goalId,
              actionId,
            );
            if (needsConfirmation && !coveredByJourneyGrant) {
              // Keep sensitive arguments transient in component memory. The
              // confirmation card never renders slots (including OTP values).
              abandonPendingConfirmation(
                "confirmation_superseded",
                "A newer confirmation replaced the pending action.",
              );
              // When this directive opens an authored journey, show the whole
              // plan rather than its first step. Approving a named list is
              // what makes one tap honest instead of a blank cheque.
              // Resolved from the GOAL: the first directive of a journey is
              // its navigation step, and a route action is never a journey in
              // its own right, so resolving by action id found nothing.
              const journeyPlan = goalId
                ? resolveJourneyPlanForGoal(goalId)
                : null;
              const pending = {
                directiveId,
                actionId,
                slots,
                route: pathname,
                leaseId: directiveLeaseId,
                ledgerSessionId: directiveLedgerSessionId,
                actionRunId: actionRun.id,
                transport: directiveTransport,
                contextRevision,
                plan:
                  journeyPlan && journeyPlan.goalId === goalId
                    ? journeyPlan
                    : null,
              };
              pendingConfirmationRef.current = pending;
              setPendingConfirmation(pending);
              // A confirmation card holds until the person acts. Silence must
              // not kill the whole voice session out from under someone who's
              // just reading it -- suspend the global idle timer for as long
              // as this card is up, and nudge once (text-only, no re-ask) if
              // they haven't responded after PENDING_CONFIRMATION_NUDGE_MS.
              clearVoiceIdleTimer();
              clearPendingConfirmationNudgeTimer();
              pendingConfirmationNudgeTimerRef.current = setTimeout(() => {
                pendingConfirmationNudgeTimerRef.current = null;
                setPendingConfirmation((prev) =>
                  prev && prev.directiveId === directiveId
                    ? { ...prev, nudgedAt: Date.now() }
                    : prev,
                );
              }, PENDING_CONFIRMATION_NUDGE_MS);
              directiveTransport?.interrupt?.();
              appInteractionCoordinator.updateActionRun(actionRun.id, {
                phase: "awaiting_confirmation",
              });
              setVoiceStatus("thinking", "Confirmation needed", eventOptions);
              return;
            }
            const runtimeState = runtime?.appRuntimeState;
            if (!runtimeState) {
              {
                reportDirectiveSettlement({
                  status: "failed",
                  summary: "The app was not ready to run that action.",
                  reason: "missing_runtime_state",
                });
              }
              return;
            }
            void (async () => {
              try {
                // The person approved this whole plan at the batch card, so no
                // second card is shown -- but the ledger still needs the
                // one-time receipt that proves this directive was authorized.
                // Minting it here is the mechanical half of an approval that
                // already happened, not another ask.
                if (coveredByJourneyGrant) {
                  const confirmation =
                    await directiveTransport?.confirmActionDirective?.({
                      directiveId,
                      actionId,
                      contextRevision,
                    });
                  journeyGrantReceipt = confirmation?.receipt;
                  if (!journeyGrantReceipt) {
                    // Nothing runs without ledger authority, approval or not.
                    reportDirectiveSettlement({
                      status: "failed",
                      summary: "The approved step could not be authorized.",
                      reason: "journey_receipt_unavailable",
                    });
                    return;
                  }
                }
                appInteractionCoordinator.updateActionRun(actionRun.id, {
                  phase: "executing",
                });
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
                  goalAuthorization:
                    isSettledJourneyDirective && directiveJourney
                      ? {
                          goalId: directiveJourney.goalId,
                          expectedScreen: directiveJourney.destinationScreen,
                        }
                      : null,
                });
                if (executionResult.routeAfter) {
                  appInteractionCoordinator.updateActionRun(actionRun.id, {
                    phase: "navigating",
                    message: `Opening ${action?.label ?? "your request"}`,
                  });
                }
                const result = await settleAgentBarAction(executionResult);
                let destinationContextId: string | null = null;
                if (result.routeAfter) {
                  const destinationContext = await waitForDestinationVoiceContext({
                    readContext: () => latestVoiceContextRef.current,
                    result,
                    signal: actionAbortControllerRef.current?.signal,
                  });
                  if (destinationContext) {
                    const applied =
                      await directiveTransport?.applyContextAndWait?.(
                        destinationContext,
                        { signal: actionAbortControllerRef.current?.signal },
                      );
                    if (applied?.status === "acknowledged") {
                      destinationContextId = applied.contextId;
                    }
                  }
                }
                reportDirectiveSettlement({
                    status: result.status,
                    summary: result.resultSummary,
                    reason: result.reason,
                    routeAfter: result.routeAfter,
                    screenAfter: result.screenAfter,
                    destinationContextId,
                });
              } catch {
                reportDirectiveSettlement({
                    status: "failed",
                    summary: "The app could not complete that action.",
                    reason: "client_execution_failed",
                });
              }
            })();
            return;
          }
        }
        if (event.directive.kind !== "action" && event.directive.kind !== "prompt") {
          return;
        }
        // Specialist directive (location share/check-in/SOS, device
        // permission re-ask, connected-systems update, or a Nav consent
        // prompt) rather than a run_app_action directive. It needs the chat
        // surface's audited specialist runtime; preserve the relay envelope
        // so prompt cards retain their owning specialist and exact kind.
        const delegateAgentId = event.directive.delegateAgentId ?? null;
        const directiveType =
          typeof event.directive.payload?.kind === "string"
            ? event.directive.payload.kind
            : typeof event.directive.payload?.type === "string"
              ? event.directive.payload.type
              : "this";
        // SOS dispatches for real: `sos_panic` captures the current position
        // and publishes it to every ready emergency contact
        // (specialist-directive-runtime.ts). The visible control requires a
        // two-second press-and-hold precisely so that cannot happen by
        // accident -- and a spoken "yes", or a tap on a card One put there,
        // is not that gesture. The two paths were quietly enforcing different
        // standards for the same irreversible act.
        //
        // Voice's job here is to get someone to the control fast, not to
        // stand in for it. Open SOS and stop; the press-and-hold stays the
        // only thing that sends.
        if (delegateAgentId === "agent_location" && directiveType === "sos_panic") {
          router.push("/one/location?action=sos");
          return;
        }
        const handoff = createHandoff({
          reason: "action_requires_chat",
          transcript: null,
          assistantText: `One line this up for you: ${directiveType}. Confirm here to continue.`,
          specialistDirective: delegateAgentId
            ? {
                delegateAgentId,
                directive: {
                  kind: event.directive.kind,
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
        clearJourneyGrant("session_closed");
        abandonPendingConfirmation(
          "session_closed",
          "The confirmation was cancelled when the voice session closed.",
        );
        liveClientRef.current = null;
        voiceLeaseRef.current?.release("transport_closed");
        voiceLeaseRef.current = null;
        activeRuntimeModeRef.current = null;
        if (erroredRef.current) return;
        setConversationActive(false);
      }
    },
    [
      agentPopover,
      abandonPendingConfirmation,
      appendMirrorEvent,
      clearJourneyGrant,
      busyOperations,
      clearPendingConfirmationNudgeTimer,
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

  useEffect(() => {
    handleTransportEventRef.current = handleTransportEvent;
  }, [handleTransportEvent]);

  const stopConversation = useCallback(() => {
    actionAbortControllerRef.current?.abort();
    appInteractionCoordinator.cancelActiveActionRuns("Action cancelled when the voice session ended");
    clearVoiceIdleTimer();
    erroredRef.current = false;
    abandonPendingConfirmation(
      "session_cancelled",
      "The confirmation was cancelled when the voice session ended.",
    );
    liveClientRef.current?.stop();
    liveClientRef.current = null;
    voiceLeaseRef.current?.release("voice_session_stopped");
    voiceLeaseRef.current = null;
    activeRuntimeModeRef.current = null;
    prewarmedRelayRef.current = null;
    setConversationActive(false);
    resetVoice();
  }, [abandonPendingConfirmation, clearVoiceIdleTimer, resetVoice]);

  const settlePendingConfirmation = useCallback(
    (confirmed: boolean) => {
      const pending = pendingConfirmationRef.current;
      if (!pending) return;
      pendingConfirmationRef.current = null;
      clearPendingConfirmationNudgeTimer();
      setPendingConfirmation(null);
      // Approving a plan authorizes its remaining batchable steps, so the
      // person is not asked again for work they just agreed to. Only on a
      // real approval, and only for the ids the plan enumerated.
      if (confirmed && pending.plan?.batchableActionIds.length) {
        recordJourneyApproval(
          pending.plan.goalId,
          pending.plan.batchableActionIds,
        );
      }
      const reportPendingSettlement = (settlement: DirectiveSettlement) => {
        if (voiceLeaseRef.current?.id !== pending.leaseId) return;
        pending.transport?.reportActionSettlement?.({
          directiveId: pending.directiveId,
          actionId: pending.actionId,
          contextRevision: pending.contextRevision,
          ...settlement,
          receipt: pending.receipt,
        });
        appInteractionCoordinator.settleDirective(
          pending.ledgerSessionId,
          pending.directiveId,
          settlement,
        );
        appInteractionCoordinator.finishActionRunFromSettlement(
          pending.actionRunId,
          settlement,
        );
      };
      if (!confirmed) {
        reportPendingSettlement({
          status: "blocked",
          summary: "The person cancelled the confirmation.",
          reason: "user_cancelled",
        });
        setVoiceStatus("listening", "Listening");
        // The confirm/success/failure branches below all resume the idle
        // timer; declining a proposal must too, or the session is left
        // without an idle timer running at all until the next activity.
        scheduleVoiceIdleTimer();
        return;
      }
      if (!pending.receipt) {
        const confirmationTransport = pending.transport;
        if (!confirmationTransport?.confirmActionDirective) {
          reportPendingSettlement({
            status: "failed",
            summary: "The confirmation service was unavailable.",
            reason: "confirmation_authority_unavailable",
          });
          return;
        }
        setVoiceStatus("thinking", "Authorizing confirmation");
        // Invoke through its owning transport. Extracting this class method and
        // calling it bare loses the GeminiLiveClient receiver (`this.ws`).
        void confirmationTransport.confirmActionDirective({
          directiveId: pending.directiveId,
          actionId: pending.actionId,
          contextRevision: pending.contextRevision,
        })
          .then((confirmation) => {
            if (voiceLeaseRef.current?.id !== pending.leaseId) return;
            const authorized = { ...pending, receipt: confirmation.receipt };
            const confirmingAction = getKaiActionById(pending.actionId);
            const requiresRealTap = requiresHardTapConfirmation(
              confirmingAction,
              runtime?.oneVoiceContextSnapshot.voice_settings.require_tap_confirmation ===
                true,
            );
            if (requiresRealTap) {
              // A popup must be opened during a fresh physical gesture. The
              // first tap only receives ledger authority; preserve the second
              // tap as the platform-required activation boundary.
              pendingConfirmationRef.current = authorized;
              setPendingConfirmation(authorized);
              appInteractionCoordinator.updateActionRun(pending.actionRunId, {
                phase: "awaiting_confirmation",
                message: "Authorized. Tap to continue.",
              });
              setVoiceStatus("thinking", "Tap to continue");
              return;
            }
            // A spoken yes is the confirmation, not a preliminary tap. Keep
            // the receipt in the same pending slot and immediately take the
            // normal authorized execution path exactly once.
            pendingConfirmationRef.current = authorized;
            settlePendingConfirmationRef.current(true);
          })
          .catch(() => {
            reportPendingSettlement({
              status: "failed",
              summary: "That confirmation expired or was already used.",
              reason: "confirmation_rejected",
            });
          });
        return;
      }
      const runtimeState = runtime?.appRuntimeState;
      if (!runtimeState) {
        reportPendingSettlement({
          status: "failed",
          summary: "The app was not ready to confirm that action.",
          reason: "missing_runtime_state",
        });
        return;
      }
      setVoiceStatus("thinking", "Confirming");
      appInteractionCoordinator.updateActionRun(pending.actionRunId, {
        phase: "executing",
      });
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
        .then((executionResult) => {
          if (executionResult.routeAfter) {
            appInteractionCoordinator.updateActionRun(pending.actionRunId, {
              phase: "navigating",
              message: `Opening ${getKaiActionById(pending.actionId)?.label ?? "your request"}`,
            });
          }
          return executionResult;
        })
        .then(settleAgentBarAction)
        .then((result) => {
          scheduleVoiceIdleTimer();
          reportPendingSettlement({
            status: result.status,
            summary: result.resultSummary,
            reason: result.reason,
            routeAfter: result.routeAfter,
            screenAfter: result.screenAfter,
          });
        })
        .catch(() => {
          scheduleVoiceIdleTimer();
          reportPendingSettlement({
            status: "failed",
            summary: "The app could not complete the confirmed action.",
            reason: "client_execution_failed",
          });
        });
    },
    [
      busyOperations,
      clearPendingConfirmationNudgeTimer,
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
    settlePendingConfirmationRef.current = settlePendingConfirmation;
  }, [settlePendingConfirmation]);

  useEffect(() => {
    const pending = pendingConfirmationRef.current;
    if (!pending || pending.route === pathname) return;
    abandonPendingConfirmation(
      "route_changed",
      "The confirmation was cancelled because the screen changed.",
    );
  }, [abandonPendingConfirmation, pathname]);

  const startConversation = useCallback(async () => {
    // Toggle off when a session (live OR an error still on screen) exists.
    if (voiceLeaseRef.current && !liveClientRef.current && !conversationActive) {
      // A second native tap while credentials are resolving is the same start
      // request, not a toggle. Coalesce it so one mic/socket survives.
      return;
    }
    if (liveClientRef.current || erroredRef.current || conversationActive) {
      stopConversation();
      return;
    }
    const lease = appInteractionCoordinator.acquireVoiceLease({
      owner: "one_live",
      onRevoked: () => stopConversationRef.current(),
    });
    voiceLeaseRef.current = lease;
    const runtimeConnection = await resolveGeminiRuntimeConnection({
      userId: user?.uid,
      vaultKey,
      vaultOwnerToken,
    });
    if (!lease.isCurrent() || voiceLeaseRef.current?.id !== lease.id) {
      return;
    }
    if (runtimeConnection.mode === "byok" && !runtimeConnection.credential) {
      erroredRef.current = true;
      setVoiceStatus("error", "Your Gemini key is unavailable. Open Connections settings.");
      lease.release("missing_runtime_credential");
      voiceLeaseRef.current = null;
      return;
    }
    if (runtimeConnection.transport === "vertex_api_key") {
      erroredRef.current = true;
      setVoiceStatus(
        "error",
        "Your Google Cloud Vertex key is ready for typed turns. Use managed Gemini for voice.",
      );
      lease.release("unsupported_voice_transport");
      voiceLeaseRef.current = null;
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
      onEvent: (event) => {
        if (!lease.isCurrent() || voiceLeaseRef.current?.id !== lease.id) {
          return;
        }
        handleTransportEventRef.current(event);
      },
    });
    liveClientRef.current = client;
    activeRuntimeModeRef.current = runtimeConnection.mode;
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
      runtimeCredentialMode: runtimeConnection.mode,
      runtimeCredential: runtimeConnection.credential,
      runtimeCredentialTransport: runtimeConnection.transport,
      runtimeVertexProject: runtimeConnection.vertexProject,
      runtimeVertexLocation: runtimeConnection.vertexLocation,
    });
  }, [
    conversationActive,
    runtime?.oneVoiceContextSnapshot,
    runtime?.tier,
    mirrorSessionId,
    scheduleVoiceIdleTimer,
    stopConversation,
    vaultOwnerToken,
    vaultKey,
    user?.uid,
    setVoiceStatus,
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
  // and specialist tools (for example, Location) fail closed for the rest of
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
      void startConversation();
    },
    [startConversation],
  );

  useEffect(() => {
    const handleConversationRequest = () => {
      void startConversation();
    };
    window.addEventListener(
      AGENT_CONVERSATION_REQUEST_EVENT,
      handleConversationRequest,
    );
    return () => {
      window.removeEventListener(
        AGENT_CONVERSATION_REQUEST_EVENT,
        handleConversationRequest,
      );
    };
  }, [startConversation]);

  const openAgentChat = useCallback(() => {
    if (conversationActive) return;
    agentPopover?.openAgent();
  }, [agentPopover, conversationActive]);

  useEffect(() => {
    return onGeminiRuntimeConfigurationChanged(() => {
      if (activeRuntimeModeRef.current === "byok") {
        stopConversation();
      }
    });
  }, [stopConversation]);

  useEffect(() => {
    if (!isVaultUnlocked && activeRuntimeModeRef.current === "byok") {
      stopConversation();
    }
  }, [isVaultUnlocked, stopConversation]);

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
      // The snapshot identity churns on every navigation and cache event, so
      // this effect re-fires constantly. The ticket is context-free (context
      // rides in post-connect app_context frames) — reuse an unexpired one,
      // never mint concurrently, and back off after a rate limit instead of
      // hammering the relay endpoint on every snapshot change.
      const existing = prewarmedRelayRef.current;
      if (
        existing &&
        existing.accessTier === accessTier &&
        existing.expiresAtMs > Date.now()
      ) {
        return;
      }
      if (relayMintInFlightRef.current) return;
      if (Date.now() < relayMintCooldownUntilRef.current) return;
      relayMintInFlightRef.current = true;
      void ApiService.getOneAdkLiveRelayUrl({ signal: controller.signal })
        .then((relayUrl) => {
          relayMintInFlightRef.current = false;
          relayMintBackoffMsRef.current = 5_000;
          if (controller.signal.aborted) return;
          prewarmedRelayRef.current = {
            relayUrl,
            expiresAtMs: Date.now() + 45_000,
            snapshotId: context.snapshot_id,
            accessTier,
          };
        })
        .catch((error: unknown) => {
          relayMintInFlightRef.current = false;
          const status =
            typeof error === "object" && error !== null
              ? Number((error as { status?: unknown }).status)
              : NaN;
          if (status === 429) {
            relayMintCooldownUntilRef.current =
              Date.now() + relayMintBackoffMsRef.current;
            relayMintBackoffMsRef.current = Math.min(
              relayMintBackoffMsRef.current * 2,
              60_000,
            );
          }
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

  // Not a raw `visibilitychange` listener: that event alone is known to be
  // unreliable inside the native iOS/Android WebView shell, which is exactly
  // where a leaked-open mic matters most. `appInteractionCoordinator`
  // already merges DOM visibility with Capacitor's native `appStateChange`
  // into one verdict -- this is the one place in the app that must react to
  // real backgrounding, so it reads that verdict instead of duplicating half
  // of it.
  const appLifecycle = useAppLifecycle();
  useEffect(() => {
    if (appLifecycle.state !== "background") return;
    prewarmedRelayRef.current = null;
    if (liveClientRef.current || conversationActive) {
      stopConversation();
    }
  }, [
    appLifecycle.state,
    appLifecycle.revision,
    conversationActive,
    stopConversation,
  ]);

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
  
  // The visual styling of the bar (width, aurora, etc.) aligns with the chat
  // workspace's concept of onboarding.
  const visualOnboardingChrome =
    (runtime?.onboardingActive ?? chromeState.useOnboardingChrome) ||
    isHomeRoute ||
    isLoginRoute ||
    isFoundationPublic;

  // The physical navbar rendering strictly follows path and auth state. We use
  // this strictly for positioning to avoid overlapping the navbar if the cloud
  // state (runtime.onboardingActive) lags behind the local pathname.
  const physicalNavbarAbsent =
    !user ||
    chromeState.useOnboardingChrome ||
    isHomeRoute ||
    isLoginRoute ||
    isFoundationPublic;

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
    // startConversation(); // Disabled per user request (no auto-voice/listening)
    // Intentionally excludes startConversation/conversationActive from deps:
    // this must fire exactly once per onboarding mount, not re-run whenever
    // those identities change (they change on every voice status transition).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboardingGreeterMode]);

  const unmountBar =
    !agentPopover ||
    authLoading ||
    // Focused onboarding routes retain voice but use the voice-only rendering
    // branch above, so Agent Chat never appears over setup or phone entry.
    path === ROUTES.AGENT ||
    // "/login" keeps the bar (signed-out onboarding greeter, parity with "/");
    // only the logout transition unmounts it.
    path.startsWith(ROUTES.LOGOUT) ||
    runtime?.oneVoiceContextSnapshot.ui.interaction_layer?.agent_continuity ===
      "suppressed";

  const appAccent = useAccent();

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
  const pendingConfirmationPlanSteps = pendingConfirmation?.plan?.steps ?? [];
  const pendingActionNeedsTrustedActivation =
    pendingAction?.activation_policy === "trusted_activation_required";
  const pendingActionLabel = pendingAction?.label || "Continue this action";

  // The specific reason (e.g. mic blocked, no device) now has its own card
  // below, so the pill only ever needs the short, generic status label --
  // showing the full reason here too just repeated it, truncated mid-word.
  const voiceStatusLabel =
    activeActionRun?.message ?? getAgentVoiceStatusLabel(voiceStatus);
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

  const currentThemePreference = resolveThemePreference(theme) ?? "system";
  const nextTheme = nextThemePreference(currentThemePreference);
  const themeToggleButton = (
    <button
      type="button"
      onClick={() => setTheme(nextTheme)}
      aria-label={`Theme: ${currentThemePreference}. Switch to ${nextTheme}`}
      title={`Theme: ${currentThemePreference}. Switch to ${nextTheme}`}
      className="relative grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full text-current transition-colors duration-200 hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
    >
      {currentThemePreference === "system" ? (
        <Monitor className="h-[17px] w-[17px]" />
      ) : currentThemePreference === "dark" ? (
        <Moon className="h-[17px] w-[17px]" />
      ) : (
        <Sun className="h-[17px] w-[17px]" />
      )}
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
      className="relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full transition-colors duration-200 hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
    >
      <span
        style={{
          backgroundColor:
            appAccent === "gold"
              ? "var(--foundation-gold-dark, #C3A354)"
              : "var(--app-accent)",
        }}
        className="relative z-10 block h-[18px] w-[18px] rounded-full shadow-[inset_0_1px_3px_rgba(0,0,0,0.2)] border border-black/10 dark:border-white/10 transition-colors duration-200"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden rounded-full"
      >
        <MaterialRipple variant="gradient" effect="fill" />
      </span>
    </button>
  );

  // During onboarding and on foundation public routes, show the theme and accent toggles
  const showToggles = onboardingGreeterMode || isOneSetupRoute(pathname || "") || isFoundationPublic;
  const showAgentChatAction = Boolean(
    user?.uid &&
      !focusedOnboardingVoiceOnly &&
      !isHomeRoute &&
      !isLoginRoute &&
      !isFoundationPublic,
  );
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
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-current">
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
                : "tabular-nums text-current/60",
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
  ) : (
    // One shared idle launcher across onboarding and signed-in surfaces.
    // Onboarding adds only its appearance controls; it does not fork the
    // interaction hierarchy, hit target, motion, or voice entry contract.
    <>
      <button
        type="button"
        data-native-voice-control-id="one_voice_agent_bar_start"
        data-testid="one-voice-agent-bar-start-icon"
        onClick={handleVoiceStartClick}
        aria-label={`Start a voice conversation. ${hint}`}
        title="Start a voice conversation with One"
        className="agent-bar-voice-launcher press-scale relative flex min-w-0 flex-1 self-stretch items-center gap-2 overflow-hidden rounded-full px-2 text-left transition-[background-color,transform] duration-200 hover:bg-current/[0.09] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--app-accent-ring)] dark:hover:bg-current/[0.12]"
      >
        <span
          aria-hidden
          className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-current"
        >
          <AudioLines className="h-[19px] w-[19px]" />
        </span>
        <span className="relative z-10 min-w-0 flex-1 truncate text-[13px] font-medium text-current/70">
          Talk to One
        </span>
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-full"
        >
          <MaterialRipple variant="gradient" effect="fill" />
        </span>
      </button>
      {showAgentChatAction ? (
        <button
          type="button"
          data-testid="one-agent-chat-open"
          onClick={openAgentChat}
          aria-label={`Open Agent Chat. ${hint}`}
          title="Open Agent Chat"
          className="relative grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full bg-current/[0.055] text-current transition-colors duration-200 hover:bg-current/[0.09]"
        >
          <MessageCircle className="h-[17px] w-[17px]" />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-hidden rounded-full"
          >
            <MaterialRipple variant="gradient" effect="fill" />
          </span>
        </button>
      ) : null}
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
      data-ui-role="talk-to-one"
      data-agent-bar-layout={layout}
      data-ambient-chrome-ignore
      className={cn(
        "pointer-events-none flex flex-col items-center",
        layout === "slot"
          ? "w-full"
          : "fixed inset-x-0 gap-3 px-4 transform-gpu",
        layout === "fixed" && (elevatedForInteractionLayer ? "z-[540]" : "z-[118]"),
      )}
      style={
        layout === "fixed"
          ? ({
              bottom: physicalNavbarAbsent
                ? "calc(var(--app-safe-area-bottom-effective) + 0.75rem)"
                : "var(--agent-bar-with-nav-bottom)",
            } as CSSProperties)
          : undefined
      }
      aria-hidden={barHidden}
    >
      {/* Sits above the approval card and never with it: a disambiguation is
          raised when an action could not run at all, so there is nothing
          pending to confirm at the same moment. */}
      <VoiceActionCard />
      <VoiceWalkthroughPanel enabled={walkthroughModeEnabled} />
      {/* A connection-level failure (mic blocked, no device, unsupported
          browser) happens before any session exists, so there is nothing to
          confirm and nothing pending -- just a reason and a way out. Shown
          as its own card instead of packed into the pill's truncated status
          text, which cut mid-sentence on anything longer than a few words. */}
      {voiceStatus === "error" && voiceMessage ? (
        <div
          role="alertdialog"
          aria-label="Voice error"
          className="agent-approval-glass pointer-events-auto w-full max-w-[min(calc(100vw-3rem),392px)] rounded-3xl p-4 text-[#1d1d1f] dark:text-[#f5f5f7]"
        >
          <p className="text-[13px] font-medium text-muted-foreground">
            Voice couldn&apos;t start
          </p>
          <p className="mt-1 text-[14px] leading-relaxed">{voiceMessage}</p>
          <button
            type="button"
            onClick={stopConversation}
            className="mt-4 h-12 w-full rounded-full bg-black/[0.05] text-[15px] font-semibold ring-1 ring-inset ring-black/10 transition-colors hover:bg-black/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary dark:bg-white/[0.08] dark:ring-white/15 dark:hover:bg-white/[0.12]"
          >
            Close
          </button>
        </div>
      ) : null}
      {pendingConfirmation ? (
        <div
          role="dialog"
          aria-label="Confirm voice action"
          className="agent-approval-glass pointer-events-auto w-full max-w-[min(calc(100vw-3rem),392px)] rounded-3xl p-4 text-[#1d1d1f] dark:text-[#f5f5f7]"
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
              : pendingConfirmationPlanSteps.length > 1
                ? "Sensitive values stay hidden. Say yes to run these steps, or no to cancel."
                : "Sensitive values stay hidden. Say yes to run this, or no to cancel."}
          </p>
          {/* Every step is named before anything runs, so one approval is a
              list the person can read rather than an open-ended permission. */}
          {pendingConfirmationPlanSteps.length > 1 ? (
            <ol className="mt-3 flex flex-col gap-1.5">
              {pendingConfirmationPlanSteps.map((step, index) => (
                <li
                  key={step.actionId}
                  className="flex items-baseline gap-2 text-[13px] leading-relaxed"
                >
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {index + 1}.
                  </span>
                  <span>
                    {step.label}
                    {step.batchable ? null : (
                      <span className="ml-1.5 text-[12px] font-medium text-muted-foreground">
                        (asks you again)
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
          {pendingConfirmation.nudgedAt ? (
            <p className="mt-2 text-[12px] font-medium text-muted-foreground/80">
              {pendingActionNeedsTrustedActivation
                ? "Still there? Tap the button above or Cancel when you're ready."
                : "Still there? Say yes to continue or no to cancel."}
            </p>
          ) : null}
          {pendingActionNeedsTrustedActivation ? (
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => settlePendingConfirmation(false)}
                className="h-10 rounded-full bg-black/[0.05] text-[14px] font-semibold ring-1 ring-inset ring-black/10 transition-colors hover:bg-black/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary dark:bg-white/[0.08] dark:ring-white/15 dark:hover:bg-white/[0.12]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => settlePendingConfirmation(true)}
                className="h-10 rounded-full bg-primary text-[14px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
              >
                {pendingConfirmation.receipt ? pendingActionLabel : "Authorize"}
              </button>
            </div>
          ) : null}
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
          // The root, public, and signed-in variants share one bar chassis.
          // Route state may add toggles, but cannot fork width or geometry.
          layout === "slot"
            ? "max-w-[min(calc(100vw-1.5rem),var(--app-agent-bar-max-width))]"
            : "max-w-[min(calc(100vw-2rem),34rem)]",
          layout === "slot"
            ? "h-11 rounded-[22px] px-2.5"
            : "h-11 rounded-full pl-3 pr-1.5",
          // Single, consolidated transition covering surface color plus the
          // open/close fade+lift. Smoothly eases the bar in/out with the agent
          // window lifecycle so it never snaps back into place after closing.
          "transition-[opacity,transform,background-color,box-shadow] duration-300 ease-[cubic-bezier(0.16,0.84,0.28,1)] will-change-[opacity,transform]",
          // Bottom-shell material: read the same live ambient token as the
          // shared bottom mask so the Agent Bar never becomes a white pill on
          // a dark/gradient route surface.
          "backdrop-blur-[24px] backdrop-saturate-[1.6]",
          "bottom-chrome-surface",
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
              visualOnboardingChrome
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
