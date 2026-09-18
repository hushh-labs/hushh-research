"use client";

/**
 * The One Live Voice launcher in the bottom-shell agent slot.
 *
 * Idle: the "Talk to One" pill (tap -> session.start) beside Chat. Active:
 * the same dock becomes the state pill (waveform, label, Mute, Stop) with the
 * conversation panel docked ABOVE it as a collapsible, inner-scrolling sheet.
 * The app screen stays the result surface — like Siri, this is a non-modal
 * bottom overlay, never a page-wide backdrop.
 *
 * Keeps the launcher identity the shell, the native shells and the contract
 * tests rely on: data-testid="one-voice-agent-bar",
 * data-native-voice-control-id="one_voice_agent_bar_start",
 * data-agent-dock="one-agent-dock", the shell's var(--app-agent-bar-max-width)
 * width, and the "var(--agent-bar-with-nav-bottom)" seat for layout="fixed".
 *
 * Every visible state here is read from the session store, which derives it
 * only from typed frames; nothing on this surface is set from transcript text.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { usePathname } from "next/navigation";
import { AudioLines, Keyboard, Send, X } from "@/components/icons";

import { useVoiceSession } from "@/components/one-voice/voice-session-provider";
import { useAuth } from "@/hooks/use-auth";
import { isNative } from "@/lib/capacitor/platform";
import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import { isFoundationPublicRoute } from "@/lib/navigation/routes";
import {
  useVoiceSessionState,
  useVoiceSessionStore,
} from "@/lib/one-voice/session-store";
import { cn } from "@/lib/utils";

import { OneVoicePanel, panelHasContent } from "./one-voice-panel";
import { VoiceStatePill } from "./voice-state-pill";
import { transcriptStatusLine } from "./voice-transcript";

/**
 * Mirrors ONE_VOICE_FOCUS_PENDING_EVENT in lib/one-voice/directives.ts. Spelt
 * out here because that module reaches the API service and the native plugin
 * registry, which the shell's module graph (and its unit tests) keep out of
 * the launcher. The control test pins the two strings together.
 */
const FOCUS_PENDING_EVENT = "one-voice:focus-pending";

const DOCK_WIDTH_SLOT =
  "max-w-[min(calc(100vw-1.5rem),var(--app-agent-bar-max-width))]";
const DOCK_WIDTH_FIXED = "max-w-[min(calc(100vw-2rem),34rem)]";

/** Native only: the OS microphone settings screen. Web has no such door. */
function openMicrophoneSettings(): void {
  void import("@/lib/capacitor/one-voice-invocation")
    .then(({ NativeOneVoiceInvocation }) =>
      NativeOneVoiceInvocation.openCommandCaptureSettings(),
    )
    .catch(() => undefined);
}

