"use client";

/**
 * Location agent redesign — Quick Actions grid (Now tab).
 *
 * PRESENTATION ONLY. A single reusable `QuickActionCard` renders every tile in
 * the "Quick actions" block so the six location shortcuts (Check-In, Alert,
 * Drive To, Pick Me Up, Meeting, Safe Arrival) stay visually identical and
 * behaviourally consistent. Each card is a 44px tinted icon circle + bold title
 * + a footer row (subtitle + circular chevron), on a 3-column grid, matching the
 * Apple Blue v2 design. Cards are prop-driven and delegate taps to the hub.
 */

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { SECTION_HEADING } from "./tokens";

export type QuickActionTone = "green" | "red" | "blue" | "violet" | "slate";

/**
 * Per-tone icon-circle palette, using the design's exact soft tints + saturated
 * foregrounds (with sensible dark-mode fallbacks).
 */
const TONE_STYLES: Record<QuickActionTone, { tile: string; icon: string }> = {
  green: {
    tile: "bg-[#e5f4ea] dark:bg-emerald-400/15",
    icon: "text-[#2ea44f] dark:text-emerald-300",
  },
  red: {
    tile: "bg-[#fdeeec] dark:bg-red-400/15",
    icon: "text-[#e0342c] dark:text-red-300",
  },
  blue: {
    tile: "bg-[#e7f0fd] dark:bg-sky-400/15",
    icon: "text-[#2f7cf6] dark:text-sky-300",
  },
  violet: {
    tile: "bg-[#efeafc] dark:bg-violet-400/15",
    icon: "text-[#7b5cf0] dark:text-violet-300",
  },
  slate: {
    tile: "bg-[#eeeef2] dark:bg-white/10",
    icon: "text-[#6b6b76] dark:text-slate-300",
  },
};

export type QuickActionCardProps = {
  icon: ReactNode;
  title: string;
  subtitle: string;
  tone?: QuickActionTone;
  onClick?: () => void;
  /** Non-interactive treatment for actions that aren't wired up yet. */
  comingSoon?: boolean;
  /** Disable interaction without the coming-soon semantics. */
  disabled?: boolean;
};

export function QuickActionCard({
  icon,
  title,
  subtitle,
  tone = "slate",
  onClick,
  comingSoon = false,
  disabled = false,
}: QuickActionCardProps) {
  const palette = TONE_STYLES[tone];
  const interactive = !comingSoon && !disabled;

  return (
    <button
      type="button"
      onClick={interactive ? onClick : undefined}
      disabled={!interactive}
      aria-disabled={!interactive}
      className={cn(
        "group flex h-full w-full min-w-0 flex-col gap-3 rounded-2xl bg-white p-3 text-left shadow-[0_2px_8px_rgba(0,0,0,0.04)] transition-all duration-200 dark:bg-[color:var(--app-card-surface-default-solid)]",
        interactive
          ? "cursor-pointer hover:-translate-y-0.5 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
          : "cursor-not-allowed",
      )}
    >
      <div className="flex w-full items-start justify-between gap-2">
        <span
          className={cn(
            "flex h-11 w-11 items-center justify-center rounded-full",
            palette.tile,
            palette.icon,
          )}
        >
          {icon}
        </span>
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#eef2f8] dark:bg-white/10">
          <ChevronRight className="h-3 w-3 text-black/40 dark:text-muted-foreground" />
        </span>
      </div>

      <div className="mt-auto w-full min-w-0">
        <p className="truncate text-[15px] font-bold leading-tight text-[#1c1c2e] dark:text-foreground">
          {title}
        </p>
        {/* Subtitle spans the full card width (no chevron sharing the row) and
            uses a compact size so the one-line description stays fully visible
            on every device without truncating to an ellipsis. */}
        <span className="mt-1.5 block truncate text-[11px] leading-tight text-black/50 dark:text-muted-foreground">
          {subtitle}
        </span>
      </div>
    </button>
  );
}


export function QuickActionsSection({
  title = "Quick actions",
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <h2 className={SECTION_HEADING}>{title}</h2>
        <span className="inline-flex items-center gap-[7px] rounded-full bg-[#eef2f8] px-3 py-1.5 dark:bg-white/10">
          <span className="h-2 w-2 rounded-full bg-[color:var(--app-accent)]" />
          <span className="text-[13px] font-semibold text-black/55 dark:text-muted-foreground">
            Live features
          </span>
        </span>
      </div>
      <div className="grid auto-rows-fr grid-cols-3 gap-2.5">{children}</div>
    </section>
  );
}
