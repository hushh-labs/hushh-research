"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { cn } from "@/lib/utils";
import { Icon } from "@/lib/morphy-ux/ui/icon";

export type SegmentedPillOption = {
  value: string;
  label: string;
  icon?: LucideIcon;
  badge?: number;
  tone?: "default" | "accent";
  disabled?: boolean;
  dataTourId?: string;
};

type SegmentedPillSize = "compact" | "default";
type SegmentedPillLayout = "inline" | "stacked";

type SegmentedPillProps = {
  value: string;
  options: SegmentedPillOption[];
  onValueChange: (value: string) => void;
  size?: SegmentedPillSize;
  layout?: SegmentedPillLayout;
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
    container: "min-h-[38px] p-1",
    button: "px-2 py-1.5 text-xs",
    icon: "sm",
    label: "text-[11px] font-medium leading-none",
    gap: "gap-1",
    stackedContainer: "min-h-[58px] p-1",
    stackedButton: "px-1.5 py-1.5",
    stackedLabel: "text-[10px] font-medium leading-[1.05]",
    stackedGap: "gap-1",
  },
  default: {
    container: "min-h-[45px] p-1",
    button: "px-3 py-2 text-sm",
    icon: "sm",
    label: "text-sm font-medium",
    gap: "gap-1.5",
    stackedContainer: "min-h-[66px] p-1",
    stackedButton: "px-2 py-2",
    stackedLabel: "text-xs font-medium leading-tight",
    stackedGap: "gap-1.5",
  },
};

export const SegmentedPill = React.forwardRef<HTMLDivElement, SegmentedPillProps>(
  (
    {
      value,
      options,
      onValueChange,
      size = "default",
      layout = "inline",
      hitArea = "segment",
      className,
      ariaLabel = "Segmented selector",
    },
    ref
  ) => {
    const styles = SIZE_STYLES[size];
    const isStacked = layout === "stacked";
    const activeIndex = Math.max(
      0,
      options.findIndex((option) => option.value === value)
    );

    return (
      <div
        ref={ref}
        data-theme-control
        role="radiogroup"
        aria-label={ariaLabel}
        className={cn(
          "pointer-events-none relative grid items-center rounded-full border-0 bg-background/80 shadow-[0_11px_34px_0_var(--theme-color-boxShadow)] backdrop-blur-[var(--blur-standard)]",
          isStacked ? styles.stackedContainer : styles.container,
          className
        )}
        style={{
          gridTemplateColumns: `repeat(${Math.max(options.length, 1)}, minmax(0, 1fr))`,
        }}
      >
        <div
          aria-hidden
          data-segment-indicator
          className="pointer-events-none absolute left-1 top-1 bottom-1 rounded-full bg-black/10 shadow-[0_2px_8px_rgba(0,0,0,0.08)] backdrop-blur-sm dark:bg-white/15 dark:shadow-[0_2px_8px_rgba(0,0,0,0.4)] transition-transform duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
          style={{
            width: `calc((100% - 0.5rem) / ${Math.max(options.length, 1)})`,
            transform: `translateX(calc(${activeIndex * 100}% + var(--segment-drag-x, 0px)))`,
          }}
        />
        {options.map((option) => {
          const isActive = option.value === value;
          const isDisabled = !!option.disabled;
          const isAccent = option.tone === "accent";
          const needsWrapper = hitArea === "content" || hitArea === "segment";
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
                "relative z-10 flex min-w-0 items-center justify-center overflow-hidden rounded-full text-center transition-[color,opacity,transform] duration-500 ease-[cubic-bezier(0.25,1,0.5,1)] disabled:cursor-not-allowed",
                "pointer-events-auto",
                hitArea === "content" ? "w-fit flex-none self-center" : "h-full w-full",
                isStacked ? "flex-col" : "flex-row",
                isStacked ? styles.stackedButton : styles.button,
                isStacked ? styles.stackedGap : styles.gap,
                isActive
                  ? "text-foreground font-semibold"
                  : isAccent
                    ? "text-primary/85 hover:text-primary"
                    : "text-foreground/60 hover:text-foreground/80",
                isDisabled && "opacity-45"
              )}
            >
              {option.icon || (typeof option.badge === "number" && option.badge > 0) ? (
                <span className="relative flex shrink-0 items-center justify-center">
                  {option.icon ? (
                    <Icon
                      icon={option.icon}
                      size={styles.icon}
                      className={cn(
                        "transition-transform duration-500 ease-[cubic-bezier(0.25,1,0.5,1)]",
                        isActive && "scale-105"
                      )}
                    />
                  ) : null}
                  {typeof option.badge === "number" && option.badge > 0 ? (
                    <span className="absolute -right-1 -top-1 inline-flex h-3.5 min-w-[0.875rem] items-center justify-center rounded-full border border-background bg-red-500 px-1 text-[9px] font-bold leading-none text-white">
                      {option.badge > 9 ? "9+" : option.badge}
                    </span>
                  ) : null}
                </span>
              ) : null}
              <span
                className={cn(
                  isStacked ? "max-w-full whitespace-normal" : "whitespace-nowrap",
                  isStacked ? styles.stackedLabel : styles.label
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
                  hitArea === "content" && isStacked ? "py-0.5" : ""
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
  }
);

SegmentedPill.displayName = "SegmentedPill";
