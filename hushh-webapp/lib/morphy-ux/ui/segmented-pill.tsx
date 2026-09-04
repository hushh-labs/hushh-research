"use client";

import * as React from "react";

import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { cn } from "@/lib/utils";

export type SegmentedPillIcon = React.ElementType<
  React.SVGProps<SVGSVGElement> & { size?: number | string }
>;

export type SegmentedPillOption = {
  value: string;
  label: string;
  icon?: SegmentedPillIcon;
  /** Optional selected-state counterpart for libraries with filled icons. */
  activeIcon?: SegmentedPillIcon;
  /** A count when sets are exactly countable, or a dot for attention unions
   * whose sources may overlap. */
  badge?: number | "dot";
  tone?: "default" | "accent";
  disabled?: boolean;
  dataTourId?: string;
};

type SegmentedPillSize = "compact" | "shell" | "default";
type SegmentedPillLayout = "inline" | "stacked";

type SegmentedPillProps = {
  value: string;
  options: SegmentedPillOption[];
  onValueChange: (value: string) => void;
  size?: SegmentedPillSize;
  layout?: SegmentedPillLayout;
  slotCount?: number;
  hitArea?: "segment" | "content";
  className?: string;
  ariaLabel?: string;
};

const SIZE_STYLES: Record<
  SegmentedPillSize,
  {
    container: string;
    button: string;
    icon: "xs" | "sm" | "md";
    label: string;
    gap: string;
    stackedContainer: string;
    stackedButton: string;
    stackedLabel: string;
    stackedGap: string;
  }
> = {
  compact: {
    container: "min-h-[36px] p-0.5",
    button: "px-2 py-1 ui-text-tab-label",
    icon: "xs",
    label: "leading-none",
    gap: "gap-1",
    stackedContainer: "min-h-[52px] p-0.5",
    stackedButton: "px-1 py-1",
    stackedLabel: "text-[11px] leading-[13px]",
    stackedGap: "gap-0.5",
  },
  shell: {
    container: "min-h-[42px] p-1",
    button: "px-2.5 py-1.5 ui-text-tab-label",
    icon: "sm",
    label: "leading-none",
    gap: "gap-1.5",
    stackedContainer: "min-h-[64px] p-2",
    stackedButton: "min-h-11 px-1 py-1",
    stackedLabel: "text-[11px] leading-[13px]",
    stackedGap: "gap-[3px]",
  },
  default: {
    container: "min-h-[45px] p-1",
    button: "px-3 py-2 ui-text-form-label",
    icon: "sm",
    label: "",
    gap: "gap-1.5",
    stackedContainer: "min-h-[64px] p-2",
    stackedButton: "min-h-11 px-2 py-1",
    stackedLabel: "text-[11px] leading-[13px]",
    stackedGap: "gap-[3px]",
  },
};

export const SegmentedPill = React.forwardRef<
  HTMLDivElement,
  SegmentedPillProps
