"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { SurfaceCard, type SurfaceAccent, type SurfaceTone } from "@/components/app-ui/surfaces";
import { Icon } from "@/lib/morphy-ux/ui";
import { cn } from "@/lib/utils";

type SectionAccent =
  | "neutral"
  | "kai"
  | "ria"
  | "consent"
  | "marketplace"
  | "developers"
  | "success"
  | "warning"
  | "critical"
  | "default"
  | "sky"
  | "emerald"
  | "amber"
  | "rose"
  | "violet";

const ACCENT_STYLES: Record<SectionAccent, {
  eyebrow: string;
  icon: string;
  divider: string;
}> = {
  neutral: {
    eyebrow: "text-muted-foreground",
    icon:
      "border border-black/10 bg-white text-black shadow-[0_10px_28px_-18px_rgba(0,0,0,0.28)] dark:border-white/10 dark:bg-white/8 dark:text-white dark:shadow-none",
    divider: "bg-border/50",
  },
  kai: {
    eyebrow: "text-violet-700 dark:text-violet-300",
    icon: "bg-violet-500/10 text-violet-700 dark:bg-violet-400/10 dark:text-violet-200",
    divider: "bg-violet-300/50 dark:bg-violet-400/30",
  },
  ria: {
    eyebrow: "text-emerald-700 dark:text-emerald-300",
    icon: "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-200",
    divider: "bg-emerald-300/50 dark:bg-emerald-400/30",
  },
  consent: {
    eyebrow: "text-amber-700 dark:text-amber-300",
    icon: "bg-amber-500/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-200",
    divider: "bg-amber-300/50 dark:bg-amber-400/30",
  },
  marketplace: {
    eyebrow: "text-sky-700 dark:text-sky-300",
    icon: "bg-sky-500/10 text-sky-700 dark:bg-sky-400/10 dark:text-sky-200",
    divider: "bg-sky-300/50 dark:bg-sky-400/30",
  },
  developers: {
    eyebrow: "text-rose-700 dark:text-rose-300",
    icon: "bg-rose-500/10 text-rose-700 dark:bg-rose-400/10 dark:text-rose-200",
    divider: "bg-rose-300/50 dark:bg-rose-400/30",
  },
  success: {
    eyebrow: "text-emerald-700 dark:text-emerald-300",
    icon: "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-200",
    divider: "bg-emerald-300/50 dark:bg-emerald-400/30",
  },
  warning: {
    eyebrow: "text-amber-700 dark:text-amber-300",
    icon: "bg-amber-500/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-200",
    divider: "bg-amber-300/50 dark:bg-amber-400/30",
  },
  critical: {
    eyebrow: "text-rose-700 dark:text-rose-300",
    icon: "bg-rose-500/10 text-rose-700 dark:bg-rose-400/10 dark:text-rose-200",
    divider: "bg-rose-300/50 dark:bg-rose-400/30",
  },
  default: {
    eyebrow: "text-muted-foreground",
    icon:
      "border border-black/10 bg-white text-black shadow-[0_10px_28px_-18px_rgba(0,0,0,0.28)] dark:border-white/10 dark:bg-white/8 dark:text-white dark:shadow-none",
    divider: "bg-border/50",
  },
  sky: {
    eyebrow: "text-muted-foreground",
    icon: "bg-[color:var(--app-card-surface-compact)] text-foreground shadow-[var(--shadow-xs)]",
    divider: "bg-border/50",
  },
  emerald: {
    eyebrow: "text-emerald-700 dark:text-emerald-300",
    icon: "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-200",
    divider: "bg-emerald-300/50 dark:bg-emerald-400/30",
  },
  amber: {
    eyebrow: "text-amber-700 dark:text-amber-300",
    icon: "bg-amber-500/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-200",
    divider: "bg-amber-300/50 dark:bg-amber-400/30",
  },
  rose: {
    eyebrow: "text-rose-700 dark:text-rose-300",
    icon: "bg-rose-500/10 text-rose-700 dark:bg-rose-400/10 dark:text-rose-200",
    divider: "bg-rose-300/50 dark:bg-rose-400/30",
  },
  violet: {
    eyebrow: "text-violet-700 dark:text-violet-300",
    icon: "bg-violet-500/10 text-violet-700 dark:bg-violet-400/10 dark:text-violet-200",
    divider: "bg-violet-300/50 dark:bg-violet-400/30",
  },
};

