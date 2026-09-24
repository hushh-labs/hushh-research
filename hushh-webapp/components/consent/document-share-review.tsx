"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
} from "@/lib/vault/session-epoch";
import { useCoarseClock, usePeriodicTask } from "@/lib/perf/use-periodic-task";
import { Button } from "@/lib/morphy-ux/button";
import {
  BodyText,
  HelperText,
  MediumRowLabel,
} from "@/components/app-ui/typography";
import {
  FlowActionGroup,
  FlowSelectionSummary,
} from "@/components/app-ui/flow-actions";
import {
  DriveSharingError,
  DriveSharingService,
  type SharingStatus,
  type SharingReview,
  type SharingDelivery,
  type SharingRevocationReview,
} from "@/lib/services/drive-sharing-service";

type Snapshot = {
  status: SharingStatus;
  review?: SharingReview;
  delivery?: SharingDelivery;
  revocation?: SharingRevocationReview;
};
type SessionGuard = () => void;
const UNDECIDED = new Set(["pending", "preparing", "review_ready"]);
const OUTCOME_LABELS: Record<string, string> = {
  queued: "Waiting to share",
  dispatching: "Sharing pending",
  unknown: "Checking the outcome",
  succeeded: "Shared",
  preexisting: "Access already existed",
  present_unattributed: "Access found; not managed by One",
  rejected: "Could not share",
  not_dispatched: "Not shared",
  needs_review: "Review needed",
  removed: "Recorded access removed",
  absent: "Recorded access is absent",
};
const STATUS_LABELS: Record<string, string> = {
  pending: "Request pending",
  preparing: "Preparing suggestions",
  review_ready: "Ready for review",
  approved: "Sharing pending",
  declined: "Request declined",
  cancelled: "Request cancelled",
  expired: "Request expired",
  completed: "Sharing results",
  partial: "Some files were not shared",
  management_only: "Manage recorded access",
};

export function DocumentShareReview({
  requestId,
  onChanged,
}: {
  requestId: string;
  onChanged: () => void;
}) {
  const { user } = useAuth();
  const { isVaultUnlocked, getVaultOwnerToken } = useVault();
  if (!user || !isVaultUnlocked)
    return <BodyText role="status">Unlock your vault to review.</BodyText>;
  return (
    <UnlockedDocumentReview
      key={`${user.uid}:${requestId}:${snapshotVaultSessionEpoch()}`}
      requestId={requestId}
      getToken={getVaultOwnerToken}
      onChanged={onChanged}
    />
  );
}

