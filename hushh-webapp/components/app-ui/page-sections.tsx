"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { SurfaceCard, type SurfaceAccent, type SurfaceTone } from "@/components/app-ui/surfaces";
import { Icon } from "@/lib/morphy-ux/ui";
import { cn } from "@/lib/utils";

type SectionAccent =
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
  default: {
    eyebrow: "text-muted-foreground/88",
    icon: "border-border/70 bg-background/90 text-foreground shadow-[0_18px_38px_-28px_rgba(15,23,42,0.24)] dark:shadow-[0_22px_40px_-30px_rgba(0,0,0,0.5)]",
    divider: "bg-border/82 dark:bg-border/72",
  },
  sky: {
    eyebrow: "text-sky-700/90 dark:text-sky-300/90",
    icon: "border-sky-200/80 bg-sky-500/[0.08] text-sky-700 shadow-[0_18px_38px_-28px_rgba(56,189,248,0.38)] dark:border-sky-400/20 dark:bg-sky-400/10 dark:text-sky-200 dark:shadow-[0_22px_40px_-28px_rgba(56,189,248,0.22)]",
    divider: "bg-sky-300/82 dark:bg-sky-400/42",
  },
  emerald: {
    eyebrow: "text-emerald-700/90 dark:text-emerald-300/90",
    icon: "border-emerald-200/80 bg-emerald-500/[0.08] text-emerald-700 shadow-[0_18px_38px_-28px_rgba(16,185,129,0.34)] dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-200 dark:shadow-[0_22px_40px_-28px_rgba(16,185,129,0.22)]",
    divider: "bg-emerald-300/78 dark:bg-emerald-400/38",
  },
  amber: {
    eyebrow: "text-amber-700/92 dark:text-amber-300/92",
    icon: "border-amber-200/80 bg-amber-500/[0.08] text-amber-700 shadow-[0_18px_38px_-28px_rgba(245,158,11,0.34)] dark:border-amber-400/22 dark:bg-amber-400/10 dark:text-amber-200 dark:shadow-[0_22px_40px_-28px_rgba(245,158,11,0.22)]",
    divider: "bg-amber-300/78 dark:bg-amber-400/38",
  },
  rose: {
    eyebrow: "text-rose-700/90 dark:text-rose-300/90",
    icon: "border-rose-200/80 bg-rose-500/[0.08] text-rose-700 shadow-[0_18px_38px_-28px_rgba(244,63,94,0.34)] dark:border-rose-400/20 dark:bg-rose-400/10 dark:text-rose-200 dark:shadow-[0_22px_40px_-28px_rgba(244,63,94,0.22)]",
    divider: "bg-rose-300/78 dark:bg-rose-400/38",
  },
  violet: {
    eyebrow: "text-violet-700/90 dark:text-violet-300/90",
    icon: "border-violet-200/80 bg-violet-500/[0.08] text-violet-700 shadow-[0_18px_38px_-28px_rgba(139,92,246,0.34)] dark:border-violet-400/20 dark:bg-violet-400/10 dark:text-violet-200 dark:shadow-[0_22px_40px_-28px_rgba(139,92,246,0.22)]",
    divider: "bg-violet-300/78 dark:bg-violet-400/38",
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
    return <div className="shrink-0 self-center">{leading}</div>;
  }

  if (!icon) {
    return null;
  }

  return (
    <span className={iconClassName}>
      <Icon icon={icon} size={iconSize} />
    </span>
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
      <div className="flex flex-col gap-[var(--page-header-row-gap)] lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-3xl min-w-0 space-y-[var(--page-header-copy-gap)]">
          <div className="flex items-center gap-3 sm:gap-4">
            <HeaderLeading
              icon={icon}
              leading={leading}
              iconSize="lg"
              iconClassName={cn(
                "inline-flex h-10 w-10 shrink-0 self-center items-center justify-center rounded-[18px] border sm:h-11 sm:w-11 sm:rounded-[20px]",
                styles.icon
              )}
            />
            <div className="min-w-0 space-y-1">
              {eyebrow ? (
                <p
                  className={cn(
                    "text-[10px] font-semibold uppercase tracking-[0.28em]",
                    styles.eyebrow
                  )}
                >
                  {eyebrow}
                </p>
              ) : null}
              <h1 className="text-[clamp(1.28rem,3vw,1.95rem)] font-semibold tracking-tight leading-[1.05] text-foreground">
                {title}
              </h1>
            </div>
          </div>
          {description ? (
            <div className="max-w-2xl text-[13px] leading-5 text-muted-foreground sm:text-[14px]">
              {description}
            </div>
          ) : null}
        </div>
        {actions ? (
          <div className="flex flex-wrap gap-[var(--page-header-actions-gap)]">{actions}</div>
        ) : null}
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
      <div className="flex flex-col gap-[var(--section-header-row-gap)] sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-[var(--section-header-copy-gap)]">
          <div className="flex items-center gap-2.5 sm:gap-3">
            <HeaderLeading
              icon={icon}
              leading={leading}
              iconSize="md"
              iconClassName={cn(
                "inline-flex h-9 w-9 shrink-0 self-center items-center justify-center rounded-[16px] border sm:h-10 sm:w-10 sm:rounded-[18px]",
                styles.icon
              )}
            />
            <div className="min-w-0 space-y-1">
              {eyebrow ? (
                <p
                  className={cn(
                    "text-[10px] font-semibold uppercase tracking-[0.22em]",
                    styles.eyebrow
                  )}
                >
                  {eyebrow}
                </p>
              ) : null}
              <h2 className="text-[14px] font-semibold tracking-tight leading-[1.08] text-foreground sm:text-[16px]">
                {title}
              </h2>
            </div>
          </div>
          {description ? (
            <div className="text-[13px] leading-5 text-muted-foreground sm:text-[14px]">
              {description}
            </div>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap gap-[var(--section-header-actions-gap)]">
            {actions}
          </div>
        ) : null}
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
