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

import type { ReactNode } from "react";
import {
  Clock3,
  Copy,
  ExternalLink,
  Loader2,
  MapPin,
  RefreshCw,
  Share2,
  ShieldCheck,
} from "lucide-react";

import { cn } from "@/lib/utils";
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
  subtitle: string;
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
        selected && "border-[#0a84ff]/50 ring-1 ring-[#0a84ff]/30",
      )}
    >
      <Avatar initials={initialsFrom(name)} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-semibold text-foreground">
          {name}
        </p>
        <p className={cn(MUTED_TEXT, "truncate")}>{subtitle}</p>
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
/* RequestCard (Inbox: needs your review)                             */
/* ------------------------------------------------------------------ */

export function RequestCard({
  name,
  promptLine,
  reason,
  durationLabel,
  approveLabel = "Share 1 hour",
  onApprove,
  onDecline,
  approveBusy,
  declineBusy,
}: {
  name: string;
  promptLine: string;
  reason?: string;
  durationLabel?: string;
  approveLabel?: string;
  onApprove: () => void;
  onDecline: () => void;
  approveBusy?: boolean;
  declineBusy?: boolean;
}) {
  return (
    <div className={cn(SUBCARD_SURFACE, "space-y-3 p-3.5")}>
      <div className="flex items-start gap-3">
        <Avatar initials={initialsFrom(name)} />
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold text-foreground">
            {name} is asking
          </p>
          <p className={MUTED_TEXT}>{promptLine}</p>
          {reason ? (
            <p className="mt-1.5 rounded-lg bg-background/60 px-2.5 py-1.5 text-xs italic text-muted-foreground">
              {reason}
            </p>
          ) : null}
          {durationLabel ? (
            <p className={cn(MUTED_TEXT, "mt-1")}>{durationLabel}</p>
          ) : null}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button
          size="sm"
          onClick={onApprove}
          isLoading={approveBusy}
          className="h-9 rounded-full text-sm"
        >
          {approveLabel}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onDecline}
          isLoading={declineBusy}
          className="h-9 rounded-full text-sm"
        >
          Decline
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SharedWithMeCard (Inbox / Now: a received share)                   */
/* ------------------------------------------------------------------ */

export function SharedWithMeCard({
  name,
  statusLine,
  metaLine,
  onView,
  onDismiss,
  viewBusy,
  viewed,
  children,
}: {
  name: string;
  statusLine: string;
  metaLine?: string;
  onView: () => void;
  onDismiss?: () => void;
  viewBusy?: boolean;
  viewed?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={cn(SUBCARD_SURFACE, "space-y-3 p-3.5")}>
      <div className="flex items-center gap-3">
        <Avatar initials={initialsFrom(name)} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-foreground">
            {name} is sharing with you
          </p>
          <p className={cn(MUTED_TEXT, "truncate")}>{statusLine}</p>
        </div>
        <StatusPill tone="live">Live</StatusPill>
      </div>
      {metaLine ? <p className={MUTED_TEXT}>{metaLine}</p> : null}
      {children}
      <div className="grid grid-cols-2 gap-2">
        <Button
          size="sm"
          onClick={onView}
          isLoading={viewBusy}
          className="h-9 rounded-full text-sm"
        >
          <MapPin className="mr-1.5 h-3.5 w-3.5" />
          {viewed ? "Open map" : "View"}
        </Button>
        {onDismiss ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onDismiss}
            className="h-9 rounded-full text-sm"
          >
            Dismiss
          </Button>
        ) : null}
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
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#0a84ff]/12 text-[#0a84ff]">
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
          : "bg-[#0a84ff]/12 text-[#0a84ff]";
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
            className="h-10 w-full rounded-full bg-[#0a84ff] text-sm font-semibold text-white hover:bg-[#0a84ff]/90"
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
