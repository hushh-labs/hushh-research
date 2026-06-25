"use client";

/**
 * One Location redesign — shared presentational primitives.
 *
 * PRESENTATION ONLY. Every component here is prop-driven and stateless w.r.t.
 * business logic. Typography matches the app-wide system: titles use
 * `font-semibold` + the semantic Tailwind size scale (mapped to the Apple-HIG
 * --foundation-* tokens) with the default body font — exactly like
 * SurfaceCardTitle — so the Location feature looks identical to every other page.
 */

import type { ReactNode } from "react";
import { AlertTriangle, ChevronRight, ShieldCheck } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  AVATAR_BUBBLE,
  CARD_SURFACE,
  EYEBROW,
  MUTED_TEXT,
  PILL_LIVE,
  PILL_NEUTRAL,
  PILL_PENDING,
  PILL_READY,
  SCREEN_TITLE,
  SECTION_HEADING,
  SUBCARD_SURFACE,
  TRUST_SURFACE,
  WARNING_SURFACE,
} from "./tokens";

/* ------------------------------------------------------------------ */
/* Header                                                             */
/* ------------------------------------------------------------------ */

export function LocationHeader({
  title,
  subtitle,
  trailing,
}: {
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className={SCREEN_TITLE}>{title}</h1>
        {subtitle ? <p className={cn(MUTED_TEXT, "mt-1")}>{subtitle}</p> : null}
      </div>
      {trailing ? <div className="shrink-0">{trailing}</div> : null}
    </header>
  );
}

/** Full-screen focused task-flow header (no local tabs in flows). */
export function TaskFlowHeader({
  eyebrow,
  title,
  description,
  onBack,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  onBack?: () => void;
}) {
  return (
    <header className="space-y-1.5">
      <div className="flex items-center gap-2">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="-ml-1 flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            aria-label="Back"
          >
            <ChevronRight className="h-5 w-5 rotate-180" />
          </button>
        ) : null}
        {eyebrow ? <p className={EYEBROW}>{eyebrow}</p> : null}
      </div>
      <h1 className={SCREEN_TITLE}>{title}</h1>
      {description ? <p className={MUTED_TEXT}>{description}</p> : null}
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* Generic building blocks                                            */
/* ------------------------------------------------------------------ */

export function StatusPill({
  tone = "neutral",
  children,
  className,
}: {
  tone?: "ready" | "pending" | "live" | "neutral";
  children: ReactNode;
  className?: string;
}) {
  const palette =
    tone === "ready"
      ? PILL_READY
      : tone === "pending"
        ? PILL_PENDING
        : tone === "live"
          ? PILL_LIVE
          : PILL_NEUTRAL;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold",
        palette,
        className,
      )}
    >
      {tone === "live" ? (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
      ) : null}
      {children}
    </span>
  );
}

export function Avatar({
  initials,
  size = 36,
}: {
  initials: string;
  size?: number;
}) {
  return (
    <span
      className={AVATAR_BUBBLE}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {initials}
    </span>
  );
}

export function SectionCard({
  title,
  description,
  action,
  children,
  className,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn(CARD_SURFACE, "p-4", className)}>
      {(title || action) && (
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title ? <h2 className={SECTION_HEADING}>{title}</h2> : null}
            {description ? (
              <p className={cn(MUTED_TEXT, "mt-0.5")}>{description}</p>
            ) : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      )}
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Privacy status (Now hub)                                           */
/* ------------------------------------------------------------------ */

export function PrivacyStatusCard({
  isSharing,
  headline,
  lines,
}: {
  isSharing: boolean;
  headline: string;
  lines: string[];
}) {
  return (
    <section className={cn(CARD_SURFACE, "p-5")}>
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "flex h-11 w-11 items-center justify-center rounded-full",
            isSharing
              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"
              : "bg-[#0a84ff]/12 text-[#0a84ff]",
          )}
        >
          <ShieldCheck className="h-6 w-6" />
        </span>
        <div className="min-w-0">
          <p className="text-lg font-semibold leading-tight tracking-tight text-foreground">
            {headline}
          </p>
          {lines.map((line) => (
            <p key={line} className={MUTED_TEXT}>
              {line}
            </p>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Trust / warning banners                                            */
/* ------------------------------------------------------------------ */

export function TrustNoteCard({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className={cn(TRUST_SURFACE, "flex gap-3 p-3.5")}>
      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
      <div>
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className={MUTED_TEXT}>{description}</p>
      </div>
    </div>
  );
}

export function WarningCard({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className={cn(WARNING_SURFACE, "flex gap-3 p-3.5")}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-xs leading-snug opacity-90">{description}</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Empty state                                                        */
/* ------------------------------------------------------------------ */

export function EmptyState({
  icon,
  title,
  description,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
}) {
  return (
    <div className={cn(SUBCARD_SURFACE, "flex flex-col items-center gap-2 p-6 text-center")}>
      {icon ? <div className="text-muted-foreground">{icon}</div> : null}
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {description ? <p className={MUTED_TEXT}>{description}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Quick-path row (Now hub navigation to People / Links / Inbox)      */
/* ------------------------------------------------------------------ */

export function QuickPathRow({
  icon,
  title,
  description,
  badge,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        SUBCARD_SURFACE,
        "flex w-full items-center gap-3 p-3.5 text-left transition-colors hover:border-[#0a84ff]/40",
      )}
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#0a84ff]/12 text-[#0a84ff]">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-foreground">
          {title}
        </span>
        <span className={cn(MUTED_TEXT, "block")}>{description}</span>
      </span>
      {badge ? (
        <StatusPill tone="live" className="shrink-0">
          {badge}
        </StatusPill>
      ) : null}
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}
