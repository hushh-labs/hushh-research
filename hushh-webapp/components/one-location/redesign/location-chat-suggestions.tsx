"use client";

import { cn } from "@/lib/utils";

export interface SuggestionChip {
  label: string;
  mode: "send" | "prefill";
  value: string;
}

export const LOCATION_SUGGESTION_CHIPS: SuggestionChip[] = [
  { label: "Who can see me?", mode: "send", value: "Who can see me right now?" },
  { label: "Stop sharing with…", mode: "prefill", value: "Stop sharing with " },
  {
    label: "Ask someone to share",
    mode: "prefill",
    value: "Ask … to share their location with me",
  },
  {
    label: "Deny a request",
    mode: "send",
    value: "Deny the latest location request",
  },
  {
    label: "Share my location with…",
    mode: "prefill",
    value: "Share my location with ",
  },
  {
    label: "Show me where someone is",
    mode: "send",
    value: "Show me where someone is",
  },
  {
    label: "Make a public link",
    mode: "send",
    value: "Make a public link to my location",
  },
];

export function SuggestionChips(props: {
  onSend: (value: string) => void;
  onPrefill: (value: string) => void;
}) {
  const { onSend, onPrefill } = props;
  return (
    <div className="flex flex-wrap gap-2" data-testid="location-chat-suggestions">
      {LOCATION_SUGGESTION_CHIPS.map((chip) => (
        <button
          key={chip.label}
          type="button"
          onClick={() =>
            chip.mode === "send" ? onSend(chip.value) : onPrefill(chip.value)
          }
          className={cn(
            "rounded-full border border-[color:var(--app-card-border-standard)]",
            "bg-[color:var(--app-card-surface-compact)] px-3 py-1.5 text-xs font-medium",
            "text-foreground transition-colors hover:border-[#d4a574]/50 hover:text-[#b8894d]",
          )}
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}
