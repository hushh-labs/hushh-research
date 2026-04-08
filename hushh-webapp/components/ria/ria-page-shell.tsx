"use client";

import type { ComponentPropsWithoutRef, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { BriefcaseBusiness, ShieldCheck, TriangleAlert } from "lucide-react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import {
  PageHeader,
  SectionHeader,
} from "@/components/app-ui/page-sections";
import {
  SurfaceCard,
  SurfaceInset,
  SurfaceStack,
  type SurfaceAccent,
  type SurfaceTone,
} from "@/components/app-ui/surfaces";
import { cn } from "@/lib/utils";

export function RiaPageShell({
  eyebrow,
  title,
  description,
  actions,
  icon = BriefcaseBusiness,
  statusPanel,
  children,
  className,
  headerClassName,
  contentClassName,
  stackClassName,
  nativeTest,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  icon?: LucideIcon;
  statusPanel?: ReactNode;
  children: ReactNode;
  className?: string;
  headerClassName?: string;
  contentClassName?: string;
  stackClassName?: string;
  nativeTest?: {
    routeId: string;
    marker: string;
    authState: "authenticated" | "public" | "anonymous" | "redirecting" | "pending";
    dataState:
      | "booting"
      | "loading"
      | "loaded"
      | "empty-valid"
      | "unavailable-valid"
      | "redirect-valid"
      | "error";
    errorCode?: string | null;
    errorMessage?: string | null;
  };
}) {
  return (
    <AppPageShell
      as="main"
      width="standard"
      className={cn("pb-28", className)}
      nativeTest={nativeTest}
    >
      <AppPageHeaderRegion className={cn("pt-2 sm:pt-3", headerClassName)}>
        <PageHeader
          eyebrow={eyebrow}
          title={title}
          description={description}
          actions={actions}
          icon={icon}
          accent="ria"
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion className={contentClassName}>
        <SurfaceStack className={stackClassName}>
          {statusPanel ? <div>{statusPanel}</div> : null}
          {children}
        </SurfaceStack>
      </AppPageContentRegion>
    </AppPageShell>
  );
}

export function RiaSurface({
  children,
  className,
  accent = "none",
  tone = "default",
  ...props
}: ComponentPropsWithoutRef<typeof SurfaceCard> & {
  accent?: SurfaceAccent;
  tone?: SurfaceTone;
}) {
  return (
    <SurfaceCard tone={tone} accent={accent} className={className} {...props}>
      {children}
    </SurfaceCard>
  );
}

export function RiaCompatibilityState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <section className="space-y-3">
      <SectionHeader
        eyebrow="Compatibility Mode"
        title={title}
        description={description}
        icon={TriangleAlert}
      />
      <RiaSurface tone="warning" className="border-dashed">
        <p className="text-sm leading-6 text-muted-foreground">
          This surface is running in degraded compatibility mode until the full IAM contract is
          available in the active environment.
        </p>
      </RiaSurface>
    </section>
  );
}

export function MetricTile({
  label,
  value,
  helper,
}: {
  label: string;
  value: string;
  helper?: string;
}) {
  return (
    <SurfaceInset className="p-4">
      <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground">{value}</p>
      {helper ? <p className="mt-1 text-xs text-muted-foreground">{helper}</p> : null}
    </SurfaceInset>
  );
}

type RiaStatusTone = "neutral" | "warning" | "success" | "critical";

type RiaStatusItem = {
  label: string;
  value: string;
  helper?: string;
  tone?: RiaStatusTone;
};

const STATUS_TONE_STYLES: Record<RiaStatusTone, string> = {
  neutral: "border-border/60 bg-background/75 text-foreground",
  warning: "border-primary/20 bg-primary/6 text-foreground",
  success: "border-emerald-500/20 bg-emerald-500/8 text-foreground",
  critical: "border-red-500/20 bg-red-500/8 text-foreground",
};

export function RiaStatusPanel({
  title,
  description,
  items,
  actions,
  className,
  eyebrow = "Status",
  dataTestId,
}: {
  title: string;
  description?: string;
  items: RiaStatusItem[];
  actions?: ReactNode;
  className?: string;
  eyebrow?: string;
  dataTestId?: string;
}) {
  return (
    <RiaSurface
      accent="sky"
      className={cn("space-y-5 p-5 sm:p-6", className)}
      data-testid={dataTestId}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[18px] border border-sky-200/80 bg-sky-500/[0.08] text-sky-700 shadow-[0_18px_38px_-28px_rgba(56,189,248,0.38)] dark:border-sky-400/20 dark:bg-sky-400/10 dark:text-sky-200 dark:shadow-[0_22px_40px_-28px_rgba(56,189,248,0.22)]">
              <ShieldCheck className="h-4 w-4" />
            </span>
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-sky-700/90 dark:text-sky-300/90">
              {eyebrow}
            </p>
          </div>
          <div className="space-y-1">
            <h2 className="text-[14px] font-semibold tracking-tight leading-[1.08] text-foreground sm:text-[16px]">
              {title}
            </h2>
            {description ? (
              <p className="max-w-2xl text-[13px] leading-5 text-muted-foreground sm:text-[14px]">
                {description}
              </p>
            ) : null}
          </div>
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
      </div>

      <div className="grid gap-px overflow-hidden rounded-[20px] bg-border/60 sm:grid-cols-2 xl:grid-cols-4">
        {items.map((item) => (
          <div
            key={`${item.label}-${item.value}`}
            className={cn(
              "px-4 py-3.5 sm:px-5",
              STATUS_TONE_STYLES[item.tone || "neutral"]
            )}
          >
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              {item.label}
            </p>
            <p className="mt-1.5 text-[17px] font-semibold tracking-tight text-foreground">{item.value}</p>
            {item.helper ? <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{item.helper}</p> : null}
          </div>
        ))}
      </div>
    </RiaSurface>
  );
}
