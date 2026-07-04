"use client";

import { cn } from "@/lib/utils";

export interface MarketplaceSuggestionChip {
  label: string;
  mode: "send" | "prefill";
  value: string;
}

// Slice-1 chips map to the two read-only tools (list published / earnings).
export const MARKETPLACE_SUGGESTION_CHIPS: MarketplaceSuggestionChip[] = [
  { label: "What have I published?", mode: "send", value: "What have I published to the marketplace?" },
  { label: "What's it worth?", mode: "send", value: "What are my published slices worth?" },
  { label: "How much have I made?", mode: "send", value: "How much money have I made so far?" },
  { label: "Anything on the market?", mode: "send", value: "Do I have anything on the market right now?" },
];

export function MarketplaceSuggestionChips(props: {
  onSend: (value: string) => void;
  onPrefill: (value: string) => void;
}) {
  const { onSend, onPrefill } = props;
  return (
    <div className="flex flex-wrap gap-2" data-testid="marketplace-chat-suggestions">
      {MARKETPLACE_SUGGESTION_CHIPS.map((chip) => (
        <button
          key={chip.label}
          type="button"
          onClick={() =>
            chip.mode === "send" ? onSend(chip.value) : onPrefill(chip.value)
          }
          className={cn(
            "rounded-full border border-[color:var(--app-card-border-standard)]",
            "bg-[color:var(--app-card-surface-compact)] px-3 py-1.5 text-xs font-medium",
            "text-foreground transition-colors hover:border-emerald-500/50 hover:text-emerald-700 dark:hover:text-emerald-300",
          )}
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}
