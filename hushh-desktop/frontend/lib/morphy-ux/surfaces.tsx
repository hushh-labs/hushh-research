"use client";

import * as React from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  type CardProps,
} from "@/lib/morphy-ux/card";
import { cn } from "@/lib/utils";

export type SurfaceTone = "default" | "feature" | "warning" | "success" | "critical";
export type SurfaceAccent =
  | "none"
  | "neutral"
  | "kai"
  | "ria"
  | "consent"
  | "marketplace"
  | "developers"
  | "sky"
  | "emerald"
  | "amber"
  | "violet"
  | "rose"
  | "default";

const SURFACE_TONE_CLASSNAMES: Record<SurfaceTone, string> = {
  default: "",
  feature:
    "!bg-[var(--app-card-surface-hero)] !shadow-[var(--app-card-shadow-feature)]",
  warning:
    "border-[color:color-mix(in_srgb,var(--app-card-border-strong)_76%,rgb(245_158_11)_24%)]",
  success:
    "border-[color:color-mix(in_srgb,var(--app-card-border-strong)_76%,rgb(16_185_129)_24%)]",
  critical:
    "border-[color:color-mix(in_srgb,var(--app-card-border-strong)_72%,rgb(244_63_94)_28%)]",
};

const SURFACE_ACCENT_CLASSNAMES: Record<SurfaceAccent, string> = {
  none: "",
  neutral: "",
  kai: "",
  ria: "",
  consent: "",
  marketplace: "",
  developers: "",
  sky: "",
  emerald: "",
  amber: "",
  violet: "",
  rose: "",
  default: "",
};

export const surfaceDataTableShellClassName = cn(
  "overflow-x-auto overflow-y-hidden rounded-[var(--app-card-radius-standard)] border",
  "border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)]",
  "shadow-[var(--app-card-shadow-standard)]"
);

export const surfaceInteractiveShellClassName = cn(
  "rounded-[var(--app-card-radius-feature)] border border-transparent",
  "bg-[color:var(--app-card-surface-default-solid)] shadow-[var(--app-card-shadow-standard)]",
  "transition-[background-color,border-color,box-shadow] duration-200 ease-out",
  "hover:bg-[color:var(--app-card-surface-default-solid)] hover:shadow-[var(--app-card-shadow-feature)]"
);

export const surfaceInsetClassName = cn(
  "rounded-[var(--app-card-radius-compact)] border border-transparent",
  "bg-[color:var(--app-card-surface-compact)] shadow-[var(--shadow-xs)]"
);

type SurfaceCardProps = Omit<CardProps, "effect" | "preset" | "showRipple" | "variant"> & {
  tone?: SurfaceTone;
  accent?: SurfaceAccent;
};

export const SurfaceCard = React.forwardRef<HTMLDivElement, SurfaceCardProps>(
  ({ tone = "default", accent = "none", className, children, ...props }, ref) => (
    <Card
      ref={ref}
      type="apple"
      data-surface-tone={tone}
      data-surface-accent={accent}
      variant="none"
      showRipple={false}
      className={cn(
        "min-w-0 overflow-visible",
        SURFACE_TONE_CLASSNAMES[tone],
        SURFACE_ACCENT_CLASSNAMES[accent],
        className
      )}
      {...props}
    >
      {children}
    </Card>
  )
);

SurfaceCard.displayName = "SurfaceCard";

export const SurfaceCardHeader = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof CardHeader>
>(({ className, ...props }, ref) => (
  <CardHeader
    ref={ref}
    className={cn(
      "px-[var(--surface-card-header-px)] pb-[var(--surface-card-header-pb)] pt-[var(--surface-card-header-pt)]",
      className
    )}
    {...props}
  />
));

SurfaceCardHeader.displayName = "SurfaceCardHeader";

export const SurfaceCardTitle = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof CardTitle>
>(({ className, ...props }, ref) => (
  <CardTitle
    ref={ref}
    className={cn("text-sm font-semibold tracking-tight sm:text-[15px]", className)}
    {...props}
  />
));

SurfaceCardTitle.displayName = "SurfaceCardTitle";

export const SurfaceCardDescription = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof CardDescription>
>(({ className, ...props }, ref) => (
  <CardDescription
    ref={ref}
    className={cn("text-[11px] leading-4 text-muted-foreground sm:text-[12px]", className)}
    {...props}
  />
));

SurfaceCardDescription.displayName = "SurfaceCardDescription";

export const SurfaceCardContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof CardContent>
>(({ className, ...props }, ref) => (
  <CardContent
    ref={ref}
    className={cn(
      "px-[var(--surface-card-content-px)] pb-[var(--surface-card-content-pb)] pt-0",
      className
    )}
    {...props}
  />
));

SurfaceCardContent.displayName = "SurfaceCardContent";

export function SurfaceInset({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn(surfaceInsetClassName, "p-[var(--surface-inset-p)]", className)} {...props} />;
}

export function SurfaceStack({
  compact = false,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  compact?: boolean;
}) {
  return (
    <div
      className={cn("surface-stack", compact && "surface-stack-compact", className)}
      {...props}
    />
  );
}

export function SurfaceDataTableShell({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn(surfaceDataTableShellClassName, className)} {...props} />;
}

type ChartSurfaceCardProps = Omit<SurfaceCardProps, "title"> & {
  title: React.ReactNode;
  description?: React.ReactNode;
  headerClassName?: string;
  contentClassName?: string;
};

export function ChartSurfaceCard({
  title,
  description,
  children,
  className,
  headerClassName,
  contentClassName,
  tone = "default",
  accent = "none",
  ...props
}: ChartSurfaceCardProps) {
  return (
    <SurfaceCard tone={tone} accent={accent} className={className} {...props}>
      <SurfaceCardHeader className={headerClassName}>
        <SurfaceCardTitle>{title}</SurfaceCardTitle>
        {description ? <SurfaceCardDescription>{description}</SurfaceCardDescription> : null}
      </SurfaceCardHeader>
      <SurfaceCardContent className={contentClassName}>{children}</SurfaceCardContent>
    </SurfaceCard>
  );
}

type FallbackSurfaceCardProps = Omit<SurfaceCardProps, "title"> & {
  title: React.ReactNode;
  detail: React.ReactNode;
  contentClassName?: string;
};

export function FallbackSurfaceCard({
  title,
  detail,
  className,
  contentClassName,
  tone = "default",
  accent = "none",
  ...props
}: FallbackSurfaceCardProps) {
  return (
    <ChartSurfaceCard
      title={title}
      tone={tone}
      accent={accent}
      className={className}
      contentClassName={cn("space-y-0", contentClassName)}
      {...props}
    >
      <div
        className={cn(
          surfaceInsetClassName,
          "border-dashed p-4 text-sm text-muted-foreground"
        )}
      >
        {detail}
      </div>
    </ChartSurfaceCard>
  );
}
