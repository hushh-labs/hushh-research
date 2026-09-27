"use client";

import { cn } from "@/lib/utils";

export type ShareMode = "share" | "request";

/** Shared keyboard and touch behavior for Location's Share/Request switch. */
export function SegmentedModeControl({
  value,
  onChange,
}: {
  value: ShareMode;
  onChange: (value: ShareMode) => void;
}) {
  return (
    <div
      aria-label="Choose location sharing mode"
      className="flex h-12 w-full min-w-0 max-w-full items-center overflow-hidden rounded-[9px] bg-[color:var(--app-segmented-track-surface)] p-[2px]"
      role="tablist"
    >
      {(["share", "request"] as const).map((mode) => (
        <button
          key={mode}
          aria-selected={value === mode}
          role="tab"
          type="button"
          tabIndex={value === mode ? 0 : -1}
          data-location-mode={mode}
          onClick={() => onChange(mode)}
          onKeyDown={(event) => {
            const nextMode =
              event.key === "ArrowRight" || event.key === "ArrowLeft"
                ? mode === "share"
                  ? "request"
                  : "share"
                : event.key === "End"
                  ? "request"
                  : event.key === "Home"
                    ? "share"
                    : null;
            if (!nextMode) return;
            event.preventDefault();
            onChange(nextMode);
            event.currentTarget.parentElement
              ?.querySelector<HTMLButtonElement>(
                `[data-location-mode="${nextMode}"]`,
              )
              ?.focus();
          }}
          className={cn(
            "min-h-11 flex-1 rounded-[7px] text-[13px] capitalize transition-[background-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] motion-reduce:transition-none",
            value === mode
              ? "bg-[color:var(--app-segmented-active-surface)] font-semibold text-[color:var(--app-label)] shadow-[var(--app-card-shadow-standard)]"
              : "font-medium text-[color:var(--app-secondary-label)] hover:text-[color:var(--app-label)]",
          )}
        >
          {mode}
        </button>
      ))}
    </div>
  );
}
