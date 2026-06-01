"use client";

import { Keyboard, Loader2, Mic, MicOff, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AgentVoiceStatus } from "@/lib/agent/agent-voice-state";
import { getAgentVoiceStatusLabel } from "@/lib/agent/agent-voice-state";

type AgentVoiceWaveInputProps = {
  status: AgentVoiceStatus;
  level: number;
  muted: boolean;
  disabled?: boolean;
  onToggleMute: () => void;
  onCancel: () => void;
};

const WAVE_BARS = Array.from({ length: 18 }, (_, index) => index);

export function AgentVoiceWaveInput({
  status,
  level,
  muted,
  disabled,
  onToggleMute,
  onCancel,
}: AgentVoiceWaveInputProps) {
  const label = getAgentVoiceStatusLabel(status);
  const isBusy = status === "transcribing" || status === "thinking";
  const activeLevel = muted || isBusy ? 0.08 : Math.max(level, 0.08);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        disabled={disabled}
        onClick={onCancel}
        aria-label="Cancel voice mode"
        title="Cancel voice mode"
      >
        <Keyboard className="h-4 w-4" />
      </Button>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs font-medium text-foreground">
          {isBusy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          ) : muted ? (
            <MicOff className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <Mic className="h-3.5 w-3.5 text-primary" />
          )}
          <span>{label}</span>
        </div>
        <div className="mt-2 flex h-8 items-center gap-1 overflow-hidden">
          {WAVE_BARS.map((index) => {
            const phase = Math.sin(index * 0.85);
            const scale = muted ? 0.12 : activeLevel * (0.7 + Math.abs(phase) * 0.8);
            return (
              <span
                key={index}
                className={cn(
                  "block w-1 rounded-full bg-primary/70 transition-[height,opacity] duration-100",
                  (status === "listening" || status === "speaking") &&
                    !muted &&
                    "animate-pulse",
                  status === "error" && "bg-destructive/70"
                )}
                style={{ height: `${Math.max(5, Math.min(30, 5 + scale * 30))}px` }}
              />
            );
          })}
        </div>
      </div>

      <Button
        type="button"
        variant={muted ? "secondary" : "outline"}
        size="icon"
        className="h-9 w-9 shrink-0"
        disabled={disabled || status === "transcribing"}
        onClick={onToggleMute}
        aria-label={muted ? "Unmute Agent voice" : "Mute Agent voice"}
        title={muted ? "Unmute Agent voice" : "Mute Agent voice"}
      >
        {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
      </Button>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-9 w-9 shrink-0"
        disabled={disabled}
        onClick={onCancel}
        aria-label="Exit voice mode"
        title="Exit voice mode"
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
