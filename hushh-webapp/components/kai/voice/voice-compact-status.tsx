"use client";

import { RotateCcw, Volume2, VolumeX } from "lucide-react";

import { VoiceEqualizer } from "@/components/kai/voice-equalizer";
import { cn } from "@/lib/utils";

type VoiceCompactStatusMode = "processing" | "speaking" | "retry_ready";

type VoiceCompactStatusProps = {
  mode: VoiceCompactStatusMode;
  label: string;
  stageText?: string | null;
  replyText?: string | null;
  smoothedLevel: number;
  onStopSpeaking?: () => void;
  onReplay?: () => void;
  onRetry?: () => void;
  onConfirm?: () => void;
  onCancel?: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
};

function renderDots() {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary [animation-delay:0ms]" />
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary [animation-delay:120ms]" />
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary [animation-delay:240ms]" />
    </span>
  );
}

export function VoiceCompactStatus({
  mode,
  label,
  stageText,
  replyText,
  smoothedLevel,
  onStopSpeaking,
  onReplay,
  onRetry,
  onConfirm,
  onCancel,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
}: VoiceCompactStatusProps) {
  const showWaveform = mode !== "processing";
  const showReplay = Boolean(onReplay) && (mode === "speaking" || mode === "retry_ready");

  return (
    <div className="overflow-hidden rounded-2xl border border-border/70 bg-background/95 shadow-lg backdrop-blur">
      <div className="flex items-start gap-3 px-3 py-3 sm:px-4">
        <span
          className={cn(
            "mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
            mode === "processing" && "bg-primary/10 text-primary",
            mode === "speaking" && "bg-emerald-500/15 text-emerald-600",
            mode === "retry_ready" && "bg-amber-500/15 text-amber-600"
          )}
        >
          {mode === "processing" ? "Processing" : mode === "speaking" ? "Speaking" : "Retry"}
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-xs font-medium leading-5 text-foreground">
            {label} {mode === "processing" ? renderDots() : null}
          </p>
          {stageText ? (
            <p className="whitespace-normal break-words text-[11px] leading-4 text-muted-foreground">
              {stageText}
            </p>
          ) : null}
        </div>

        {mode === "speaking" && (onStopSpeaking || showReplay) ? (
          <div className="flex shrink-0 items-center gap-1.5">
            {onStopSpeaking ? (
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border/60 bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onClick={onStopSpeaking}
                aria-label="Stop speaking"
              >
                <VolumeX className="h-3.5 w-3.5" />
              </button>
            ) : null}
            {showReplay ? (
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border/60 bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onClick={onReplay}
                aria-label="Replay last response"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        ) : null}

        {mode === "retry_ready" ? (
          <div className="flex shrink-0 items-center gap-1.5">
            {showReplay ? (
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border/60 bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onClick={onReplay}
                aria-label="Replay last response"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            ) : null}
            {onCancel ? (
              <button
                type="button"
                className="inline-flex h-8 shrink-0 items-center rounded-full border border-border/60 bg-background px-3 text-[11px] font-semibold text-foreground transition-colors hover:bg-muted"
                onClick={onCancel}
              >
                {cancelLabel}
              </button>
            ) : null}
            {onConfirm ? (
              <button
                type="button"
                className="inline-flex h-8 shrink-0 items-center rounded-full bg-primary px-3 text-[11px] font-semibold text-primary-foreground transition-opacity hover:opacity-90"
                onClick={onConfirm}
              >
                {confirmLabel}
              </button>
            ) : onRetry ? (
              <button
                type="button"
                className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full border border-border/60 bg-background px-3 text-[11px] font-semibold text-foreground transition-colors hover:bg-muted"
                onClick={onRetry}
              >
                <Volume2 className="h-3.5 w-3.5" />
                Retry
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {showWaveform ? (
        <div className="h-9 border-t border-border/50 bg-gradient-to-r from-primary/5 via-background to-primary/10">
          <VoiceEqualizer state="listening" level={smoothedLevel} />
        </div>
      ) : null}

      {replyText ? (
        <div className="border-t border-border/60 px-3 py-2 sm:px-4">
          <p className="line-clamp-3 whitespace-normal break-words text-[11px] leading-4 text-muted-foreground">
            {replyText}
          </p>
        </div>
      ) : null}
    </div>
  );
}