function HeaderLeading({
  icon,
  leading,
  iconClassName,
  iconSize,
}: {
  icon?: LucideIcon;
  leading?: ReactNode;
  iconClassName: string;
  iconSize: "md" | "lg";
}) {
  if (leading) {
    return <div className="shrink-0 self-start">{leading}</div>;
  }

  if (!icon) {
    return null;
  }

  return (
    <div className={cn("self-stretch", iconClassName)}>
      <Icon icon={icon} size={iconSize} />
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  icon,
  leading,
  accent = "default",
  className,
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: LucideIcon;
  leading?: ReactNode;
  accent?: SectionAccent;
  className?: string;
}) {
  const styles = ACCENT_STYLES[accent];
  return (
    <header
      className={cn("space-y-[var(--page-header-stack-gap)]", className)}
      data-slot="page-header"
      data-page-primary="true"
    >
      <div className="flex items-stretch gap-3 sm:gap-4">
        {icon || leading ? (
          <HeaderLeading
            icon={icon}
            leading={leading}
            iconSize="lg"
            iconClassName={cn(
              "flex w-10 shrink-0 items-center justify-center rounded-[var(--app-card-radius-feature)] px-2 py-3 sm:w-12 sm:px-3",
              styles.icon
            )}
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <div
            className="flex flex-col gap-[var(--page-header-row-gap)] sm:flex-row sm:items-center sm:justify-between"
            data-slot="page-header-row"
          >
            <div className="min-w-0 flex-1 space-y-[var(--page-header-copy-gap)]">
              {eyebrow ? (
                <p
                  className={cn(
                    "text-xs font-semibold uppercase tracking-[0.24em]",
                    styles.eyebrow
                  )}
                >
                  {eyebrow}
                </p>
              ) : null}
              <h1 className="text-[clamp(1.28rem,3vw,1.75rem)] font-semibold tracking-tight leading-[1.1] text-foreground">
                {title}
              </h1>
              {description ? (
                <div
                  className="max-w-2xl line-clamp-2 text-sm leading-6 text-muted-foreground sm:line-clamp-none"
                  data-slot="page-header-description"
                >
                  {description}
                </div>
              ) : null}
            </div>
            {actions ? (
              <div
                className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0 sm:justify-end sm:self-center"
                data-slot="page-header-actions"
              >
                {actions}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <div className={cn("h-px w-full", styles.divider)} />
    </header>
  );
}

export function SectionHeader({
  eyebrow,
  title,
  description,
  actions,
  icon,
  leading,
  accent = "default",
  className,
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: LucideIcon;
  leading?: ReactNode;
  accent?: SectionAccent;
  className?: string;
}) {
  const styles = ACCENT_STYLES[accent];
  return (
    <div className={cn("space-y-[var(--section-header-stack-gap)]", className)}>
      <div className="flex items-stretch gap-3">
        {icon || leading ? (
          <HeaderLeading
            icon={icon}
            leading={leading}
            iconSize="md"
            iconClassName={cn(
              "flex w-9 shrink-0 items-center justify-center rounded-[var(--app-card-radius-feature)] px-2 py-2.5 sm:w-10 sm:px-2.5",
              styles.icon
            )}
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <div
            className="flex flex-col gap-[var(--section-header-stack-gap)] sm:flex-row sm:items-center sm:justify-between"
            data-slot="section-header-row"
          >
            <div className="min-w-0 flex-1 space-y-[var(--section-header-copy-gap)]">
              {eyebrow ? (
                <p className={cn("text-xs font-semibold uppercase tracking-[0.2em]", styles.eyebrow)}>
                  {eyebrow}
                </p>
              ) : null}
              <h2 className="text-sm font-semibold tracking-tight text-foreground sm:text-base">
                {title}
              </h2>
              {description ? (
                <div
                  className="line-clamp-2 text-sm leading-6 text-muted-foreground sm:line-clamp-none"
                  data-slot="section-header-description"
                >
                  {description}
                </div>
              ) : null}
            </div>
            {actions ? (
              <div
                className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0 sm:justify-end sm:self-center"
                data-slot="section-header-actions"
              >
                {actions}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <div className={cn("h-px w-full", styles.divider)} />
    </div>
  );
}

export function ContentSurface({
  children,
  className,
  accent = "none",
  tone = "default",
}: {
  children: ReactNode;
  className?: string;
  accent?: SurfaceAccent;
  tone?: SurfaceTone;
}) {
  return (
    <SurfaceCard tone={tone} accent={accent} className={className}>
      {children}
    </SurfaceCard>
  );
}
