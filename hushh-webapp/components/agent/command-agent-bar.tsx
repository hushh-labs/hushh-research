"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { usePathname } from "next/navigation";
import { AudioLines, X, ChevronUp } from "@/components/icons";
import { AgentVoiceWaveform } from "@/components/agent/agent-voice-waveform";
import { LocationCommandCard } from "./location-command-card";
import {
  useLocationCommand,
  useLocationCommandLive,
} from "./location-command-provider";
import { getKaiChromeState } from "@/lib/navigation/kai-chrome-state";
import {
  isFoundationPublicRoute,
  ROUTES,
} from "@/lib/navigation/routes";
import { cn } from "@/lib/utils";

/** Presentation only. The provider above route and chrome changes owns the task. */
export function CommandAgentBar({
  layout = "fixed",
}: {
  layout?: "fixed" | "slot";
}) {
  const {
    view,
    user,
    recording,
    collapsed,
    setCollapsed,
    startCapture,
    finishCapture,
    cancelCapture,
    cancelTask,
    run,
    hapticCancel,
    active,
  } = useLocationCommand();
  // Microphone-cadence fields come from their own context so only this bar
  // re-renders per audio frame, never the whole bottom shell.
  const { level, elapsedMs } = useLocationCommandLive();
  const pathname = usePathname();
  const [held, setHeld] = useState(false);
  const [cancelArmed, setCancelArmed] = useState(false);
  const press = useRef<{
    id: number;
    x: number;
    at: number;
    finish: boolean;
  } | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearPress = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
    press.current = null;
    setHeld(false);
    setCancelArmed(false);
  };
  useEffect(
    () => () => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (!recording) clearPress();
  }, [recording]);
  const foundationRouteWithoutNavigation =
    isFoundationPublicRoute(pathname) && pathname !== ROUTES.HOME;
  const noNavbar =
    !user ||
    getKaiChromeState(pathname).useOnboardingChrome ||
    foundationRouteWithoutNavigation;
  const elapsed = `${Math.floor(elapsedMs / 60_000)}:${String(Math.floor(elapsedMs / 1000) % 60).padStart(2, "0")}`;
  const working = view.phase === "working";
  const status =
    recording === "starting"
      ? "Preparing microphone…"
      : cancelArmed
        ? "Release to cancel"
        : recording
          ? held
            ? "Release to send"
            : "Tap to send"
          : working
            ? view.message
            : "Talk to One";
  return (
    <div
      data-agent-bar-shell
      data-command-active={active || undefined}
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
      <div className="pointer-events-none w-full max-w-[min(calc(100vw-2rem),var(--app-agent-bar-max-width))]">
        <LocationCommandCard />
        {working && view.transcript && !collapsed ? (
          <p
            className="pointer-events-auto mb-1 line-clamp-2 px-3 text-xs text-muted-foreground"
            aria-label="Your request"
          >
            {view.transcript}
          </p>
        ) : null}
      </div>
      <div
        data-testid="one-voice-agent-bar"
        data-agent-dock="one-agent-dock"
        data-command-capture-state={recording ?? "idle"}
        data-command-cancel-armed={cancelArmed || undefined}
        role="group"
        aria-label="One private agent"
        className={cn(
          "bottom-chrome-surface pointer-events-auto relative flex w-full items-center overflow-hidden rounded-full transition-opacity motion-reduce:transition-none",
          layout === "slot"
            ? "max-w-[min(calc(100vw-2rem),var(--app-agent-bar-max-width))]"
            : "max-w-[min(calc(100vw-2rem),34rem)]",
          cancelArmed && "text-destructive",
        )}
      >
        <button
          type="button"
          data-native-voice-control-id="one_voice_agent_bar_start"
          data-testid="one-voice-agent-bar-start-icon"
          data-agent-action="voice"
          className={cn(
            "agent-bar-voice-launcher relative flex h-11 min-w-0 flex-1 touch-none select-none items-center gap-2 rounded-l-full px-3 text-left text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
            recording && "bg-primary/5",
          )}
          disabled={working || (active && !recording)}
          aria-label={
            recording
              ? "Finish recording"
              : "Talk to One. Hold to speak, or tap to start and finish."
          }
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => {
            if (event.button !== 0 || (!event.isPrimary && event.pointerType))
              return;
            event.currentTarget.setPointerCapture(event.pointerId);
            press.current = {
              id: event.pointerId,
              x: event.clientX,
              at: Date.now(),
              finish: Boolean(recording),
            };
            setCancelArmed(false);
            if (recording) return;
            // Prepare immediately; the threshold chooses the gesture, never microphone timing.
            run(startCapture());
            holdTimer.current = setTimeout(() => {
              if (press.current) setHeld(true);
            }, 250);
          }}
          onPointerMove={(event) => {
            const current = press.current;
            if (!current || current.id !== event.pointerId) return;
            const armed = current.x - event.clientX >= 64;
            if (armed && !cancelArmed) hapticCancel();
            setCancelArmed(armed);
          }}
          onPointerUp={(event) => {
            const current = press.current;
            if (!current || current.id !== event.pointerId) return;
            const cancel = current.x - event.clientX >= 64;
            const finish = current.finish || Date.now() - current.at >= 250;
            clearPress();
            if (cancel) cancelCapture();
            else if (finish) run(finishCapture());
          }}
          onPointerCancel={() => {
            clearPress();
            cancelCapture();
          }}
          onLostPointerCapture={() => {
            if (press.current) {
              clearPress();
              cancelCapture();
            }
          }}
          onClick={(event) => {
            // Pointer gestures are handled above. Keyboard and assistive activation use tap mode.
            if (event.detail !== 0) return;
            run(recording ? finishCapture() : startCapture());
          }}
        >
          {recording || working ? (
            <AgentVoiceWaveform
              level={level}
              status={
                recording === "recording"
                  ? "listening"
                  : working
                    ? "thinking"
                    : "connecting"
              }
              barCount={28}
              className="h-6 min-w-6 flex-1"
            />
          ) : (
            <AudioLines className="h-5 w-5 shrink-0" />
          )}
          <span
            className={cn(
              "min-w-0 truncate",
              (recording || working) && "text-xs",
            )}
            role="status"
            aria-live={recording ? "off" : "polite"}
          >
            {status}
          </span>
          {recording ? (
            <span
              className="text-xs tabular-nums"
              aria-label="Recording duration"
            >
              {elapsed}
            </span>
          ) : null}
        </button>
        {recording || working ? (
          <button
            type="button"
            data-native-voice-control-id="one_location_command_cancel_capture"
            onClick={recording ? cancelCapture : cancelTask}
            aria-label={recording ? "Cancel recording" : "Cancel task"}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
        {collapsed && view.phase !== "idle" ? (
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            aria-label="Show command"
            className="flex h-11 w-11 items-center justify-center"
          >
            <ChevronUp className="h-4 w-4" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
