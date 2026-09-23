"use client";

/**
 * The always-visible strip of the One Live Voice dock while a session runs.
 *
 * Waveform + level, one state label, Mute (aria-pressed; keeps the track and
 * drops frames), Stop (X). A tap on the waveform is an interrupt. The label
 * is plain text on purpose: VoiceOver hears the conversation through the
 * transcript log, never twice. Under prefers-reduced-motion the waveform is
 * a static level bar.
 */

import {
  AudioLines,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  Wifi,
  X,
} from "@/components/icons";

import { AgentVoiceWaveform } from "@/components/agent/agent-voice-waveform";
import type { AgentVoiceStatus } from "@/lib/agent/agent-voice-state";
import { useMediaQuery } from "@/lib/morphy-ux/use-media-query";
import type { VoicePhase } from "@/lib/one-voice/session-types";
import { cn } from "@/lib/utils";

export type VoiceStatePillProps = {
  phase: VoicePhase;
  speaking: boolean;
  muted: boolean;
  degraded: boolean;
  level: number;
  /** Half-duplex fallback: outbound frames are gated while One speaks. */
  halfDuplex?: boolean;
  /** One-line status shown under the label while the panel is collapsed. */
  statusLine?: string | null;
  /** Present when there is a panel to show or hide. */
  expanded?: boolean;
  onToggleExpanded?: () => void;
  onMute: (muted: boolean) => void;
  onStop: () => void;
  onInterrupt: () => void;
};

const PHASE_LABEL: Record<VoicePhase, string> = {
  idle: "Talk to One",
  connecting: "Connecting…",
  listening: "Listening",
  understanding: "Understanding",
  asking: "One is asking",
  confirming: "Confirm to continue",
  executing: "Working…",
  complete: "Done",
  error: "Something went wrong",
  paused: "Paused",
};

/** The visible state label for a phase; the muted mic wins while listening. */
export function voicePhaseLabel(
  phase: VoicePhase,
  options?: { muted?: boolean; speaking?: boolean; halfDuplex?: boolean },
): string {
  if (phase === "listening" && options?.muted) return "Muted";
  if (
    options?.speaking &&
    options.halfDuplex &&
    (phase === "asking" || phase === "complete")
  ) {
    return "Tap to interrupt";
  }
  return PHASE_LABEL[phase];
}

/** Map the session phase onto the waveform palette the edge glow already uses. */
export function waveformStatusForPhase(
  phase: VoicePhase,
  options: { speaking: boolean; muted: boolean },
): AgentVoiceStatus {
  switch (phase) {
    case "connecting":
      return "connecting";
    case "listening":
      return options.muted ? "muted" : "listening";
    case "understanding":
    case "executing":
      return "thinking";
    case "asking":
    case "complete":
      return options.speaking ? "speaking" : "listening";
    case "confirming":
      return "listening";
    case "error":
      return "error";
    case "paused":
      return "muted";
    case "idle":
    default:
      return "idle";
  }
}

function StaticLevelBar({
  level,
  status,
}: {
  level: number;
  status: AgentVoiceStatus;
}) {
  const clamped = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  const width =
    status === "listening" || status === "speaking" ? clamped : 0.06;
  return (
    <span
      role="img"
      aria-label="Voice activity"
      data-testid="one-voice-static-level"
      className="relative block h-1.5 w-full min-w-6 flex-1 overflow-hidden rounded-full bg-[color:var(--app-neutral-fill)]"
    >
      <span
        className={cn(
          "one-voice-level-fill absolute inset-y-0 left-0 rounded-full",
          status === "error"
            ? "bg-[color:var(--app-destructive)]"
            : "bg-[color:var(--app-accent)]",
        )}
        style={{ width: "100%", transform: `scaleX(${width})`, transformOrigin: "left" }}
      />
    </span>
  );
}

const ICON_BUTTON =
  "flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--app-focus-ring)]";

