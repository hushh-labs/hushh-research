// components/agent/agent-bar.tsx
// Persistent, screen-aware agent launcher bar.
//
// A small dock that sits above the bottom navbar + search on every
// authenticated screen. Voice and Chat share one segmented pill: Voice owns
// the waveform/effects, Chat owns the text conversation entry point.

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
import { VoiceErrorCard } from "@/components/agent/voice-error-card";
import { useOptionalOneLocationInteractionSurface } from "@/components/one-location/onboarding/location-onboarding-interaction-surface";
import { useAuth } from "@/hooks/use-auth";
import {
  executeAgentGatewayAction,
  executeTrustedActivationGatewayAction,
  type AgentActionRuntimeResult,
} from "@/lib/agent/agent-action-runtime";
import { settleAgentGatewayAction } from "@/lib/agent/agent-gateway-action-settlement";
import { useAgentRuntimeStateOptional } from "@/lib/agent/agent-runtime-context";
import { registerOneSystemActionExecutor } from "@/lib/agent/one-system-action-executor";
import { executeOneSystemActionThroughGateway } from "@/lib/agent/one-system-action-gateway-adapter";
import {
  dispatchServerDirectCapability,
  isServerDirectCapability,
} from "@/lib/agent/server-direct-capability-runtime";
import { requiresHardTapConfirmation } from "@/lib/agent/confirmation-tap-policy";
import {
  readVoicePreferences,
  subscribeVoicePreferences,
} from "@/lib/agent/voice-preferences";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";
import {
  buildPublishLocationEnvelopesDirective,
  runLocationDirective,
} from "@/lib/agent/specialist-directive-runtime";
import { ApiService } from "@/lib/services/api-service";
import {
  getAgentVoiceStatusLabel,
  useAgentVoiceState,
} from "@/lib/agent/agent-voice-state";
import {
  AGENT_CONVERSATION_CANCEL_EVENT,
  AGENT_CONVERSATION_REQUEST_EVENT,
  AGENT_CONVERSATION_STOP_EVENT,
  acknowledgeAgentConversation,
  markAgentConversationOwnerReady,
  type AgentConversationRequest,
} from "@/lib/agent/agent-voice-settings";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { validateMorphyAxAssessment } from "@/lib/morphy-ax";
import { snapKaiBottomChromeVisible } from "@/lib/navigation/kai-bottom-chrome-visibility";
import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";
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
import type { LocationOnboardingRunResultV1 } from "@/lib/services/one-location-onboarding-run-client";
import { publishLocationCommandStatusCard } from "@/lib/one-location/location-command-status-card";
import {
  parseToolTraceCard,
  parseVoiceSubject,
  publishVoiceCard,
} from "@/lib/voice/voice-action-card";
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
import {
  createRealtimeVoiceTransport,
  primeRealtimeVoiceOutput,
} from "@/lib/voice/one-voice-transport-factory";
import {
  oneVoiceSessionLifecycle,
  type OneVoiceFollowUpWindow,
} from "@/lib/voice/one-voice-session-lifecycle";
import { createOneVoiceRealtimeAudioInput } from "@/lib/voice/native-realtime-audio-input";
import type { OneVoiceRealtimeAudioInput } from "@/lib/voice/realtime-audio-input";
import type { OneVoiceContextSnapshot } from "@/lib/voice/screen-context-builder";
import type {
  OneVoiceConfirmationMethod,
  OneVoiceActivationSource,
  OneVoiceSessionEvent,
  RealtimeVoiceTransport,
} from "@/lib/voice/one-voice-transport";
import type {
  AgentVoiceEventOptions,
  AgentVoiceStatus,
} from "@/lib/agent/agent-voice-state";
import { redactSensitiveVoiceTranscript } from "@/lib/voice/voice-sensitive-redaction";
import { createVoiceTurnId, logVoiceMetric } from "@/lib/voice/voice-telemetry";

type PrewarmedGeminiSession = {
  client: RealtimeVoiceTransport;
  expiresAtMs: number;
  accessTier: string;
  contextKey: string;
  runtimeMode: "hushh_managed_vertex" | "byok";
  /** Never persisted; rejects a warm socket after an auth-owner transition. */
  ownerEpoch: number;
  /** Server-minted HMAC scope, never a Firebase uid. */
  voiceSessionScope: string | null;
};

type ForegroundGreetingFollowUpState =
  "arming" | "tap_required" | "listening" | null;

/**
 * The lifecycle needs to distinguish an actual person activation from an
 * automatic recovery.  A recovery must preserve a durable task, but it must
 * not reset the five-minute greeting gate simply because a socket renewed.
 */
type PendingVoiceConfirmation = {
  directiveId: string;
  actionId: string;
  slots?: Record<string, unknown>;
  /**
   * This card is owned by the app-root interaction host, never by the route
   * that happened to be visible when One proposed it. Navigation may update
   * runtime context, but only an explicit settlement, superseding directive,
   * auth boundary, or closed session may remove a pending confirmation.
   */
  leaseId: string;
  ledgerSessionId: string;
  actionRunId: string;
  transport: RealtimeVoiceTransport | null;
  contextRevision: string;
  receipt?: string;
  /** Set once the person has gone quiet on this card past the nudge window. */
  nudgedAt?: number | null;
  /**
   * The server's hard-card policy. Unlike a normal confirmation, this action
   * may only be authorized by the physical card button, never spoken text or
   * a carried journey approval.
   */
  requiresTrustedTapConfirmation?: boolean;
  /**
   * The journey this directive opens, when it opens one. Present means the
   * card shows the whole plan and one approval covers its batchable steps.
   */
  plan?: JourneyPlan | null;
};

/**
 * Local, RAM-only ownership of one tap-started command. It contains no
 * transcript or slot data: the opaque id only correlates the visible command
 * with the server-owned final-transcript boundary. Speech end is never
 * inferred from a pointer release or a client RMS threshold.
 */
type LocationCommandActivation = {
  turnId: string;
  cancelled: boolean;
  /** Set only by the relay's authoritative speech-end control event. */
  endpointed: boolean;
  completed: boolean;
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

/**
 * A foreground welcome is allowed to arm capture only when it can do so
 * without manufacturing a browser permission prompt outside a user gesture.
 * The native bridge has its own reviewed permission flow; its `start` result
 * remains the authoritative device check. Browser callers must have already
 * granted microphone permission, otherwise the visible pill is the required
 * user gesture rather than a silent, empty follow-up timer.
 */
async function canAutoArmGreetingFollowUp(
  realtimeAudioInput: OneVoiceRealtimeAudioInput | null,
): Promise<boolean> {
  if (realtimeAudioInput?.source === "ios_native_pcm") return true;
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.getUserMedia ||
    !navigator.permissions?.query
  ) {
    return false;
  }
  try {
    const permission = await navigator.permissions.query({
      name: "microphone" as PermissionName,
    });
    return permission.state === "granted";
  } catch {
    // Safari and embedded webviews can omit the Permissions API. Treat that
    // as tap-required instead of probing getUserMedia from a server directive.
    return false;
  }
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

const DESTINATION_CONTEXT_UNSETTLED_SUMMARY =
  "I couldn't verify the next screen. Please try again.";

function failedDestinationContextResult(
  result: AgentActionRuntimeResult,
  reason:
    "destination_context_unsettled" | "destination_context_unacknowledged",
): AgentActionRuntimeResult {
  return {
    ...result,
    // A `started` settlement is deliberately non-terminal in the relay so it
    // cannot honestly conclude the action. This client has no background
    // settlement continuation after this bounded barrier, therefore sending
    // `started` here would leave the directive open until server-side garbage
    // collection. Report a terminal verification failure instead: the route
    // may have begun, but One must not claim it reached the usable screen.
    status: "failed",
    reason,
    resultSummary: DESTINATION_CONTEXT_UNSETTLED_SUMMARY,
  };
}

/**
 * A navigation action cannot truthfully be settled as successful until the
 * destination has both rendered a matching redacted context and had that
 * context acknowledged by the relay that owns the spoken outcome. This is
 * shared by direct and confirmation-card actions so neither path announces a
 * screen transition before the UI can actually accept the next turn.
 */
async function settleAgentBarActionWithDestination(input: {
  result: AgentActionRuntimeResult;
  readContext: () => OneVoiceContextSnapshot | null;
  transport: RealtimeVoiceTransport | null | undefined;
  signal?: AbortSignal;
}): Promise<{
  result: AgentActionRuntimeResult;
  destinationContextId: string | null;
}> {
  const result = await settleAgentBarAction(input.result);
  if (!result.routeAfter || result.status !== "succeeded") {
    return { result, destinationContextId: null };
  }

  const destinationContext = await waitForDestinationVoiceContext({
    readContext: input.readContext,
    result,
    signal: input.signal,
  });
  if (!destinationContext) {
    return {
      result: failedDestinationContextResult(
        result,
        "destination_context_unsettled",
      ),
      destinationContextId: null,
    };
  }

  const applied = await input.transport?.applyContextAndWait?.(
    destinationContext,
    { signal: input.signal },
  );
  if (applied?.status !== "acknowledged") {
    return {
      result: failedDestinationContextResult(
        result,
        "destination_context_unacknowledged",
      ),
      destinationContextId: null,
    };
  }

  return { result, destinationContextId: applied.contextId };
}

// A confirmation card waits for an explicit tap; this only decides when to
// nudge someone who's gone quiet on it. Nudging is a same-card text change,
// not a re-ask -- it never re-sends anything to the backend, and it fires at
// most once per card (see pendingConfirmationNudgeTimerRef).
const PENDING_CONFIRMATION_NUDGE_MS = 12_000;

// Kill switch for the dead-end insight card, off by request while the
// experience is reworked. Flip back to true to restore it -- the backend
// dead_end context and the remedy-action handler are untouched. Typed as
// `boolean`, not inferred as the literal `false`, so flipping it doesn't
// also require silencing a "this is always null" narrowing complaint below.
const DEAD_END_INSIGHTS_ENABLED: boolean = false;

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
  requiresTrustedTapConfirmation: boolean;
  slots: Record<string, unknown> | undefined;
}): string {
  // Directive ledgers must never retain action inputs. Slot names/types are
  // enough to reject conflicting reuse of an ID without retaining OTPs or
  // other sensitive values in client memory beyond the execution itself.
  const slots: Array<[string, string]> = Object.entries(input.slots ?? {})
    .map(([key, value]): [string, string] => [
      key,
      Array.isArray(value) ? "array" : typeof value,
    ])
    .sort((left, right) => left[0].localeCompare(right[0]));
  return JSON.stringify({
    actionId: input.actionId,
    goalId: input.goalId,
    needsConfirmation: input.needsConfirmation,
    requiresTrustedTapConfirmation: input.requiresTrustedTapConfirmation,
    slots,
  });
}

