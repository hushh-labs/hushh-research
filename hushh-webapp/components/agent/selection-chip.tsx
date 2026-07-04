"use client";

import { Check } from "lucide-react";

/**
 * Right-aligned user-side chip summarizing a card selection, styled to match the
 * central chat's primary user bubble so both surfaces read consistently.
 */
export function SelectionChip({ label }: { label: string }) {
  return (
    <div className="flex w-full justify-end" data-testid="selection-chip">
      <span className="inline-flex items-center gap-1.5 rounded-2xl bg-primary/10 px-3.5 py-1.5 text-sm font-medium text-primary shadow-sm shadow-primary/5">
        <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {label}
      </span>
    </div>
  );
}