export function OneVoiceControl({
  layout = "slot",
}: {
  layout?: "fixed" | "slot";
}) {
  const session = useVoiceSession();
  const state = useVoiceSessionState();
  const pathname = usePathname();
  const { user } = useAuth();
  const inputId = useId();
  const stackRef = useRef<HTMLDivElement | null>(null);

  const [collapsed, setCollapsed] = useState(false);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");

  const active = state.phase !== "idle";
  // A start that failed before the socket opened leaves the phase idle with
  // an error; the card still has to be seen.
  const engaged = active || state.error !== null;
  const hasPanel = engaged && panelHasContent(state);
  const panelOpen = hasPanel && !collapsed;
  const noNavbar =
    !user ||
    getKaiChromeState(pathname).useOnboardingChrome ||
    pathname === "/" ||
    isFoundationPublicRoute(pathname);

  const pendingId = state.pendingAction?.pending_action_id ?? null;
  const pendingOpen = Boolean(
    state.pendingAction && state.pendingAction.resolvedStatus === null,
  );
  const pickerOpen = state.candidatePicker !== null;
  const errorCode = state.error?.code ?? null;

  // Anything that needs an answer opens the panel; a fresh session starts open.
  useEffect(() => {
    if (!active) setCollapsed(false);
  }, [active]);
  useEffect(() => {
    if (pendingOpen || pickerOpen || errorCode) setCollapsed(false);
  }, [pendingId, pendingOpen, pickerOpen, errorCode]);
  useEffect(() => {
    if (!active) {
      setTyping(false);
      setDraft("");
    }
  }, [active]);

  const focusPendingCard = useCallback(() => {
    const card = stackRef.current?.querySelector<HTMLElement>(
      '[data-testid="one-voice-pending-action"]',
    );
    card?.focus({ preventScroll: false });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onFocusPending = () => {
      setCollapsed(false);
      // The card may be mounting in this same tick; focus after it commits.
      window.setTimeout(focusPendingCard, 0);
    };
    window.addEventListener(FOCUS_PENDING_EVENT, onFocusPending);
    return () =>
      window.removeEventListener(FOCUS_PENDING_EVENT, onFocusPending);
  }, [focusPendingCard]);

  const start = useCallback(
    (source: string) => {
      void session.start({ source }).catch(() => undefined);
    },
    [session],
  );

  const dismissError = useCallback(() => {
    if (state.phase === "idle") {
      useVoiceSessionStore.getState().dispatch({ type: "reset" });
      return;
    }
    session.stop("dismiss");
  }, [session, state.phase]);

  const submitTyped = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    if (active) {
      session.sendText(text);
      return;
    }
    void session
      .start({ source: "typed" })
      .then(() => session.sendText(text))
      .catch(() => undefined);
  };

  const statusLine =
    collapsed && hasPanel ? transcriptStatusLine(state.transcript) : null;

  return (
    <div
      ref={stackRef}
      data-agent-bar-shell
      data-command-active={engaged || undefined}
      data-ui-role="talk-to-one"
      data-agent-bar-layout={layout}
      data-ambient-chrome-ignore
      className={cn(
        "pointer-events-none flex flex-col items-center gap-2",
        layout === "slot" ? "w-full" : "fixed inset-x-0 z-[540] px-4",
      )}
      style={
        layout === "fixed"
          ? ({
              bottom: noNavbar
                ? "calc(var(--app-safe-area-bottom-effective) + 0.75rem)"
                : "var(--agent-bar-with-nav-bottom)",
            } as CSSProperties)
          : undefined
      }
    >
      <div
        className={cn(
          "pointer-events-none flex w-full flex-col gap-2",
          DOCK_WIDTH_SLOT,
        )}
      >
        {panelOpen ? (
          <OneVoicePanel
            state={state}
            controller={session}
            onOpenSettings={isNative() ? openMicrophoneSettings : undefined}
            onDismissError={dismissError}
          />
        ) : null}
        {typing ? (
          <form
            data-testid="one-voice-type-form"
            onSubmit={submitTyped}
            className="bottom-chrome-surface pointer-events-auto flex w-full items-center gap-1 overflow-hidden rounded-full pl-4"
          >
            <label htmlFor={inputId} className="sr-only">
              Type to One
            </label>
            <input
              id={inputId}
              data-testid="one-voice-type-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Type to One"
              autoComplete="off"
              autoFocus
              enterKeyHint="send"
              className="h-11 min-w-0 flex-1 bg-transparent text-[15px] text-[color:var(--app-label)] outline-none placeholder:text-[color:var(--app-tertiary-label)]"
            />
            <button
              type="submit"
              data-testid="one-voice-type-send"
              aria-label="Send"
              disabled={!draft.trim()}
              className="flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center text-[color:var(--app-accent)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--app-focus-ring)]"
            >
              <Send className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Close typing"
              onClick={() => setTyping(false)}
              className="flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-r-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--app-focus-ring)]"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </form>
        ) : null}
      </div>
      <div
        data-testid="one-voice-agent-bar"
        data-agent-dock="one-agent-dock"
        data-voice-phase={state.phase}
        data-voice-panel={
          hasPanel ? (panelOpen ? "open" : "collapsed") : undefined
        }
        role="group"
        aria-label="One private agent"
        className={cn(
          "bottom-chrome-surface pointer-events-auto relative flex w-full items-center overflow-hidden rounded-full transition-opacity motion-reduce:transition-none",
          layout === "slot" ? DOCK_WIDTH_SLOT : DOCK_WIDTH_FIXED,
        )}
      >
        {active ? (
          <VoiceStatePill
            phase={state.phase}
            speaking={state.speaking}
            muted={state.muted}
            degraded={state.degraded}
            level={state.level}
            halfDuplex={state.halfDuplex}
            statusLine={statusLine}
            expanded={hasPanel ? panelOpen : undefined}
            onToggleExpanded={
              hasPanel ? () => setCollapsed((value) => !value) : undefined
            }
            onMute={(muted) => session.setMuted(muted)}
            onStop={() => session.stop("tap")}
            onInterrupt={() => session.interrupt()}
          />
        ) : (
          <button
            type="button"
            data-native-voice-control-id="one_voice_agent_bar_start"
            data-testid="one-voice-agent-bar-start-icon"
            data-agent-action="voice"
            data-voice-phase={state.phase}
            aria-label="Talk to One"
            disabled={!session.enabled}
            onClick={() => start("agent_bar")}
            className="agent-bar-voice-launcher relative flex h-11 min-w-0 flex-1 touch-manipulation select-none items-center gap-2 rounded-l-full px-3 text-left text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--app-focus-ring)] disabled:opacity-60"
          >
            <AudioLines className="h-5 w-5 shrink-0" aria-hidden />
            <span className="min-w-0 truncate" role="status" aria-live="polite">
              {state.error ? "Try again" : "Talk to One"}
            </span>
          </button>
        )}
        <button
          type="button"
          data-testid="one-voice-type-instead"
          aria-label="Type instead"
          aria-expanded={typing}
          onClick={() => setTyping((value) => !value)}
          className="sr-only shrink-0 touch-manipulation items-center justify-center focus:not-sr-only focus:flex focus:h-11 focus:w-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--app-focus-ring)]"
        >
          <Keyboard className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
