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
import { AudioLines, MessageSquare, X } from "lucide-react";

import { useOptionalAgentPopover } from "@/components/agent/agent-popover-provider";
import { AgentVoiceWaveform } from "@/components/agent/agent-voice-waveform";
import { useAuth } from "@/hooks/use-auth";
import { executeAgentGatewayAction } from "@/lib/agent/agent-action-runtime";
import { useAgentRuntimeStateOptional } from "@/lib/agent/agent-runtime-context";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";
import { ApiService } from "@/lib/services/api-service";
import {
  getAgentVoiceStatusLabel,
  useAgentVoiceState,
} from "@/lib/agent/agent-voice-state";
import { useKaiBottomChromeVisibility } from "@/lib/navigation/kai-bottom-chrome-visibility";
import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import { ROUTES, isOneSetupRoute } from "@/lib/navigation/routes";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import { usePersonaState } from "@/lib/persona/persona-context";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";
import { getVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { createRealtimeVoiceTransport } from "@/lib/voice/one-voice-transport-factory";
import type {
  OneVoiceSessionEvent,
  RealtimeVoiceTransport,
} from "@/lib/voice/one-voice-transport";
import type { AgentVoiceEventOptions, AgentVoiceStatus } from "@/lib/agent/agent-voice-state";

type PrewarmedGeminiRelay = {
  relayUrl: string;
  expiresAtMs: number;
  snapshotId: string;
  accessTier: string;
};

// Precaution: if a live voice session sits idle (no user speech, no agent
// speech, no tool/navigation activity) this long, close it automatically
// instead of leaving an open mic/session hanging indefinitely. Mirrors the
// idle-timeout pattern already used for the streamed voice turn watchdog in
// `agent-chat-workspace.tsx` (`VOICE_AGENT_IDLE_TIMEOUT_MS`), but scoped to
// the full ambient session rather than a single streamed turn since Gemini
// Live has no per-turn stream to watch.
const AGENT_BAR_VOICE_IDLE_TIMEOUT_MS = 90_000;

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
  const pathname = usePathname();
  const router = useRouter();
  const agentPopover = useOptionalAgentPopover();
  // Shared single source of truth for the agent's active state. The bar uses it
  // for tier-aware presentation and to detect the home/onboarding surfaces
  // consistently with the chat workspace, instead of recomputing locally.
  const runtime = useAgentRuntimeStateOptional();
  const { user } = useAuth();
  const { vaultOwnerToken } = useVault();
  const { switchPersona } = usePersonaState();
  const busyOperations = useKaiSession((state) => state.busyOperations);
  const setAnalysisParams = useKaiSession((state) => state.setAnalysisParams);
  const appendMirrorEvent = useOneConversationSession((state) => state.appendMirrorEvent);
  const createHandoff = useOneConversationSession((state) => state.createHandoff);
  const mirrorSessionId = useOneConversationSession((state) => state.sessionId);

  // In-bar conversation (Gemini Live full-duplex) state. This lives entirely in
  // the bar: tapping conversation mode does NOT open the chat popover. Instead
  // the bar highlights and an ambient waveform animates in place, reacting to
  // the user's voice (listening) and the agent's reply (speaking).
  const [conversationActive, setConversationActive] = useState(false);
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
  // Last SCREEN pushed into the live session. Deduping on snapshot_id was a
  // bug: snapshot_id churns with every voice state transition (voiceRevision
  // = transitionSeq), so each listening/speaking flip re-pushed app_context,
  // and each push preempted One's active model turn (speech cut mid-sentence,
  // greetings cancelled). Navigation continuity only needs the screen.
  const lastPushedScreenRef = useRef<string | null>(null);
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

  const handleTransportEvent = useCallback((event: OneVoiceSessionEvent) => {
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
      sessionId: "sessionId" in event ? event.sessionId ?? null : null,
      sourceId: "sourceId" in event ? event.sourceId ?? null : event.provider,
      sourceSeq: "sourceSeq" in event ? event.sourceSeq ?? null : null,
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
        text: transcript,
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
        const route =
          typeof event.directive.payload?.route === "string"
            ? event.directive.payload.route
            : null;
        if (route && route.startsWith("/")) {
          router.push(route);
        }
        return;
      }
      if (event.directive.kind === "action") {
        const actionId =
          typeof event.directive.payload?.actionId === "string"
            ? event.directive.payload.actionId
            : null;
        if (actionId) {
          const slots =
            event.directive.payload?.slots &&
            typeof event.directive.payload.slots === "object"
              ? (event.directive.payload.slots as Record<string, unknown>)
              : undefined;
          if (event.directive.payload?.needsConfirmation === true) {
            // Sensitive actions confirm in the audited chat surface, never
            // silently from voice.
            const handoff = createHandoff({
              reason: "action_requires_chat",
              transcript: null,
              assistantText: `Confirm before running: ${actionId}`,
              actionId,
            });
            liveClientRef.current?.interrupt?.();
            agentPopover?.openAgent({ handoff });
            return;
          }
          const runtimeState = runtime?.appRuntimeState;
          if (!runtimeState) return;
          void executeAgentGatewayAction({
            actionId,
            slots,
            userId: user?.uid ?? "",
            router,
            appRuntimeState: runtimeState,
            surfaceMetadata: getVoiceSurfaceMetadata(),
            hasPortfolioData:
              runtimeState.portfolio.has_portfolio_data ||
              runtime?.oneVoiceContextSnapshot.cache.portfolio_ready === true,
            busyOperations,
            setAnalysisParams,
            switchPersona,
          });
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
        typeof event.payload?.transcript === "string" ? event.payload.transcript : null;
      const assistantText =
        typeof event.payload?.assistantText === "string" ? event.payload.assistantText : null;
      const actionId =
        typeof event.payload?.actionId === "string" ? event.payload.actionId : null;
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
      clearVoiceIdleTimer();
      liveClientRef.current = null;
      if (erroredRef.current) return;
      setConversationActive(false);
    }
  }, [
    agentPopover,
    appendMirrorEvent,
    busyOperations,
    clearVoiceIdleTimer,
    createHandoff,
    router,
    runtime,
    scheduleVoiceIdleTimer,
    setAnalysisParams,
    setVoiceLevel,
    setVoiceStatus,
    switchPersona,
    user?.uid,
  ]);

  const stopConversation = useCallback(() => {
    clearVoiceIdleTimer();
    erroredRef.current = false;
    liveClientRef.current?.stop();
    liveClientRef.current = null;
    prewarmedRelayRef.current = null;
    setConversationActive(false);
    resetVoice();
  }, [clearVoiceIdleTimer, resetVoice]);

  useEffect(() => {
    stopConversationRef.current = stopConversation;
  }, [stopConversation]);

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
    lastPushedScreenRef.current = context?.route.screen ?? null;
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
      lastPushedScreenRef.current = null;
      return;
    }
    const context = runtime?.oneVoiceContextSnapshot;
    const client = liveClientRef.current;
    if (!context || !client?.updateContext) return;
    // Only a real screen change warrants a push; anything finer-grained
    // (voice transitions, cache freshness ticks) preempts One's active
    // model turn on the Live API and audibly cuts speech.
    if (lastPushedScreenRef.current === context.route.screen) return;
    if (client.updateContext(context)) {
      lastPushedScreenRef.current = context.route.screen;
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
    if (typeof document !== "undefined" && document.visibilityState !== "visible") {
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
  }, [
    conversationActive,
    runtime?.oneVoiceContextSnapshot,
    runtime?.tier,
  ]);

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
      liveClientRef.current?.stop();
      liveClientRef.current = null;
      prewarmedRelayRef.current = null;
      resetVoice();
    };
  }, [resetVoice]);

  const chromeState = useMemo(() => getKaiChromeState(pathname), [pathname]);
  // The root intro screen ("/") has no bottom nav, exactly like the onboarding
  // flow, so the bar must anchor above the safe area (not against the absent
  // nav inset) and must not ride the scroll-hide translation there. Prefer the
  // shared runtime's derived signals so the bar and chat workspace agree on the
  // home/onboarding surface; fall back to local computation when the provider
  // is unavailable.
  const isHomeRoute = runtime?.isHomeRoute ?? (pathname ?? "") === ROUTES.HOME;
  const useOnboardingChrome =
    (runtime?.onboardingActive ?? chromeState.useOnboardingChrome) || isHomeRoute;

  // Hide/show in lockstep with the rest of the bottom chrome (nav + search).
  const allowScrollHide = !useOnboardingChrome;
  const { progress: hideBottomChromeProgress } =
    useKaiBottomChromeVisibility(allowScrollHide);

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
  // exist (legacy dedicated agent route, phone mandate, appearance lab,
  // developers) or on transient auth transitions (login, logout) where the
  // app shell is not the host.
  const path = pathname ?? "";
  // The waveform action circle is white only on the 2c dark dashboard (where a
  // white circle pops); on every other surface (welcome, profile, kai, …) it is
  // the indigo accent, per design.md §5.5.
  const onDashboard = path === ROUTES.ONE_HOME || path === `${ROUTES.ONE_HOME}/`;
  // The logged-out welcome ("/") now hosts the dogfooding onboarding voice
  // greeter instead of unmounting the bar outright: it doubles as the
  // pre-auth conversation starter and stays route-aware for whatever the
  // signed-out flow visits next.
  const onboardingGreeterMode = isHomeRoute && runtime?.tier === "anon_onboarding";

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
    if (conversationActive || liveClientRef.current || erroredRef.current) return;
    autoGreetedRef.current = true;
    startConversation();
    // Intentionally excludes startConversation/conversationActive from deps:
    // this must fire exactly once per onboarding mount, not re-run whenever
    // those identities change (they change on every voice status transition).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboardingGreeterMode]);

  const unmountBar =
    !agentPopover ||
    // The One setup surface is a focused onboarding flow (like Apple's "Finish
    // Setting Up" in Settings): a centered translucent agent launcher reads
    // over the wide grouped-list rows on scroll (they show through it / beside
    // it), so it is unmounted across the whole setup surface. isOneSetupRoute
    // (not an exact match) is required because the Capacitor build uses
    // trailingSlash, so the runtime pathname is "/one/setup/".
    isOneSetupRoute(path) ||
    path.startsWith(ROUTES.PHONE_MANDATE) ||
    path.startsWith(ROUTES.LABS_PROFILE_APPEARANCE) ||
    path === ROUTES.DEVELOPERS ||
    path === ROUTES.AGENT ||
    path.startsWith(ROUTES.LOGIN) ||
    path.startsWith(ROUTES.LOGOUT);

  if (unmountBar) {
    return null;
  }

  // While the agent window is active, keep the bar mounted but visually faded
  // and non-interactive. When the window finishes closing it eases back in over
  // the same envelope instead of popping in from a fresh mount.
  const barHidden = Boolean(agentWindowActive);

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

  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-[118] flex justify-center px-4 transform-gpu"
      style={
        {
          // Sit just above the visible bottom nav and ride the same scroll-hide
          // translation as the rest of the bottom chrome.
          //
          // --app-bottom-inset already = measured nav height
          // (--app-bottom-fixed-ui) + safe-area + lift, so it is the full
          // clearance above the nav on its own. We add a single small visual gap
          // (0.5rem) above that — do NOT re-add the safe area (it is already
          // baked into --app-bottom-inset) and do NOT floor against the static
          // 88px fallback. Both of those were double-counting and inflated the
          // gap. The transient-zero case is already handled upstream: the navbar
          // preserves its last measured --app-bottom-fixed-ui while temporarily
          // unmounted, and this bar only renders when the nav is present, so the
          // inset is always the real measured value here.
          //
          // During onboarding the bottom nav is intentionally hidden, so
          // --app-bottom-inset is not the right clearance there (it can be stale
          // or near-zero). In that case pin the bar directly above the safe area
          // with the same small visual gap, and do not ride the scroll-hide
          // translation (there is no nav to hide in lockstep with).
          bottom: useOnboardingChrome
            ? "calc(env(safe-area-inset-bottom, 0px) + 0.75rem)"
            : "calc(var(--app-bottom-inset) + 0.5rem)",
          transform: useOnboardingChrome
            ? undefined
            : "translate3d(0, calc(var(--bottom-chrome-progress, 0) * var(--bottom-chrome-hide-distance, var(--bottom-chrome-full-height))), 0)",
          "--bottom-chrome-progress": String(hideBottomChromeProgress),
        } as CSSProperties
      }
      aria-hidden={barHidden}
    >
      <div
        data-testid="one-voice-agent-bar"
        data-voice-mode={nativeVoiceMode}
        className={cn(
          "pointer-events-auto flex w-full max-w-[min(calc(100vw-2rem),34rem)] items-center gap-2",
          "h-11 rounded-full pl-3 pr-1.5",
          // Single, consolidated transition covering surface color plus the
          // open/close fade+lift. Smoothly eases the bar in/out with the agent
          // window lifecycle so it never snaps back into place after closing.
          "transition-[opacity,transform,background-color,box-shadow] duration-300 ease-[cubic-bezier(0.16,0.84,0.28,1)] will-change-[opacity,transform]",
          // Resting: solid ink "#111" ask pill (2c cinematic) with a hairline
          // rim so it reads on both light and dark shells. While in conversation
          // mode the bar lifts to a highlighted, primary-tinted surface so it
          // reads as a live, active listening session.
          conversationActive
            ? "bg-primary/10 text-foreground ring-1 ring-primary/30 dark:bg-primary/15"
            : isHomeRoute
              ? "bg-black/[0.05] text-[#0A0A0A] ring-1 ring-black/[0.06] dark:bg-white/[0.08] dark:text-white dark:ring-white/10"
              : "bg-[#0A0908] text-white ring-1 ring-white/10",
          barHidden
            ? "pointer-events-none translate-y-1 scale-[0.98] opacity-0"
            : "translate-y-0 scale-100 opacity-100",
        )}
      >
        {conversationActive ? (
          <>
            <div
              className="flex min-w-0 flex-1 items-center gap-3 pl-1"
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
                  // The error reason can be a full sentence; let it use the row
                  // and truncate rather than overflow the pill. Status words stay
                  // compact with tabular figures.
                  voiceStatus === "error"
                    ? "min-w-0 max-w-[60%] flex-1 truncate text-right text-destructive/80"
                    : "tabular-nums text-foreground/60",
                )}
                title={voiceStatus === "error" ? voiceStatusLabel : undefined}
              >
                {voiceStatusLabel}
              </span>
            </div>
            <button
              type="button"
              data-native-voice-control-id="one_voice_agent_bar_end"
              data-testid="one-voice-agent-bar-end"
              onClick={stopConversation}
              aria-label="End conversation"
              title="End conversation"
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                "bg-black/[0.05] text-accent-strong dark:bg-white/[0.07]",
                "transition-[background-color,transform] duration-200",
                "hover:bg-black/[0.08] active:scale-90 dark:hover:bg-white/[0.1]",
              )}
            >
              <X className="h-4 w-4" />
            </button>
          </>
        ) : onboardingGreeterMode ? (
          // Signed-out welcome ("/"): the bar itself IS the conversation
          // starter (not a text hint that opens chat). Left = mic icon
          // marker, whole body is the tap target, right = chat toggle that
          // stays visually present but disabled - chat needs a signed-in,
          // vault-capable session, which does not exist pre-auth.
          <>
            <button
              type="button"
              data-native-voice-control-id="one_voice_agent_bar_start"
              data-testid="one-voice-agent-bar-start-icon"
              onClick={handleVoiceStartClick}
              aria-label="Start conversation with One"
              title="Start conversation"
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2.5 rounded-full pl-1 text-left",
                "transition-colors duration-200 active:scale-[0.99]",
              )}
            >
              <span
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                  "bg-black/[0.05] text-accent-strong ring-1 ring-black/[0.04] dark:bg-white/[0.07] dark:ring-white/[0.08]",
                )}
              >
                <AudioLines className="h-[16px] w-[16px]" />
              </span>
              <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-muted-foreground">
                Talk to One
              </span>
            </button>
            <button
              type="button"
              disabled
              aria-disabled="true"
              aria-label="Chat is available after you sign in"
              title="Chat is available after you sign in"
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
                "bg-black/[0.05] text-muted-foreground/50 ring-1 ring-black/[0.04] dark:bg-white/[0.07] dark:ring-white/[0.08]",
                "cursor-not-allowed opacity-60",
              )}
            >
              <MessageSquare className="h-[18px] w-[18px]" />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              data-testid="one-voice-agent-bar-start"
              onClick={openAgentChat}
              aria-label={`Open Agent Chat. ${hint}`}
              title="Open Agent Chat"
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2.5 rounded-full pl-1 text-left",
                "transition-colors duration-200 active:scale-[0.99]",
              )}
            >
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-[14px] font-medium",
                  isHomeRoute ? "text-black/45 dark:text-white/55" : "text-white/55",
                )}
              >
                {hint}
              </span>
            </button>
            <button
              type="button"
              data-native-voice-control-id="one_voice_agent_bar_start"
              data-testid="one-voice-agent-bar-start-icon"
              onClick={handleVoiceStartClick}
              aria-label="Start conversation"
              title="Start conversation"
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
                onDashboard
                  ? "bg-white text-[#111] hover:bg-white/90"
                  : "bg-[linear-gradient(158deg,#E4C482,#B98A45)] text-white hover:brightness-95",
                "transition-[background-color,transform] duration-200 active:scale-90",
              )}
            >
              <AudioLines className="h-[18px] w-[18px]" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
