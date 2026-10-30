"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Icon } from "@/lib/morphy-ux/ui/icon";

export type IconChipTone = "blue" | "green" | "orange";
export type IconChipState = "muted" | "active";

const TONE_VARIABLE_CLASSES: Record<IconChipTone, string> = {
  blue: "[--chip-fg:var(--tone-blue)] [--chip-bg:var(--tone-blue-bg)] [--chip-glow:var(--tone-blue-glow)]",
  green:
    "[--chip-fg:var(--tone-green)] [--chip-bg:var(--tone-green-bg)] [--chip-glow:var(--tone-green-glow)]",
  orange:
    "[--chip-fg:var(--tone-orange)] [--chip-bg:var(--tone-orange-bg)] [--chip-glow:var(--tone-orange-glow)]",
};

export interface IconChipProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  icon: LucideIcon;
  tone: IconChipTone;
  state?: IconChipState;
}

export const IconChip = React.forwardRef<HTMLDivElement, IconChipProps>(
  ({ icon, tone, state = "active", className, ...props }, ref) => {
    return (
      <div
        ref={ref}
        data-chip="true"
        data-tone={tone}
        data-state={state}
        className={cn(
          "grid h-12 w-12 shrink-0 place-items-center rounded-full border border-transparent",
          "text-muted-foreground bg-[color-mix(in_oklch,var(--background)_92%,var(--muted)_8%)]",
          "transition-[background-color,color,transform,opacity] duration-300",
          "data-[state=active]:bg-[var(--chip-bg)] data-[state=active]:text-[var(--chip-fg)]",
          "data-[state=active]:ring-1 data-[state=active]:ring-[var(--chip-fg)]/28",
          "data-[state=active]:shadow-[0_0_18px_var(--chip-glow)]",
          TONE_VARIABLE_CLASSES[tone],
          className
        )}
        {...props}
      >
        <Icon icon={icon} size="lg" />
      </div>
    );
  }
);

IconChip.displayName = "IconChip";
