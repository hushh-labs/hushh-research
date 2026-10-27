"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { DocumentOriginalLink as OriginalLink } from "./document-original-link";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { BodyText, HelperText } from "@/components/app-ui/typography";
import { BackgroundDocumentLink } from "./background-document-files";
import { RequesterPaymentSection } from "@/components/consent/requester-payment-section";
import { formatDocumentRequestPrice } from "@/lib/consent/document-request-price";
import { periodConflictNote } from "@/lib/consent/document-request-flow";
import type { RequesterPriceView } from "@/lib/consent/document-request-payment-view";
import { presentRequesterRecovery } from "@/lib/consent/document-request-requester-view";
import { Button } from "@/lib/morphy-ux/button";
import { DriveRequestRequesterService } from "@/lib/services/drive-request-requester-service";
import {
  DriveSharingError,
  DriveSharingService,
  type DriveBulkReasonCode,
  type DriveBulkShareCounts,
  type DriveBulkShareIssue,
  type SharingDelivery,
  type SharingDeliveryFilePage,
  type SharingRequestContext,
  type SharingStatus,
} from "@/lib/services/drive-sharing-service";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { useVault } from "@/lib/vault/vault-context";

export type DocumentRequestRequesterPanelProps = {
  requestId: string;
  status: SharingStatus;
  delivery?: SharingDelivery;
  /** The requester's own terms; null when this request has none to show. */
  context: SharingRequestContext | null;
  /** True while the details sheet runs another action. */
  locked: boolean;
  /** "inline" hosts are already a card (chat), so groups stay flat. */
  surface: "sheet" | "inline";
  /** Withdraws a free request; paid requests withdraw in the payment section. */
  onCancel: () => void;
  /** Reloads the details after a requester action. */
  onChanged: () => void;
};

const UNDECIDED = new Set(["pending", "preparing", "review_ready"]);
const HAIRLINES = "divide-y divide-border/60 border-y border-border/60";

function requesterIssueText(reason: DriveBulkReasonCode | string): string {
  if (reason === "date_range_required")
    return "This request needs exact dates. Make a new request with a start and end date.";
  if (reason === "source_not_shareable")
    return "The owner's Google account lacks sharing permission. Ask them to contact the file owner or shared drive manager.";
  if (reason === "permission_rejected")
    return "Google Drive denied sharing. The owner can check the file's sharing permissions.";
  if (reason === "permission_outcome_unknown" || reason === "permission_catalog_incomplete")
    return "The result has not been confirmed. The owner can check access in Google Drive.";
  // Google shares silently only with Google accounts; nothing the owner can fix.
  if (reason === "recipient_needs_google_account") return "Link a Google account to receive files.";
  if (reason === "drive_policy_blocked")
    return "The owner's Google Workspace settings don't allow sharing these files with you.";
  if (reason === "sharing_rate_limited")
    return "Google Drive limited how many files the owner could share at once.";
  if (reason === "stopped") return "The owner stopped sharing these files.";
  // A retry is never promised here: it may already be closed.
  if (reason === "provider_unavailable") return "Google Drive could not finish sharing these files.";
  return "These files were not shared.";
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-h-11 items-start justify-between gap-4 py-2.5">
      <HelperText as="dt" className="shrink-0">
        {label}
      </HelperText>
      <BodyText as="dd" className="min-w-0 text-right tabular-nums [overflow-wrap:anywhere]">
        {value}
      </BodyText>
    </div>
  );
}

/** Estimate, owner price and final price as rows; never "locked". */
function priceFacts(price: RequesterPriceView | null): ReactNode[] {
  if (!price) return [];
  const { estimateCents: estimate, currentCents: current, finalCents: final } = price;
  const estimateRow =
    estimate === null ? null : (
      <Fact key="estimate" label="Estimate" value={formatDocumentRequestPrice(estimate)} />
    );
  if (price.state === "awaiting_owner")
    return [<Fact key="price" label="Price" value="Set by the owner" />];
  if (price.state === "final" && final !== null)
    return [
      <Fact key="final" label="Final price" value={formatDocumentRequestPrice(final)} />,
      estimate !== final ? estimateRow : null,
    ];
  if (current === null) return [];
  if (price.state === "estimate")
    return [<Fact key="estimate" label="Estimate" value={formatDocumentRequestPrice(current)} />];
  return [
    <Fact key="price" label="Price" value={formatDocumentRequestPrice(current)} />,
    estimate !== current ? estimateRow : null,
  ];
}

