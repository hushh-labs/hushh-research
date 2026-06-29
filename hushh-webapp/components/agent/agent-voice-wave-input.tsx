"use client";

import { Keyboard, Loader2, Mic, MicOff, X } from "lucide-react";

import { AgentVoiceWaveform } from "@/components/agent/agent-voice-waveform";
import { Button } from "@/components/ui/button";
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
        <AgentVoiceWaveform
          className="mt-2"
          level={level}
          status={status}
          muted={muted}
        />
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
