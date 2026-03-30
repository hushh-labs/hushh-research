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
export type SurfaceAccent = "none" | "sky" | "emerald" | "amber" | "violet" | "rose";

type SurfaceCardProps = Omit<CardProps, "effect" | "preset" | "showRipple" | "variant"> & {
  tone?: SurfaceTone;
  accent?: SurfaceAccent;
};

export const SurfaceCard = React.forwardRef<HTMLDivElement, SurfaceCardProps>(
  ({ tone = "default", accent = "none", className, children, ...props }, ref) => (
    <Card
      ref={ref}
      data-surface-tone={tone}
      data-surface-accent={accent}
      preset={tone === "feature" ? "surface-feature" : "surface"}
      variant="none"
      effect="glass"
      showRipple={false}
      glassAccent={tone === "feature" ? "balanced" : "soft"}
      className={cn("min-w-0 overflow-visible", className)}
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
    className={cn("px-4 pb-2 pt-4 sm:px-5 sm:pb-2.5 sm:pt-5", className)}
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
    className={cn("px-4 pb-4 pt-0 sm:px-5 sm:pb-5", className)}
    {...props}
  />
));

SurfaceCardContent.displayName = "SurfaceCardContent";

export function SurfaceInset({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-[20px] border border-[color:var(--app-card-border-standard)] bg-[var(--app-card-surface-compact)] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
        className
      )}
      {...props}
    />
  );
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
      <div className="rounded-[20px] border border-dashed border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] p-4 text-sm text-muted-foreground">
        {detail}
      </div>
    </ChartSurfaceCard>
  );
}
