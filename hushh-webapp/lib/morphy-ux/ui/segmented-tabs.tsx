"use client";

import { useRef, type CSSProperties, type KeyboardEvent } from "react";

import { cn } from "@/lib/utils";

export interface SegmentedTabOption {
  value: string;
  label: string;
  accessibleLabel?: string;
}

export type SegmentedTabsVariant =
  | "default"
  | "agent-top"
  | "subordinate"
  | "filter";

export function SegmentedTabs({
  value,
  onValueChange,
  options,
  mobileColumns,
  disabled = false,
  className,
  ariaLabel,
  variant = "default",
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: SegmentedTabOption[];
  mobileColumns?: number;
  /** Disable every option while the owning selection is settling. */
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  /** Opt into the compact Location-style navigation presentation. */
  variant?: SegmentedTabsVariant;
}) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const resolvedDesktopColumns = Math.max(options.length, 1);
  const resolvedMobileColumns = Math.max(
    mobileColumns ?? resolvedDesktopColumns,
    1,
  );
  const isSubordinate = variant === "subordinate";
  const isFilter = variant === "filter";

  return (
    <div
      role="tablist"
      data-ui-role="segmented-tabs"
      data-ui-variant={variant}
      aria-label={ariaLabel}
      className={cn(
        isFilter
          ? "relative flex w-full max-w-full items-center gap-2 overflow-x-auto"
          : "relative grid w-full [grid-template-columns:repeat(var(--segmented-mobile-cols),minmax(0,1fr))] sm:[grid-template-columns:repeat(var(--segmented-desktop-cols),minmax(0,1fr))]",
        variant === "agent-top"
          ? "h-9 min-h-0 rounded-[10px]"
          : isSubordinate
            ? "h-10 min-h-0 rounded-none border-b border-border/50 bg-transparent p-0"
            : isFilter
              ? "min-h-8"
              : "min-h-11 rounded-[14px] p-0.5 backdrop-blur-xl",
        !isSubordinate && !isFilter && "border-0",
        "bg-[color:var(--app-segmented-track-surface)] shadow-none",
        isSubordinate && "border-b border-border/50 bg-transparent",
        isFilter && "bg-transparent",
        className,
      )}
      style={
        {
          "--segmented-mobile-cols": String(resolvedMobileColumns),
          "--segmented-desktop-cols": String(resolvedDesktopColumns),
        } as CSSProperties
      }
    >
      {options.map((option, index) => {
        const isActive = option.value === value;

        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-label={option.accessibleLabel}
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            disabled={disabled}
            data-state={isActive ? "active" : "inactive"}
            onClick={() => {
              if (!disabled && !isActive) onValueChange(option.value);
            }}
            ref={(node) => {
              tabRefs.current[index] = node;
            }}
            onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
              if (disabled || options.length < 2) return;
              let nextIndex: number | null = null;
              if (event.key === "ArrowRight") nextIndex = (index + 1) % options.length;
              else if (event.key === "ArrowLeft") nextIndex = (index - 1 + options.length) % options.length;
              else if (event.key === "Home") nextIndex = 0;
              else if (event.key === "End") nextIndex = options.length - 1;
              if (nextIndex === null) return;
              event.preventDefault();
              const next = options[nextIndex];
              if (!next) return;
              tabRefs.current[nextIndex]?.focus();
              if (next.value !== value) onValueChange(next.value);
            }}
              className={cn(
                "relative isolate flex min-w-0 items-center justify-center overflow-hidden border text-center transition-[background-color,border-color,box-shadow,color] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]",
                variant === "agent-top"
                  ? "h-full min-h-0 rounded-[8px] px-1 py-0 min-[360px]:px-2 sm:px-3"
                  : isSubordinate
                    ? "h-full min-h-0 rounded-none border-b-2 px-3 py-0 text-sm sm:px-4"
                    : isFilter
                      ? "h-8 min-h-8 flex-none rounded-full px-3 py-0 text-xs sm:text-sm"
                      : "min-h-10 rounded-[12px] px-3 py-2 sm:px-4",
                isActive
                  ? cn(
                      isSubordinate
                        ? "z-10 border-[color:var(--app-accent)] bg-transparent text-[color:var(--app-accent)] font-semibold shadow-none"
                        : isFilter
                          ? "z-10 border-[color:var(--app-accent-border)] bg-[color:var(--app-accent-surface)] text-[color:var(--app-accent-deep)] font-semibold shadow-none"
                          : "z-10 border-transparent bg-[color:var(--app-segmented-active-surface)] text-[color:var(--app-segmented-active-foreground)] font-semibold shadow-[var(--app-segmented-active-shadow)]",
                      variant === "agent-top" && "mx-0.5",
                    )
                  : isSubordinate
                    ? "border-transparent bg-transparent text-[color:var(--app-secondary-label)] [@media(hover:hover)]:hover:text-[color:var(--app-label)]"
                    : isFilter
                      ? "border-border/60 bg-[color:var(--app-card-surface-compact)] text-[color:var(--app-secondary-label)] [@media(hover:hover)]:hover:border-[color:var(--app-accent-border)]"
                      : "border-transparent bg-transparent text-[color:var(--app-secondary-label)] [@media(hover:hover)]:hover:bg-[color:var(--app-neutral-fill)]",
                disabled && "cursor-not-allowed opacity-60",
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
              className={cn(
                variant === "agent-top"
                  ? "ui-text-agent-tab-label relative z-10 block min-w-0 truncate text-center"
                  : "ui-text-form-label relative z-10 block min-w-0 text-center",
                !isSubordinate && !isFilter && "truncate",
                (isSubordinate || isFilter) && "whitespace-nowrap",
              )}
            >
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
