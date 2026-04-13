"use client";

import { Mic, MicOff, Send, X } from "lucide-react";

import { VoiceEqualizer } from "@/components/kai/voice-equalizer";
import { cn } from "@/lib/utils";

type VoiceConsoleSheetProps = {
  open: boolean;
  muted: boolean;
  submitting: boolean;
  submitEnabled?: boolean;
  showSubmit?: boolean;
  transcriptPreview: string;
  smoothedLevel: number;
  onMuteToggle: () => void;
  onSubmit: () => void;
  onCancel: () => void;
  onExamplePrompt: (prompt: string) => void;
};

const EXAMPLE_PROMPTS = [
  "Analyze Nvidia",
  "What's happening here?",
  "Explain this screen",
  "Open dashboard",
] as const;

export function VoiceConsoleSheet({
  open,
  muted,
  submitting,
  submitEnabled = true,
  showSubmit = true,
  transcriptPreview,
  smoothedLevel,
  onMuteToggle,
  onSubmit,
  onCancel,
  onExamplePrompt,
}: VoiceConsoleSheetProps) {
  if (!open) {
    return null;
  }

  return (
    <div
      className={cn(
        "w-full overflow-hidden rounded-3xl border border-border/70 bg-background/95 shadow-2xl backdrop-blur-xl"
      )}
      aria-hidden={!open}
    >
      <div className="border-b border-border/60 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-foreground">
            {submitting ? "Submitting..." : muted ? "Microphone muted" : "Listening..."}
          </p>
          <span className="rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
            {submitting ? "Submitting" : muted ? "Muted" : "Listening"}
          </span>
        </div>
        <p className="mt-2 min-h-10 whitespace-normal break-words text-xs text-muted-foreground">
          {transcriptPreview || "Listening for your voice..."}
        </p>
      </div>

      <div className="h-20 bg-gradient-to-r from-primary/5 via-background to-primary/10">
        <VoiceEqualizer state={submitting ? "processing" : "listening"} level={smoothedLevel} />
      </div>

      <div className="space-y-3 px-4 py-3">
        <div className="flex flex-wrap gap-2">
          {EXAMPLE_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              className="rounded-full border border-border/70 bg-background px-3 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => onExamplePrompt(prompt)}
            >
              {prompt}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-full border border-border/70 bg-background text-xs font-semibold text-foreground transition-colors hover:bg-muted"
            onClick={onMuteToggle}
            disabled={submitting}
          >
            {muted ? <Mic className="h-3.5 w-3.5" /> : <MicOff className="h-3.5 w-3.5" />}
            {muted ? "Unmute" : "Mute"}
          </button>
          {showSubmit ? (
            <button
              type="button"
              className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-full bg-primary text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-70"
              onClick={onSubmit}
              disabled={submitting || !submitEnabled}
            >
              {submitting ? (
                <Mic className="h-3.5 w-3.5 animate-pulse" />
              ) : submitEnabled ? (
                <Send className="h-3.5 w-3.5" />
              ) : (
                <Mic className="h-3.5 w-3.5" />
              )}
              {submitting ? "Submitting..." : submitEnabled ? "Submit" : "Connecting..."}
            </button>
          ) : null}
          <button
            type="button"
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-border/70 bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={onCancel}
            aria-label="End voice session"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