// The panel toggle is intentionally a labelled control: the neighboring X
// stops the live session, whereas this only changes the dock presentation.
const PANEL_TOGGLE_BUTTON =
  "flex h-11 min-w-11 shrink-0 touch-manipulation items-center justify-center gap-1.5 px-2 text-[11px] font-semibold leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--app-focus-ring)]";

export function VoiceStatePill({
  phase,
  speaking,
  muted,
  degraded,
  level,
  halfDuplex = false,
  statusLine,
  expanded,
  onToggleExpanded,
  onMute,
  onStop,
  onInterrupt,
}: VoiceStatePillProps) {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const label = voicePhaseLabel(phase, { muted, speaking, halfDuplex });
  const status = waveformStatusForPhase(phase, { speaking, muted });
  const interruptLabel = speaking
    ? "Interrupt One"
    : `Voice activity: ${label}`;

  return (
    <>
      <button
        type="button"
        data-native-voice-control-id="one_voice_agent_bar_start"
        data-testid="one-voice-agent-bar-start-icon"
        data-agent-action="voice"
        data-voice-phase={phase}
        aria-label={interruptLabel}
        onClick={onInterrupt}
        className="relative flex h-11 min-w-0 flex-1 touch-manipulation select-none items-center gap-2 rounded-l-full px-3 text-left text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--app-focus-ring)]"
      >
        {phase === "connecting" ? (
          <AudioLines
            className="h-5 w-5 shrink-0 text-[color:var(--app-secondary-label)]"
            aria-hidden
          />
        ) : reducedMotion ? (
          <StaticLevelBar level={level} status={status} />
        ) : (
          <AgentVoiceWaveform
            level={level}
            status={status}
            muted={muted}
            barCount={22}
            className="h-6 min-w-6 flex-1"
          />
        )}
        <span className="flex min-w-0 flex-col leading-tight">
          <span
            data-testid="one-voice-state-label"
            className="truncate text-[13px] font-medium"
          >
            {label}
          </span>
          {statusLine ? (
            <span
              data-testid="one-voice-status-line"
              className="max-w-[40vw] truncate text-[11px] text-[color:var(--app-secondary-label)]"
            >
              {statusLine}
            </span>
          ) : null}
        </span>
        {degraded ? (
          <span
            className="inline-flex shrink-0 items-center text-[color:var(--app-warning-deep)] dark:text-[color:var(--app-warning-bright)]"
            data-testid="one-voice-degraded"
          >
            <Wifi className="h-3.5 w-3.5" aria-hidden />
            <span className="sr-only">Connection is weak</span>
          </span>
        ) : null}
      </button>
      <button
        type="button"
        data-testid="one-voice-mute"
        aria-label={muted ? "Unmute microphone" : "Mute microphone"}
        aria-pressed={muted}
        onClick={() => onMute(!muted)}
        className={cn(
          ICON_BUTTON,
          muted &&
            "text-[color:var(--app-warning-deep)] dark:text-[color:var(--app-warning-bright)]",
        )}
      >
        {muted ? (
          <MicOff className="h-4 w-4" aria-hidden />
        ) : (
          <Mic className="h-4 w-4" aria-hidden />
        )}
      </button>
      {onToggleExpanded ? (
        <button
          type="button"
          data-testid="one-voice-toggle-panel"
          aria-label={expanded ? "Minimize voice panel" : "Expand voice panel"}
          aria-expanded={Boolean(expanded)}
          onClick={onToggleExpanded}
          className={PANEL_TOGGLE_BUTTON}
        >
          {expanded ? (
            <Minimize2 className="h-4 w-4 shrink-0" aria-hidden />
          ) : (
            <Maximize2 className="h-4 w-4 shrink-0" aria-hidden />
          )}
          <span>{expanded ? "Minimize" : "Expand"}</span>
        </button>
      ) : null}
      <button
        type="button"
        data-testid="one-voice-stop"
        data-native-voice-control-id="one_voice_agent_bar_stop"
        aria-label="Stop"
        onClick={onStop}
        className={cn(ICON_BUTTON, "rounded-r-full")}
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </>
  );
}