function resolveVoiceExecutableActionIds(
  transport: RealtimeVoiceTransport | null | undefined,
  fallback: readonly string[] | null | undefined,
): readonly string[] | null {
  // Once the relay acknowledges app_context, its filtered inventory is the
  // browser execution boundary. Before that barrier, retain the local
  // redacted snapshot as a startup fallback; an acknowledged empty list is
  // intentionally preserved as empty and must not fall back to local data.
  return transport?.getExecutableActionIds?.() ?? fallback ?? null;
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

// The command relay may select only a compiled, lease-bound Location workflow
// directive. Its actual card/device behavior is owned by the app-root command
// bridge, never by route-specific chat UI.
const LOCATION_COMMAND_WORKFLOW_ID = "workflow.setup.location";

function isLocationCommandWorkflowDirective(
  result: LocationOnboardingRunResultV1,
): boolean {
  const directive = result.directive;
  const pendingDirective = result.run.pendingDirective;
  return Boolean(
    result.run.workflowId === LOCATION_COMMAND_WORKFLOW_ID &&
    directive &&
    pendingDirective &&
    directive.directiveId === pendingDirective.directiveId &&
    directive.contractId === pendingDirective.contractId &&
    directive.lease.leaseId === pendingDirective.lease.leaseId &&
    directive.lease.runRevision === result.run.revision &&
    pendingDirective.lease.runRevision === result.run.revision,
  );
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
  // The durable Location workflow surface is app-root-owned, so a command
  // started from any route can safely render its server-issued card without
  // mounting legacy conversational UI or losing the task on navigation.
  const locationInteractionSurface = useOptionalOneLocationInteractionSurface();
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
  // The relay remains the author of this message. Keeping its first returned
  // text visible means a WebAudio policy that declines background playback
  // still leaves a person with the same welcome, without synthesizing a turn.
  const [foregroundGreeting, setForegroundGreeting] = useState<string | null>(
    null,
  );
  // A completed relay greeting deliberately leaves the launcher idle: this is
  // the explicit "tap to talk" state, not an open microphone or a second
  // hidden conversation. It also gives audio-output-restricted devices a
  // visible affordance after the server response completes.
  const [foregroundGreetingReady, setForegroundGreetingReady] = useState(false);
  // Presentation only. This never changes server greeting eligibility or
  // persists microphone/permission state; it tells a person whether the
  // directive's ten-second follow-up can actually hear them.
  const [foregroundGreetingFollowUpState, setForegroundGreetingFollowUpState] =
    useState<ForegroundGreetingFollowUpState>(null);
  // Bumped to trigger a deferred (re)start -- manual retry or automatic
  // reconnect -- once conversationActive has genuinely settled. See the
  // effect near startConversation for why this can't just call it directly.
  const [retryNonce, setRetryNonce] = useState(0);
  const [pendingConfirmation, setPendingConfirmation] =
    useState<PendingVoiceConfirmation | null>(null);
  // A confirm raised purely from a spoken turn -- no physical tap -- mounts
  // this dialog wherever the bottom chrome's auto-hide progress currently
  // sits. Without this, a card raised while the chrome was scrolled away
  // stayed translated off-screen with nothing bringing it back, the same
  // defect app-bottom-shell.tsx already prevents for a real tap via
  // onPointerDownCapture.
  useEffect(() => {
    if (pendingConfirmation) snapKaiBottomChromeVisible();
  }, [pendingConfirmation]);
  // The journey approval lives in module scope, not component state: it has
  // to survive the navigation it exists to span, and a ref does not survive a
  // remount. See lib/voice/journey-approval-grant.ts.
  const clearJourneyGrant = useCallback((reason: string) => {
    clearJourneyApproval(reason);
  }, []);
  const activeActionRun = useActiveActionRun();
  // This is populated only from the authenticated relay-session response.
  // It intentionally never receives a Firebase uid or a browser-generated id.
  const voiceSessionScopeRef = useRef<string | null>(null);
  // Keeps an in-memory warm socket from crossing an auth-owner transition
  // without retaining the owner identity alongside the socket.
  const voiceSessionOwnerEpochRef = useRef(0);
  // A direct relay-ticket request is cancellable independently from an open
  // socket. Stopping, backgrounding, or changing auth must not leave a stale
  // ticket request able to install an old owner's opaque scope afterward.
  const relaySessionAbortControllerRef = useRef<AbortController | null>(null);
  // The lifecycle module owns the opaque timing record. This timer owns only
  // this mounted transport's capture lease: after a reply it closes cloud PCM
  // without closing the authenticated relay or throwing away the durable run.
  // The epoch makes a late timer from a prior reply/session a harmless no-op.
  const followUpCaptureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const followUpCaptureEpochRef = useRef(0);
  const clearFollowUpCaptureTimer = useCallback(() => {
    followUpCaptureEpochRef.current += 1;
    if (followUpCaptureTimerRef.current) {
      clearTimeout(followUpCaptureTimerRef.current);
      followUpCaptureTimerRef.current = null;
    }
  }, []);
  // Read directly rather than through AgentRuntimeState's snapshot: that
  // snapshot is deliberately the subset of preferences the backend relay
  // needs to see, and walk-through mode is a purely client-side rendering
  // choice with nothing for the relay to act on.
  const [voicePreferences, setVoicePreferences] = useState(() =>
    readVoicePreferences(user?.uid),
  );
  const walkthroughModeEnabled = voicePreferences.walkthroughMode;
  useEffect(() => {
    setVoicePreferences(readVoicePreferences(user?.uid));
    if (!user?.uid) return;
    return subscribeVoicePreferences(user.uid, setVoicePreferences);
  }, [user?.uid]);
  useEffect(() => {
    relaySessionAbortControllerRef.current?.abort();
    relaySessionAbortControllerRef.current = null;
    const previousScope = voiceSessionScopeRef.current;
    if (previousScope) {
      oneVoiceSessionLifecycle.clearUser(previousScope);
    }
    voiceSessionScopeRef.current = null;
    voiceSessionOwnerEpochRef.current += 1;
    clearFollowUpCaptureTimer();
    setForegroundGreeting(null);
    setForegroundGreetingReady(false);
    setForegroundGreetingFollowUpState(null);
  }, [clearFollowUpCaptureTimer, user?.uid]);
  // Present only while the current screen has genuinely stopped -- e.g. no
  // connections to share location with -- and names the one action that
  // unsticks it. Already computed and reactive (screen-context-builder.ts
  // moves the context revision whenever it appears or clears); today it only
  // ever reaches the model as a spoken hint. Shown here too, so the same
  // "you're stuck, here's the way out" reaches someone who never asked out
  // loud and is just looking at a dead screen.
  //
  // Temporarily switched off -- gated here rather than deleted, since the
  // backend/context plumbing is unchanged and this is meant to come back.
  const deadEnd = DEAD_END_INSIGHTS_ENABLED
    ? (runtime?.oneVoiceContextSnapshot.ui.dead_end ?? null)
    : null;
  const deadEndRemedyAction = deadEnd
    ? getKaiActionById(deadEnd.remedy_action_id)
    : null;
  const [deadEndRemedyBusy, setDeadEndRemedyBusy] = useState(false);
  const pendingConfirmationRef = useRef<PendingVoiceConfirmation | null>(null);
  const voiceStatus = useAgentVoiceState((s) => s.status);
  const voiceMessage = useAgentVoiceState((s) => s.message);
  const voiceLevel = useAgentVoiceState((s) => s.level);
  const setVoiceStatus = useAgentVoiceState((s) => s.setStatus);
  const setVoiceLevel = useAgentVoiceState((s) => s.setLevel);
  const resetVoice = useAgentVoiceState((s) => s.reset);
  const liveClientRef = useRef<RealtimeVoiceTransport | null>(null);
  const locationInteractionSurfaceRef = useRef(locationInteractionSurface);
  useEffect(() => {
    locationInteractionSurfaceRef.current = locationInteractionSurface;
  }, [locationInteractionSurface]);
  const locationCommandActivationRef = useRef<LocationCommandActivation | null>(
    null,
  );
  const ensureLocationCommandActivation = useCallback(() => {
    const existing = locationCommandActivationRef.current;
    if (existing && !existing.cancelled && !existing.completed) {
      return existing;
    }
    const activation: LocationCommandActivation = {
      turnId: `location_command_${createVoiceTurnId()}`,
      cancelled: false,
      endpointed: false,
      completed: false,
    };
    locationCommandActivationRef.current = activation;
    return activation;
  }, []);
  const latestVoiceContextRef = useRef<OneVoiceContextSnapshot | null>(
    runtime?.oneVoiceContextSnapshot ?? null,
  );
  const latestSystemActionRuntimeRef = useRef(runtime);
  useEffect(() => {
    latestSystemActionRuntimeRef.current = runtime;
  }, [runtime]);
  // UI state updates after async credential resolution. This lease reserves
  // microphone/transport ownership synchronously at the actual tap boundary.
  const voiceLeaseRef = useRef<VoiceSessionLease | null>(null);
  const activeRuntimeModeRef = useRef<"hushh_managed_vertex" | "byok" | null>(
    null,
  );
  const lastTranscriptRef = useRef<{ text: string; atMs: number } | null>(null);
  const prewarmedSessionRef = useRef<PrewarmedGeminiSession | null>(null);
  // The exact warm transport currently draining a fixed server greeting. This
  // is an in-memory audio-safety fence only; it is not a greeting eligibility
  // reservation and never survives a page/app lifecycle boundary.
  const foregroundGreetingOutputClientRef =
    useRef<RealtimeVoiceTransport | null>(null);
  const prewarmAbortControllerRef = useRef<AbortController | null>(null);
  // A system invocation can only request this existing owner. Correlation
  // metadata stays in memory until the Live transport either listens or fails.
  const externalStartRequestRef = useRef<AgentConversationRequest | null>(null);
  const cancelledExternalRequestIdsRef = useRef(new Set<string>());
  const finishExternalStart = useCallback((outcome: "accepted" | "failed") => {
    const request = externalStartRequestRef.current;
    if (!request?.requestId || request.source !== "siri_app_shortcut") return;
    externalStartRequestRef.current = null;
    acknowledgeAgentConversation({
      source: "siri_app_shortcut",
      requestId: request.requestId,
      outcome,
    });
    if (outcome === "failed") {
      snapKaiBottomChromeVisible();
      console.info(
        `[SIRI_ONE_VOICE] state=fallback_shown request_id=${request.requestId} source=siri_app_shortcut outcome=failed`,
      );
    }
  }, []);

  // Test-only dispatch entry point: invokes the same pure execution boundary a
  // real Gemini tool-call reaches, but skips the confirmation card and journey
  // grant machinery that wraps it in normal use. Automation supplies the
  // actionId/slots a voice turn would have produced; this proves the action
  // itself works end-to-end without simulating audio/STT.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const bridge = window.__HUSHH_NATIVE_TEST__;
    if (!bridge?.enabled) return undefined;

    const dispatch = async (
      actionId: string,
      slots?: Record<string, unknown>,
    ) => {
      bridge.dispatchAgentActionStatus = `running:${actionId}`;
      bridge.dispatchAgentActionError = "";
      if (isServerDirectCapability(actionId)) {
        // The physical-device/E2E bridge is a caller, never an alternate
        // action engine. Keep its Circle coverage on the same server runtime
        // that Siri uses, and fail closed if that runtime is unavailable.
        const serverResult = await dispatchServerDirectCapability({
          actionId,
          slots: slots ?? {},
          vaultOwnerToken,
          invocationId: `native_test_${Date.now()}_${Math.random()
            .toString(36)
            .slice(2, 14)}`,
        });
        const currentRoute = runtime?.appRuntimeState.route ?? null;
        const action = getKaiActionById(actionId);
        const result: AgentActionRuntimeResult = {
          status:
            serverResult.status === "completed"
              ? "succeeded"
              : serverResult.status === "settling" ||
                  serverResult.status === "paused"
                ? "started"
                : serverResult.status === "input_needed" ||
                    serverResult.status === "blocked"
                  ? "blocked"
                  : "failed",
          actionId,
          label: action?.label ?? null,
          routeBefore: currentRoute?.pathname ?? null,
          screenBefore: currentRoute?.screen ?? null,
          resultSummary: serverResult.message,
          reason:
            serverResult.status === "completed"
              ? null
              : `server_direct_${serverResult.status}`,
          data: {
            ...(serverResult.runId
              ? { capabilityRunId: serverResult.runId }
              : {}),
            ...(serverResult.missingSlot
              ? { missingSlot: serverResult.missingSlot }
              : {}),
          },
        };
        bridge.dispatchAgentActionStatus = `ok:${actionId}`;
        return result;
      }
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
          allowedActionIds: resolveVoiceExecutableActionIds(
            liveClientRef.current,
            runtime?.oneVoiceContextSnapshot.executable_action_ids ??
              runtime?.oneVoiceContextSnapshot.available_action_ids,
          ),
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
          error instanceof Error
            ? error.message
            : "native action dispatch failed";
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
  }, [
    runtime,
    user?.uid,
    router,
    busyOperations,
    setAnalysisParams,
    switchPersona,
    vaultOwnerToken,
  ]);

  // Siri/App Intents are a structured invocation surface, not another action
  // engine. Register the existing Agent Bar owner as the only executor and
  // feed it the exact generated action id and slots after native auth settles.
  useEffect(() => {
    const execute = async (
      actionId: string,
      slots: Record<string, unknown>,
      goalAuthorization?: { goalId: string; expectedScreen: string } | null,
    ): Promise<AgentActionRuntimeResult> => {
      const currentRuntime = latestSystemActionRuntimeRef.current;
      const runtimeState = currentRuntime?.appRuntimeState;
      if (!runtimeState) {
        return {
          status: "blocked",
          actionId,
          label: null,
          routeBefore: null,
          resultSummary: "HUSSH is still restoring the action runtime.",
          reason: "missing_runtime_state",
        };
      }
      const result = await executeAgentGatewayAction({
        actionId,
        slots,
        userId: user?.uid ?? "",
        router,
        appRuntimeState: runtimeState,
        surfaceMetadata: getVoiceSurfaceMetadata(),
        allowedActionIds: resolveVoiceExecutableActionIds(
          liveClientRef.current,
          currentRuntime?.oneVoiceContextSnapshot.executable_action_ids ??
            currentRuntime?.oneVoiceContextSnapshot.available_action_ids,
        ),
        hasPortfolioData:
          runtimeState.portfolio.has_portfolio_data ||
          currentRuntime?.oneVoiceContextSnapshot.cache.portfolio_ready ===
            true,
        busyOperations,
        setAnalysisParams,
        switchPersona,
        goalAuthorization,
      });
      return settleAgentGatewayAction(result, {
        getCurrentRoute: () =>
          latestSystemActionRuntimeRef.current?.appRuntimeState.route ??
          runtimeState.route,
        getCurrentSurfaceMetadata: getVoiceSurfaceMetadata,
      });
    };

    const executeServerDirect = async (
      actionId: string,
      slots: Record<string, unknown>,
      invocationId: string,
    ): Promise<AgentActionRuntimeResult> => {
      // This intentionally does not require a mounted route/runtime state.
      // Siri can open the app while React is restoring, but the server-owned
      // Circle capability has its own authenticated context, run, and
      // settlement proof. A client route must not become its executor.
      const currentRoute =
        latestSystemActionRuntimeRef.current?.appRuntimeState.route ?? null;
      const action = getKaiActionById(actionId);
      const result = await dispatchServerDirectCapability({
        actionId,
        slots,
        vaultOwnerToken,
        invocationId,
      });
      const runtimeStatus: AgentActionRuntimeResult["status"] =
        result.status === "completed"
          ? "succeeded"
          : result.status === "settling" || result.status === "paused"
            ? "started"
            : result.status === "input_needed" || result.status === "blocked"
              ? "blocked"
              : "failed";
      return {
        status: runtimeStatus,
        actionId,
        label: action?.label ?? null,
        routeBefore: currentRoute?.pathname ?? null,
        screenBefore: currentRoute?.screen ?? null,
        resultSummary: result.message,
        reason:
          runtimeStatus === "succeeded"
            ? null
            : `server_direct_${result.status}`,
        data: {
          ...(result.runId ? { capabilityRunId: result.runId } : {}),
          ...(result.missingSlot ? { missingSlot: result.missingSlot } : {}),
        },
      };
    };

    const waitForScreen = async (screen: string): Promise<boolean> => {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        if (
          latestSystemActionRuntimeRef.current?.appRuntimeState.route.screen ===
          screen
        ) {
          return true;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 25));
      }
      return false;
    };

    const executor = (
      invocation: Parameters<
        typeof executeOneSystemActionThroughGateway
      >[0]["invocation"],
    ) =>
      executeOneSystemActionThroughGateway({
        invocation,
        execute,
        executeServerDirect,
        getCurrentRoute: () => ({
          pathname:
            latestSystemActionRuntimeRef.current?.appRuntimeState.route
              .pathname ?? null,
          screen:
            latestSystemActionRuntimeRef.current?.appRuntimeState.route
              .screen ?? null,
        }),
        waitForScreen,
        afterSelection: () =>
          new Promise<void>((resolve) =>
            window.requestAnimationFrame(() =>
              window.requestAnimationFrame(() => resolve()),
            ),
          ),
      });

    return registerOneSystemActionExecutor(executor);
  }, [
    busyOperations,
    router,
    setAnalysisParams,
    switchPersona,
    user?.uid,
    vaultOwnerToken,
  ]);
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
  const pendingConfirmationNudgeTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  // Last actionable context pushed into the live session. Do not dedupe on
  // snapshot_id: it intentionally changes on every voice-state transition.
  const lastPushedContextRef = useRef<string | null>(null);
  const actionAbortControllerRef = useRef<AbortController | null>(null);
  // Tracks whether the active session ended with an error, so the bar can keep
  // showing the error status (instead of snapping shut) until it is dismissed.
  const erroredRef = useRef(false);
  // Set only when the relay's own sessionEnded frame said the failure is
  // resumable; cleared on every "closed" so a later unsignaled drop (a raw
  // network blip, carrying no opinion either way) never inherits a stale
  // "yes, reconnect" from an unrelated earlier failure.
  const lastErrorResumableRef = useRef(false);
  // The provider's own continuation token, handed off in the "closed" event
  // just before the client instance carrying it is torn down. Consumed by
  // the next start() -- manual retry or automatic reconnect alike -- so the
  // provider continues the SAME conversation instead of starting fresh.
  const lastResumptionHandleRef = useRef<string | null>(null);
  const pendingResumptionHandleRef = useRef<string | null>(null);
  // Deliberately conservative: at most ONE automatic reconnect for the whole
  // life of this bar, not one per failure. A provider that keeps failing the
  // same resumed conversation must never be able to loop silently -- a
  // person tapping Try Again by hand (which re-arms this in retryConversation)
  // is always a safe, bounded way past that cap, so nothing is actually lost
  // by keeping the automatic side of this strict.
  const autoReconnectedRef = useRef(false);
  // Ref indirection lets the idle-timer callback always call the CURRENT
  // stopConversation without needing it in handleTransportEvent's deps
  // (stopConversation is declared further down, after handleTransportEvent).
  const stopConversationRef = useRef<() => void>(() => {});
  // Same indirection: startConversation is declared even further down, but
  // handleTransportEvent needs to be able to trigger a reconnect the moment
  // a resumable session closes.
  const startConversationRef = useRef<() => void>(() => {});
  const handleTransportEventRef = useRef<(event: OneVoiceSessionEvent) => void>(
    () => {},
  );
  // Same indirection, same reason: a spoken yes is read inside
  // handleTransportEvent, and settlePendingConfirmation is declared well below
  // it.
  const settlePendingConfirmationRef = useRef<
    (
      confirmed: boolean,
      confirmationMethod?: OneVoiceConfirmationMethod,
    ) => void
  >(() => {});

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

  /**
   * Leave the relay/session/context warm after One answers, but never keep
   * cloud microphone capture open indefinitely. A later pill tap reuses this
   * exact transport through startConversation's inactive-input branch.
   *
   * This intentionally does not claim foreground wake-word support: until a
   * reviewed local KWS pack exists, expiry returns to the visible tap-ready
   * state rather than pretending that "Hey One" is listening.
   */
  const scheduleFollowUpCaptureClose = useCallback(
    (scope: string, window: OneVoiceFollowUpWindow) => {
      clearFollowUpCaptureTimer();
      const timerEpoch = followUpCaptureEpochRef.current;
      const remainingMs = Math.max(0, window.expiresAtMs - Date.now());
      followUpCaptureTimerRef.current = setTimeout(() => {
        followUpCaptureTimerRef.current = null;
        if (followUpCaptureEpochRef.current !== timerEpoch) return;
        if (voiceSessionScopeRef.current !== scope) return;

        // Make the local lifecycle agree with the capture boundary before the
        // asynchronous device/browser release. It contains timing only; no
        // audio, transcript, route, or user identifier is persisted here.
        oneVoiceSessionLifecycle.closeFollowUpWindow(scope);
        const transport = liveClientRef.current;
        if (!transport?.stopAudioInput) return;
        void transport.stopAudioInput().then(() => {
          if (
            followUpCaptureEpochRef.current !== timerEpoch ||
            voiceSessionScopeRef.current !== scope ||
            liveClientRef.current !== transport ||
            transport.isAudioInputActive?.() === true
          ) {
            return;
          }
          setVoiceLevel(0);
          setVoiceStatus("idle", "Tap to talk");
        });
      }, remainingMs);
    },
    [clearFollowUpCaptureTimer, setVoiceLevel, setVoiceStatus],
  );

  /**
   * Promote an authenticated foreground-warm transport only after the server
   * has issued its fixed greeting directive. This is deliberately separate
   * from greeting eligibility: the server has already made that decision.
   * Here we only decide whether this device can honestly open the promised
   * capture window without bypassing browser user-activation rules.
   */
  const armServerGreetingFollowUp = useCallback(
    async (input: {
      client: RealtimeVoiceTransport;
      scope: string;
      realtimeAudioInput: OneVoiceRealtimeAudioInput | null;
      ownerEpoch: number;
      runtimeMode: "hushh_managed_vertex" | "byok";
    }): Promise<boolean> => {
      if (
        input.ownerEpoch !== voiceSessionOwnerEpochRef.current ||
        voiceSessionScopeRef.current !== input.scope
      ) {
        return false;
      }

      const alreadyCapturing = input.client.isAudioInputActive?.() === true;
      if (!alreadyCapturing) {
        setForegroundGreetingFollowUpState("arming");
        const autoCaptureEligible = await canAutoArmGreetingFollowUp(
          input.realtimeAudioInput,
        );
        if (
          input.ownerEpoch !== voiceSessionOwnerEpochRef.current ||
          voiceSessionScopeRef.current !== input.scope
        ) {
          return false;
        }
        if (!autoCaptureEligible) {
          // Do not create a timer that cannot hear anything. In particular,
          // getUserMedia may only prompt after a browser gesture; the visible
          // pill is that gesture and remains usable with this warm relay.
          setForegroundGreetingFollowUpState("tap_required");
          setVoiceStatus("idle", "Tap to enable microphone for replies.");
          return false;
        }
      }

      // A genuine active conversation always owns its own lease. A warm
      // greeting may promote its exact client, but it may never steal a lease
      // from a concurrent tap or Siri handoff.
      if (voiceLeaseRef.current && liveClientRef.current !== input.client) {
        return false;
      }
      let lease = voiceLeaseRef.current;
      if (!lease) {
        lease = appInteractionCoordinator.acquireVoiceLease({
          owner: "one_live",
          onRevoked: () => stopConversationRef.current(),
        });
        if (!lease.isCurrent()) {
          setForegroundGreetingFollowUpState("tap_required");
          setVoiceStatus("idle", "Tap to enable microphone for replies.");
          return false;
        }
        voiceLeaseRef.current = lease;
      }

      if (liveClientRef.current && liveClientRef.current !== input.client) {
        if (voiceLeaseRef.current?.id === lease.id) {
          lease.release("greeting_follow_up_superseded");
          voiceLeaseRef.current = null;
        }
        return false;
      }

      // From this point the warm connection is a real session owner. Remove
      // only this reference; do not stop the socket we are about to arm.
      if (prewarmedSessionRef.current?.client === input.client) {
        prewarmedSessionRef.current = null;
      }
      liveClientRef.current = input.client;
      activeRuntimeModeRef.current = input.runtimeMode;
      setConversationActive(true);

      const started =
        alreadyCapturing || (await input.client.startAudioInput?.()) === true;
      if (
        !started ||
        input.ownerEpoch !== voiceSessionOwnerEpochRef.current ||
        voiceSessionScopeRef.current !== input.scope ||
        liveClientRef.current !== input.client
      ) {
        if (liveClientRef.current === input.client) {
          liveClientRef.current = null;
        }
        if (voiceLeaseRef.current?.id === lease.id) {
          lease.release("greeting_follow_up_capture_unavailable");
          voiceLeaseRef.current = null;
        }
        activeRuntimeModeRef.current = null;
        setConversationActive(false);
        setForegroundGreetingFollowUpState("tap_required");
        setVoiceStatus("idle", "Tap to enable microphone for replies.");
        return false;
      }

      const followUpWindow = oneVoiceSessionLifecycle.openFollowUpWindow(
        input.scope,
      );
      if (followUpWindow) {
        scheduleFollowUpCaptureClose(input.scope, followUpWindow);
      }
      setForegroundGreetingFollowUpState("listening");
      setVoiceStatus("listening", "Listening");
      return true;
    },
    [scheduleFollowUpCaptureClose, setVoiceStatus],
  );

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
        event.type === "greeting" ||
        event.type === "greeting_playback_settled" ||
        event.type === "client_directive" ||
        event.type === "tool_trace" ||
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
      const activeLocationCommand = locationCommandActivationRef.current;
      if (event.type === "location_command_ready") {
        if (
          activeLocationCommand?.turnId === event.turnId &&
          !activeLocationCommand.cancelled &&
          !activeLocationCommand.completed
        ) {
          setVoiceStatus("listening", "Listening", eventOptions);
        }
        return;
      }
      if (event.type === "location_command_endpointed") {
        // The relay—not the browser UI—owns speech-end detection. Capture is
        // already closing on the transport side; this is only the visible
        // transition into the final-transcript/routing wait state.
        if (
          activeLocationCommand?.turnId === event.turnId &&
          !activeLocationCommand.cancelled &&
          !activeLocationCommand.completed
        ) {
          activeLocationCommand.endpointed = true;
          setVoiceLevel(0);
          setVoiceStatus("thinking", "Transcribing", eventOptions);
        }
        return;
      }
      if (event.type === "location_command_session_rollover") {
        setVoiceStatus("idle", "Ready for next command", eventOptions);
        return;
      }
      if (event.type === "location_command_result") {
        // The transport has already enforced the authenticated speech-end,
        // final transcription, and completion boundary for this opaque turn.
        // Retain a second UI fence so no stale/malicious result can render a
        // card, navigate, or claim a verified mutation for another tap.
        if (
          activeLocationCommand?.turnId !== event.turnId ||
          activeLocationCommand.cancelled ||
          activeLocationCommand.completed ||
          (!activeLocationCommand.endpointed && event.outcome !== "failed")
        ) {
          return;
        }
        activeLocationCommand.completed = true;
        let navigated = false;
        let workflowHandoff = false;
        let workflowHandoffUnavailable = false;
        let circleNameHandoff = false;
        if (
          event.outcome === "interaction_required" &&
          event.circleNameDirective?.actionId === "location.create_circle"
        ) {
          // The app-root owner revalidates this fixed relay projection before
          // it enters durable presentation state. AgentBar deliberately owns
          // neither the lease nor the form, so a route transition cannot
          // dismiss an active Circle-name task.
          circleNameHandoff = Boolean(
            locationInteractionSurfaceRef.current?.presentCircleNameDirective(
              event.circleNameDirective,
            ),
          );
          if (circleNameHandoff) {
            snapKaiBottomChromeVisible();
          }
        }
        const workflowResult =
          event.outcome !== "navigate" &&
          event.result &&
          isLocationCommandWorkflowDirective(event.result)
            ? event.result
            : null;
        if (workflowResult) {
          const surface = locationInteractionSurfaceRef.current;
          // The app-root Location command bridge consumes this exact server
          // projection and binds its card to real OS permission/GPS callbacks.
          // It never delegates a live lease to the legacy setup page, whose
          // coarse completion state is not a verified runtime settlement.
          if (surface) {
            surface.presentServerResult(workflowResult);
            workflowHandoff = true;
            snapKaiBottomChromeVisible();
          } else {
            workflowHandoffUnavailable = true;
          }
        }
        if (event.outcome === "navigate" && event.navigation) {
          const action = getKaiActionById(event.navigation.capabilityId);
          const target = action?.execution_target;
          if (
            target?.status === "wired" &&
            target.path === "route" &&
            target.target === event.navigation.route
          ) {
            navigated = true;
            const requested = requestInternalAppNavigation({
              href: event.navigation.route,
              source: "voice",
              transitionMode: "contextual",
              scroll: false,
            });
            if (!requested) {
              router.push(event.navigation.route, { scroll: false });
            }
          }
        }
        // Non-workflow results remain display-only. Workflow directives above
        // are consumed by the global command bridge, which owns their real
        // device/card callbacks.
        const rejectedWorkflowDirective = Boolean(
          event.result?.directive && !workflowResult,
        );
        if (
          event.outcome !== "navigate" &&
          event.result &&
          !workflowResult &&
          !event.result.directive
        ) {
          locationInteractionSurfaceRef.current?.presentServerResult(
            event.result,
          );
        }
        const renderedStatusCard = event.statusCard
          ? publishLocationCommandStatusCard(event.statusCard)
          : false;
        const missingRequiredWorkflowHandoff =
          (event.outcome === "interaction_required" ||
            event.outcome === "ask") &&
          !workflowHandoff &&
          !circleNameHandoff;
        const statusMessage = renderedStatusCard
          ? event.statusCard?.cardId ===
            "one.location.command.circle_verified.v1"
            ? "Circle ready"
            : "Location ready"
          : workflowHandoff
            ? "Location setup needs your next step"
            : circleNameHandoff
              ? "Name your Circle"
              : workflowHandoffUnavailable ||
                  missingRequiredWorkflowHandoff ||
                  rejectedWorkflowDirective
                ? "Location task is unavailable"
                : event.outcome === "execute_started"
                  ? "Working"
                  : event.outcome === "interaction_required"
                    ? "Your input is needed"
                    : event.outcome === "navigate"
                      ? navigated
                        ? "Opening Location"
                        : "Location route is unavailable"
                      : event.outcome === "ask"
                        ? "Choose an option"
                        : event.outcome === "blocked"
                          ? "Location needs your attention"
                          : "Location command could not finish";
        setVoiceStatus(
          event.outcome === "failed" ||
            (event.outcome === "navigate" && !navigated) ||
            workflowHandoffUnavailable ||
            missingRequiredWorkflowHandoff ||
            rejectedWorkflowDirective
            ? "error"
            : workflowHandoff
              ? "idle"
              : renderedStatusCard || event.result || circleNameHandoff
                ? "idle"
                : "thinking",
          statusMessage,
          eventOptions,
        );
        return;
      }
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
        if (status === "listening") {
          finishExternalStart("accepted");
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
        if (activeLocationCommand && !activeLocationCommand.completed) {
          activeLocationCommand.cancelled = true;
        }
        actionAbortControllerRef.current?.abort();
        clearJourneyGrant("transport_error");
        abandonPendingConfirmation(
          "transport_error",
          "The confirmation was cancelled because the voice session hit an error.",
        );
        erroredRef.current = true;
        lastErrorResumableRef.current = event.resumable === true;
        setVoiceStatus("error", event.message, eventOptions);
        finishExternalStart("failed");
        return;
      }
      if (event.type === "greeting") {
        foregroundGreetingOutputClientRef.current = liveClientRef.current;
        setForegroundGreeting(event.greeting.text);
        setForegroundGreetingReady(true);
        // Do not arm capture yet. The transport emits a separate settled
        // boundary after the greeting's output drains so One cannot hear its
        // own welcome through the microphone.
        setForegroundGreetingFollowUpState("arming");
        return;
      }
      if (event.type === "greeting_playback_settled") {
        if (
          foregroundGreetingOutputClientRef.current === liveClientRef.current
        ) {
          foregroundGreetingOutputClientRef.current = null;
        }
        const voiceSessionScope = voiceSessionScopeRef.current;
        const client = liveClientRef.current;
        if (!event.played || !voiceSessionScope || !client) {
          setForegroundGreetingFollowUpState("tap_required");
          setVoiceStatus("idle", "Tap to enable microphone for replies.");
          return;
        }
        void armServerGreetingFollowUp({
          client,
          scope: voiceSessionScope,
          // A currently promoted client is already capturing or falls back to
          // the explicit tap path. Warm sessions pass their concrete native
          // input from the prewarm handler below.
          realtimeAudioInput: null,
          ownerEpoch: voiceSessionOwnerEpochRef.current,
          runtimeMode: activeRuntimeModeRef.current ?? "hushh_managed_vertex",
        });
        return;
      }
      if (event.type === "assistant_text") {
        if (activeLocationCommand && !activeLocationCommand.cancelled) {
          // Location command turns are visual-only. The transport suppresses
          // model output too; this is a second UI fence for mixed/legacy relay
          // frames so an unexpected response cannot become chatty audio/UI.
          return;
        }
        const voiceSessionScope = voiceSessionScopeRef.current;
        if (voiceSessionScope) {
          // A reply opens the bounded hands-free continuation window. This is
          // timing-only local state; microphone ownership remains with the
          // existing transport and no response text enters persistence.
          const followUpWindow =
            oneVoiceSessionLifecycle.openFollowUpWindow(voiceSessionScope);
          if (followUpWindow) {
            scheduleFollowUpCaptureClose(voiceSessionScope, followUpWindow);
          }
        }
        appendMirrorEvent({
          role: "assistant",
          text: event.text,
          source: "gemini_live",
          turnId: event.turnId ?? null,
        });
        // When iOS output is unavailable or muted, the reply must still be
        // visible in the active One Voice bar instead of looking like a stuck
        // "Thinking" state. This is local presentation of One's response;
        // nothing is persisted or added to telemetry here.
        setVoiceStatus("speaking", event.text, eventOptions);
        return;
      }
      if (event.type === "transcript_final") {
        if (activeLocationCommand) {
          if (
            activeLocationCommand.cancelled ||
            (event.turnId && event.turnId !== activeLocationCommand.turnId)
          ) {
            return;
          }
          // Do not mirror, classify confirmations, or send this transcript
          // into the legacy conversational path. The relay's Location Brain
          // owns semantic selection after its authoritative speech-end
          // boundary; only location_command_endpointed opens the UI result
          // fence for this turn.
          return;
        }
        const voiceSessionScope = voiceSessionScopeRef.current;
        if (voiceSessionScope) {
          // Speech inside the follow-up window extends its local capture
          // deadline. Server-side activity is recorded independently by the
          // authenticated relay, so this browser never owns greeting timing.
          const extendedFollowUp =
            oneVoiceSessionLifecycle.extendFollowUpOnSpeech(voiceSessionScope);
          if (extendedFollowUp) {
            scheduleFollowUpCaptureClose(voiceSessionScope, extendedFollowUp);
          }
        }
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
        const pendingConfirmation = pendingConfirmationRef.current;
        if (pendingConfirmation?.requiresTrustedTapConfirmation) {
          // The relay will reject non-tap approval for a hard-card action;
          // retain the approved UI instead of treating "yes" as either an
          // authorization or a new request.
          setVoiceStatus("thinking", "Tap to confirm", eventOptions);
          return;
        }
        if (pendingConfirmation) {
          const answer = classifySpokenConfirmation(event.text);
          // The only record that a spoken yes was even considered. Without it
          // a confirmation settled by tap and one settled by voice are the
          // same success in every log, so "I had to click" could not be told
          // apart from "the classifier declined the utterance" -- and the
          // whole hands-free claim rested on not knowing the difference.
          // Word count only; the transcript itself never goes to telemetry.
          console.info(
            `[VOICE_CONFIRM] action=${pendingConfirmation.actionId} ` +
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
            settlePendingConfirmationRef.current(answer === "affirm", "voice");
            return;
          }
        }
        actionAbortControllerRef.current?.abort();
        // A fresh request supersedes the plan the person approved for the last
        // one. Approval was for a named list, not for whatever One does next.
        clearJourneyGrant("new_user_intent");
        // Gemini Live produced this display transcript from the PCM it already
        // received. It owns the conversational turn, including clarification
        // and multi-turn slot filling; the client never sends it back as a
        // second text turn.
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
        if (event.source === "input") {
          const transport = liveClientRef.current;
          // Apple Speech only captures audio. Gemini Live owns the complete
          // conversational turn immediately so it can ask for a missing name,
          // retain the follow-up, and use the governed server action path.
          // Do not wait on local ranking here: it may be slow or unavailable,
          // and it must never turn an agent conversation into a dead end.
          logVoiceMetric({
            metric: "voice_turn_delegated_to_agent",
            value: 1,
            // Relay/model turn labels are not a browser telemetry contract.
            // Mint a local opaque correlation id instead of trusting one.
            turnId: createVoiceTurnId(),
            tags: {
              entrypoint: "native_final",
            },
          });
          transport?.sendUserText?.(transcript);
          setVoiceStatus("thinking", "Understanding", eventOptions);
          return;
        }
        setVoiceStatus("thinking", "Understanding", eventOptions);
        return;
      }
      if (event.type === "tool_trace") {
        if (activeLocationCommand && !activeLocationCommand.cancelled) {
          return;
        }
        // Display-only: a read tool's answer, illustrated alongside the
        // spoken readout. Nothing to execute, nothing to authorize -- unlike
        // client_directive below, this never reaches the governed gateway.
        const card = parseToolTraceCard(event.trace);
        if (card) publishVoiceCard(card);
        return;
      }
      if (event.type === "client_directive") {
        if (activeLocationCommand) {
          // Command mode is visual-only. A typed command result is the sole
          // path allowed to render a card, navigate, or start a verified
          // action; conversational Gemini directives are never a fallback.
          return;
        }
        // One's tools decided this (single decision-maker); the client only
        // executes through the same governed gateway the app uses.
        if (event.directive.kind === "navigate") {
          // Direct navigation directives predate generated action contracts.
          // Do not let a legacy ADK tool bypass the active route's verified
          // control inventory; every live route transition now enters through
          // an `action` directive and executeAgentGatewayAction.
          console.warn(
            "[AgentBar] Rejected legacy direct navigation directive.",
          );
          return;
        }
        if (event.directive.kind === "action_result") {
          // Backend-direct: the mutation already ran server-side before this
          // arrived (_park_action_result_directive in action_tools.py), so
          // there is nothing to execute and nothing to settle back -- unlike
          // a `kind: "action"` directive, this only needs to become visible.
          // No directiveId/contextRevision binding either, for the same
          // reason: there is no settlement round trip to bind one to.
          const actionId =
            typeof event.directive.payload?.actionId === "string"
              ? event.directive.payload.actionId
              : null;
          const message =
            typeof event.directive.payload?.message === "string"
              ? event.directive.payload.message
              : null;
          if (!actionId || !message) {
            console.warn(
              "[AgentBar] Rejected malformed action_result directive.",
            );
            return;
          }
          const resultPhase =
            event.directive.payload?.status === "failed"
              ? "failed"
              : "completed";
          const action = getKaiActionById(actionId);
          const subject = parseVoiceSubject(
            event.directive.payload as Record<string, unknown> | undefined,
          );
          const run = appInteractionCoordinator.startActionRun({
            actionId,
            label: action?.label ?? actionId,
            source: "voice",
            message,
          });
          appInteractionCoordinator.updateActionRun(run.id, {
            phase: resultPhase,
            message,
            subject,
          });
          return;
        }
        if (event.directive.kind === "publish_location_envelopes") {
          // Backend-direct: the grant(s) already exist server-side, and a
          // separate action_result directive (same turn, not necessarily
          // handled before or after this one -- the backend parks both
          // under different hussh:pending_directive keys with no ordering
          // guarantee between them) renders the completed card for them.
          // This directive carries only the one step a backend tool call
          // can never do itself: capture the coordinate, encrypt it per
          // recipient, and store it. Reuses the exact runtime
          // the tap-to-confirm specialist flow already uses for this, kind
          // "action"/type "publish_share", including its refusal to trust a
          // directive-supplied recipient key -- runLocationDirective always
          // re-reads it from server state. Deliberately not routed through
          // the delegateAgentId handoff below: that path hands off to chat
          // for a tap, and this has none to give -- it auto-fires.
          const publishDirective = buildPublishLocationEnvelopesDirective(
            event.directive.payload,
          );
          if (!publishDirective) {
            console.warn(
              "[AgentBar] Rejected malformed publish_location_envelopes directive.",
            );
            return;
          }
          if (!vaultOwnerToken) {
            console.warn(
              "[AgentBar] No vault token; cannot publish location envelopes.",
            );
            return;
          }
          void (async () => {
            // runLocationDirective never throws -- every internal failure is
            // caught inside it and reported as a resolved DelegateResult with
            // status "failed" (see specialist-directive-runtime.ts), the same
            // way the tap-to-confirm chat flow reads it. A try/catch here
            // would never fire; the status is the only signal there is.
            const result = await runLocationDirective(
              publishDirective,
              vaultOwnerToken,
              user?.uid ?? null,
            ).catch((error: unknown) => ({
              status: "failed" as const,
              detail: error instanceof Error ? error.message : "action failed",
            }));
            if (result.status === "completed") return;
            // The model has already said "Shared with Sarah" by the time this
            // can fail -- there is nothing left to retract. Surface a second,
            // visible card explaining the publish itself failed, using the
            // same action-run mechanism the completed card used, rather than
            // silently leaving a grant with no location on it.
            const message =
              result.detail || "Couldn't finish sharing your location.";
            const failedActionId = "location.share_selected";
            const run = appInteractionCoordinator.startActionRun({
              actionId: failedActionId,
              label:
                getKaiActionById(failedActionId)?.label ?? "Share location",
              source: "voice",
              message,
            });
            appInteractionCoordinator.updateActionRun(run.id, {
              phase: "failed",
              message,
            });
          })();
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
            const requiresTrustedTapConfirmation =
              event.directive.payload?.requiresTrustedTapConfirmation === true;
            const needsConfirmation =
              requiresTrustedTapConfirmation ||
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
            const reportDirectiveSettlement = (
              settlement: DirectiveSettlement,
            ) => {
              if (voiceLeaseRef.current?.id !== directiveLeaseId) {
                return;
              }
              directiveTransport?.reportActionSettlement?.({
                directiveId,
                actionId,
                contextRevision,
                ...settlement,
                receipt:
                  pendingConfirmationRef.current?.receipt ??
                  journeyGrantReceipt,
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
                requiresTrustedTapConfirmation,
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
            // A hard-card action must never inherit an earlier journey
            // approval. Its own card tap is the policy boundary.
            const coveredByJourneyGrant =
              !requiresTrustedTapConfirmation &&
              isCoveredByJourneyApproval(goalId, actionId);
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
                leaseId: directiveLeaseId,
                ledgerSessionId: directiveLedgerSessionId,
                actionRunId: actionRun.id,
                transport: directiveTransport,
                contextRevision,
                requiresTrustedTapConfirmation,
                plan:
                  journeyPlan && journeyPlan.goalId === goalId
                    ? journeyPlan
                    : null,
              };
              pendingConfirmationRef.current = pending;
              setPendingConfirmation(pending);
              // Render is an explicit runtime outcome, not a model-generated
              // UI escape hatch. Log only the registered action id and
              // opaque session correlation -- never the pending slots.
              logVoiceMetric({
                metric: "voice_confirmation_rendered",
                value: 1,
                turnId: createVoiceTurnId(),
                correlation: {
                  voice_session_id: eventOptions.sessionId,
                },
              });
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
              const isCurrentDirectiveRun = () =>
                voiceLeaseRef.current?.id === directiveLeaseId &&
                appInteractionCoordinator.getActiveActionRun()?.id ===
                  actionRun.id;
              let isCurrentDirectiveExecution: (() => boolean) | null = null;
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
                      confirmationMethod: "journey_grant",
                    });
                  journeyGrantReceipt = confirmation?.receipt;
                  if (!isCurrentDirectiveRun()) return;
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
                const actionController = new AbortController();
                actionAbortControllerRef.current = actionController;
                const actionSignal = actionController.signal;
                const currentDirectiveExecution = () =>
                  actionAbortControllerRef.current === actionController &&
                  !actionSignal.aborted &&
                  isCurrentDirectiveRun();
                isCurrentDirectiveExecution = currentDirectiveExecution;
                const executionResult = await executeAgentGatewayAction({
                  actionId,
                  slots,
                  userId: user?.uid ?? "",
                  router,
                  appRuntimeState: runtimeState,
                  surfaceMetadata: getVoiceSurfaceMetadata(),
                  allowedActionIds: resolveVoiceExecutableActionIds(
                    directiveTransport,
                    runtime?.oneVoiceContextSnapshot.executable_action_ids ??
                      runtime?.oneVoiceContextSnapshot.available_action_ids,
                  ),
                  hasPortfolioData:
                    runtimeState.portfolio.has_portfolio_data ||
                    runtime?.oneVoiceContextSnapshot.cache.portfolio_ready ===
                      true,
                  busyOperations,
                  setAnalysisParams,
                  switchPersona,
                  executionContext: { directiveId },
                  signal: actionSignal,
                  goalAuthorization:
                    isSettledJourneyDirective && directiveJourney
                      ? {
                          goalId: directiveJourney.goalId,
                          expectedScreen: directiveJourney.destinationScreen,
                        }
                      : null,
                });
                if (!currentDirectiveExecution()) return;
                // A handler that resolved who this run is about (a matched
                // recipient, a person a request just went to) says so through
                // the same `data` bag the confirm/disambiguation cards read.
                // Surfacing it here, before settlement, is what lets the
                // walkthrough panel show a name the moment it is known
                // instead of only once the whole run finishes.
                const resolvedSubject = parseVoiceSubject(executionResult.data);
                if (resolvedSubject) {
                  appInteractionCoordinator.updateActionRun(actionRun.id, {
                    subject: resolvedSubject,
                  });
                }
                if (executionResult.routeAfter) {
                  appInteractionCoordinator.updateActionRun(actionRun.id, {
                    phase: "navigating",
                    message: `Opening ${action?.label ?? "your request"}`,
                  });
                }
                const { result, destinationContextId } =
                  await settleAgentBarActionWithDestination({
                    result: executionResult,
                    readContext: () => latestVoiceContextRef.current,
                    transport: directiveTransport,
                    signal: actionSignal,
                  });
                if (!currentDirectiveExecution()) return;
                reportDirectiveSettlement({
                  status: result.status,
                  summary: result.resultSummary,
                  reason: result.reason,
                  routeAfter: result.routeAfter,
                  screenAfter: result.screenAfter,
                  destinationContextId,
                });
              } catch {
                if (!isCurrentDirectiveRun()) return;
                if (
                  isCurrentDirectiveExecution &&
                  !isCurrentDirectiveExecution()
                ) {
                  return;
                }
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
        if (
          event.directive.kind !== "action" &&
          event.directive.kind !== "prompt"
        ) {
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
        if (
          delegateAgentId === "agent_location" &&
          directiveType === "sos_panic"
        ) {
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
        clearFollowUpCaptureTimer();
        clearJourneyGrant("session_closed");
        abandonPendingConfirmation(
          "session_closed",
          "The confirmation was cancelled when the voice session closed.",
        );
        liveClientRef.current = null;
        voiceLeaseRef.current?.release("transport_closed");
        voiceLeaseRef.current = null;
        activeRuntimeModeRef.current = null;
        lastResumptionHandleRef.current = event.resumptionHandle ?? null;
        if (erroredRef.current) {
          // A resumable failure gets one automatic attempt to pick the same
          // conversation back up before this becomes something the person
          // has to notice and act on themselves -- that is the entire point
          // of the relay bothering to say "resumable" in the first place.
          if (lastErrorResumableRef.current && !autoReconnectedRef.current) {
            autoReconnectedRef.current = true;
            pendingResumptionHandleRef.current =
              lastResumptionHandleRef.current;
            erroredRef.current = false;
            lastErrorResumableRef.current = false;
            // Not just skipped this time -- startConversation's own guard
            // treats a still-true conversationActive as "already running"
            // and would route straight to stopConversation instead of
            // actually reconnecting.
            setConversationActive(false);
            setRetryNonce((current) => current + 1);
          }
          return;
        }
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
      clearFollowUpCaptureTimer,
      clearVoiceIdleTimer,
      createHandoff,
      router,
      runtime,
      armServerGreetingFollowUp,
      scheduleVoiceIdleTimer,
      scheduleFollowUpCaptureClose,
      setAnalysisParams,
      setVoiceLevel,
      setVoiceStatus,
      switchPersona,
      user?.uid,
      vaultOwnerToken,
      finishExternalStart,
    ],
  );

  useEffect(() => {
    handleTransportEventRef.current = handleTransportEvent;
  }, [handleTransportEvent]);

  /**
   * A foreground warm session has no microphone lease and must be disposable
   * independently from an active conversation. Keeping that distinction lets
   * us pre-authenticate the relay without silently listening or blocking the
   * actual voice owner.
   */
  const stopPrewarmedSession = useCallback(() => {
    prewarmAbortControllerRef.current?.abort();
    prewarmAbortControllerRef.current = null;
    const warmed = prewarmedSessionRef.current;
    prewarmedSessionRef.current = null;
    if (foregroundGreetingOutputClientRef.current === warmed?.client) {
      foregroundGreetingOutputClientRef.current = null;
    }
    warmed?.client.stop();
  }, []);

  // Narrower than stopConversation: aborts whatever the walkthrough panel is
  // currently showing without ending the voice session it belongs to. The
  // abort is best-effort -- not every handler checks its signal mid-flight --
  // so cancelActiveActionRuns is what actually makes the UI reflect "stopped"
  // immediately rather than waiting on work that may keep running unseen.
  const cancelActiveWalkthroughTask = useCallback(() => {
    actionAbortControllerRef.current?.abort();
    appInteractionCoordinator.cancelActiveActionRuns("Cancelled");
    abandonPendingConfirmation(
      "cancelled_from_walkthrough",
      "The confirmation was cancelled.",
    );
  }, [abandonPendingConfirmation]);

  const stopConversation = useCallback(() => {
    const activeLocationCommand = locationCommandActivationRef.current;
    if (activeLocationCommand && !activeLocationCommand.completed) {
      activeLocationCommand.cancelled = true;
      liveClientRef.current?.endInputTurn?.({
        turnId: activeLocationCommand.turnId,
        cancelled: true,
      });
    }
    relaySessionAbortControllerRef.current?.abort();
    relaySessionAbortControllerRef.current = null;
    actionAbortControllerRef.current?.abort();
    appInteractionCoordinator.cancelActiveActionRuns(
      "Action cancelled when the voice session ended",
    );
    clearVoiceIdleTimer();
    clearFollowUpCaptureTimer();
    erroredRef.current = false;
    abandonPendingConfirmation(
      "session_cancelled",
      "The confirmation was cancelled when the voice session ended.",
    );
    liveClientRef.current?.stop();
    liveClientRef.current = null;
    const voiceSessionScope = voiceSessionScopeRef.current;
    if (voiceSessionScope) {
      oneVoiceSessionLifecycle.closeFollowUpWindow(voiceSessionScope);
    }
    voiceLeaseRef.current?.release("voice_session_stopped");
    voiceLeaseRef.current = null;
    activeRuntimeModeRef.current = null;
    stopPrewarmedSession();
    setConversationActive(false);
    setForegroundGreetingFollowUpState(null);
    resetVoice();
  }, [
    abandonPendingConfirmation,
    clearFollowUpCaptureTimer,
    clearVoiceIdleTimer,
    resetVoice,
    stopPrewarmedSession,
  ]);

  const runDeadEndRemedy = useCallback(() => {
    if (!deadEndRemedyAction || deadEndRemedyBusy) return;
    const runtimeState = runtime?.appRuntimeState;
    if (!runtimeState) return;
    // A tap is its own confirmation, the same trust the pending-confirmation
    // card's own Authorize button and every VoiceActionCard row already
    // extend -- so this runs through the same direct execution path they do,
    // not the spoken/ledger-confirmed one a voice command would take.
    const execute =
      deadEndRemedyAction.activation_policy === "trusted_activation_required"
        ? executeTrustedActivationGatewayAction
        : executeAgentGatewayAction;
    setDeadEndRemedyBusy(true);
    void execute({
      actionId: deadEndRemedyAction.action_id,
      slots: {},
      userId: user?.uid ?? "",
      router,
      appRuntimeState: runtimeState,
      surfaceMetadata: getVoiceSurfaceMetadata(),
      allowedActionIds: resolveVoiceExecutableActionIds(
        liveClientRef.current,
        runtime?.oneVoiceContextSnapshot.executable_action_ids ??
          runtime?.oneVoiceContextSnapshot.available_action_ids,
      ),
      hasPortfolioData:
        runtimeState.portfolio.has_portfolio_data ||
        runtime?.oneVoiceContextSnapshot.cache.portfolio_ready === true,
      busyOperations,
      setAnalysisParams,
      switchPersona,
    }).finally(() => setDeadEndRemedyBusy(false));
  }, [
    deadEndRemedyAction,
    deadEndRemedyBusy,
    runtime,
    user?.uid,
    router,
    busyOperations,
    setAnalysisParams,
    switchPersona,
  ]);

  const settlePendingConfirmation = useCallback(
    (
      confirmed: boolean,
      confirmationMethod: OneVoiceConfirmationMethod = "tap",
    ) => {
      const pending = pendingConfirmationRef.current;
      if (!pending) return;
      if (
        confirmed &&
        pending.requiresTrustedTapConfirmation === true &&
        confirmationMethod !== "tap"
      ) {
        setVoiceStatus("thinking", "Tap to confirm");
        return;
      }
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
        void confirmationTransport
          .confirmActionDirective({
            directiveId: pending.directiveId,
            actionId: pending.actionId,
            contextRevision: pending.contextRevision,
            confirmationMethod,
          })
          .then((confirmation) => {
            if (voiceLeaseRef.current?.id !== pending.leaseId) return;
            const authorized = { ...pending, receipt: confirmation.receipt };
            const confirmingAction = getKaiActionById(pending.actionId);
            const requiresAdditionalActivationTap =
              requiresHardTapConfirmation(
                confirmingAction,
                runtime?.oneVoiceContextSnapshot.voice_settings
                  .require_tap_confirmation === true,
              ) &&
              (confirmationMethod !== "tap" ||
                confirmingAction?.activation_policy ===
                  "trusted_activation_required");
            if (requiresAdditionalActivationTap) {
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
            settlePendingConfirmationRef.current(true, confirmationMethod);
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
      const actionController = new AbortController();
      actionAbortControllerRef.current = actionController;
      const actionSignal = actionController.signal;
      const isCurrentPendingExecution = () =>
        actionAbortControllerRef.current === actionController &&
        !actionSignal.aborted &&
        voiceLeaseRef.current?.id === pending.leaseId &&
        appInteractionCoordinator.getActiveActionRun()?.id ===
          pending.actionRunId;

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
        allowedActionIds: resolveVoiceExecutableActionIds(
          pending.transport,
          runtime?.oneVoiceContextSnapshot.executable_action_ids ??
            runtime?.oneVoiceContextSnapshot.available_action_ids,
        ),
        hasPortfolioData:
          runtimeState.portfolio.has_portfolio_data ||
          runtime?.oneVoiceContextSnapshot.cache.portfolio_ready === true,
        busyOperations,
        setAnalysisParams,
        switchPersona,
        executionContext: { directiveId: pending.directiveId },
        signal: actionSignal,
      });
      void (async () => {
        try {
          const executionResult = await settlement;
          if (!isCurrentPendingExecution()) return;
          if (executionResult.routeAfter) {
            appInteractionCoordinator.updateActionRun(pending.actionRunId, {
              phase: "navigating",
              message: `Opening ${getKaiActionById(pending.actionId)?.label ?? "your request"}`,
            });
          }
          const { result, destinationContextId } =
            await settleAgentBarActionWithDestination({
              result: executionResult,
              readContext: () => latestVoiceContextRef.current,
              transport: pending.transport,
              signal: actionSignal,
            });
          if (!isCurrentPendingExecution()) return;
          scheduleVoiceIdleTimer();
          reportPendingSettlement({
            status: result.status,
            summary: result.resultSummary,
            reason: result.reason,
            routeAfter: result.routeAfter,
            screenAfter: result.screenAfter,
            destinationContextId,
          });
        } catch {
          if (!isCurrentPendingExecution()) return;
          scheduleVoiceIdleTimer();
          reportPendingSettlement({
            status: "failed",
            summary: "The app could not complete the confirmed action.",
            reason: "client_execution_failed",
          });
        }
      })();
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

  const startConversation = useCallback(
    async (
      externalRequest?: AgentConversationRequest,
      activationSource: OneVoiceActivationSource = "recovery",
    ) => {
      // A tap may still be resolving a relay ticket while capture begins. Keep
      // the opaque command in a ref so this async path can begin it or fail it
      // closed; React state is intentionally not command authority.
      // The visible Talk-to-One control is command-only. A client may never
      // silently downgrade its PCM to the conversational relay when a server
      // deployment is unavailable; that condition gets a truthful command
      // retry result instead. Non-launcher entrypoints retain their explicit
      // source and do not inherit a tap command by accident.
      const requestedLocationCommand =
        activationSource === "tap" || activationSource === "action_button"
          ? ensureLocationCommandActivation()
          : null;
      const locationCommandTurnId = requestedLocationCommand?.turnId ?? null;
      const isSiriRequest =
        externalRequest?.source === "siri_app_shortcut" &&
        Boolean(externalRequest.requestId);
      const isPersonInitiated =
        activationSource === "tap" ||
        activationSource === "siri_app_shortcut" ||
        activationSource === "action_button";
      if (
        isSiriRequest &&
        externalRequest?.requestId &&
        cancelledExternalRequestIdsRef.current.has(externalRequest.requestId)
      ) {
        return;
      }
      // A real activation clears only the local capture timer. The relay gets
      // the typed source below and records meaningful activity atomically on
      // the server; this browser never advances the five-minute greeting gate.
      if (isPersonInitiated) {
        clearFollowUpCaptureTimer();
      }
      if (locationCommandTurnId) {
        // Both physical microphone entrypoints (the persistent Talk control
        // and Agent Chat's mic) enter the same visible command state before
        // any relay or microphone await. Siri remains a typed handoff.
        setVoiceStatus("listening", "Listening");
      }
      // Toggle off when a session (live OR an error still on screen) exists.
      if (
        voiceLeaseRef.current &&
        !liveClientRef.current &&
        !conversationActive
      ) {
        // A second native tap while credentials are resolving is the same start
        // request, not a toggle. Coalesce it so one mic/socket survives.
        if (isSiriRequest) {
          externalStartRequestRef.current = externalRequest ?? null;
        }
        return;
      }
      if (liveClientRef.current || erroredRef.current || conversationActive) {
        if (isSiriRequest) {
          externalStartRequestRef.current = externalRequest ?? null;
          if (externalRequest?.initialRequestText) {
            liveClientRef.current?.sendUserText?.(
              externalRequest.initialRequestText,
            );
          }
          finishExternalStart(
            liveClientRef.current || conversationActive ? "accepted" : "failed",
          );
          return;
        }
        // A Siri/App Intent text handoff may intentionally keep the warmed
        // session microphone-free. The first real voice tap arms that existing
        // session instead of tearing it down and paying the relay handshake
        // again; a later tap while capture is active remains the normal stop.
        const activeClient = liveClientRef.current;
        if (locationCommandTurnId) {
          if (
            !activeClient?.beginInputTurn?.({ turnId: locationCommandTurnId })
          ) {
            setVoiceStatus(
              "error",
              "Command input is not ready. Tap to try again.",
            );
            return;
          }
          const audioStarted =
            activeClient.isAudioInputActive?.() === true
              ? true
              : await activeClient.startAudioInput?.();
          if (audioStarted !== true) {
            setVoiceStatus("error", "Voice could not start the microphone.");
            return;
          }
          setVoiceStatus("listening", "Listening");
          return;
        }
        if (
          activeClient?.startAudioInput &&
          activeClient.isAudioInputActive?.() === false
        ) {
          void activeClient.startAudioInput().then((started) => {
            if (started !== true) {
              setVoiceStatus("error", "Voice could not start the microphone.");
            }
          });
          return;
        }
        stopConversation();
        return;
      }
      if (isSiriRequest) {
        externalStartRequestRef.current = externalRequest ?? null;
      }
      setForegroundGreeting(null);
      setForegroundGreetingReady(false);
      setForegroundGreetingFollowUpState(null);
      const lease = appInteractionCoordinator.acquireVoiceLease({
        owner: "one_live",
        onRevoked: () => stopConversationRef.current(),
      });
      voiceLeaseRef.current = lease;
      const ownerEpoch = voiceSessionOwnerEpochRef.current;
      const context = runtime?.oneVoiceContextSnapshot ?? null;
      const contextKey = context ? actionableContextKey(context) : null;
      // The command surface deliberately owns a fresh transcript-only relay
      // session for every tap. A previously warmed conversational socket may
      // have different setup semantics and must never receive command PCM or
      // reintroduce a greeting/chat turn while this feature flag is enabled.
      if (locationCommandTurnId) {
        stopPrewarmedSession();
      }
      const warmed = locationCommandTurnId ? null : prewarmedSessionRef.current;
      if (
        warmed &&
        warmed.accessTier === runtime?.tier &&
        warmed.expiresAtMs > Date.now() &&
        warmed.contextKey === contextKey &&
        warmed.ownerEpoch === voiceSessionOwnerEpochRef.current
      ) {
        // Claim the already-authenticated socket before touching the mic. The
        // warm client has been intentionally silent until this tap; once it is
        // installed as the active owner, its normal event handler updates UI.
        prewarmedSessionRef.current = null;
        liveClientRef.current = warmed.client;
        // If the fixed greeting is still waiting for audio or draining, stop it
        // before the same physical tap opens PCM. This fences local self-capture
        // even when the provider control frame and launcher tap race.
        if (foregroundGreetingOutputClientRef.current === warmed.client) {
          warmed.client.cancelGreetingOutput?.();
          foregroundGreetingOutputClientRef.current = null;
        }
        // This call is still in the physical launcher tap's synchronous stack
        // (there has been no await in startConversation yet). A warm greeting
        // may already own a suspended WKWebView output context, so resume that
        // exact client before asking it to open PCM capture below.
        if (!isSiriRequest) {
          warmed.client.resumeOutputForUserGesture?.();
        }
        // A person-originated activation reaches the relay through
        // `activationSource`; no browser timing record is allowed to suppress a
        // server-owned greeting. Keep the opaque scope only for the local
        // follow-up capture timer.
        if (warmed.voiceSessionScope) {
          voiceSessionScopeRef.current = warmed.voiceSessionScope;
        }
        activeRuntimeModeRef.current = warmed.runtimeMode;
        erroredRef.current = false;
        setConversationActive(true);
        scheduleVoiceIdleTimer();
        lastPushedContextRef.current = contextKey;
        const warmedRequest =
          externalRequest ?? externalStartRequestRef.current;
        const warmedInitialText = warmedRequest?.initialRequestText?.trim();
        if (
          locationCommandTurnId &&
          !warmed.client.beginInputTurn?.({ turnId: locationCommandTurnId })
        ) {
          erroredRef.current = true;
          setVoiceStatus(
            "error",
            "Command input is not ready. Tap to try again.",
          );
          warmed.client.stop();
          liveClientRef.current = null;
          voiceLeaseRef.current?.release("warm_location_command_unavailable");
          voiceLeaseRef.current = null;
          activeRuntimeModeRef.current = null;
          setConversationActive(false);
          return;
        }
        const audioStarted = warmedInitialText
          ? true
          : await warmed.client.startAudioInput?.();
        if (!lease.isCurrent() || voiceLeaseRef.current?.id !== lease.id) {
          warmed.client.stop();
          return;
        }
        if (audioStarted !== true) {
          erroredRef.current = true;
          setVoiceStatus("error", "Voice could not start the microphone.");
          warmed.client.stop();
          liveClientRef.current = null;
          voiceLeaseRef.current?.release("warm_audio_input_failed");
          voiceLeaseRef.current = null;
          activeRuntimeModeRef.current = null;
          setConversationActive(false);
          finishExternalStart("failed");
          return;
        }
        if (!warmedInitialText) {
          // The warm transport received its pre-claim state events while the
          // launcher intentionally remained idle. Starting its already-warm
          // audio input can therefore be a no-op at the transport state layer
          // and emit no fresh `listening` event. Mirror the successful physical
          // tap here so the active pill never remains visually idle; this does
          // not open or capture from the microphone until startAudioInput above
          // has returned true.
          setVoiceStatus("listening", "Listening");
        }
        if (warmedInitialText) {
          logVoiceMetric({
            metric: "voice_turn_delegated_to_agent",
            value: 1,
            turnId: createVoiceTurnId(),
            tags: {
              entrypoint: "siri_initial_request",
            },
          });
          warmed.client.sendUserText?.(warmedInitialText);
          finishExternalStart("accepted");
        }
        return;
      }
      // A stale/expired warm socket must not compete with the explicit session
      // for provider capacity or accidentally receive later context updates.
      if (warmed) stopPrewarmedSession();
      // A Location command is always organization-managed. Start its local
      // microphone capture and bounded command queue while the relay ticket is
      // minted rather than showing Listening with no capture behind it. The
      // transport retains every frame locally and cannot open/send command PCM
      // until its relay, provider, and context barriers all complete.
      if (locationCommandTurnId) {
        const relaySessionController = new AbortController();
        relaySessionAbortControllerRef.current?.abort();
        relaySessionAbortControllerRef.current = relaySessionController;
        const relaySessionPromise = ApiService.getOneAdkLiveRelaySession({
          signal: relaySessionController.signal,
        });
        const realtimeAudioInput = createOneVoiceRealtimeAudioInput();
        const client = createRealtimeVoiceTransport({
          onEvent: (event) => {
            if (!lease.isCurrent() || voiceLeaseRef.current?.id !== lease.id) {
              return;
            }
            handleTransportEventRef.current(event);
          },
        });
        liveClientRef.current = client;
        // Claim the command boundary before `start()` opens local capture. The
        // transport supports this pre-start claim specifically so the bounded
        // onset queue has an active turn while the relay ticket is still being
        // minted; without it, early PCM would be intentionally discarded.
        if (!client.beginInputTurn?.({ turnId: locationCommandTurnId })) {
          relaySessionController.abort();
          if (
            relaySessionAbortControllerRef.current === relaySessionController
          ) {
            relaySessionAbortControllerRef.current = null;
          }
          // The aborted ticket is no longer observed by a transport, so consume
          // its expected rejection without surfacing a cancellation as an error.
          void relaySessionPromise.catch(() => undefined);
          erroredRef.current = true;
          setVoiceStatus(
            "error",
            "Command input is not ready. Tap to try again.",
          );
          client.stop();
          if (liveClientRef.current === client) {
            liveClientRef.current = null;
          }
          voiceLeaseRef.current?.release("location_command_unavailable");
          voiceLeaseRef.current = null;
          activeRuntimeModeRef.current = null;
          setConversationActive(false);
          return;
        }
        activeRuntimeModeRef.current = "hushh_managed_vertex";
        erroredRef.current = false;
        setConversationActive(true);
        scheduleVoiceIdleTimer();
        // The client pushes the starting snapshot as app_context on setupComplete.
        lastPushedContextRef.current = context
          ? actionableContextKey(context)
          : null;
        const resumptionHandle = pendingResumptionHandleRef.current;
        pendingResumptionHandleRef.current = null;
        const startPromise = client.start({
          context,
          accessTier: runtime?.tier ?? null,
          // Do not await relay-ticket minting before starting the microphone.
          // The transport awaits this promise only after it has opened local
          // capture, then flushes its bounded PCM queue after full readiness.
          relayUrlPromise: relaySessionPromise.then(({ relayUrl }) => relayUrl),
          sessionMirrorId: mirrorSessionId,
          allowedActionIds:
            context?.executable_action_ids ??
            context?.available_action_ids ??
            null,
          consentToken: vaultOwnerToken ?? null,
          runtimeCredentialMode: "hushh_managed_vertex",
          runtimeCredential: null,
          runtimeCredentialTransport: "developer_api",
          runtimeVertexProject: null,
          runtimeVertexLocation: null,
          resumptionHandle,
          voiceName: readVoicePreferences(user?.uid).voiceName,
          initialGreetingEnabled: false,
          activationSource,
          realtimeAudioInput,
          locationCommandMode: true,
          deferAudioInput: false,
        });
        try {
          const relaySession = await relaySessionPromise;
          if (
            relaySessionAbortControllerRef.current === relaySessionController
          ) {
            relaySessionAbortControllerRef.current = null;
          }
          if (
            !lease.isCurrent() ||
            voiceLeaseRef.current?.id !== lease.id ||
            ownerEpoch !== voiceSessionOwnerEpochRef.current ||
            liveClientRef.current !== client
          ) {
            return;
          }
          voiceSessionScopeRef.current = relaySession.voiceSessionScope;
          await startPromise;
        } catch {
          if (
            relaySessionAbortControllerRef.current === relaySessionController
          ) {
            relaySessionAbortControllerRef.current = null;
          }
          // A user cancellation/background transition has already stopped the
          // transport and revoked the lease. Never replace it with an error.
          if (
            relaySessionController.signal.aborted ||
            !lease.isCurrent() ||
            voiceLeaseRef.current?.id !== lease.id ||
            ownerEpoch !== voiceSessionOwnerEpochRef.current
          ) {
            return;
          }
          // `GeminiLiveTransport.start` emits the safe retry state for a relay
          // failure; this branch only releases the owner if setup threw before
          // it could do so itself.
          client.stop();
          if (liveClientRef.current === client) {
            liveClientRef.current = null;
          }
          voiceLeaseRef.current?.release(
            "location_command_relay_session_failed",
          );
          voiceLeaseRef.current = null;
          activeRuntimeModeRef.current = null;
          setConversationActive(false);
          finishExternalStart("failed");
        }
        return;
      }

      const runtimeConnection = await resolveGeminiRuntimeConnection({
        userId: user?.uid,
        vaultKey,
        vaultOwnerToken,
      });
      if (
        !lease.isCurrent() ||
        voiceLeaseRef.current?.id !== lease.id ||
        ownerEpoch !== voiceSessionOwnerEpochRef.current
      ) {
        if (lease.isCurrent() && voiceLeaseRef.current?.id === lease.id) {
          lease.release("voice_owner_changed");
          voiceLeaseRef.current = null;
        }
        return;
      }
      if (runtimeConnection.mode === "byok" && !runtimeConnection.credential) {
        erroredRef.current = true;
        setVoiceStatus(
          "error",
          "Your Gemini key is unavailable. Open Connections settings.",
        );
        lease.release("missing_runtime_credential");
        voiceLeaseRef.current = null;
        finishExternalStart("failed");
        return;
      }
      // Location commands are an organization-managed, server-authorized
      // product path.  Do not silently borrow a personal Gemini connection
      // even if one is configured for ordinary conversational experiments.
      if (
        locationCommandTurnId &&
        runtimeConnection.mode !== "hushh_managed_vertex"
      ) {
        erroredRef.current = true;
        setVoiceStatus(
          "error",
          "Location commands use the managed secure voice service. Tap to try again.",
        );
        lease.release("location_command_requires_managed_runtime");
        voiceLeaseRef.current = null;
        finishExternalStart("failed");
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
        finishExternalStart("failed");
        return;
      }
      // A Siri request can arrive while an ordinary in-app start is still
      // resolving credentials. In that race the earlier call returns through
      // the lease guard above, so take the latest external request from the ref
      // when this session is finally created.
      const externalRequestForSession =
        externalRequest ?? externalStartRequestRef.current;
      if (externalRequestForSession?.source === "siri_app_shortcut") {
        externalStartRequestRef.current = externalRequestForSession;
      }
      // Mint the relay URL and the server-owned lifecycle scope together. The
      // scope never rides in the WebSocket URL, app context, model prompt, or
      // telemetry; it only keys local timing metadata after the response is
      // structurally validated by ApiService.
      let relaySession: Awaited<
        ReturnType<typeof ApiService.getOneAdkLiveRelaySession>
      >;
      const relaySessionController = new AbortController();
      relaySessionAbortControllerRef.current?.abort();
      relaySessionAbortControllerRef.current = relaySessionController;
      try {
        relaySession = await ApiService.getOneAdkLiveRelaySession({
          signal: relaySessionController.signal,
        });
      } catch {
        if (relaySessionAbortControllerRef.current === relaySessionController) {
          relaySessionAbortControllerRef.current = null;
        }
        if (
          !lease.isCurrent() ||
          voiceLeaseRef.current?.id !== lease.id ||
          ownerEpoch !== voiceSessionOwnerEpochRef.current
        ) {
          return;
        }
        erroredRef.current = true;
        setVoiceStatus(
          "error",
          "Voice could not reach the secure voice relay.",
        );
        lease.release("relay_session_failed");
        voiceLeaseRef.current = null;
        finishExternalStart("failed");
        return;
      }
      if (relaySessionAbortControllerRef.current === relaySessionController) {
        relaySessionAbortControllerRef.current = null;
      }
      if (
        !lease.isCurrent() ||
        voiceLeaseRef.current?.id !== lease.id ||
        ownerEpoch !== voiceSessionOwnerEpochRef.current
      ) {
        if (lease.isCurrent() && voiceLeaseRef.current?.id === lease.id) {
          lease.release("voice_owner_changed");
          voiceLeaseRef.current = null;
        }
        return;
      }
      const { relayUrl, voiceSessionScope } = relaySession;
      voiceSessionScopeRef.current = voiceSessionScope;
      erroredRef.current = false;
      setConversationActive(true);
      scheduleVoiceIdleTimer();
      // iOS provides the same PCM16/16 kHz contract as the browser's
      // AudioWorklet. It is intentionally not a native transcript adapter:
      // Gemini Live receives the audio first and owns endpointing/dialogue.
      const realtimeAudioInput = createOneVoiceRealtimeAudioInput();
      const client = createRealtimeVoiceTransport({
        onEvent: (event) => {
          if (!lease.isCurrent() || voiceLeaseRef.current?.id !== lease.id) {
            return;
          }
          handleTransportEventRef.current(event);
        },
      });
      liveClientRef.current = client;
      if (locationCommandTurnId) {
        if (!client.beginInputTurn?.({ turnId: locationCommandTurnId })) {
          erroredRef.current = true;
          setVoiceStatus(
            "error",
            "Command input is not ready. Tap to try again.",
          );
          client.stop();
          voiceLeaseRef.current?.release("location_command_unavailable");
          voiceLeaseRef.current = null;
          liveClientRef.current = null;
          setConversationActive(false);
          return;
        }
      }
      activeRuntimeModeRef.current = runtimeConnection.mode;
      // The client pushes the starting snapshot as app_context on setupComplete.
      lastPushedContextRef.current = context
        ? actionableContextKey(context)
        : null;
      // Consumed once: a resumption handle belongs to the session that just
      // ended, not to whatever the person starts after it. Reading it here
      // and clearing it in the same breath means an ordinary, unrelated later
      // start never accidentally inherits a stale one.
      const resumptionHandle = pendingResumptionHandleRef.current;
      pendingResumptionHandleRef.current = null;
      await client.start({
        context,
        accessTier: runtime?.tier ?? null,
        relayUrl,
        sessionMirrorId: mirrorSessionId,
        allowedActionIds:
          context?.executable_action_ids ??
          context?.available_action_ids ??
          null,
        consentToken: vaultOwnerToken ?? null,
        runtimeCredentialMode: runtimeConnection.mode,
        runtimeCredential: runtimeConnection.credential,
        runtimeCredentialTransport: runtimeConnection.transport,
        runtimeVertexProject: runtimeConnection.vertexProject,
        runtimeVertexLocation: runtimeConnection.vertexLocation,
        resumptionHandle,
        voiceName: readVoicePreferences(user?.uid).voiceName,
        // Explicitly started sessions already have a person at the mic. The
        // fresh-session welcome belongs only to the foreground warm socket, so
        // a later tap or Siri handoff can never trigger a second greeting.
        initialGreetingEnabled: false,
        activationSource,
        realtimeAudioInput,
        locationCommandMode: Boolean(locationCommandTurnId),
        deferAudioInput: Boolean(externalRequestForSession?.initialRequestText),
      });
      const initialRequestText =
        externalRequestForSession?.initialRequestText?.trim();
      const initialContextReady = initialRequestText
        ? Boolean(
            context &&
            (await client.waitForContextReady?.({ timeoutMs: 2_000 })),
          )
        : true;
      if (initialRequestText && !initialContextReady) {
        setVoiceStatus(
          "error",
          "Agent One could not verify the current screen before handling that request.",
        );
        client.stop();
        finishExternalStart("failed");
        return;
      }
      if (initialRequestText) {
        logVoiceMetric({
          metric: "voice_turn_delegated_to_agent",
          value: 1,
          turnId: createVoiceTurnId(),
          tags: {
            entrypoint: "siri_initial_request",
          },
        });
        client.sendUserText?.(initialRequestText);
      }
    },
    [
      conversationActive,
      runtime?.oneVoiceContextSnapshot,
      runtime?.tier,
      mirrorSessionId,
      scheduleVoiceIdleTimer,
      clearFollowUpCaptureTimer,
      ensureLocationCommandActivation,
      stopConversation,
      vaultOwnerToken,
      vaultKey,
      user?.uid,
      setVoiceStatus,
      finishExternalStart,
      stopPrewarmedSession,
    ],
  );

  // Retrying from an error is stop-then-start, but not in the same tick:
  // startConversation's own guard reads `conversationActive` from THIS
  // render's closure, which is still whatever it was before stopConversation
  // just changed it -- calling both back to back here would see the stale
  // value and hit the "already active" branch again instead of actually
  // starting. A pre-setup failure (mic blocked, no device) never set
  // conversationActive true in the first place, so waiting for it to CHANGE
  // would wait forever for exactly that case -- the counter always changes,
  // regardless of whether conversationActive does, so the effect below is
  // guaranteed to run on every retry.
  useEffect(() => {
    startConversationRef.current = () => void startConversation();
  }, [startConversation]);
  // A manual retry gets the same continuation token an automatic reconnect
  // would use, and resets the one-per-session automatic budget: a person
  // choosing to retry by hand is a fresh decision, not a continuation of
  // whatever already failed once automatically.
  const retryConversation = useCallback(() => {
    pendingResumptionHandleRef.current = lastResumptionHandleRef.current;
    autoReconnectedRef.current = false;
    stopConversation();
    setRetryNonce((current) => current + 1);
  }, [stopConversation]);
  useEffect(() => {
    if (retryNonce === 0) return;
    startConversationRef.current();
    // Only a fresh retry request should re-fire this -- startConversationRef
    // is a ref, kept current by the effect above, and reading .current here
    // does not need to be declared as a dependency.
  }, [retryNonce]);

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
    const contextKey = actionableContextKey(context!);
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

  const beginLocationCommandTap = useCallback(() => {
    const activation = ensureLocationCommandActivation();
    const turnId = activation.turnId;
    // This runs inside the physical click gesture. The command transport has
    // no output lane, but priming here preserves a valid platform activation
    // for any existing output-context cleanup.
    primeRealtimeVoiceOutput();
    logVoiceMetric({
      metric: "voice_tap",
      value: 1,
      turnId,
      tags: { entrypoint: "location_tap" },
    });
    // The tap opens one command turn. Show the promised state in the same
    // event turn so people can start speaking naturally; server-side speech
    // endpointing—not a second tap or a client timer—closes that turn.
    // Capture remains locally buffered until relay, provider, and trusted
    // context each acknowledge readiness, and a real failure replaces this
    // with the specific retry state below.
    setVoiceStatus("listening", "Listening");
    void startConversation(undefined, "tap");
  }, [ensureLocationCommandActivation, setVoiceStatus, startConversation]);

  const handleVoiceStartClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      const activeCommand = locationCommandActivationRef.current;
      if (
        activeCommand &&
        !activeCommand.cancelled &&
        !activeCommand.completed
      ) {
        // A second tap is an explicit cancellation. It closes capture and
        // preserves the command runtime's fail-closed cancellation path; it
        // is never interpreted as a speech-end boundary.
        stopConversation();
        return;
      }
      beginLocationCommandTap();
    },
    [
      beginLocationCommandTap,
      stopConversation,
    ],
  );

  useEffect(() => {
    const handleConversationRequest = (event: Event) => {
      const request = (event as CustomEvent<AgentConversationRequest>).detail;
      const isSiriRequest = request?.source === "siri_app_shortcut";
      void startConversation(
        isSiriRequest ? request : undefined,
        isSiriRequest ? "siri_app_shortcut" : "action_button",
      );
    };
    // A stop that is a no-op unless something is actually live, so it cannot
    // become a general-purpose cancel. `stopConversation` also aborts the
    // in-flight action run and cancels active action runs, so an unconditional
    // call would kill a typed action run every time someone looked at another
    // surface. The lease check is the half that matters: it covers the window
    // where the mic is leased but the transport is not live yet, and releasing
    // the lease makes the in-flight `startConversation` abort at its own
    // post-await `lease.isCurrent()` check.
    const handleConversationStop = () => {
      if (
        !voiceLeaseRef.current &&
        !liveClientRef.current &&
        !erroredRef.current &&
        !conversationActive
      ) {
        return;
      }
      stopConversation();
    };
    const handleConversationCancel = (event: Event) => {
      const cancellation = (
        event as CustomEvent<{
          source?: string;
          requestId?: string;
        }>
      ).detail;
      if (
        cancellation?.source !== "siri_app_shortcut" ||
        typeof cancellation.requestId !== "string" ||
        !cancellation.requestId
      ) {
        return;
      }
      cancelledExternalRequestIdsRef.current.add(cancellation.requestId);
      if (
        externalStartRequestRef.current?.requestId !== cancellation.requestId
      ) {
        return;
      }
      externalStartRequestRef.current = null;
      stopConversationRef.current();
    };
    window.addEventListener(
      AGENT_CONVERSATION_REQUEST_EVENT,
      handleConversationRequest,
    );
    window.addEventListener(
      AGENT_CONVERSATION_STOP_EVENT,
      handleConversationStop,
    );
    window.addEventListener(
      AGENT_CONVERSATION_CANCEL_EVENT,
      handleConversationCancel,
    );
    const markUnavailable = markAgentConversationOwnerReady();
    return () => {
      markUnavailable();
      window.removeEventListener(
        AGENT_CONVERSATION_REQUEST_EVENT,
        handleConversationRequest,
      );
      window.removeEventListener(
        AGENT_CONVERSATION_STOP_EVENT,
        handleConversationStop,
      );
      window.removeEventListener(
        AGENT_CONVERSATION_CANCEL_EVENT,
        handleConversationCancel,
      );
    };
  }, [conversationActive, startConversation, stopConversation]);

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
    const handleLifecycleChange = () => {
      const lifecycle = appInteractionCoordinator.getLifecycleSnapshot();
      if (lifecycle.state === "background") {
        setForegroundGreeting(null);
        setForegroundGreetingReady(false);
        setForegroundGreetingFollowUpState(null);
        stopPrewarmedSession();
        if (liveClientRef.current || conversationActive) {
          stopConversation();
        }
        return;
      }
    };

    return appInteractionCoordinator.subscribeLifecycle(handleLifecycleChange);
  }, [conversationActive, stopConversation, stopPrewarmedSession]);

  // Talk-to-One is a command surface, not a foreground live-chat surface.
  // Clear any residual greeting/prewarm state on mount and whenever its
  // owner changes; every microphone activation creates an explicit command
  // turn below.
  useEffect(() => {
    setForegroundGreeting(null);
    setForegroundGreetingReady(false);
    setForegroundGreetingFollowUpState(null);
    stopPrewarmedSession();
  }, [stopPrewarmedSession]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") return;
      setForegroundGreeting(null);
      setForegroundGreetingReady(false);
      setForegroundGreetingFollowUpState(null);
      stopPrewarmedSession();
      if (liveClientRef.current || conversationActive) {
        stopConversation();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [conversationActive, stopConversation, stopPrewarmedSession]);

  // Tear down the live session if the bar unmounts (route change, sign-out).
  // Also clear the shared voice store so a stale status (e.g. "error",
  // "listening") does not leak to other consumers after the bar is gone.
  useEffect(() => {
    return () => {
      if (idleTimeoutRef.current) {
        clearTimeout(idleTimeoutRef.current);
        idleTimeoutRef.current = null;
      }
      clearFollowUpCaptureTimer();
      abandonPendingConfirmation(
        "component_unmounted",
        "The confirmation was cancelled when the voice surface closed.",
        false,
      );
      liveClientRef.current?.stop();
      liveClientRef.current = null;
      relaySessionAbortControllerRef.current?.abort();
      relaySessionAbortControllerRef.current = null;
      stopPrewarmedSession();
      resetVoice();
    };
  }, [
    abandonPendingConfirmation,
    clearFollowUpCaptureTimer,
    resetVoice,
    stopPrewarmedSession,
  ]);

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

  // A pending server-issued card has a higher continuity requirement than the
  // launcher. The dedicated Agent route may hide its ordinary dock, but it
  // must not hide the person's next required decision behind that navigation.
  // Logout/auth-loading and an explicit runtime suppression remain hard
  // boundaries and deliberately do not inherit this visual exception.
  const unmountBar =
    !agentPopover ||
    authLoading ||
    // Focused onboarding routes retain voice but use the voice-only rendering
    // branch above, so Agent Chat never appears over setup or phone entry.
    (path === ROUTES.AGENT && !pendingConfirmation) ||
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
  const barHidden = Boolean(agentWindowActive && !pendingConfirmation);
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
  // Broader than trusted activation: also true when a confirm_required
  // action needs a hard tap only because of the person's own
  // require_tap_confirmation setting (lib/agent/confirmation-tap-policy.ts).
  // requiresHardTapConfirmation() is the one place that decision is already
  // made correctly (agent-bar.tsx:1342 uses it to decide whether to keep the
  // confirmation pending for a tap); without this second check, a card in
  // that state rendered "say yes to continue" with no Cancel/Authorize
  // buttons at all -- a real dead end, since a spoken yes never settles it.
  const pendingActionNeedsHardTap =
    pendingConfirmation?.requiresTrustedTapConfirmation === true ||
    requiresHardTapConfirmation(
      pendingAction,
      runtime?.oneVoiceContextSnapshot.voice_settings
        .require_tap_confirmation === true,
    );
  const pendingActionLabel = pendingAction?.label || "Continue this action";

  // The specific reason (mic blocked, no device, setup timeout) now lives in
  // VoiceErrorCard, which shows it in full. This pill is a compact status
  // strip with real estate for maybe half a sentence -- long enough to
  // truncate any real reason into an ellipsis that told nobody what to do.
  const voiceStatusLabel =
    activeActionRun?.message ??
    (voiceStatus === "speaking" && voiceMessage
      ? voiceMessage
      : getAgentVoiceStatusLabel(voiceStatus));
  const nativeVoiceMode =
    !conversationActive || voiceStatus === "idle"
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
        className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]"
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
        className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]"
      >
        <MaterialRipple variant="gradient" effect="fill" />
      </span>
    </button>
  );

  // During onboarding and on foundation public routes, show the theme and accent toggles
  const showToggles =
    onboardingGreeterMode ||
    isOneSetupRoute(pathname || "") ||
    isFoundationPublic;
  const showAgentChatAction = Boolean(
    user?.uid &&
    !focusedOnboardingVoiceOnly &&
    !isHomeRoute &&
    !isLoginRoute &&
    !isFoundationPublic,
  );
  const foregroundGreetingFollowUpLabel =
    foregroundGreetingFollowUpState === "tap_required"
      ? "Tap to enable mic"
      : foregroundGreetingFollowUpState === "arming"
        ? "Preparing mic"
        : foregroundGreetingFollowUpState === "listening"
          ? "Listening"
          : "Tap to talk";
  const voiceLauncherInstruction = "Tap to talk to One. I’ll listen until you finish.";
  // Dock contents for the assistant actions, one JSX source across all modes so
  // the voice/theme controls and test ids never fork.
  const pillContents =
    conversationActive && voiceStatus !== "idle" ? (
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
          onPointerDown={(event) => {
            // Stop on press, before Material Web's release ripple can finish.
            // Keyboard activation still uses onClick below.
            event.preventDefault();
            stopConversation();
          }}
          onClick={stopConversation}
            aria-label="Cancel command"
            title="Tap to cancel command"
          className="bottom-chrome-surface relative z-0 flex h-11 min-w-0 flex-1 items-center gap-3 overflow-hidden rounded-full pl-1 pr-2 text-left transition-[background-color,transform] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--app-accent-ring)]"
        >
          <span
            aria-hidden
            className={cn(
              "one-bar-aurora -z-10 transition-opacity duration-500",
              visualOnboardingChrome
                ? "one-bar-aurora--onboarding"
                : "one-bar-aurora--active",
            )}
          />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]"
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
                  ? "text-destructive/80"
                  : "tabular-nums text-current/60",
              )}
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
        <div
          className={cn(
            "flex min-w-0 flex-1 items-stretch",
            showAgentChatAction && "overflow-hidden rounded-full",
          )}
        >
          <button
            type="button"
            data-native-voice-control-id="one_voice_agent_bar_start"
            data-testid="one-voice-agent-bar-start-icon"
            data-agent-action="voice"
            onClick={handleVoiceStartClick}
            aria-label={
              foregroundGreetingReady
                ? voiceLauncherInstruction
                : `${voiceLauncherInstruction} ${hint}`
            }
            title={
              "Tap to start a command with One"
            }
            className={cn(
              "agent-bar-voice-launcher press-scale bottom-chrome-surface relative flex h-11 min-w-0 flex-1 items-center gap-2 overflow-hidden px-3 text-left transition-[background-color,transform] duration-200 hover:bg-current/[0.09] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--app-accent-ring)] dark:hover:bg-current/[0.12]",
              showAgentChatAction
                ? "rounded-l-full rounded-r-none"
                : "rounded-full",
            )}
          >
            <span
              aria-hidden
              className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-current"
            >
              <AudioLines className="h-[19px] w-[19px]" />
            </span>
            <span
              data-testid="one-voice-foreground-greeting"
              role={foregroundGreeting ? "status" : undefined}
              aria-live={foregroundGreeting ? "polite" : undefined}
              aria-atomic={foregroundGreeting ? "true" : undefined}
              className="relative z-10 min-w-0 flex-1 truncate text-[13px] font-medium text-current/70"
            >
              {foregroundGreeting ?? "Talk to One"}
            </span>
            {foregroundGreetingReady ? (
              <span
                data-testid="one-voice-talk-ready"
                data-follow-up-state={
                  foregroundGreetingFollowUpState ?? "ready"
                }
                aria-hidden
                className="relative z-10 shrink-0 rounded-full bg-current/[0.09] px-2 py-1 text-[11px] font-semibold text-current/70"
              >
                {foregroundGreetingFollowUpLabel}
              </span>
            ) : null}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-[inherit]"
            >
              <MaterialRipple variant="gradient" effect="fill" />
            </span>
          </button>
          {showAgentChatAction ? (
            <button
              type="button"
              data-testid="one-agent-chat-open"
              data-agent-action="chat"
              onClick={openAgentChat}
              aria-label={`Chat with One. ${hint}`}
              title="Chat with One"
              className="bottom-chrome-surface press-scale relative flex h-11 min-w-[88px] shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-l-none rounded-r-full border-l border-current/15 px-3 text-current transition-[background-color,transform] duration-200 hover:bg-current/[0.09] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--app-accent-ring)] dark:hover:bg-current/[0.12] sm:min-w-[96px]"
            >
              <MessageCircle className="h-[17px] w-[17px]" />
              <span
                data-testid="one-agent-chat-label"
                className="text-[13px] font-medium text-current/70"
              >
                Chat
              </span>
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]"
              >
                <MaterialRipple variant="gradient" effect="fill" />
              </span>
            </button>
          ) : null}
        </div>
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
        layout === "fixed" &&
          (elevatedForInteractionLayer ? "z-[540]" : "z-[118]"),
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
      <VoiceWalkthroughPanel
        enabled={walkthroughModeEnabled}
        onCancel={cancelActiveWalkthroughTask}
      />
      {/* Only while nothing more immediate is already up: a confirmation or
          error is the person's next decision, and a dead end describing a
          state the screen has already moved past would be stale advice
          competing with it. */}
      {deadEnd && !pendingConfirmation ? (
        <div
          role="status"
          aria-label="What's blocking this screen"
          className="agent-approval-glass pointer-events-auto w-full max-w-[min(calc(100vw-3rem),392px)] rounded-3xl p-4 text-[#1d1d1f] dark:text-[#f5f5f7]"
        >
          <p className="text-[13px] leading-relaxed">{deadEnd.reason}</p>
          {deadEndRemedyAction ? (
            <button
              type="button"
              onClick={runDeadEndRemedy}
              disabled={deadEndRemedyBusy}
              className="mt-4 h-12 w-full rounded-full bg-primary text-[15px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-transparent disabled:opacity-50"
            >
              {deadEndRemedyBusy ? "Working…" : deadEndRemedyAction.label}
            </button>
          ) : null}
        </div>
      ) : null}
      <VoiceErrorCard
        message={voiceStatus === "error" ? voiceMessage : null}
        onRetry={retryConversation}
        onClose={stopConversation}
      />
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
          {/* Sourced from the generated contract's own `meaning`, the same
              field VoiceConfirm's `consequence` already reads for the 7
              handler-authored cards -- so every confirmation names what will
              actually happen, not just that something needs a yes, and stays
              true when the action's behavior changes instead of drifting
              into static copy nobody updates alongside it. */}
          {pendingAction?.meaning ? (
            <p className="mt-1 text-[13px] leading-relaxed">
              {pendingAction.meaning}
            </p>
          ) : null}
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            {pendingActionNeedsTrustedActivation
              ? "This tap opens the provider window and keeps One active here."
              : pendingActionNeedsHardTap
                ? "Sensitive values stay hidden. Tap Authorize to continue, or Cancel."
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
              {pendingActionNeedsHardTap
                ? "Still there? Tap the button above or Cancel when you're ready."
                : "Still there? Say yes to continue or no to cancel."}
            </p>
          ) : null}
          {pendingActionNeedsHardTap ? (
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
        data-agent-dock="one-agent-dock"
        role="group"
        aria-label="One assistant"
        data-voice-mode={nativeVoiceMode}
        data-morphy-ax-presentation={runtime?.morphyAxPresentation ?? "idle"}
        className={cn(
          // z-0 (not just `relative`) keeps each child action's internal glow
          // and ripple scoped to that action instead of flattening into the
          // whole bottom shell.
          "pointer-events-auto relative z-0 flex w-full items-stretch gap-2",
          // The root, public, and signed-in variants share one bar chassis.
          // Route state may add toggles, but cannot fork width or geometry.
          layout === "slot"
            ? "max-w-[min(calc(100vw-1.5rem),var(--app-agent-bar-max-width))]"
            : "max-w-[min(calc(100vw-2rem),34rem)]",
          // Single, consolidated transition covering surface color plus the
          // open/close fade+lift. Smoothly eases the bar in/out with the agent
          // window lifecycle so it never snaps back into place after closing.
          "transition-[opacity,transform,background-color,box-shadow] duration-300 ease-[cubic-bezier(0.16,0.84,0.28,1)] will-change-[opacity,transform]",
          // Bottom-shell material: read the same live ambient token as the
          // shared bottom mask so the Agent Bar never becomes a white pill on
          // a dark/gradient route surface.
          barHidden
            ? "pointer-events-none translate-y-1 scale-[0.98] opacity-0"
            : "translate-y-0 scale-100 opacity-100",
          barAmbient && "pointer-events-none opacity-70",
        )}
      >
        {pillContents}
      </div>
    </div>
  );
}
