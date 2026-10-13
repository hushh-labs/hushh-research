"use client";

import { AlertCircle, Loader2, Mic, MicOff, Volume2 } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  getAgentVoiceStatusLabel,
  useAgentVoiceState,
} from "@/lib/agent/agent-voice-state";

type AgentVoiceFloatingIndicatorProps = {
  onClick?: () => void;
  className?: string;
};

export function AgentVoiceFloatingIndicator({
  onClick,
  className,
}: AgentVoiceFloatingIndicatorProps) {
  const active = useAgentVoiceState((state) => state.active);
  const status = useAgentVoiceState((state) => state.status);
  const level = useAgentVoiceState((state) => state.level);
  const message = useAgentVoiceState((state) => state.message);

  if (!active || status === "idle") return null;

  const label = message || getAgentVoiceStatusLabel(status);
  const icon =
    status === "transcribing" || status === "thinking" ? (
      <Loader2 className="h-4 w-4 animate-spin" />
    ) : status === "muted" ? (
      <MicOff className="h-4 w-4" />
    ) : status === "speaking" ? (
      <Volume2 className="h-4 w-4" />
    ) : status === "error" ? (
      <AlertCircle className="h-4 w-4" />
    ) : (
      <Mic className="h-4 w-4" />
    );

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "fixed right-4 z-[470] flex h-11 items-center gap-2 rounded-full border border-primary/40 bg-background/95 px-4 text-sm font-medium text-foreground shadow-lg backdrop-blur-md transition-transform hover:scale-[1.02] focus:outline-none focus:ring-2 focus:ring-primary/40",
        status === "error" && "border-destructive/50 text-destructive focus:ring-destructive/40",
        className
      )}
      style={{
        bottom:
          "calc(var(--app-bottom-fixed-ui, 76px) + max(var(--app-safe-area-bottom-effective), 0.75rem) + 4.25rem)",
      }}
      aria-label={`Agent voice ${label}`}
      title={label}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-primary",
          status === "error" && "bg-destructive/10 text-destructive"
        )}
      >
        {icon}
      </span>
      <span>{label}</span>
      <span
        className="h-2 w-2 rounded-full bg-primary transition-transform"
        style={{ transform: `scale(${1 + Math.min(1, level) * 1.4})` }}
        aria-hidden
      />
    </button>
  );
}
