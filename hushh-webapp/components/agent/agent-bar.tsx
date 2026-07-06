// components/agent/agent-bar.tsx
// Persistent, screen-aware agent launcher bar.
//
// A single sleek bar that spans across just above the bottom navbar + search on
// every authenticated screen. It replaces the old draggable floating "Agent"
// pill so the agent is always present and context-aware: the hint text adapts to
// the current screen so the bar can guide the user from onboarding to any part
// of the app. The bar defaults to One Voice conversation; Agent Chat owns its
// own mic control inside the popover.

"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { AudioLines, X } from "lucide-react";

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
import {
  OneVoiceLiveActionBridge,
  type OneVoiceLiveActionBridgeConfig,
} from "@/lib/voice/one-voice-live-action-bridge";
import { createRealtimeVoiceTransport } from "@/lib/voice/one-voice-transport-factory";
import type {
  OneVoiceActionProposal,
  OneVoiceSessionEvent,
  RealtimeVoiceTransport,
} from "@/lib/voice/one-voice-transport";
import { getVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import type { AgentVoiceEventOptions, AgentVoiceStatus } from "@/lib/agent/agent-voice-state";

type PrewarmedGeminiRelay = {
  relayUrl: string;
  expiresAtMs: number;
  snapshotId: string;
  accessTier: string;
};

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
  const { vaultOwnerToken, vaultKey } = useVault();
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
  const liveActionBridgeRef = useRef<OneVoiceLiveActionBridge | null>(null);
  const pendingProposalRef = useRef<OneVoiceActionProposal | null>(null);
  const lastTranscriptRef = useRef<{ text: string; atMs: number } | null>(null);
  const prewarmedRelayRef = useRef<PrewarmedGeminiRelay | null>(null);
  // Tracks whether the active session ended with an error, so the bar can keep
  // showing the error status (instead of snapping shut) until it is dismissed.
  const erroredRef = useRef(false);

  const handleTransportEvent = useCallback((event: OneVoiceSessionEvent) => {
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
    if (event.type === "action_proposal") {
      pendingProposalRef.current = event.proposal;
      liveClientRef.current?.interrupt?.();
      if (event.transcript) {
        void liveActionBridgeRef.current?.processTranscript({
          transcript: event.transcript,
          candidate: event.proposal,
        });
        pendingProposalRef.current = null;
      }
      return;
    }
    if (event.type === "transcript_final") {
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
      const proposal = pendingProposalRef.current;
      pendingProposalRef.current = null;
      void liveActionBridgeRef.current?.processTranscript({
        transcript,
        candidate: proposal,
      });
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
      liveClientRef.current = null;
      if (erroredRef.current) return;
      setConversationActive(false);
    }
  }, [agentPopover, appendMirrorEvent, createHandoff, setVoiceLevel, setVoiceStatus]);

  const stopConversation = useCallback(() => {
    erroredRef.current = false;
    liveClientRef.current?.stop();
    liveClientRef.current = null;
    prewarmedRelayRef.current = null;
    setConversationActive(false);
    resetVoice();
  }, [resetVoice]);

  useEffect(() => {
    if (!runtime) {
      liveActionBridgeRef.current?.cancel("agent_bar_runtime_unavailable");
      liveActionBridgeRef.current = null;
      return;
    }
    const bridgeConfig: OneVoiceLiveActionBridgeConfig = {
      userId: user?.uid,
      vaultOwnerToken,
      vaultKey,
      getAppRuntimeState: () => runtime.appRuntimeState,
      getVoiceContext: () =>
        runtime.oneVoiceContextSnapshot as unknown as Record<string, unknown>,
      executeAction: (actionId, slots) =>
        executeAgentGatewayAction({
          actionId,
          slots,
          userId: user?.uid ?? "",
          router,
          appRuntimeState: runtime.appRuntimeState,
          surfaceMetadata: getVoiceSurfaceMetadata(),
          hasPortfolioData:
            runtime.appRuntimeState.portfolio.has_portfolio_data ||
            runtime.oneVoiceContextSnapshot.cache.portfolio_ready === true,
          busyOperations,
          setAnalysisParams,
          switchPersona,
        }),
      router,
      setAnalysisParams,
      speak: async ({ text, turnId, segmentType }) => {
        appendMirrorEvent({
          role: "assistant",
          text,
          source: "one_voice_orchestrator",
          turnId,
        });
        const spoken = await liveClientRef.current?.speakText?.({
          text,
          turnId,
          segmentType,
        });
        if (!spoken) {
          setVoiceStatus("speaking", text, {
            sessionId: null,
            sourceId: "one_voice_orchestrator",
            sourceSeq: null,
          });
        }
      },
      mirrorAssistantText: ({ text, turnId }) => {
        appendMirrorEvent({
          role: "assistant",
          text,
          source: "one_voice_orchestrator",
          turnId,
        });
      },
      openChatHandoff: (handoffInput) => {
        const handoff = createHandoff(handoffInput);
        liveClientRef.current?.interrupt?.();
        agentPopover?.openAgent({ handoff });
        stopConversation();
      },
      setStage: (stage) => {
        if (stage === "planning" || stage === "dispatch") {
          setVoiceStatus("thinking", stage === "planning" ? "Understanding" : "Acting");
        } else if (stage === "speaking_ack" || stage === "speaking_final") {
          setVoiceStatus("speaking");
        } else if (stage === "idle" && conversationActive) {
          setVoiceStatus("listening");
        }
      },
      onDebug: (event, payload) => {
        if (process.env.NODE_ENV !== "production") {
          console.debug("[ONE_VOICE_LIVE_BRIDGE]", event, payload || {});
        }
      },
    };
    if (liveActionBridgeRef.current) {
      liveActionBridgeRef.current.updateConfig(bridgeConfig);
      return;
    }
    liveActionBridgeRef.current = new OneVoiceLiveActionBridge(bridgeConfig);
  }, [
    agentPopover,
    appendMirrorEvent,
    busyOperations,
    conversationActive,
    createHandoff,
    router,
    runtime,
    setAnalysisParams,
    setVoiceStatus,
    stopConversation,
    switchPersona,
    user?.uid,
    vaultKey,
    vaultOwnerToken,
  ]);

  const startConversation = useCallback(() => {
    // Toggle off when a session (live OR an error still on screen) exists.
    if (liveClientRef.current || erroredRef.current || conversationActive) {
      stopConversation();
      return;
    }
    erroredRef.current = false;
    setConversationActive(true);
    const context = runtime?.oneVoiceContextSnapshot ?? null;
    const prewarmedRelay = prewarmedRelayRef.current;
    const relayUrl =
      prewarmedRelay &&
      context &&
      prewarmedRelay.snapshotId === context.snapshot_id &&
      prewarmedRelay.accessTier === runtime?.tier &&
      prewarmedRelay.expiresAtMs > Date.now()
        ? prewarmedRelay.relayUrl
        : null;
    prewarmedRelayRef.current = null;
    const client = createRealtimeVoiceTransport({
      onEvent: handleTransportEvent,
    });
    liveClientRef.current = client;
    void client.start({
      context,
      accessTier: runtime?.tier ?? null,
      relayUrl,
      sessionMirrorId: mirrorSessionId,
      allowedActionIds: context?.available_action_ids ?? null,
    });
  }, [
    conversationActive,
    runtime?.oneVoiceContextSnapshot,
    runtime?.tier,
    mirrorSessionId,
    handleTransportEvent,
    stopConversation,
  ]);

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
      void ApiService.getGeminiLiveRelayUrl({
        screen: context.route.screen,
        persona: context.persona.active,
        routeFamily: context.route.route_family,
        voiceState: context.voice.state,
        accessTier,
        availableActionIds: context.available_action_ids,
        visibleModules: context.ui.visible_modules,
        cacheFreshness: context.cache.freshness,
        vaultReady: context.cache.vault_ready,
        portfolioReady: context.cache.portfolio_ready,
        signal: controller.signal,
      })
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
      liveActionBridgeRef.current?.cancel("agent_bar_unmounted");
      liveActionBridgeRef.current = null;
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
  // full agent). EXCEPTION — the LOGGED-OUT welcome ("/"): an agent input has no
  // meaning before sign-in and read as a confusing "backdoor" pinned under the
  // CTA, so we unmount it there (signed-in users are redirected off "/", so the
  // bar still shows on /one and every authed surface). We also unmount where an
  // agent launcher genuinely must not exist (legacy dedicated agent route, phone
  // mandate, appearance lab, developers) or on transient auth transitions
  // (login, logout) where the app shell is not the host.
  const path = pathname ?? "";
  // The waveform action circle is white only on the 2c dark dashboard (where a
  // white circle pops); on every other surface (welcome, profile, kai, …) it is
  // the indigo accent, per design.md §5.5.
  const onDashboard = path === ROUTES.ONE_HOME || path === `${ROUTES.ONE_HOME}/`;
  const unmountBar =
    !agentPopover ||
    // Logged-out welcome ("/"): no agent before sign-in. On "/" an anonymous
    // user is always the `anon_onboarding` tier; signed-in users are redirected
    // off "/", so the bar still shows on /one and every authed surface.
    (isHomeRoute && runtime?.tier === "anon_onboarding") ||
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
          // Match the bottom nav flat translucent shell surface. Active voice
          // keeps a neutral surface; only the voice icon/status carries accent.
          conversationActive
            ? "bg-black/[0.05] text-[#1d1d1f] ring-1 ring-black/[0.04] dark:bg-white/[0.07] dark:text-[#f5f5f7] dark:ring-white/[0.08]"
            : "bg-black/[0.05] text-[#1d1d1f] ring-1 ring-black/[0.04] dark:bg-white/[0.07] dark:text-[#f5f5f7] dark:ring-white/[0.08]",
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
        ) : (
          <>
            <button
              type="button"
              data-testid="one-voice-agent-bar-start"
              onClick={startConversation}
              aria-label={`Start conversation. ${hint}`}
              title="Start conversation"
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2.5 rounded-full pl-1 text-left",
                "transition-colors duration-200 active:scale-[0.99]",
              )}
            >
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-[14px] font-medium",
                  "text-muted-foreground",
                )}
              >
                {hint}
              </span>
            </button>
            <button
              type="button"
              data-native-voice-control-id="one_voice_agent_bar_start"
              data-testid="one-voice-agent-bar-start-icon"
              onClick={startConversation}
              aria-label="Start conversation"
              title="Start conversation"
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
                "bg-black/[0.05] text-accent-strong ring-1 ring-black/[0.04] dark:bg-white/[0.07] dark:ring-white/[0.08]",
                onDashboard && "text-accent-strong",
                "transition-[background-color,transform] duration-200 active:scale-90",
                "hover:bg-black/[0.08] dark:hover:bg-white/[0.1]",
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
