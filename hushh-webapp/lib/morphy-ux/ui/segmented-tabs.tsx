"use client";

import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

export interface SegmentedTabOption {
  value: string;
  label: string;
}

export function SegmentedTabs({
  value,
  onValueChange,
  options,
  mobileColumns,
  disabled = false,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: SegmentedTabOption[];
  mobileColumns?: number;
  /** Disable every option while the owning selection is settling. */
  disabled?: boolean;
  className?: string;
}) {
  const resolvedDesktopColumns = Math.max(options.length, 1);
  const resolvedMobileColumns = Math.max(mobileColumns ?? resolvedDesktopColumns, 1);

  return (
    <div
      className={cn(
        "relative grid min-h-11 w-full rounded-[14px] p-0.5 backdrop-blur-xl [grid-template-columns:repeat(var(--segmented-mobile-cols),minmax(0,1fr))] sm:[grid-template-columns:repeat(var(--segmented-desktop-cols),minmax(0,1fr))]",
        // One material with the Location strip: a recessed grey track, no
        // border. It used to borrow `--app-card-surface-compact` (#fcfcfd) and
        // a card border, which put a near-white bordered box around a
        // near-white pill -- the same control as Location's, reading as a
        // different component on the very next page.
        "border-0 bg-[color:var(--app-segmented-track-surface)] shadow-none",
        className
      )}
      style={
        {
          "--segmented-mobile-cols": String(resolvedMobileColumns),
          "--segmented-desktop-cols": String(resolvedDesktopColumns),
        } as CSSProperties
      }
    >
      {options.map((option) => {
        const isActive = option.value === value;

        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={isActive}
            disabled={disabled}
            data-state={isActive ? "active" : "inactive"}
            onClick={() => {
              if (!disabled && !isActive) onValueChange(option.value);
            }}
            className={cn(
              "relative isolate flex min-h-10 min-w-0 items-center justify-center overflow-hidden rounded-[12px] border px-3 py-2 text-center transition-[background-color,border-color,box-shadow,color] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] sm:px-4",
              isActive
                ? // Raised, not outlined. `font-semibold` matches the Location
                  // strip's active label; the colour comes from the label
                  // class, which forces `--app-label` either way.
                  "z-10 border-transparent bg-[color:var(--app-segmented-active-surface)] text-[color:var(--app-segmented-active-foreground)] font-semibold shadow-[var(--app-segmented-active-shadow)]"
                : "border-transparent bg-transparent text-[color:var(--app-secondary-label)] [@media(hover:hover)]:hover:bg-[color:var(--app-neutral-fill)]",
              disabled && "cursor-not-allowed opacity-60"
            )}
          >
            {/*
              A tab label is product-owned copy, not user content, so it may
              never resolve to an ellipsis: "Around yo…" is a defect, not
              graceful degradation. `truncate` is still here because a label
              that overflows must not blow the grid out instead -- the contract
              marks the overflow as forbidden so a measurement can catch it,
              rather than letting it silently look intentional.

              These attributes are inert: no styling, no accessibility effect.
              They exist so a headless width check can find every tab title in
              the app from one shared primitive instead of per screen.
            */}
            <span
              data-ui-contract="required-title"
              data-ui-truncation="forbid"
              data-ui-id={`segmented-tab-${option.value}`}
              className="ui-text-form-label relative z-10 block min-w-0 truncate text-center"
            >
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
