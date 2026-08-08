"use client";

/**
 * One Location redesign — feature cards (people, shares, requests, links, device).
 *
 * PRESENTATION ONLY. All actions are passed in as callbacks that map directly to
 * the existing page handlers (handleShare, handleRevoke, handleApprove, etc).
 * Typography uses the app-wide semantic Tailwind sizes (text-xs/sm/base mapped to
 * the Apple-HIG --foundation-* tokens) for consistency with other pages.
 * No business logic lives here.
 */

import { useId, type ReactNode } from "react";
import {
  ChevronDown,
  Clock3,
  Copy,
  ExternalLink,
  Loader2,
  MapPin,
  RefreshCw,
  Share2,
  ShieldCheck,
  User,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { Button } from "@/components/ui/button";
import { Avatar, StatusPill } from "./primitives";
import { MUTED_TEXT, SUBCARD_SURFACE } from "./tokens";

function initialsFrom(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const first = parts[0] ?? "";
  if (parts.length === 1) return (first.slice(0, 2) || "?").toUpperCase();
  const last = parts[parts.length - 1] ?? "";
  return ((first[0] ?? "") + (last[0] ?? "")).toUpperCase() || "?";
}

/* ------------------------------------------------------------------ */
/* TrustedPersonCard                                                  */
/* ------------------------------------------------------------------ */

export function TrustedPersonCard({
  name,
  subtitle,
  tone = "ready",
  statusLabel,
  actionLabel,
  actionAriaLabel,
  onAction,
  actionBusy,
  actionDisabled,
  selected,
}: {
  name: string;
  subtitle?: string;
  tone?: "ready" | "pending" | "neutral";
  statusLabel?: string;
  actionLabel?: string;
  actionAriaLabel?: string;
  onAction?: () => void;
  actionBusy?: boolean;
  actionDisabled?: boolean;
  selected?: boolean;
}) {
  return (
    <div
      className={cn(
        SUBCARD_SURFACE,
        "flex items-center gap-3 p-3.5",
        selected && "border-[color:var(--app-accent)]/50 ring-1 ring-[color:var(--app-accent-ring)]",
      )}
    >
      <Avatar initials={initialsFrom(name)} />
      <div className="min-w-0 flex-1">
        <p className="break-words text-[13px] font-semibold leading-snug text-foreground [overflow-wrap:anywhere] sm:text-base">
          {name}
        </p>
        {subtitle ? (
          <p
            className={cn(
              MUTED_TEXT,
              "break-words text-[11px] leading-snug [overflow-wrap:anywhere] sm:text-xs",
            )}
          >
            {subtitle}
          </p>
        ) : null}
      </div>

      {statusLabel ? (
        <StatusPill tone={tone === "neutral" ? "neutral" : tone}>
          {statusLabel}
        </StatusPill>
      ) : null}
      {actionLabel && onAction ? (
        <Button
          size="sm"
          variant={tone === "pending" ? "outline" : "default"}
          onClick={onAction}
          aria-label={actionAriaLabel}
          isLoading={actionBusy}
          disabled={actionDisabled}
          className="h-8 shrink-0 rounded-full px-3.5 text-sm"
        >
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ActiveShareCard                                                    */
/* ------------------------------------------------------------------ */

export function ActiveShareCard({
  name,
  expiryLabel,
  metaLabel,
  onStop,
  onExtend,
  stopBusy,
  extendBusy,
}: {
  name: string;
  expiryLabel: string;
  metaLabel?: string;
  onStop: () => void;
  onExtend?: () => void;
  stopBusy?: boolean;
  extendBusy?: boolean;
}) {
  return (
    <div className={cn(SUBCARD_SURFACE, "space-y-3 p-3.5")}>
      <div className="flex items-center gap-3">
        <Avatar initials={initialsFrom(name)} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-foreground">
            Sharing with {name}
          </p>
          <p className={cn(MUTED_TEXT, "truncate")}>{expiryLabel}</p>
        </div>
        <StatusPill tone="live">Live</StatusPill>
      </div>
      {metaLabel ? (
        <p className={cn(MUTED_TEXT, "flex items-center gap-1.5")}>
          <Clock3 className="h-3.5 w-3.5" />
          {metaLabel}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="destructive"
          size="sm"
          onClick={onStop}
          isLoading={stopBusy}
          className="h-9 rounded-full text-sm"
        >
          Stop sharing
        </Button>
        {onExtend ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onExtend}
            isLoading={extendBusy}
            className="h-9 rounded-full text-sm"
          >
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Extend
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* RequestCard (focused needs-review detail)                           */
/* ------------------------------------------------------------------ */

export function RequestCard({
  name,
  promptLine,
  reason,
  approveLabel = "Approve",
  onApprove,
  onDecline,
  approveBusy,
  declineBusy,
}: {
  name: string;
  promptLine: string;
  reason?: string;
  approveLabel?: string;
  onApprove: () => void;
  onDecline: () => void;
  approveBusy?: boolean;
  declineBusy?: boolean;
}) {
  return (
    <div className={cn(SUBCARD_SURFACE, "p-4")}>
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#d8d8de] text-white dark:bg-white/15">
          <User className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[16px] font-bold text-[#1c1c2e] dark:text-foreground">
            {name}
          </p>
          <p className="mt-0.5 truncate text-[13px] text-black/50 dark:text-muted-foreground">
            {promptLine}
          </p>
        </div>
      </div>
      {reason ? (
        <p className="mt-2.5 rounded-lg bg-black/[0.03] px-2.5 py-1.5 text-xs italic text-black/50 dark:bg-white/5 dark:text-muted-foreground">
          {reason}
        </p>
      ) : null}
      <div className="mt-3.5 flex gap-2.5">
        <Button
          onClick={onApprove}
          isLoading={approveBusy}
          className="h-11 flex-1 rounded-full bg-[color:var(--app-accent)] text-sm font-semibold text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90"
        >
          {approveLabel}
        </Button>
        <Button
          onClick={onDecline}
          isLoading={declineBusy}
          className="h-11 flex-1 rounded-full bg-[#ededf2] text-sm font-semibold text-[#1d1d1f] hover:bg-[#e2e2ea] dark:bg-white/10 dark:text-foreground"
        >
          Decline
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SharedWithMeCard (focused received-share detail)                   */
/* ------------------------------------------------------------------ */

export function SharedWithMeCard({
  name,
  statusLine,
  onView,
  onDismiss,
  onRecenter,
  mapHref,
  viewBusy,
  previewExpanded,
  children,
  message,
  address,
  addressLoading,
  coordinatesFallback,
}: {
  name: string;
  statusLine: string;
  onView: () => void;
  onDismiss?: () => void;
  onRecenter?: () => void;
  mapHref?: string;
  viewBusy?: boolean;
  previewExpanded?: boolean;
  children?: ReactNode;
  message?: string;
  /** Reverse-geocoded street address for the shared location, if resolved. */
  address?: string | null;
  /** True while the street address is being reverse-geocoded. */
  addressLoading?: boolean;
  /** "lat, lng" shown when no street address is available. */
  coordinatesFallback?: string;
}) {
  const canOpenMap = Boolean(previewExpanded && mapHref);
  const previewRegionId = useId();
  const isPreviewExpanded = Boolean(previewExpanded);
  const canTogglePreview = !isPreviewExpanded || Boolean(onDismiss);
  const togglePreview = () => {
    if (isPreviewExpanded) {
      onDismiss?.();
      return;
    }
    onView();
  };

  return (
    <div className={cn(SUBCARD_SURFACE, "space-y-3 p-3.5")}>
      <div className="flex items-start gap-3">
        <Avatar initials={initialsFrom(name)} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-foreground">
            {name} is sharing with you
          </p>
          <div className="mt-0.5 flex min-w-0 items-center gap-2">
            <p className={cn(MUTED_TEXT, "min-w-0 truncate")}>{statusLine}</p>
            <StatusPill tone="live" className="shrink-0">
              Live
            </StatusPill>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isPreviewExpanded && onRecenter ? (
            <ShellActionSurface
              variant="icon"
              className="h-11 w-11 sm:h-9 sm:w-9"
              aria-label={`Recenter map on ${name}'s location`}
              aria-controls={previewRegionId}
              title="Recenter map"
              onClick={onRecenter}
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            </ShellActionSurface>
          ) : null}
          {canTogglePreview ? (
            <ShellActionSurface
              variant="icon"
              className="h-11 w-11 sm:h-9 sm:w-9"
              aria-label={`${isPreviewExpanded ? "Collapse" : "Expand"} shared location from ${name}`}
              aria-expanded={isPreviewExpanded}
              aria-controls={previewRegionId}
              disabled={viewBusy && !isPreviewExpanded}
              onClick={togglePreview}
            >
              {viewBusy && !isPreviewExpanded ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <ChevronDown
                  className={cn(
                    "h-4 w-4 transition-transform duration-200",
                    isPreviewExpanded && "rotate-180",
                  )}
                  aria-hidden="true"
                />
              )}
            </ShellActionSurface>
          ) : null}
        </div>
      </div>
      {address || addressLoading || coordinatesFallback ? (
        <div className="flex items-start gap-1.5">
          <MapPin
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          {addressLoading && !address ? (
            <span
              className="mt-0.5 h-3.5 w-40 max-w-full animate-pulse rounded bg-muted"
              aria-hidden="true"
            />
          ) : (
            <p className={cn(MUTED_TEXT, "min-w-0 break-words text-sm")}>
              {address ?? coordinatesFallback}
            </p>
          )}
        </div>
      ) : null}
      <div id={previewRegionId} hidden={!isPreviewExpanded}>
        {children}
      </div>
      {message ? (
        <p className={cn(MUTED_TEXT, "text-sm")}>{message}</p>
      ) : null}
      <div className="grid grid-cols-1 gap-2">
        {canOpenMap ? (
          <Button
            asChild
            size="sm"
            className="h-9 rounded-full bg-[color:var(--app-accent)] text-sm text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90"
          >
            <a
              href={mapHref}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open shared location in Google Maps"
            >
              <MapPin className="mr-1.5 h-3.5 w-3.5" />
              Open map
            </a>
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={onView}
            isLoading={viewBusy}
            className="h-9 rounded-full bg-[color:var(--app-accent)] text-sm text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90"
          >
            <MapPin className="mr-1.5 h-3.5 w-3.5" />
            View location
          </Button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* TemporaryLinkCard / InviteLinkCard                                 */
/* ------------------------------------------------------------------ */

export function TemporaryLinkCard({
  title,
  statusLine,
  expiryLabel,
  onCopy,
  onShare,
  onRevoke,
  revokeBusy,
}: {
  title: string;
  statusLine: string;
  expiryLabel?: string;
  onCopy: () => void;
  onShare: () => void;
  onRevoke: () => void;
  revokeBusy?: boolean;
}) {
  return (
    <div className={cn(SUBCARD_SURFACE, "space-y-3 p-3.5")}>
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)]">
          <ExternalLink className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold text-foreground">{title}</p>
          <p className={MUTED_TEXT}>{statusLine}</p>
          {expiryLabel ? (
            <p className={cn(MUTED_TEXT, "mt-0.5 flex items-center gap-1.5")}>
              <Clock3 className="h-3.5 w-3.5" />
              {expiryLabel}
            </p>
          ) : null}
        </div>
        <StatusPill tone="live">Live</StatusPill>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onCopy}
          className="h-9 rounded-full text-sm"
        >
          <Copy className="mr-1 h-3.5 w-3.5" />
          Copy
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onShare}
          className="h-9 rounded-full text-sm"
        >
          <Share2 className="mr-1 h-3.5 w-3.5" />
          Share
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={onRevoke}
          isLoading={revokeBusy}
          className="h-9 rounded-full text-sm"
        >
          Revoke
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* DeviceReadinessCard                                                */
/* ------------------------------------------------------------------ */

export function DeviceReadinessCard({
  tone,
  title,
  description,
  actionLabel,
  onAction,
  actionBusy,
  onRefresh,
  refreshBusy,
  refreshLabel = "Refresh location",
}: {
  tone: "ready" | "warning" | "blocked" | "checking";
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  actionBusy?: boolean;
  onRefresh?: () => void;
  refreshBusy?: boolean;
  refreshLabel?: string;
}) {
  const iconWrap =
    tone === "ready"
      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"
      : tone === "warning"
        ? "bg-amber-500/15 text-amber-600 dark:text-amber-300"
        : tone === "blocked"
          ? "bg-red-500/15 text-red-600 dark:text-red-300"
          : "bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)]";
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
            iconWrap,
          )}
        >
          {tone === "checking" ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <ShieldCheck className="h-5 w-5" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold text-foreground">{title}</p>
          <p className={MUTED_TEXT}>{description}</p>
        </div>
      </div>
      <div className="grid gap-2">
        {onRefresh ? (
          <Button
            variant="default"
            size="sm"
            onClick={onRefresh}
            isLoading={refreshBusy}
            className="h-10 w-full rounded-full bg-[color:var(--app-accent)] text-sm font-semibold text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90"
          >
            {!refreshBusy ? <RefreshCw className="mr-2 h-4 w-4" /> : null}
            {refreshLabel}
          </Button>
        ) : null}
        {actionLabel && onAction ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onAction}
            isLoading={actionBusy}
            className="h-10 w-full rounded-full text-sm"
          >
            {!actionBusy ? <ExternalLink className="mr-2 h-4 w-4" /> : null}
            {actionLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ActivityReceiptCard                                                */
/* ------------------------------------------------------------------ */

export function ActivityReceiptCard({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) {
  return (
    <div className={cn(SUBCARD_SURFACE, "flex items-start gap-3 p-3")}>
      <span className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className={MUTED_TEXT}>{detail}</p>
      </div>
    </div>
  );
}

export { initialsFrom };
