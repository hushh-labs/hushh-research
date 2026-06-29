// components/agent/agent-bar.tsx
// Persistent, screen-aware agent launcher bar.
//
// A single sleek bar that spans across just above the bottom navbar + search on
// every authenticated screen. It replaces the old draggable floating "Agent"
// pill so the agent is always present and context-aware: the hint text adapts to
// the current screen so the bar can guide the user from onboarding to any part
// of the app. For now it keeps the existing behavior (tap or mic both open the
// agent); richer per-screen actions are a planned follow-up.

"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { usePathname } from "next/navigation";
import { AudioLines, Mic, X } from "lucide-react";

import { useOptionalAgentPopover } from "@/components/agent/agent-popover-provider";
import { AgentVoiceWaveform } from "@/components/agent/agent-voice-waveform";
import { useAgentRuntimeStateOptional } from "@/lib/agent/agent-runtime-context";
import {
  getAgentVoiceStatusLabel,
  useAgentVoiceState,
} from "@/lib/agent/agent-voice-state";
import { useKaiBottomChromeVisibility } from "@/lib/navigation/kai-bottom-chrome-visibility";
import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import { ROUTES } from "@/lib/navigation/routes";
import {
  GeminiLiveClient,
  type GeminiLiveVoiceState,
} from "@/lib/services/gemini-live-client";
import { cn } from "@/lib/utils";

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
  const agentPopover = useOptionalAgentPopover();
  // Shared single source of truth for the agent's active state. The bar uses it
  // for tier-aware presentation and to detect the home/onboarding surfaces
  // consistently with the chat workspace, instead of recomputing locally.
  const runtime = useAgentRuntimeStateOptional();

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
  const liveClientRef = useRef<GeminiLiveClient | null>(null);
  // Tracks whether the active session ended with an error, so the bar can keep
  // showing the error status (instead of snapping shut) until it is dismissed.
  const erroredRef = useRef(false);

  const stopConversation = useCallback(() => {
    erroredRef.current = false;
    liveClientRef.current?.stop();
    liveClientRef.current = null;
    setConversationActive(false);
    resetVoice();
  }, [resetVoice]);

  const startConversation = useCallback(() => {
    // Toggle off when a session (live OR an error still on screen) exists.
    if (liveClientRef.current || erroredRef.current || conversationActive) {
      stopConversation();
      return;
    }
    erroredRef.current = false;
    setConversationActive(true);
    setVoiceStatus("connecting");
    const client = new GeminiLiveClient({
      onVoiceState: (state: GeminiLiveVoiceState) => {
        switch (state) {
          case "connecting":
            setVoiceStatus("connecting");
            break;
          case "listening":
            setVoiceStatus("listening");
            break;
          case "thinking":
            setVoiceStatus("thinking");
            break;
          case "speaking":
            setVoiceStatus("speaking");
            break;
          case "idle":
          default:
            break;
        }
      },
      onInputLevel: (level) => {
        const current = useAgentVoiceState.getState().status;
        if (current === "listening" || current === "connecting") {
          setVoiceLevel(level);
        }
      },
      onOutputLevel: (level) => {
        if (useAgentVoiceState.getState().status === "speaking") {
          setVoiceLevel(level);
        }
      },
      onError: (message) => {
        // Surface why the session ended and keep the bar in conversation mode
        // long enough to read it, instead of silently snapping back. The error
        // status is sticky; tapping the X (or re-tapping conversation) resets.
        erroredRef.current = true;
        setVoiceStatus("error", message);
      },
      onClose: () => {
        liveClientRef.current = null;
        // If we closed because of an error, leave the bar showing the error
        // status (the X dismisses it). A clean close returns the bar to rest.
        if (erroredRef.current) return;
        setConversationActive(false);
      },
    });
    liveClientRef.current = client;
    // Pass the active screen + persona so the backend composes a state-aware
    // (still tool-less) persona instruction. These only shape tone/guidance.
    void client.start({
      screen: runtime?.screen ?? null,
      persona: runtime?.activePersona ?? null,
    });
  }, [
    conversationActive,
    runtime?.screen,
    runtime?.activePersona,
    setVoiceLevel,
    setVoiceStatus,
    stopConversation,
  ]);

  // Tear down the live session if the bar unmounts (route change, sign-out).
  // Also clear the shared voice store so a stale status (e.g. "error",
  // "listening") does not leak to other consumers after the bar is gone.
  useEffect(() => {
    return () => {
      liveClientRef.current?.stop();
      liveClientRef.current = null;
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
  // The agent is a SINGLE bar that is present everywhere, including the very
  // first marketing/intro screen ("/"), onboarding, and for anonymous
  // (pre-sign-in) users on the welcome flow. It degrades gracefully by
  // auth/vault level: anonymous + locked-vault users get informational/
  // navigation help and an in-place unlock prompt only when a vault operation
  // is invoked, while unlocked users get the full agent. So we do NOT unmount
  // on onboarding chrome, on the root intro screen, or on missing auth. We only
  // unmount where an agent launcher genuinely must not exist (legacy dedicated
  // agent route, phone mandate, appearance lab, developers), or on the
  // transient auth transitions (login, logout) where the app shell is not the
  // host.
  const path = pathname ?? "";
  const unmountBar =
    !agentPopover ||
    path.startsWith(ROUTES.PHONE_MANDATE) ||
    path.startsWith(ROUTES.LABS_PROFILE_APPEARANCE) ||
    path === ROUTES.DEVELOPERS ||
    path === ROUTES.AGENT ||
    path.startsWith(ROUTES.LOGIN) ||
    path.startsWith(ROUTES.LOGOUT);

  if (unmountBar) {
    return null;
  }

  // The popover window is suppressed on a few entry routes (the root intro
  // screen), so opening the chat panel there is a no-op. On those routes the
  // conversational voice piece IS the agent: route the hint/mic taps into
  // in-bar conversation mode instead of a dead panel-open.
  const popoverSuppressed = isHomeRoute;
  const openAgent = () => {
    if (popoverSuppressed) {
      startConversation();
      return;
    }
    agentPopover.openAgent();
  };

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
        className={cn(
          "pointer-events-auto flex w-full max-w-[min(calc(100vw-2rem),34rem)] items-center gap-2",
          "h-11 rounded-full pl-3 pr-1.5",
          // Single, consolidated transition covering surface color plus the
          // open/close fade+lift. Smoothly eases the bar in/out with the agent
          // window lifecycle so it never snaps back into place after closing.
          "transition-[opacity,transform,background-color,box-shadow] duration-300 ease-[cubic-bezier(0.16,0.84,0.28,1)] will-change-[opacity,transform]",
          // Flat surface matching the top app bar controls and bottom nav. While
          // in conversation mode the bar lifts to a highlighted, primary-tinted
          // surface so it reads as a live, active listening session.
          conversationActive
            ? "bg-primary/10 text-foreground ring-1 ring-primary/30 dark:bg-primary/15"
            : "bg-black/[0.05] text-[#1d1d1f] dark:bg-white/[0.07] dark:text-[#f5f5f7]",
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
              onClick={stopConversation}
              aria-label="End conversation"
              title="End conversation"
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                "bg-primary/15 text-primary",
                "transition-[background-color,transform] duration-200",
                "hover:bg-primary/25 active:scale-90",
              )}
            >
              <X className="h-4 w-4" />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={openAgent}
              aria-label={hint}
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2.5 rounded-full pl-1 text-left",
                "transition-colors duration-200 active:scale-[0.99]",
              )}
            >
              <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-foreground/70">
                {hint}
              </span>
            </button>
            <button
              type="button"
              onClick={openAgent}
              aria-label="Talk to your agent"
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                "bg-black/[0.05] text-foreground/70 dark:bg-white/[0.07]",
                "transition-[background-color,transform] duration-200",
                "hover:bg-black/[0.08] hover:text-primary dark:hover:bg-white/[0.1] active:scale-90",
              )}
            >
              <Mic className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={startConversation}
              aria-label="Start a conversational session"
              title="Conversational mode"
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                "bg-black/[0.05] text-foreground/70 dark:bg-white/[0.07]",
                "transition-[background-color,transform] duration-200",
                "hover:bg-black/[0.08] hover:text-primary dark:hover:bg-white/[0.1] active:scale-90",
              )}
            >
              <AudioLines className="h-4 w-4" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
