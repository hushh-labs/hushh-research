"use client";

import { X } from "lucide-react";

import { cn } from "@/lib/utils";

/** Shared, touch-friendly clear affordance for controlled search fields. */
export function SearchClearButton({
  visible,
  label = "Clear search",
  onClear,
  className,
}: {
  visible: boolean;
  label?: string;
  onClear: () => void;
  className?: string;
}) {
  if (!visible) return null;

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onPointerDown={(event) => event.preventDefault()}
      onClick={onClear}
      className={cn(
        "absolute right-1 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] active:scale-95",
        className,
      )}
    >
      <X className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
    </button>
  );
}
