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

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ChevronDown,
  Clock3,
  Copy,
  ExternalLink,
  Loader2,
  Link2,
  MapPin,
  Pencil,
  RefreshCw,
  Share2,
  ShieldCheck,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { roleClasses } from "@/lib/morphy-ux/tokens/semantic-roles";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import {
  FormLabel,
  HelperText,
  MediumRowLabel,
  RowDescription,
  RowLabel,
  StatusText,
} from "@/components/app-ui/typography";
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
  onEdit,
  editActive,
  onRemove,
  removeBusy,
  removeAriaLabel,
  expandedContent,
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
          <MediumRowLabel
            as="p"
            className="break-words [overflow-wrap:anywhere]"
          >
            {name}
          </MediumRowLabel>
          {subtitle ? (
            <RowDescription
              className={cn(
                MUTED_TEXT,
                "break-words [overflow-wrap:anywhere]",
              )}
            >
              {subtitle}
            </RowDescription>
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
          <MediumRowLabel as="p" className="truncate">
            Sharing with {name}
          </MediumRowLabel>
          <RowDescription className={cn(MUTED_TEXT, "truncate")}>
            {expiryLabel}
          </RowDescription>
        </div>
        <StatusPill tone="live">Live</StatusPill>
      </div>
      {metaLabel ? (
        <RowDescription className={cn(MUTED_TEXT, "flex items-center gap-1.5")}>
          <Clock3 className="h-3.5 w-3.5" />
          {metaLabel}
        </RowDescription>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="destructive"
          size="sm"
          onClick={onStop}
          isLoading={stopBusy}
          className="ui-text-button-label h-9 rounded-full"
        >
          Stop sharing
        </Button>
        {onExtend ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onExtend}
            isLoading={extendBusy}
            className="ui-text-button-label h-9 rounded-full"
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
    <div className={cn(SUBCARD_SURFACE, "p-4 shadow-none")}>
      <div className="flex items-start gap-3">
        <Avatar initials={initialsFrom(name)} size={40} />
        <div className="min-w-0 flex-1">
          <MediumRowLabel as="p">
            {name}
          </MediumRowLabel>
          <RowDescription className={cn(MUTED_TEXT, "mt-0.5")}>
            {promptLine}
          </RowDescription>
        </div>
      </div>
      {reason ? (
        <div className="mt-3 rounded-[12px] bg-[color:var(--app-card-surface-compact)] px-3 py-2.5">
          <FormLabel as="p" className={MUTED_TEXT}>
            Reason
          </FormLabel>
          <RowLabel as="p" className="mt-0.5">
            {reason}
          </RowLabel>
        </div>
      ) : null}
      {decided ? (
        <StatusText
          as="p"
          role="status"
          className={cn(
            "mt-3 inline-flex min-h-8 items-center gap-1.5 rounded-full px-3",
            decision === "approved"
              ? "bg-[color:var(--app-success)]/12 text-[color:var(--app-success)]"
              : "bg-[color:var(--app-neutral-fill-strong)] text-[color:var(--app-secondary-label)]",
          )}
        >
          <ShieldCheck className="h-4 w-4" aria-hidden />
          {decision === "approved" ? "Approved" : "Declined"}
        </StatusText>
      ) : (
        <div className="mt-3.5 grid grid-cols-1 gap-2.5 min-[430px]:grid-cols-[0.82fr_1.18fr]">
          <Button
            onClick={() => {
              if (decided) return;
              setDecision("approved");
              onApprove();
            }}
            disabled={decided}
            // Deliberately not `isLoading`: the card has already answered. A
            // spinner here would reintroduce the wait it was pressed to remove.
            className="ui-text-button-label order-1 h-11 rounded-full bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90 min-[430px]:order-2"
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
            className="ui-text-button-label order-2 h-11 rounded-full bg-[color:var(--app-neutral-fill-strong)] text-[color:var(--app-label)] hover:bg-[color:var(--app-neutral-fill-strong)]/80 min-[430px]:order-1"
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
  shareLanes,
}: {
  name: string;
  statusLine: ReactNode;
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
  /** Came from the Save My Soul panic flow -- the one this UI calls "SMS". */
  isSmsTriggered?: boolean;
  /**
   * Every live share from this person, when there is more than one.
   *
   * One owner can now hold two live grants with you at once -- an ordinary
   * share and an SMS (SOS) one -- and they end at different moments. The card
   * stays ONE card per person (two cards for one name is the thing this
   * replaced), so the per-share breakdown hangs here, under the name, rather
   * than being folded into a single `statusLine` that could only be right
   * about one of them.
   */
  shareLanes?: ReactNode;
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
    <div className={cn(SUBCARD_SURFACE, "space-y-3 rounded-[18px] p-4 shadow-none")}>
      <div className="flex items-start gap-3">
        <Avatar initials={initialsFrom(name)} size={40} />
        <div className="min-w-0 flex-1">
          <RowLabel as="p">
            {name}
          </RowLabel>
          <RowDescription
            className={cn(
              MUTED_TEXT,
              "mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5",
            )}
          >
            {statusLine}
          </RowDescription>
        </div>
      </div>
      {shareLanes}
      {address || addressLoading || coordinatesFallback ? (
        <div className="flex items-start gap-1.5">
          <MapPin
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--app-tertiary-label)]"
            aria-hidden="true"
          />
          {addressLoading && !address ? (
            <span
              className="mt-0.5 h-3.5 w-40 max-w-full animate-pulse rounded bg-muted"
              aria-hidden="true"
            />
          ) : (
            <RowDescription className={cn(MUTED_TEXT, "min-w-0 break-words")}>
              {address ?? coordinatesFallback}
            </RowDescription>
          )}
        </div>
      ) : null}
      {viewStatus ? (
        viewStatus.tone === "waiting" ? (
          // Deliberately not `role="alert"`, not amber, not an icon that reads
          // as a problem. Nothing is wrong: the share is live and the first
          // point simply has not arrived. `aria-live="polite"` announces it
          // once without interrupting, which is what a status is.
          <RowDescription
            as="p"
            aria-live="polite"
            className={cn(MUTED_TEXT, "flex items-start gap-1.5")}
          >
            <Clock3
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
              aria-hidden="true"
            />
            <span className="min-w-0 break-words">
              Waiting for their first update…
            </span>
          </RowDescription>
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
              <HelperText
                as="p"
                className={cn(
                  "min-w-0 break-words [overflow-wrap:anywhere]",
                  warningRole.glyph,
                )}
              >
                {viewStatus.message}
              </HelperText>
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
      {canTogglePreview ? (
        <button
          type="button"
          className="ui-text-button-label inline-flex min-h-11 items-center gap-1.5 rounded-full text-[color:var(--app-accent)] transition-colors hover:text-[color:var(--app-accent-deep)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)] focus-visible:ring-offset-2 disabled:opacity-60"
          aria-label={
            isPreviewExpanded
              ? `Collapse shared location from ${name}`
              : `View shared location from ${name}`
          }
          aria-expanded={isPreviewExpanded}
          aria-controls={previewRegionId}
          disabled={viewBusy && !isPreviewExpanded}
          onClick={togglePreview}
        >
          {viewBusy && !isPreviewExpanded ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : null}
          {isPreviewExpanded ? "Hide map" : "View location"}
          <ChevronDown
            className={cn(
              "h-4 w-4 transition-transform duration-200",
              isPreviewExpanded && "rotate-180",
            )}
            aria-hidden="true"
          />
        </button>
      ) : null}
      <div id={previewRegionId} hidden={!isPreviewExpanded}>
        <div className="relative overflow-hidden rounded-[14px]">
          {children}
          {isPreviewExpanded && onRecenter ? (
            <ShellActionSurface
              variant="icon"
              className="absolute right-2 top-2 z-10 h-11 w-11 bg-[color:var(--app-card-surface-default-solid)]/90 backdrop-blur"
              aria-label={`Recenter map on ${name}'s location`}
              aria-controls={previewRegionId}
              title="Recenter map"
              onClick={onRecenter}
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            </ShellActionSurface>
          ) : null}
        </div>
      </div>
      {message ? (
        <RowDescription
          as="p"
          className={cn(
            MUTED_TEXT,
            "rounded-[12px] bg-[color:var(--app-neutral-fill)] px-3 py-2",
          )}
        >
          “{message}”
        </RowDescription>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {canOpenMap ? (
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="ui-text-button-label h-11 rounded-full px-0 text-[color:var(--app-accent)] hover:bg-transparent hover:text-[color:var(--app-accent-deep)]"
          >
            <a
              href={mapHref}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open shared location in Google Maps"
            >
              Open in Google Maps
              <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
            </a>
          </Button>
        ) : null}
        {onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            disabled={removeBusy}
            aria-label={`Remove ${name} from Shared with me`}
            className="ui-text-button-label inline-flex min-h-11 items-center justify-center rounded-full text-[color:var(--app-destructive)] transition-colors hover:text-[color:var(--app-destructive)]/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)] focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
          >
            {removeBusy ? "Stopping…" : "Stop viewing"}
          </button>
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
  description,
  onCopy,
  onShare,
  onRevoke,
  revokeBusy,
}: {
  title?: string;
  statusLine: string;
  description: string;
  onCopy: () => boolean | Promise<boolean>;
  onShare: () => void;
  onRevoke: () => void;
  revokeBusy?: boolean;
}) {
  const [copyLabel, setCopyLabel] = useState("Copy link");
  const [copyBusy, setCopyBusy] = useState(false);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyResetRef.current) {
        clearTimeout(copyResetRef.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    if (copyBusy) return;
    setCopyBusy(true);
    try {
      const copied = await onCopy();
      if (!copied) return;
      setCopyLabel("Copied");
      if (copyResetRef.current) {
        clearTimeout(copyResetRef.current);
      }
      copyResetRef.current = setTimeout(() => {
        setCopyLabel("Copy link");
      }, 1600);
    } finally {
      setCopyBusy(false);
    }
  };

  return (
    <div className={cn(SUBCARD_SURFACE, "space-y-5 p-5 sm:p-6")}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)]">
          <Link2 className="h-[18px] w-[18px]" strokeWidth={2.1} />
        </span>
        <div className="min-w-0 flex-1">
          {title ? (
            <MediumRowLabel as="p">
              {title}
            </MediumRowLabel>
          ) : null}
          <RowDescription
            className={cn(
              MUTED_TEXT,
              "flex items-center gap-2",
              title ? "mt-1" : "mt-0.5",
            )}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--app-success)]" />
            {statusLine}
          </RowDescription>
          <RowDescription className={cn(MUTED_TEXT, "mt-2")}>
            {description}
          </RowDescription>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2 min-[340px]:grid-cols-2">
        <Button
          onClick={onShare}
          className="ui-text-button-label h-12 rounded-[15px] bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90"
        >
          <Share2 className="mr-1.5 h-4 w-4" />
          Share
        </Button>
        <Button
          variant="outline"
          onClick={handleCopy}
          disabled={copyBusy}
          aria-busy={copyBusy || undefined}
          className="ui-text-button-label h-12 rounded-[15px]"
        >
          <Copy className="mr-1.5 h-4 w-4" />
          {copyBusy ? "Copying…" : copyLabel}
        </Button>
      </div>
      <div className="border-t border-border/60 pt-1">
        <button
          type="button"
          onClick={onRevoke}
          disabled={revokeBusy}
          className="ui-text-button-label min-h-11 w-full text-left text-[color:var(--app-destructive)] transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent)] focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
        >
          {revokeBusy ? "Revoking…" : "Revoke link"}
        </button>
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
      ? "bg-[color:var(--app-success)]/12 text-[color:var(--app-success)]"
      : tone === "warning"
        ? "bg-[color:var(--app-warning)]/12 text-[color:var(--app-warning)]"
        : tone === "blocked"
          ? "bg-[color:var(--app-destructive)]/12 text-[color:var(--app-destructive)]"
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
          <MediumRowLabel as="p">{title}</MediumRowLabel>
          <RowDescription className={MUTED_TEXT}>{description}</RowDescription>
        </div>
      </div>
      <div className="grid gap-2">
        {onRefresh ? (
          <Button
            variant="default"
            size="sm"
            onClick={onRefresh}
            isLoading={refreshBusy}
            className="ui-text-button-label h-10 w-full rounded-full bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent)]/90"
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
            className="ui-text-button-label h-10 w-full rounded-full"
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
      <span className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-full bg-[color:var(--app-neutral-fill)] text-[color:var(--app-secondary-label)]">
        <ShieldCheck className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0">
        <MediumRowLabel as="p">{title}</MediumRowLabel>
        <RowDescription className={MUTED_TEXT}>{detail}</RowDescription>
      </div>
    </div>
  );
}

export { initialsFrom };