>(
  (
    {
      value,
      options,
      onValueChange,
      size = "default",
      layout = "inline",
      slotCount,
      hitArea = "segment",
      className,
      ariaLabel = "Segmented selector",
    },
    ref,
  ) => {
    const styles = SIZE_STYLES[size];
    const isStacked = layout === "stacked";
    const [activePulseKey, setActivePulseKey] = React.useState(0);
    const previousValueRef = React.useRef(value);
    const resolvedSlotCount = Math.max(
      slotCount ?? options.length,
      options.length,
      1,
    );
    const activeIndex = Math.max(
      0,
      options.findIndex((option) => option.value === value),
    );

    React.useEffect(() => {
      if (previousValueRef.current === value) {
        return;
      }
      previousValueRef.current = value;
      setActivePulseKey((current) => current + 1);
    }, [value]);

    return (
      <div
        ref={ref}
        data-theme-control
        role="radiogroup"
        aria-label={ariaLabel}
        className={cn(
          "pointer-events-none relative grid items-center rounded-full border border-[color:var(--app-glass-border)] bg-[color:var(--app-glass-surface)] shadow-[var(--app-glass-shadow)] backdrop-blur-[var(--blur-standard)]",
          isStacked ? styles.stackedContainer : styles.container,
          className,
        )}
        style={{
          gridTemplateColumns: `repeat(${resolvedSlotCount}, minmax(0, 1fr))`,
        }}
      >
        <div
          aria-hidden
          data-segment-indicator
          className="pointer-events-none absolute left-2 top-2 bottom-2 overflow-hidden rounded-full bg-transparent shadow-none transition-transform duration-[300ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]"
          style={{
            width: `calc((100% - 1rem) / ${resolvedSlotCount})`,
            transform: `translateX(calc(${activeIndex * 100}% + var(--segment-drag-x, 0px)))`,
          }}
        >
          <span
            key={`${value}-${activePulseKey}`}
            data-segment-active-pulse
            className="absolute inset-0 rounded-full bg-transparent opacity-0"
          />
        </div>
        {options.map((option) => {
          const isActive = option.value === value;
          const isDisabled = !!option.disabled;
          const isAccent = option.tone === "accent";
          const needsWrapper = hitArea === "content" || hitArea === "segment";
          const OptionIcon =
            isActive && option.activeIcon ? option.activeIcon : option.icon;
          const numericBadge =
            typeof option.badge === "number" ? option.badge : null;
          const hasNumericBadge = numericBadge !== null && numericBadge > 0;
          const numericBadgeText =
            numericBadge !== null && numericBadge > 9 ? "9+" : numericBadge;
          const hasDotBadge = option.badge === "dot";
          const button = (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={isActive}
              aria-disabled={isDisabled}
              data-tour-id={option.dataTourId}
              disabled={isDisabled}
              onClick={() => {
                if (isDisabled) return;
                onValueChange(option.value);
              }}
              className={cn(
                "press-scale relative z-10 flex min-w-0 items-center justify-center overflow-hidden rounded-full text-center transition-[color,opacity,transform] duration-200 ease-[cubic-bezier(0.2,0,0,1)] disabled:cursor-not-allowed",
                "pointer-events-auto",
                hitArea === "content"
                  ? "w-fit flex-none self-center"
                  : "h-full w-full",
                isStacked ? "flex-col" : "flex-row",
                isStacked ? styles.stackedButton : styles.button,
                isStacked ? styles.stackedGap : styles.gap,
                isActive
                  ? "text-[color:var(--app-accent)] font-medium segmented-pill-active-choice"
                : isAccent
                    ? "text-[color:var(--app-accent)] segmented-pill-button-accent"
                    : "text-muted-foreground segmented-pill-button-default",
                isDisabled && "opacity-45",
              )}
            >
              {OptionIcon || hasNumericBadge || hasDotBadge ? (
                <span className="relative flex shrink-0 items-center justify-center">
                  {OptionIcon ? (
                    <OptionIcon
                      data-segment-icon
                      data-segment-icon-variant={
                        isActive && option.activeIcon ? "active" : "default"
                      }
                      size={isStacked ? 22 : { xs: 14, sm: 16, md: 20 }[styles.icon]}
                      className="shrink-0"
                      aria-hidden
                    />
                  ) : null}
                  {hasNumericBadge ? (
                    <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-background bg-red-500 px-1 text-[11px] font-bold leading-none text-white">
                      {numericBadgeText}
                    </span>
                  ) : null}
                  {hasDotBadge ? (
                    <>
                      <span
                        aria-hidden="true"
                        className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border border-background bg-red-500"
                      />
                      <span className="sr-only">New activity</span>
                    </>
                  ) : null}
                </span>
              ) : null}
              <span
                className={cn(
                  isStacked
                    ? "max-w-full whitespace-normal"
                    : "whitespace-nowrap",
                  isStacked ? styles.stackedLabel : styles.label,
                )}
              >
                {option.label}
              </span>
              <MaterialRipple
                variant={isAccent ? "link" : "none"}
                effect={isAccent ? "glass" : "fade"}
                disabled={isDisabled}
                className="z-0"
              />
            </button>
          );

          if (needsWrapper) {
            return (
              <div
                key={option.value}
                className={cn(
                  "pointer-events-none relative z-10 flex min-w-0 items-center justify-center",
                  hitArea === "segment" ? "h-full px-[2px] py-[2px]" : "",
                  hitArea === "content" && isStacked ? "py-0.5" : "",
                )}
              >
                {button}
              </div>
            );
          }

          return button;
        })}
      </div>
    );
  },
);

SegmentedPill.displayName = "SegmentedPill";
