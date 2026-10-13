import Link from "next/link";
import { ArrowRight, type LucideIcon } from "lucide-react";

import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { cn } from "@/lib/utils";

export type AgentCardTone = "finance" | "sage";

const ACCENT_BAR_CLASS_BY_TONE: Record<AgentCardTone, string> = {
  finance: "bg-gradient-to-r from-emerald-500 to-teal-400",
  sage: "bg-gradient-to-r from-violet-500 to-purple-400",
};

const ICON_CLASS_BY_TONE: Record<AgentCardTone, string> = {
  finance: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  sage: "bg-violet-500/12 text-violet-700 dark:text-violet-300",
};

const BORDER_CLASS_BY_TONE: Record<AgentCardTone, string> = {
  finance:
    "border-emerald-500/24 hover:border-emerald-500/50 dark:border-emerald-400/20 dark:hover:border-emerald-300/44",
  sage:
    "border-violet-500/24 hover:border-violet-500/50 dark:border-violet-400/20 dark:hover:border-violet-300/44",
};

const METRIC_TONE_CLASS: Record<AgentCardTone, string> = {
  finance: "text-emerald-700 dark:text-emerald-300",
  sage: "text-violet-700 dark:text-violet-300",
};

const META_DOT_CLASS_BY_TONE: Record<AgentCardTone, string> = {
  finance: "bg-emerald-500",
  sage: "bg-violet-500",
};

/**
 * A "quiet background agent" summary tile for the dashboard's Today
 * section: a live metric, a one-line insight, and when it last checked --
 * as opposed to ModeTile, which just links to a static workflow. Carries
 * a top accent bar and tone-colored metric so it reads as a live widget,
 * not another static launcher tile.
 */
export function AgentCard({
  icon: Icon,
  tone,
  title,
  metricLabel,
  metric,
  insight,
  meta,
  href,
  loading = false,
}: {
  icon: LucideIcon;
  tone: AgentCardTone;
  title: string;
  metricLabel?: string;
  metric?: string | null;
  insight: string;
  meta?: string | null;
  href: string;
  loading?: boolean;
}) {
  return (
    <Link
      href={href}
      aria-label={`Open ${title}`}
      className={cn(
        "group relative isolate flex min-h-[9.5rem] flex-col gap-2.5 overflow-hidden rounded-xl border bg-card/85 p-4 text-left shadow-[0_1px_2px_rgba(15,23,42,0.06)] transition-[background-color,border-color,box-shadow,transform] duration-200 hover:-translate-y-[1px] hover:bg-card hover:shadow-[0_18px_36px_-24px_rgba(15,23,42,0.5)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        BORDER_CLASS_BY_TONE[tone],
      )}
    >
      <span
        className={cn("absolute inset-x-0 top-0 h-[3px]", ACCENT_BAR_CLASS_BY_TONE[tone])}
        aria-hidden
      />
      <MaterialRipple variant="link" effect="glass" className="rounded-xl" />
      <span className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
              ICON_CLASS_BY_TONE[tone],
            )}
          >
            <Icon className="h-4 w-4" aria-hidden />
          </span>
          <span className="truncate text-[15px] font-semibold leading-5 text-foreground">
            {title}
          </span>
        </span>
        <ArrowRight
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-foreground"
          aria-hidden
        />
      </span>

      {metric ? (
        <span className="flex items-baseline gap-1.5">
          <span
            className={cn(
              "text-[1.7rem] font-semibold leading-8 tabular-nums",
              METRIC_TONE_CLASS[tone],
            )}
          >
            {metric}
          </span>
          {metricLabel ? (
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground/70">
              {metricLabel}
            </span>
          ) : null}
        </span>
      ) : null}

      <span className="line-clamp-2 text-sm leading-5 text-muted-foreground">
        {loading ? "Checking…" : insight}
      </span>

      {meta ? (
        <span className="mt-auto flex items-center gap-1.5 text-xs text-muted-foreground/80">
          <span
            className={cn("h-1.5 w-1.5 shrink-0 rounded-full", META_DOT_CLASS_BY_TONE[tone])}
            aria-hidden
          />
          {meta}
        </span>
      ) : null}
    </Link>
  );
}
