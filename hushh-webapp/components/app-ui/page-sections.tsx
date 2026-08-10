"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { SurfaceCard, type SurfaceAccent, type SurfaceTone } from "@/components/app-ui/surfaces";
import {
  AgentTitle,
  CardTitle,
  PageSubtitle,
  PageTitle,
  SectionLabel,
} from "@/components/app-ui/typography";
import { Icon } from "@/lib/morphy-ux/ui";
import { cn } from "@/lib/utils";

type SectionAccent =
  | "neutral"
  | "kai"
  | "ria"
  | "consent"
  | "marketplace"
  | "developers"
  | "research"
  | "location"
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
      "bg-[color:var(--app-icon-tile-background)] text-[color:var(--app-icon-tile-foreground)] shadow-none",
    divider: "bg-[color:var(--app-separator)]",
  },
  kai: {
    eyebrow: "text-muted-foreground",
    icon:
      "bg-[color:var(--app-icon-tile-background)] text-[color:var(--app-icon-tile-foreground)] shadow-none",
    divider: "bg-[color:var(--app-separator)]",
  },
  ria: {
    // RIA sub-agent = Apple-clean gold. Var-driven so it flips to the DS gold
    // (#C8923A) inside body[data-persona-surface="ria"] and stays the Foundation
    // gold elsewhere. Mirrors the marketplace accent entry.
    eyebrow: "text-muted-foreground",
    icon:
      "bg-[color:var(--app-icon-tile-background)] text-[color:var(--app-icon-tile-foreground)] shadow-none",
    divider: "bg-[color:var(--app-separator)]",
  },
  consent: {
    eyebrow: "text-muted-foreground",
    icon:
      "bg-[color:var(--app-icon-tile-background)] text-[color:var(--app-icon-tile-foreground)] shadow-none",
    divider: "bg-[color:var(--app-separator)]",
  },
  marketplace: {
    eyebrow: "text-muted-foreground",
    icon:
      "bg-[color:var(--app-icon-tile-background)] text-[color:var(--app-icon-tile-foreground)] shadow-none",
    divider: "bg-[color:var(--app-separator)]",
  },
  developers: {
    eyebrow: "text-muted-foreground",
    icon:
      "bg-[color:var(--app-icon-tile-background)] text-[color:var(--app-icon-tile-foreground)] shadow-none",
    divider: "bg-[color:var(--app-separator)]",
  },
  research: {
    eyebrow: "text-muted-foreground",
    icon:
      "bg-[color:var(--app-icon-tile-background)] text-[color:var(--app-icon-tile-foreground)] shadow-none",
    divider: "bg-[color:var(--app-separator)]",
  },
  location: {
    eyebrow: "text-muted-foreground",
    icon: "bg-[color:var(--app-accent)] text-white shadow-none",
    divider: "bg-[color:var(--app-separator)]",
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
      "bg-[color:var(--app-icon-tile-background)] text-[color:var(--app-icon-tile-foreground)] shadow-none",
    divider: "bg-[color:var(--app-separator)]",
  },
  sky: {
    eyebrow: "text-muted-foreground",
    icon:
      "bg-[color:var(--app-icon-tile-background)] text-[color:var(--app-icon-tile-foreground)] shadow-none",
    divider: "bg-[color:var(--app-separator)]",
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
  actionsInlineMobile = false,
  descriptionFullWidth = false,
  icon,
  leading,
  accent = "default",
  titleRole = "page",
  className,
  testId = "page-header",
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  actionsInlineMobile?: boolean;
  descriptionFullWidth?: boolean;
  icon?: LucideIcon;
  leading?: ReactNode;
  accent?: SectionAccent;
  titleRole?: "page" | "agent";
  className?: string;
  testId?: string;
}) {
  const styles = ACCENT_STYLES[accent];
  const TitleComponent = titleRole === "agent" ? AgentTitle : PageTitle;
  return (
    <header
      className={cn("space-y-[var(--page-header-stack-gap)]", className)}
      data-slot="page-header"
      data-page-primary="true"
      data-testid={testId}
    >
      <div className="flex items-stretch gap-3 sm:gap-4">
        {icon || leading ? (
          <HeaderLeading
            icon={icon}
            leading={leading}
            iconSize="lg"
            iconClassName={cn(
              "flex shrink-0 items-center justify-center",
              titleRole === "agent"
                ? "h-11 w-11 rounded-[10px]"
                : "h-[34px] w-[34px] rounded-[8px]",
              styles.icon
            )}
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              "gap-[var(--page-header-row-gap)] sm:flex-row sm:items-center sm:justify-between",
              actionsInlineMobile ? "flex items-start justify-between" : "flex flex-col"
            )}
            data-slot="page-header-row"
          >
            <div className="min-w-0 flex-1 space-y-[var(--page-header-copy-gap)]">
              {eyebrow ? (
                <SectionLabel
                  as="p"
                  className={cn(
                    styles.eyebrow
                  )}
                  data-slot="page-header-eyebrow"
                >
                  {eyebrow}
                </SectionLabel>
              ) : null}
              <TitleComponent>
                {title}
              </TitleComponent>
              {description && !descriptionFullWidth ? (
                <PageSubtitle
                  as="div"
                  className="max-w-2xl"
                  data-slot="page-header-description"
                >
                  {description}
                </PageSubtitle>
              ) : null}
            </div>
            {actions ? (
              <div
                className={cn(
                  "flex flex-wrap items-center gap-2 sm:w-auto sm:shrink-0 sm:justify-end sm:self-center",
                  actionsInlineMobile ? "w-auto shrink-0 justify-end self-start" : "w-full"
                )}
                data-slot="page-header-actions"
              >
                {actions}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {description && descriptionFullWidth ? (
        <PageSubtitle
          as="div"
          data-slot="page-header-description"
        >
          {description}
        </PageSubtitle>
      ) : null}
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
  testId = "section-header",
  id,
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: LucideIcon;
  leading?: ReactNode;
  accent?: SectionAccent;
  className?: string;
  testId?: string;
  id?: string;
}) {
  const styles = ACCENT_STYLES[accent];
  return (
    <div
      id={id}
      className={cn(
        // Design-system default: a little extra vertical breathing room around
        // every section heading (Workflows, Memory, Access, etc.).
        "space-y-[var(--section-header-stack-gap)] py-1 sm:py-1.5",
        className,
      )}
      data-testid={testId}
    >
      <div className="flex items-stretch gap-3">
        {icon || leading ? (
          <HeaderLeading
            icon={icon}
            leading={leading}
            iconSize="md"
            iconClassName={cn(
              "flex h-[29px] w-[29px] shrink-0 items-center justify-center rounded-[7px]",
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
                <SectionLabel as="p" className={styles.eyebrow}>
                  {eyebrow}
                </SectionLabel>
              ) : null}
              <CardTitle
                as="div"
                role="heading"
                aria-level={2}
                data-slot="section-header-title"
              >
                {title}
              </CardTitle>
              {description ? (
                <PageSubtitle
                  as="div"
                  data-slot="section-header-description"
                >
                  {description}
                </PageSubtitle>
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
      <div className={cn("h-px w-full", styles.divider)} aria-hidden="true" />
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
