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

import { useId, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ChevronDown,
  Clock3,
  Copy,
  ExternalLink,
  Loader2,
  MapPin,
  Pencil,
  RefreshCw,
  Share2,
  ShieldCheck,
  User,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { roleClasses } from "@/lib/morphy-ux/tokens/semantic-roles";
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
  nameSuffix,
  subtitle,
  tone = "ready",
  statusLabel,
  actionLabel,
  actionAriaLabel,
  onAction,
  actionBusy,
  actionDisabled,
  selected,
  onEdit,
  editActive,
  onRemove,
  removeBusy,
  removeAriaLabel,
  expandedContent,
}: {
  name: string;
  /** "till 12:29 PM" -- the live share's absolute end time, next to the name. */
  nameSuffix?: string;
  subtitle?: string;
  tone?: "ready" | "pending" | "neutral";
  statusLabel?: string;
  actionLabel?: string;
  actionAriaLabel?: string;
  onAction?: () => void;
  actionBusy?: boolean;
  actionDisabled?: boolean;
  selected?: boolean;
  /** Edit this person's live grant duration (shorten now / ask for more). */
  onEdit?: () => void;
  /** True while `expandedContent` is the open duration editor for this row. */
  editActive?: boolean;
  /** Revoke this person's live grant. */
  onRemove?: () => void;
  removeBusy?: boolean;
  /**
   * What the X actually does on this row, for people using a screen reader.
   * Defaults to ending access, because that is what it does on a live row --
   * but on a row whose request is still unanswered it ends the ASK, and
   * announcing that as "remove their access" describes the wrong act.
   */
  removeAriaLabel?: string;
  /** Full-width block below the row, e.g. the inline duration editor. */
  expandedContent?: ReactNode;
}) {
  return (
    <div
      className={cn(
        SUBCARD_SURFACE,
        "p-3.5",
        // `ring-inset` draws the selection outline INSIDE the card bounds so a
        // parent scroll/`overflow-hidden` container can never clip its edges or
        // corners (the reported "incomplete blue outline"). `ring-2` gives a
        // clean, complete 360° stroke; the border tints the same edge.
        selected &&
          "border-[color:var(--app-accent)] ring-2 ring-inset ring-[color:var(--app-accent)]",
      )}
    >
      <div className="flex items-center gap-3">
        <Avatar initials={initialsFrom(name)} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-1.5">
            <p className="break-words text-[15px] font-semibold leading-5 text-foreground [overflow-wrap:anywhere] sm:text-[17px] sm:leading-[22px]">
              {name}
            </p>
            {nameSuffix ? (
              <span className={cn(MUTED_TEXT, "shrink-0")}>· {nameSuffix}</span>
            ) : null}
          </div>
          {subtitle ? (
            <p
              className={cn(
                MUTED_TEXT,
                "break-words [overflow-wrap:anywhere]",
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
        {onEdit ? (
          <ShellActionSurface
            variant="icon"
            className="h-9 w-9 shrink-0"
            aria-label={`${editActive ? "Cancel editing" : "Edit"} access for ${name}`}
            aria-pressed={editActive}
            onClick={onEdit}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </ShellActionSurface>
        ) : null}
        {onRemove ? (
          <ShellActionSurface
            variant="icon"
            className="h-9 w-9 shrink-0 text-destructive"
            aria-label={removeAriaLabel ?? `Remove ${name}'s access`}
            onClick={onRemove}
            disabled={removeBusy}
          >
            {removeBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </ShellActionSurface>
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
      {expandedContent ? (
        <div className="mt-3 space-y-3">{expandedContent}</div>
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
}: {
  name: string;
  promptLine: string;
  reason?: string;
  approveLabel?: string;
  onApprove: () => void;
  onDecline: () => void;
}) {
  // Latch the decision on THIS card, the moment it is pressed.
  //
  // Two problems this solves. First, `approveBusy` is derived from one global
  // busy value, so approving a single request put a spinner on EVERY card in
  // the list. Second, that spinner was held across three sequential server
  // calls — approve, publish the encrypted point, reload state — none of which
  // the person is waiting to see. They pressed Approve; the answer is "yes".
  //
  // So the card answers immediately and the work continues behind it. The same
  // latch blocks a second press, which is what makes the optimism safe.
  const [decision, setDecision] = useState<"approved" | "declined" | null>(null);
  const decided = decision !== null;

  return (
    <div className={cn(SUBCARD_SURFACE, "p-4")}>
      <div className="flex items-center gap-3">
        <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-[color:var(--app-icon-tile-background)] text-[color:var(--app-icon-tile-foreground)]">
          <User className="h-[17px] w-[17px]" strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[17px] font-normal leading-[22px] text-foreground">
            {name}
          </p>
          <p className="mt-0.5 truncate text-[15px] leading-5 text-muted-foreground">
            {promptLine}
          </p>
        </div>
      </div>
      {reason ? (
        <p className={cn(MUTED_TEXT, "mt-2.5 rounded-[10px] bg-[color:var(--app-card-surface-compact)] px-2.5 py-1.5")}>
          {reason}
        </p>
      ) : null}
      {decided ? (
        <p
          role="status"
          className="mt-3.5 flex h-11 items-center justify-center gap-1.5 rounded-full bg-[color:var(--app-success)]/12 text-sm font-semibold text-[color:var(--app-success)]"
        >
          <ShieldCheck className="h-[17px] w-[17px]" aria-hidden />
          {decision === "approved" ? "Approved" : "Declined"}
        </p>
      ) : (
        <div className="mt-3.5 flex gap-2.5">
          <Button
            onClick={() => {
              if (decided) return;
              setDecision("approved");
              onApprove();
            }}
            disabled={decided}
            // Deliberately not `isLoading`: the card has already answered. A
            // spinner here would reintroduce the wait it was pressed to remove.
            className="h-11 flex-1 rounded-full bg-[color:var(--app-accent)] text-sm font-semibold text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90"
          >
            {approveLabel}
          </Button>
          <Button
            onClick={() => {
              if (decided) return;
              setDecision("declined");
              onDecline();
            }}
            disabled={decided}
            className="h-11 flex-1 rounded-full bg-[color:var(--app-neutral-fill-strong)] text-sm font-semibold text-foreground hover:bg-[color:var(--app-neutral-fill-strong)]/80 dark:bg-white/10"
          >
            Decline
          </Button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SharedWithMeCard (focused received-share detail)                   */
/* ------------------------------------------------------------------ */

/**
 * Why a received share has nothing on the map yet.
 *
 * `waiting` is a healthy share whose owner has not published a point yet —
 * the most common state on the receiving side, and a success. It gets calm
 * muted copy and no action, because it resolves itself on the next poll.
 *
 * `blocked` is a share the recipient genuinely cannot open and that will not
 * fix itself. Only this earns the alert treatment and the recovery action.
 *
 * Collapsing these two into one "error" string is what left recipients staring
 * at a card with a name, a date, and no explanation of any kind.
 */
export type GrantViewStatus = {
  message: string;
  tone: "waiting" | "blocked";
};

export function SharedWithMeCard({
  name,
  statusLine,
  onView,
  onDismiss,
  onRecenter,
  onRemove,
  removeBusy,
  mapHref,
  viewBusy,
  previewExpanded,
  children,
  message,
  address,
  addressLoading,
  coordinatesFallback,
  viewStatus,
  onAskReshare,
  askReshareBusy,
}: {
  name: string;
  statusLine: string;
  onView: () => void;
  onDismiss?: () => void;
  onRecenter?: () => void;
  /** Revoke this grant. Ends this person's access to your view of their
   * location -- distinct from `onDismiss`, which only collapses the local
   * preview and leaves the grant (and access) active. */
  onRemove?: () => void;
  removeBusy?: boolean;
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
  /**
   * Why there is no location on screen. Rendered only while nothing has been
   * decrypted yet — once a point arrives it is the answer, and a stale status
   * line underneath it would contradict what the person is looking at.
   */
  viewStatus?: GrantViewStatus | null;
  /** Re-request access from the owner. Offered only for the `blocked` tone. */
  onAskReshare?: () => void;
  askReshareBusy?: boolean;
}) {
  const warningRole = roleClasses("warning");
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
            {name}
          </p>
          <div className="mt-0.5 flex min-w-0 items-center gap-2">
            <p className={cn(MUTED_TEXT, "min-w-0 truncate")}>{statusLine}</p>
            <StatusPill tone="ready" className="shrink-0">
              Active
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
      {viewStatus ? (
        viewStatus.tone === "waiting" ? (
          // Deliberately not `role="alert"`, not amber, not an icon that reads
          // as a problem. Nothing is wrong: the share is live and the first
          // point simply has not arrived. `aria-live="polite"` announces it
          // once without interrupting, which is what a status is.
          <p
            aria-live="polite"
            className={cn(MUTED_TEXT, "flex items-start gap-1.5 text-sm")}
          >
            <Clock3
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
              aria-hidden="true"
            />
            <span className="min-w-0 break-words">{viewStatus.message}</span>
          </p>
        ) : (
          // Five hand-mixed hexes stood here. #ff9f0a is the iOS DARK-mode
          // orange used as a light-mode literal, and the 0.08 wash sat under
          // the light token and roughly half the dark one, so the banner
          // nearly vanished in dark. The warning role already encodes the
          // light/dark pairing this was reaching for by hand.
          <div
            role="alert"
            className={cn(
              "flex flex-col gap-2.5 rounded-[var(--app-card-radius-compact)] border p-3 sm:flex-row sm:items-center sm:justify-between",
              warningRole.tile,
              warningRole.border,
            )}
          >
            <div className="flex items-start gap-2">
              <AlertTriangle
                className={cn("mt-0.5 h-4 w-4 shrink-0", warningRole.glyph)}
                aria-hidden="true"
              />
              <p
                className={cn(
                  "min-w-0 break-words text-[12.5px] font-medium leading-snug [overflow-wrap:anywhere]",
                  warningRole.glyph,
                )}
              >
                {viewStatus.message}
              </p>
            </div>
            {onAskReshare ? (
              <Button
                variant="outline"
                size="sm"
                onClick={onAskReshare}
                isLoading={askReshareBusy}
                className={cn(
                  "w-full shrink-0 rounded-full bg-[color:var(--app-card-surface-default-solid)] sm:w-auto",
                  warningRole.border,
                  warningRole.glyph,
                )}
              >
                Ask to refresh
              </Button>
            ) : null}
          </div>
        )
      ) : null}
      <div id={previewRegionId} hidden={!isPreviewExpanded}>
        {children}
      </div>
      {message ? (
        <p className={cn(MUTED_TEXT, "text-sm")}>{message}</p>
      ) : null}
      <div className={cn("grid gap-2", onRemove ? "grid-cols-2" : "grid-cols-1")}>
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
        {onRemove ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onRemove}
            isLoading={removeBusy}
            aria-label={`Remove ${name} from Shared with me`}
            className="h-9 rounded-full text-sm text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            Remove
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
