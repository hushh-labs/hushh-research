"use client";

/**
 * One Location redesign — Quick Actions grid (Now tab).
 *
 * PRESENTATION ONLY. A single reusable `QuickActionCard` renders every tile in
 * the "Quick actions" block so the six location shortcuts (Check-In, SOS,
 * Drive To, Pick Me Up, Meeting, Safe Arrival) stay visually identical and
 * behaviourally consistent. Cards are prop-driven: they render an icon tile,
 * title + subtitle, an optional "Coming soon" state, and delegate taps to the
 * handler passed in by the hub. No business logic, no data fetching here.
 */

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { SECTION_HEADING } from "./tokens";

export type QuickActionTone =
  | "green"
  | "red"
  | "blue"
  | "amber"
  | "violet"
  | "slate";

/**
 * Per-tone palette for the icon tile. Uses soft tinted surfaces + a saturated
 * foreground so each action reads instantly while still matching the app-wide
 * calm, premium aesthetic (no harsh full-bleed colours).
 */
const TONE_STYLES: Record<
  QuickActionTone,
  { tile: string; icon: string; glow: string }
> = {
  green: {
    tile: "bg-emerald-500/12 dark:bg-emerald-400/15",
    icon: "text-emerald-600 dark:text-emerald-300",
    glow: "group-hover:shadow-[0_10px_30px_-12px_rgba(16,185,129,0.55)]",
  },
  red: {
    tile: "bg-red-500/12 dark:bg-red-400/15",
    icon: "text-red-600 dark:text-red-300",
    glow: "group-hover:shadow-[0_10px_30px_-12px_rgba(239,68,68,0.55)]",
  },
  blue: {
    tile: "bg-sky-500/12 dark:bg-sky-400/15",
    icon: "text-sky-600 dark:text-sky-300",
    glow: "group-hover:shadow-[0_10px_30px_-12px_rgba(14,165,233,0.5)]",
  },
  amber: {
    tile: "bg-amber-500/14 dark:bg-amber-400/15",
    icon: "text-amber-600 dark:text-amber-300",
    glow: "group-hover:shadow-[0_10px_30px_-12px_rgba(245,158,11,0.5)]",
  },
  violet: {
    tile: "bg-violet-500/12 dark:bg-violet-400/15",
    icon: "text-violet-600 dark:text-violet-300",
    glow: "group-hover:shadow-[0_10px_30px_-12px_rgba(139,92,246,0.5)]",
  },
  slate: {
    tile: "bg-slate-500/10 dark:bg-white/10",
    icon: "text-slate-600 dark:text-slate-300",
    glow: "group-hover:shadow-[0_10px_30px_-12px_rgba(100,116,139,0.45)]",
  },
};

export type QuickActionCardProps = {
  icon: ReactNode;
  title: string;
  subtitle: string;
  tone?: QuickActionTone;
  onClick?: () => void;
  /** Renders the muted, non-interactive "Coming soon" treatment. */
  comingSoon?: boolean;
  /** Disable interaction without the coming-soon styling (e.g. temporary). */
  disabled?: boolean;
  /** Optional accent badge in the top-right corner (e.g. "Ready"). */
  badge?: ReactNode;
};

export function QuickActionCard({
  icon,
  title,
  subtitle,
  tone = "slate",
  onClick,
  comingSoon = false,
  disabled = false,
  badge,
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
        "group relative flex min-h-[128px] w-full flex-col justify-between overflow-hidden rounded-[20px] border p-4 text-left transition-all duration-200",
        "border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)]",
        "shadow-[0_1px_2px_rgba(0,0,0,0.04),0_10px_24px_-16px_rgba(15,23,42,0.28)]",
        interactive
          ? cn(
              "cursor-pointer hover:-translate-y-0.5 hover:border-[color:var(--app-card-border-standard)] active:translate-y-0 active:scale-[0.98]",
              palette.glow,
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#007aff]/40",
            )
          : "cursor-not-allowed",
        comingSoon && "opacity-70",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className={cn(
            "flex h-12 w-12 items-center justify-center rounded-[16px] transition-transform duration-200",
            palette.tile,
            palette.icon,
            interactive && "group-hover:scale-105",
          )}
        >
          {icon}
        </span>
        {badge ? <span className="shrink-0">{badge}</span> : null}
      </div>

      <div className="mt-3 min-w-0">
        <p className="truncate text-[15px] font-semibold leading-tight text-foreground">
          {title}
        </p>
        {comingSoon ? (
          <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-muted/70 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Coming soon
          </span>
        ) : (
          <p className="mt-0.5 truncate text-[13px] font-medium text-muted-foreground">
            {subtitle}
          </p>
        )}
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
      </div>
      <div className="grid grid-cols-2 gap-3">{children}</div>
    </section>
  );
}