function UnlockedDocumentReview({
  requestId,
  getToken,
  onChanged,
}: {
  requestId: string;
  getToken: () => string | null;
  onChanged: () => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trustFuture, setTrustFuture] = useState(false);
  // Files A left unticked for this review revision; every file starts selected.
  const [unselected, setUnselected] = useState<{ key: string; ids: string[] }>({
    key: "",
    ids: [],
  });
  const serial = useRef(0);
  const alive = useRef(false);
  const inFlight = useRef(false);
  const polls = useRef(0);
  const preparedRevision = useRef<number | null>(null);
  const statusTarget = useRef<HTMLDivElement>(null);
  const now = useCoarseClock(1000);

  const load = useCallback(
    async (token: string, guard: SessionGuard): Promise<Snapshot> => {
      guard();
      let status = await DriveSharingService.status(token, requestId, guard);
      if (status.direction === "incoming" && status.status === "pending" && preparedRevision.current !== status.revision) {
        preparedRevision.current = status.revision;
        await DriveSharingService.prepare(token, requestId, guard);
        guard();
        status = await DriveSharingService.status(token, requestId, guard);
      }
      guard();
      if (status.direction === "incoming" && UNDECIDED.has(status.status)) {
        return {
          status,
          review: await DriveSharingService.review(token, requestId, guard),
        };
      }
      return {
        status,
        delivery: await DriveSharingService.delivery(token, requestId, guard),
      };
    },
    [requestId],
  );

  const run = useCallback(
    async (
      action: (token: string, guard: SessionGuard) => Promise<Snapshot>,
      focusStatus = false,
    ) => {
      if (inFlight.current || !alive.current) return;
      const token = getToken();
      if (!token) {
        setSnapshot(null);
        return;
      }
      const epoch = snapshotVaultSessionEpoch();
      const operation = ++serial.current;
      const current = () =>
        alive.current &&
        operation === serial.current &&
        isVaultSessionEpochCurrent(epoch) &&
        getToken() === token;
      const guard = () => {
        if (!current()) throw new DriveSharingError("session_changed");
      };
      inFlight.current = true;
      setBusy(true);
      setError(null);
      // Keep the current presentation stable while all actions are disabled.
      try {
        guard();
        const result = await action(token, guard);
        if (!current()) return;
        setSnapshot(result);
      } catch (cause) {
        if (!current()) return;
        preparedRevision.current = null;
        // A failed refresh must never leave an old review actionable.
        setSnapshot(null);
        const code =
          cause instanceof DriveSharingError ? cause.code : "request_failed";
        setError(
          code === "review_changed" ||
            code === "source_changed" ||
            code === "recipient_changed"
            ? "This review changed. Refresh and review it again."
            : code === "verify_google_identity_required"
              ? "Verify your Google identity to continue."
              : code === "connection_required"
                ? "An active connection with this person is required. Check Connections, then retry."
                : code === "reconnect_required" || code === "connection_changed"
                  ? "Reconnect Drive in Connections, then retry."
                  : "Could not load the current result. Refresh before trying again.",
        );
      } finally {
        if (operation === serial.current) {
          inFlight.current = false;
          if (alive.current) {
            if (!current()) setSnapshot(null);
            setBusy(false);
            if (focusStatus && current()) statusTarget.current?.focus();
          }
        }
      }
    },
    [getToken],
  );

  const mutate = (
    action: (token: string, guard: SessionGuard) => Promise<unknown>,
  ) => {
    void run(async (token, guard) => {
      await action(token, guard);
      guard();
      // Acknowledged work is reconciled even when the next GET fails.
      onChanged();
      polls.current = 0;
      return load(token, guard);
    }, true);
  };

  useEffect(() => {
    alive.current = true;
    void run(load);
    return () => {
      alive.current = false;
      serial.current += 1;
      inFlight.current = false;
    };
  }, [load, run]);

  usePeriodicTask(
    `document-share-review:${requestId}`,
    5000,
    () => {
      if (polls.current++ < 24) return run(load);
      return undefined;
    },
    {
      enabled:
        !!snapshot &&
        !snapshot.revocation &&
        (["pending", "preparing", "approved"].includes(
          snapshot.status.status,
        ) ||
          !!snapshot.delivery?.files.some((file) =>
            ["queued", "dispatching", "unknown"].includes(
              file.revocationStatus ?? "",
            ),
          )),
    },
  );

  const review = snapshot?.review;
  useEffect(() => setTrustFuture(false), [review?.reviewDigest]);
  const removal = snapshot?.revocation;
  const canApprove =
    !!review?.canApprove &&
    !!review.expiresAt &&
    Date.parse(review.expiresAt) > now;
  // A new review revision starts with every file selected again.
  const reviewKey = review ? `${review.revision}:${review.reviewDigest}` : "";
  const unselectedIds = unselected.key === reviewKey ? unselected.ids : [];
  const selectedIds = (review?.files ?? [])
    .map((file) => file.documentId)
    .filter((id) => !unselectedIds.includes(id));
  const allSelected = !!review && selectedIds.length === review.files.length;
  const refresh = () => {
    polls.current = 0;
    void run(load);
  };
  const decide = (action: "decline" | "cancel" | "review/refresh") => {
    if (!snapshot) return;
    const revision = review?.revision ?? snapshot.status.revision;
    mutate((token, guard) =>
      DriveSharingService.decide(token, requestId, action, revision, guard),
    );
  };

  return (
    <section
      aria-label="Document sharing review"
      className="min-w-0 space-y-4 break-words"
      data-testid="document-share-review"
      aria-busy={busy}
    >
      <div ref={statusTarget} tabIndex={-1} role="status" aria-live="polite">
        <BodyText>
          {busy
            ? "Checking document request…"
            : snapshot
              ? (STATUS_LABELS[snapshot.status.status] ??
                "Check request status")
              : "Document request"}
        </BodyText>
      </div>
      {error ? <HelperText role="alert">{error}</HelperText> : null}
      {review ? (
        <>
          <dl className="grid min-w-0 gap-3">
            <div>
              <HelperText as="dt">Share with</HelperText>
              <BodyText as="dd" className="break-all">
                {review.recipientEmail}
              </BodyText>
            </div>
            <div>
              <HelperText as="dt">Purpose</HelperText>
              <BodyText as="dd">{review.purpose.purpose}</BodyText>
            </div>
            {review.purpose.periodStart ? (
              <div>
                <HelperText as="dt">Requested period</HelperText>
                <BodyText as="dd">
                  {review.purpose.periodStart} – {review.purpose.periodEnd}
                </BodyText>
              </div>
            ) : null}
            <div>
              <HelperText as="dt">Access</HelperText>
              <BodyText as="dd">Viewer · Until you remove access</BodyText>
            </div>
          </dl>
          {review.files.length > 1 ? (
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={selectedIds.length === review.files.length}
                disabled={busy || !canApprove}
                onChange={(event) =>
                  setUnselected({
                    key: reviewKey,
                    ids: event.target.checked
                      ? []
                      : review.files.map((file) => file.documentId),
                  })
                }
              />
              <span>Select all</span>
            </label>
          ) : null}
          <ul aria-label="Exact files to share" className="min-w-0 space-y-2">
            {review.files.map((file) => (
              <li key={file.documentId}>
                <label className="flex min-h-11 min-w-0 items-center gap-3">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(file.documentId)}
                    disabled={busy || !canApprove}
                    onChange={(event) =>
                      setUnselected({
                        key: reviewKey,
                        ids: event.target.checked
                          ? unselectedIds.filter((id) => id !== file.documentId)
                          : [...unselectedIds, file.documentId],
                      })
                    }
                  />
                  <MediumRowLabel className="min-w-0 break-all">
                    {file.name}
                  </MediumRowLabel>
                </label>
              </li>
            ))}
          </ul>
          {review.coverage ? (
            <div>
              <HelperText as="p">
                Coverage assessment:{" "}
                {review.coverage.gaps.length > 0 ||
                review.coverage.status === "partial"
                  ? "Partial"
                  : review.coverage.status === "complete"
                    ? "Complete — review the originals"
                    : "Unknown"}
              </HelperText>
              <BodyText>{review.coverage.summary}</BodyText>
              {review.coverage.gaps.length > 0 ? (
                <ul
                  aria-label="Missing coverage"
                  className="list-inside list-disc"
                >
                  {review.coverage.gaps.map((gap, index) => (
                    <li key={index}>
                      <HelperText>{gap}</HelperText>
                    </li>
                  ))}
                </ul>
              ) : null}
              {review.coverage.truncated ? (
                <HelperText>
                  Only part of the selected information was inspected.
                </HelperText>
              ) : null}
            </div>
          ) : (
            <HelperText>
              {review.status === "review_ready" &&
              review.preparationError === "no_relevant_files"
                ? "Your private agent didn't find files that look like what they asked for. You can decline, or refresh after adding the files."
                : review.preparationError === "no_ready_files"
                  ? "Matching files couldn't be read, for example password-protected or scanned PDFs."
                  : "Suggestions are not ready yet."}
            </HelperText>
          )}
          <HelperText>
            Original files stay in Google Drive. Later edits remain visible to
            this person.
          </HelperText>
          <FlowSelectionSummary
            label="Files"
            value={selectedIds.length}
            detail="Viewer access"
          />
          {!canApprove &&
          !(
            review.coverage == null &&
            review.status === "review_ready" &&
            review.preparationError === "no_relevant_files"
          ) ? (
            <HelperText>Refresh suggestions before sharing.</HelperText>
          ) : null}
          {review.canTrustFutureRequests ? (
            <label className="flex items-start gap-3 text-sm">
              <input type="checkbox" checked={trustFuture && allSelected} disabled={busy || !canApprove || !allSelected}
                onChange={(event) => setTrustFuture(event.target.checked)} />
              <span>Trust {review.recipientEmail} for any requested Drive file, including future files. One may share matching files without asking again, including while you’re away when background preparation is enabled. You can stop future sharing anytime.</span>
            </label>
          ) : null}
          <FlowActionGroup
            primary={
              <Button
                size="prominent"
                disabled={busy || !canApprove || selectedIds.length === 0}
                onClick={() =>
                  mutate((token, guard) => trustFuture && allSelected
                    ? DriveSharingService.approve(token, requestId, review, guard, true, "any_requested_drive_file", selectedIds)
                    : DriveSharingService.approve(token, requestId, review, guard, false, undefined, selectedIds))
                }
              >
                {allSelected ? "Share files" : `Share ${selectedIds.length} of ${review.files.length} files`}
              </Button>
            }
            secondary={
              <Button
                size="standard"
                variant="none"
                disabled={busy}
                onClick={() => decide("decline")}
              >
                Decline
              </Button>
            }
            tertiary={
              <Button
                size="standard"
                variant="none"
                disabled={busy}
                onClick={() => decide("review/refresh")}
              >
                Refresh suggestions
              </Button>
            }
          />
        </>
      ) : null}
      {snapshot?.delivery ? (
        <>
          {snapshot.delivery.files.length === 0 ? (
            <HelperText>No shared files are available here.</HelperText>
          ) : null}
          <ul aria-label="Sharing results" className="min-w-0 space-y-3">
            {snapshot.delivery.files.map((file, index) => (
              <li key={file.grantId ?? index} className="min-w-0">
                <MediumRowLabel as="p" className="break-all">
                  {file.name}
                </MediumRowLabel>
                <HelperText as="p">
                  {OUTCOME_LABELS[file.status] ?? "Check status"}
                </HelperText>
                {file.revocationStatus && file.status !== "removed" ? (
                  <HelperText as="p">
                    Removal:{" "}
                    {file.revocationStatus === "queued" ||
                    file.revocationStatus === "dispatching"
                      ? "pending"
                      : "check the latest result"}
                  </HelperText>
                ) : null}
                {file.openUrl ? (
                  <a
                    href={file.openUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    referrerPolicy="no-referrer"
                    className="inline-flex min-h-11 items-center text-[color:var(--app-accent)] underline"
                  >
                    Open in Google Drive
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
          {snapshot.status.direction === "outgoing" ? (
            <HelperText>
              Open with the Google identity approved for this request. To ask
              One questions, connect your own Drive and select these files.
            </HelperText>
          ) : (
            <>
              <HelperText>
                Disconnecting Drive does not remove Google access. Other
                existing access may remain after removal.
              </HelperText>
              {!removal &&
              snapshot.delivery.files.some(
                (file) => file.managed && file.status !== "removed",
              ) ? (
                <Button
                  size="standard"
                  variant="none"
                  disabled={busy}
                  onClick={() =>
                    void run(async (token, guard) => ({
                      ...snapshot,
                      revocation: await DriveSharingService.prepareRevocation(
                        token,
                        requestId,
                        guard,
                      ),
                    }))
                  }
                >
                  Review removal
                </Button>
              ) : null}
              <a
                href="https://drive.google.com"
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
                className="inline-flex min-h-11 items-center underline"
              >
                Manage in Google Drive
              </a>
            </>
          )}
          {snapshot.status.direction === "outgoing" &&
          UNDECIDED.has(snapshot.status.status) ? (
            <Button
              size="standard"
              variant="none"
              disabled={busy}
              onClick={() => decide("cancel")}
            >
              Cancel request
            </Button>
          ) : null}
        </>
      ) : null}
      {removal ? (
        <>
          <ul aria-label="Exact access to remove" className="space-y-3">
            {removal.files.map((file) => (
              <li key={file.grantId}>
                <MediumRowLabel as="p" className="break-all">
                  {file.name}
                </MediumRowLabel>
                <HelperText className="break-all">
                  {file.recipientEmail}
                </HelperText>
              </li>
            ))}
          </ul>
          <HelperText>
            Remove only the recorded Viewer access. Other permissions may still
            allow access.
          </HelperText>
          <FlowActionGroup
            primary={
              <Button
                size="prominent"
                variant="destructive"
                disabled={busy || Date.parse(removal.expiresAt) <= now}
                onClick={() =>
                  mutate((token, guard) =>
                    DriveSharingService.revoke(
                      token,
                      requestId,
                      removal,
                      guard,
                    ),
                  )
                }
              >
                Remove access
              </Button>
            }
            secondary={
              <Button size="standard" variant="none" onClick={refresh}>
                Cancel
              </Button>
            }
          />
        </>
      ) : null}
      <Button size="standard" variant="none" disabled={busy} onClick={refresh}>
        Refresh status
      </Button>
    </section>
  );
}