function formatRequestedOn(value: string | null | undefined): string | null {
  if (!value) return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant)
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(instant)
    : null;
}

function accessTerm(status: SharingStatus): string | null {
  const days = status.approvedAccessDays ?? status.requestedAccessDays;
  if (!days) return null;
  const term = `${days} ${days === 1 ? "day" : "days"}`;
  const prefix = status.approvedAccessDays ? "Viewer for" : "Requested";
  if (!status.accessExpiresAt) return `${prefix} ${term}`;
  const expires = Date.parse(status.accessExpiresAt);
  if (!Number.isFinite(expires)) return `${prefix} ${term}`;
  const until = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(expires);
  return `${prefix} ${term} · until ${until}`;
}


function RequesterOutcome({
  counts,
  issues,
}: {
  counts: DriveBulkShareCounts;
  issues?: DriveBulkShareIssue[];
}) {
  const available = counts.shared + counts.alreadyShared;
  const rows = [
    [counts.shared, "newly shared"],
    [counts.alreadyShared, "already had access"],
    [counts.skipped, "not shared"],
    [counts.failed, "failed"],
    [counts.needsReview, "needs review"],
    [counts.unknown, "checking the outcome"],
    [counts.pending, "waiting to share"],
  ] as const;
  return (
    <div className="min-w-0 space-y-2" aria-label="Sharing outcomes">
      <BodyText>
        {available.toLocaleString()} of {counts.total.toLocaleString()} files available
      </BodyText>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {rows
          .filter(([count]) => count > 0)
          .map(([count, label]) => (
            <HelperText key={label}>
              {count.toLocaleString()} {label}
            </HelperText>
          ))}
      </div>
      {counts.total > available ? (
        <HelperText>Only confirmed available files appear here.</HelperText>
      ) : null}
      {issues?.length ? (
        <ul className="space-y-2" aria-label="Sharing issues">
          {issues.map((issue) => (
            <li key={issue.reasonCode}>
              <HelperText>
                {issue.count.toLocaleString()} {issue.count === 1 ? "file" : "files"}:{" "}
                {requesterIssueText(issue.reasonCode)}
              </HelperText>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Screen readers hear recovery changes only (review requested, owner
 * retrying, refund settled), never the row as it first appears. The row and
 * its button stay outside this region so they are not re-read on each update.
 */
function RecoveryAnnouncement({ announcement }: { announcement: string }) {
  const [spoken, setSpoken] = useState({ first: announcement, changed: false });
  if (!spoken.changed && announcement !== spoken.first) setSpoken({ ...spoken, changed: true });
  return (
    <span
      role="status"
      aria-live="polite"
      className="sr-only"
      data-testid="requester-recovery-announcement"
    >
      {spoken.changed || announcement !== spoken.first ? announcement : ""}
    </span>
  );
}

/**
 * The requester's request details: their own terms, the price, payment,
 * delivery and what happens to files that were not shared. Requester-safe
 * fields only; the Google account comes from the server, never providerData.
 */
export function DocumentRequestRequesterPanel({
  requestId,
  status,
  delivery,
  context,
  locked,
  surface,
  onCancel,
  onChanged,
}: DocumentRequestRequesterPanelProps) {
  const { getVaultOwnerToken } = useVault();
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<(string | null)[]>([]);
  const [page, setPage] = useState<SharingDeliveryFilePage | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState(false);
  const [pageRetry, setPageRetry] = useState(0);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const alive = useRef(true);
  const pageSerial = useRef(0);
  const pageKey = useRef("");
  const groupSurface =
    surface === "sheet" ? {} : { shellClassName: "rounded-none bg-transparent shadow-none" };
  const googleEmail = context?.recipientEmail ?? null;
  const price = status.price ?? delivery?.price ?? null;
  const bulkShareId = delivery?.bulkShareId ?? null;
  const sharedCount = delivery?.sharedCount ?? 0;
  const open = UNDECIDED.has(status.status) || status.status === "approved";

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      pageSerial.current += 1;
    };
  }, []);
  useEffect(() => {
    setCursor(null);
    setPrevious([]);
  }, [bulkShareId]);
  useEffect(() => {
    const ticket = ++pageSerial.current;
    if (!bulkShareId || sharedCount === 0) {
      pageKey.current = "";
      setPage(null);
      setPageError(false);
      return;
    }
    const token = getVaultOwnerToken();
    if (!token) {
      setPage(null);
      setPageError(true);
      return;
    }
    const epoch = snapshotVaultSessionEpoch();
    const guard = () => {
      if (
        !alive.current ||
        ticket !== pageSerial.current ||
        !isVaultSessionEpochCurrent(epoch) ||
        getVaultOwnerToken() !== token
      )
        throw new DriveSharingError("session_changed");
    };
    const key = `${bulkShareId}:${cursor ?? "first"}`;
    if (pageKey.current !== key) {
      pageKey.current = key;
      setPage(null);
    }
    setPageLoading(true);
    setPageError(false);
    void DriveSharingService.deliveryFiles(token, requestId, guard, cursor)
      .then((next) => {
        guard();
        setPage(next);
      })
      .catch(() => {
        try {
          guard();
        } catch {
          return;
        }
        setPage(null);
        setPageError(true);
      })
      .finally(() => {
        if (ticket === pageSerial.current) setPageLoading(false);
      });
    return () => {
      pageSerial.current += 1;
    };
  }, [getVaultOwnerToken, requestId, bulkShareId, sharedCount, cursor, pageRetry]);

  const askForReview = async () => {
    const token = getVaultOwnerToken();
    if (asking || !token) return;
    const epoch = snapshotVaultSessionEpoch();
    const guard = () => {
      if (!alive.current || !isVaultSessionEpochCurrent(epoch) || getVaultOwnerToken() !== token)
        throw new DriveSharingError("session_changed");
    };
    setAsking(true);
    setAskError(null);
    try {
      await DriveRequestRequesterService.reviewRequest(token, requestId, guard);
      onChanged();
    } catch (cause) {
      if (!alive.current) return;
      const code = cause instanceof DriveSharingError ? cause.code : "";
      if (code === "session_changed") return;
      setAskError(
        code === "review_limit_reached"
          ? "You've already asked three times."
          : code === "review_not_available"
            ? "There's nothing to review right now. Refresh to see the latest."
            : "Couldn't send your request. Try again.",
      );
      onChanged();
    } finally {
      if (alive.current) setAsking(false);
    }
  };

  const period =
    context?.purpose.periodStart && context.purpose.periodEnd
      ? `${context.purpose.periodStart} – ${context.purpose.periodEnd}`
      : null;
  // The picked dates always win over a longer span in the note.
  const periodNote = context && status.periodConflict === "request_mentions_longer_span"
    ? periodConflictNote(context.purpose.purpose, context.purpose.periodStart,
      context.purpose.periodEnd, "requester")
    : null;
  const requestedOn = formatRequestedOn(context?.requestedAt);
  const access = accessTerm(status);
  const prices = delivery?.noChargeReason === "existing_access"
    ? [<Fact key="no-charge" label="Payment" value="No charge" />]
    : priceFacts(price).filter(Boolean);
  const recovery = delivery?.recovery ?? null;
  const presented = recovery ? presentRequesterRecovery(recovery) : null;
  const sharedWith = googleEmail
    ? `Shared with ${googleEmail}. Open while signed in to that Google account.`
    : "Open while signed in to your linked Google account.";
  const free = !status.payment || status.payment.state === "none";

  return (
    <div className="consent-presentation-surface min-w-0 space-y-4" data-testid="document-request-requester-panel">
      {context || prices.length || access ? (
        <div role="group" aria-label="Your request" className="space-y-2">
          {context ? (
            <BodyText className="whitespace-pre-wrap [overflow-wrap:anywhere]">
              “{context.purpose.purpose}”
            </BodyText>
          ) : null}
          <dl className={HAIRLINES}>
            {period ? <Fact label="Period" value={period} /> : null}
            {access ? <Fact label="Access" value={access} /> : null}
            {requestedOn ? <Fact label="Requested" value={requestedOn} /> : null}
            {googleEmail ? <Fact label="Files shared with" value={googleEmail} /> : null}
            {prices}
          </dl>
          {periodNote ? <HelperText>{periodNote}</HelperText> : null}
        </div>
      ) : null}

      <RequesterPaymentSection
        requestId={requestId}
        revision={status.revision}
        payment={status.payment ?? null}
        price={status.price ?? null}
        packageDisclosure={context?.requestRevision === status.revision ? context.packageDisclosure ?? null : null}
        onChanged={onChanged}
      />

      {status.oneCopyRequested && (status.payment?.state === "paid" || status.payment?.state === "partially_refunded" || sharedCount > 0 || delivery?.files.some(file => file.openUrl)) ? <BackgroundDocumentLink requestId={requestId} /> : null}

      {delivery && !bulkShareId ? (
        <>
          {delivery.files.length > 0 ? (
            <SettingsGroup embedded title="Files" {...groupSurface}>
              {delivery.files.map((file, index) => (
                <SettingsRow
                  key={file.grantId ?? index}
                  title={file.name}
                  trailing={
                    file.openUrl ? (
                      <OriginalLink url={file.openUrl} googleEmail={googleEmail} />
                    ) : undefined
                  }
                />
              ))}
            </SettingsGroup>
          ) : open ? null : (
            <BodyText>Nothing was shared.</BodyText>
          )}
          {delivery.files.length > 0 ? <HelperText>{sharedWith}</HelperText> : null}
          {free && UNDECIDED.has(status.status) ? (
            <SettingsGroup embedded {...groupSurface}>
              <SettingsRow title="Cancel request" disabled={locked} onClick={onCancel} />
            </SettingsGroup>
          ) : null}
        </>
      ) : null}

      {delivery && bulkShareId ? (
        <>
          {delivery.noChargeReason === "existing_access" ? (
            <BodyText>These files were already available to you. No payment was needed.</BodyText>
          ) : null}
          {delivery.counts ? (
            <RequesterOutcome counts={delivery.counts} issues={delivery.issues} />
          ) : (
            <BodyText>
              {sharedCount.toLocaleString()} of {(delivery.fileCount ?? 0).toLocaleString()} files
              available
            </BodyText>
          )}
          {delivery.bulkStatus && ["queued", "running"].includes(delivery.bulkStatus) ? (
            <HelperText>Sharing continues after you leave.</HelperText>
          ) : null}
          {page?.files.length ? (
            <SettingsGroup
              embedded
              title="Available files"
              description="These links open the originals in Google Drive."
              {...groupSurface}
            >
              {page.files.map((file, index) => (
                <SettingsRow
                  key={file.grantId ?? index}
                  title={file.name}
                  trailing={
                    file.openUrl ? (
                      <OriginalLink url={file.openUrl} googleEmail={googleEmail} />
                    ) : undefined
                  }
                />
              ))}
            </SettingsGroup>
          ) : sharedCount === 0 && status.status === "approved" ? (
            <HelperText>Files appear as sharing finishes.</HelperText>
          ) : null}
          {pageLoading ? <HelperText>Loading files…</HelperText> : null}
          {pageError ? (
            <div>
              <HelperText role="alert">Couldn&apos;t load shared files.</HelperText>
              <Button data-consent-quiet-action="true" data-consent-role="compact-action" size="standard" variant="none" onClick={() => setPageRetry((value) => value + 1)}>
                Try again
              </Button>
            </div>
          ) : null}
          {previous.length || page?.nextCursor ? (
            <div className="flex flex-wrap gap-2">
              <Button data-consent-quiet-action="true" data-consent-role="compact-action"
                size="standard"
                variant="none"
                disabled={pageLoading || !previous.length}
                onClick={() => {
                  setCursor(previous.at(-1) ?? null);
                  setPrevious((items) => items.slice(0, -1));
                }}
              >
                Previous
              </Button>
              <Button data-consent-quiet-action="true" data-consent-role="compact-action"
                size="standard"
                variant="none"
                disabled={pageLoading || !page?.nextCursor}
                onClick={() => {
                  setPrevious((items) => [...items, cursor]);
                  setCursor(page?.nextCursor ?? null);
                }}
              >
                Next 25
              </Button>
            </div>
          ) : null}
          {page?.files.length ? <HelperText>{sharedWith}</HelperText> : null}
        </>
      ) : null}

      {recovery && presented ? (
        <>
          <SettingsGroup embedded testId="requester-recovery" {...groupSurface}>
            <SettingsRow
              title={<span className="tabular-nums">{presented.title}</span>}
              description={presented.line ?? undefined}
              trailingInteractive={presented.action === "request_review"}
              trailing={
                presented.action === "request_review" ? (
                  <Button data-consent-quiet-action="true" data-consent-role="compact-action"
                    size="standard"
                    variant="none"
                    disabled={locked || asking}
                    onClick={() => void askForReview()}
                  >
                    Request review
                  </Button>
                ) : undefined
              }
            />
          </SettingsGroup>
          <RecoveryAnnouncement
            announcement={[presented.title, presented.line].filter(Boolean).join(". ")}
          />
          {askError ? (
            <HelperText role="alert" className="px-1">
              {askError}
            </HelperText>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
