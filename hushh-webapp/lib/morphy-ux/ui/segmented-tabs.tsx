"use client";

import type { CSSProperties } from "react";

import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
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
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: SegmentedTabOption[];
  mobileColumns?: number;
  className?: string;
}) {
  const resolvedDesktopColumns = Math.max(options.length, 1);
  const resolvedMobileColumns = Math.max(mobileColumns ?? resolvedDesktopColumns, 1);

  return (
    <div
      className={cn(
        "relative grid w-full rounded-full p-1 backdrop-blur-xl [grid-template-columns:repeat(var(--segmented-mobile-cols),minmax(0,1fr))] sm:[grid-template-columns:repeat(var(--segmented-desktop-cols),minmax(0,1fr))]",
        "border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] shadow-[var(--app-card-shadow-standard)]",
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
            data-state={isActive ? "active" : "inactive"}
            onClick={() => {
              if (!isActive) onValueChange(option.value);
            }}
            className={cn(
              "relative isolate min-h-9 overflow-hidden rounded-full border px-4 py-2 text-center transition-[background-color,border-color,box-shadow,color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] sm:min-h-10 sm:px-4.5",
              isActive
                ? "z-10 border-[color:var(--app-segmented-active-border)] bg-[color:var(--app-segmented-active-surface)] text-[color:var(--app-segmented-active-foreground)] font-semibold shadow-[0_0_0_1px_var(--app-segmented-active-border),var(--shadow-xs)]"
                : "border-transparent bg-transparent text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
            )}
          >
            <span className="relative z-0 block truncate text-xs font-medium tracking-tight sm:text-sm">
              {option.label}
            </span>
            <MaterialRipple variant="none" effect="fade" className="z-10" />
          </button>
        );
      })}
    </div>
  );
}
