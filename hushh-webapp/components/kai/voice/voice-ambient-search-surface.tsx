"use client";

import type { MouseEvent, ReactNode } from "react";
import {
  AlertCircle,
  Check,
  Loader2,
  Mic,
  MicOff,
  RotateCcw,
  Search,
  Send,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";

import { VoiceEqualizer } from "@/components/kai/voice-equalizer";
import { Icon } from "@/lib/morphy-ux/ui";
import { getVariantStyles } from "@/lib/morphy-ux/utils";
import { cn } from "@/lib/utils";

export type VoiceAmbientMode =
  | "idle"
  | "connecting"
  | "listening"
  | "muted"
  | "processing"
  | "speaking"
  | "retry_ready"
  | "error";

type VoiceAmbientSearchSurfaceProps = {
  mode: VoiceAmbientMode;
  placeholder: string;
  transcriptPreview?: string | null;
  stageText?: string | null;
  replyText?: string | null;
  smoothedLevel: number;
  disabled?: boolean;
  showMic?: boolean;
  micDisabled?: boolean;
  micDisabledReason?: string | null;
  showSubmit?: boolean;
  submitEnabled?: boolean;
  ttsPlaying?: boolean;
  pendingConfirmation?: boolean;
  onOpenSearch: () => void;
  onMicToggle: (event: MouseEvent<HTMLButtonElement>) => void;
  onMuteToggle?: () => void;
  onSubmit?: () => void;
  onEnd?: () => void;
  onStopSpeaking?: () => void;
  onReplay?: () => void;
  onRetry?: () => void;
  onConfirm?: () => void;
  onCancel?: () => void;
};

function modeLabel(mode: VoiceAmbientMode): string {
  if (mode === "connecting") return "Connecting";
  if (mode === "listening") return "Listening";
  if (mode === "muted") return "Muted";
  if (mode === "processing") return "Processing";
  if (mode === "speaking") return "Speaking";
  if (mode === "retry_ready") return "Needs attention";
  if (mode === "error") return "Voice unavailable";
  return "Search";
}

function resolveDisplayText(input: {
  mode: VoiceAmbientMode;
  placeholder: string;
  transcriptPreview?: string | null;
  stageText?: string | null;
  replyText?: string | null;
  pendingConfirmation?: boolean;
}): string {
  const preview = String(input.transcriptPreview || "").trim();
  const stage = String(input.stageText || "").trim();
  const reply = String(input.replyText || "").trim();

  if (input.mode === "idle") return input.placeholder;
  if (input.pendingConfirmation)
    return preview || stage || "Confirm this voice action";
  if (input.mode === "connecting")
    return preview || "Connecting realtime voice session...";
  if (input.mode === "listening") return preview || "Listening...";
  if (input.mode === "muted") return preview || "Microphone muted";
  if (input.mode === "processing") return stage || preview || "Thinking...";
  if (input.mode === "speaking")
    return stage || reply || "Kai is responding...";
  if (input.mode === "retry_ready")
    return stage || preview || reply || "Tap retry and speak again.";
  return stage || preview || "Voice needs attention.";
}

function ModeIcon({
  mode,
  connecting,
}: {
  mode: VoiceAmbientMode;
  connecting: boolean;
}) {
  if (connecting || mode === "processing")
    return <Loader2 className="h-3.5 w-3.5 animate-spin" />;
  if (mode === "listening") return <Mic className="h-3.5 w-3.5" />;
  if (mode === "muted") return <MicOff className="h-3.5 w-3.5" />;
  if (mode === "speaking") return <Volume2 className="h-3.5 w-3.5" />;
  if (mode === "retry_ready" || mode === "error")
    return <AlertCircle className="h-3.5 w-3.5" />;
  return <Icon icon={Search} size="sm" />;
}

function IconButton({
  label,
  disabled,
  active,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  active?: boolean;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      data-no-route-swipe
      disabled={disabled}
      className={cn(
        "grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted/75 hover:text-foreground",
        active &&
          "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground",
        disabled && "cursor-not-allowed opacity-55",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function VoiceAmbientSearchSurface({
  mode,
  placeholder,
  transcriptPreview,
  stageText,
  replyText,
  smoothedLevel,
  disabled = false,
  showMic = true,
  micDisabled = false,
  micDisabledReason,
  showSubmit = false,
  submitEnabled = true,
  ttsPlaying = false,
  pendingConfirmation = false,
  onOpenSearch,
  onMicToggle,
  onMuteToggle,
  onSubmit,
  onEnd,
  onStopSpeaking,
  onReplay,
  onRetry,
  onConfirm,
  onCancel,
}: VoiceAmbientSearchSurfaceProps) {
  const active = mode !== "idle";
  const connecting = mode === "connecting";
  const displayText = resolveDisplayText({
    mode,
    placeholder,
    transcriptPreview,
    stageText,
    replyText,
    pendingConfirmation,
  });
  const showInlineWaveform =
    mode === "connecting" ||
    mode === "listening" ||
    mode === "speaking" ||
    mode === "processing";
  const canOpenSearch = !active && !disabled;
  const confirmText = String(
    transcriptPreview || stageText || "Confirm this voice action.",
  ).trim();

  return (
    <div className="relative">
      {pendingConfirmation ? (
        <div className="mb-2 rounded-2xl border border-border/70 bg-background/95 p-3 shadow-xl backdrop-blur">
          <p className="text-xs font-semibold text-foreground">
            Confirm voice action
          </p>
          <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
            {confirmText}
          </p>
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              className="inline-flex h-8 items-center rounded-full border border-border/70 bg-background px-3 text-[11px] font-semibold text-foreground transition-colors hover:bg-muted"
              onClick={onCancel}
            >
              Not now
            </button>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-primary px-3 text-[11px] font-semibold text-primary-foreground transition-opacity hover:opacity-90"
              onClick={onConfirm}
            >
              <Check className="h-3.5 w-3.5" />
              Confirm
            </button>
          </div>
        </div>
      ) : null}

      <div className="relative h-10">
        <button
          type="button"
          data-tour-id="kai-command-bar"
          data-voice-mode={mode}
          aria-label={
            active
              ? `Kai voice ${modeLabel(mode).toLowerCase()}`
              : "Open Kai command search"
          }
          className={cn(
            "flex h-10 w-full items-center justify-start overflow-hidden rounded-full px-3 pr-32 text-[12px]",
            getVariantStyles("none", "fade"),
            active
              ? "text-foreground shadow-lg shadow-black/5"
              : "text-muted-foreground",
            disabled && "pointer-events-none opacity-50",
          )}
          onClick={canOpenSearch ? onOpenSearch : undefined}
        >
          <span
            className={cn(
              "grid h-5 w-5 shrink-0 place-items-center rounded-full",
              active && "bg-primary/10 text-primary",
            )}
          >
            <ModeIcon mode={mode} connecting={connecting} />
          </span>
          <span className="ml-2 min-w-0 flex-1 truncate text-left">
            {displayText}
          </span>
        </button>

        <div className="absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1">
          {showInlineWaveform ? (
            <div
              className="h-6 w-16 overflow-hidden rounded-full bg-background/70 ring-1 ring-border/40 sm:w-20"
              aria-label="Voice input level"
            >
              <VoiceEqualizer
                state={mode === "processing" ? "processing" : "listening"}
                level={smoothedLevel}
                bars={7}
              />
            </div>
          ) : null}

          {mode === "idle" && showMic ? (
            <IconButton
              label="Toggle voice microphone"
              disabled={micDisabled}
              onClick={onMicToggle}
            >
              {connecting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Mic className="h-4 w-4" />
              )}
            </IconButton>
          ) : null}

          {mode === "connecting" || mode === "listening" || mode === "muted" ? (
            <>
              <IconButton
                label={
                  mode === "muted" ? "Unmute microphone" : "Mute microphone"
                }
                active={mode === "listening"}
                disabled={mode === "connecting"}
                onClick={mode === "connecting" ? undefined : onMuteToggle}
              >
                {mode === "muted" ? (
                  <Mic className="h-4 w-4" />
                ) : (
                  <MicOff className="h-4 w-4" />
                )}
              </IconButton>
              {showSubmit ? (
                <IconButton
                  label="Submit voice turn"
                  disabled={!submitEnabled}
                  active={submitEnabled}
                  onClick={onSubmit}
                >
                  <Send className="h-3.5 w-3.5" />
                </IconButton>
              ) : null}
              <IconButton label="End voice session" onClick={onEnd}>
                <X className="h-4 w-4" />
              </IconButton>
            </>
          ) : null}

          {mode === "processing" ? (
            <IconButton label="Cancel voice turn" onClick={onEnd}>
              <X className="h-4 w-4" />
            </IconButton>
          ) : null}

          {mode === "speaking" ? (
            <>
              <IconButton
                label="Stop speaking"
                disabled={!ttsPlaying}
                onClick={ttsPlaying ? onStopSpeaking : undefined}
              >
                <VolumeX className="h-4 w-4" />
              </IconButton>
              <IconButton label="Replay last response" onClick={onReplay}>
                <RotateCcw className="h-3.5 w-3.5" />
              </IconButton>
              <IconButton label="End voice session" onClick={onEnd}>
                <X className="h-4 w-4" />
              </IconButton>
            </>
          ) : null}

          {mode === "retry_ready" && !pendingConfirmation ? (
            <>
              {onReplay ? (
                <IconButton label="Replay last response" onClick={onReplay}>
                  <RotateCcw className="h-3.5 w-3.5" />
                </IconButton>
              ) : null}
              <IconButton label="Retry voice command" onClick={onRetry} active>
                <Volume2 className="h-4 w-4" />
              </IconButton>
              <IconButton label="End voice session" onClick={onEnd}>
                <X className="h-4 w-4" />
              </IconButton>
            </>
          ) : null}
        </div>
      </div>

      {mode === "idle" && showMic && micDisabledReason ? (
        <p className="mt-1 text-center text-[10px] text-muted-foreground">
          {micDisabledReason}
        </p>
      ) : null}
    </div>
  );
}
