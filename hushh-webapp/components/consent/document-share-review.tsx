"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ExternalLink, Loader2 } from "@/components/icons";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
} from "@/lib/vault/session-epoch";
import { useCoarseClock, usePeriodicTask } from "@/lib/perf/use-periodic-task";
import { Button } from "@/lib/morphy-ux/button";
import { cn } from "@/lib/utils";
import {
  BodyText,
  HelperText,
  MediumRowLabel,
} from "@/components/app-ui/typography";
import { FlowActionGroup } from "@/components/app-ui/flow-actions";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import {
  DriveSharingError,
  DriveSharingService,
  StreamUnavailable,
  type PrepareStage,
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
/** What the sheet is doing right now; "idle" means only background polls. */
type Activity =
  | "idle"
  | "loading"
  | "finding_files"
  | "sharing"
  | "declining"
  | "cancelling"
  | "restarting"
  | "preparing_removal"
  | "removing";
type Kind = "load" | "decide";
/** Per-run channel; every call is a no-op once the run is stale. */
type Report = {
  publish: (next: Snapshot) => void;
  enter: () => void;
  stage: (stage: PrepareStage | null) => void;
  acknowledged: () => void;
  signal: AbortSignal;
};
type Action = (
  token: string,
  guard: SessionGuard,
  report: Report,
) => Promise<Snapshot>;

const POLL_MS = 5000;
const POLL_BUDGET = 24;
const SLOW_AFTER_MS = 15_000;
const UNDECIDED = new Set(["pending", "preparing", "review_ready"]);
const IN_FLIGHT = new Set(["queued", "dispatching", "unknown"]);
const OUTCOME_LABELS: Record<string, string> = {
  queued: "Waiting to share",
  dispatching: "Sharing pending",
  unknown: "Checking the outcome",
  succeeded: "Shared",
  preexisting: "Access already existed",
  present_unattributed: "Access exists outside your private agent",
  rejected: "Could not share",
  not_dispatched: "Not shared",
  needs_review: "Review needed",
  removed: "Recorded access removed",
  absent: "Recorded access is absent",
};
const STATUS_LABELS: Record<string, string> = {
  pending: "Request pending",
  preparing: "Finding files",
  review_ready: "Ready for review",
  approved: "Sharing pending",
  declined: "Request declined",
  cancelled: "Request cancelled",
  expired: "Request expired",
  completed: "Sharing results",
  partial: "Some files were not shared",
  management_only: "Manage recorded access",
};
const ACTIVITY_LABELS: Record<Exclude<Activity, "idle" | "finding_files">, string> = {
  loading: "Loading request…",
  sharing: "Sharing…",
  declining: "Declining…",
  cancelling: "Cancelling…",
  restarting: "Starting a new search…",
  preparing_removal: "Preparing removal…",
  removing: "Removing access…",
};
const STAGE_LABELS: Record<PrepareStage, string> = {
  starting: "Finding files…",
  searching: "Searching Drive…",
  choosing: "Choosing files…",
  checking: "Checking coverage…",
};
const TRUST_DESCRIPTION =
  "Your private agent shares any Drive file they request, including future files, without asking. This can happen while you’re away if background preparation is on. You can stop future sharing anytime.";
const CHECKBOX_CLASS = "size-5 border-2 border-foreground/40";

/** A transport failure is retried by reading status; anything the server said is not. */
function isHard(cause: unknown): boolean {
  if (!(cause instanceof DriveSharingError)) return false;
  if (cause.code === "invalid_response") return false;
  if (cause.code === "request_failed")
    return cause.status > 0 && cause.status < 500;
  return true;
}

function errorCopy(cause: unknown): string {
  const code =
    cause instanceof DriveSharingError ? cause.code : "request_failed";
  if (
    code === "review_changed" ||
    code === "source_changed" ||
    code === "recipient_changed"
  )
    return "This review changed. Refresh and review it again.";
  if (code === "verify_google_identity_required")
    return "Verify your Google identity to continue.";
  if (code === "connection_required")
    return "Connect with this person first, then retry.";
  if (code === "reconnect_required" || code === "connection_changed")
    return "Reconnect Drive in Connections, then retry.";
  return "Refresh to try again.";
}

/** The private agent is still looking for files for this incoming request. */
function isFinding(snapshot: Snapshot | null): boolean {
  const review = snapshot?.review;
  return (
    !!review &&
    snapshot?.status.direction === "incoming" &&
    (review.status === "pending" || review.status === "preparing") &&
    !review.preparationError
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-h-11 items-start justify-between gap-4 py-2.5">
      <HelperText as="dt" className="shrink-0">
        {label}
      </HelperText>
      <BodyText as="dd" className="min-w-0 text-right [overflow-wrap:anywhere]">
        {value}
      </BodyText>
    </div>
  );
}

const HAIRLINES = "divide-y divide-border/60 border-y border-border/60";

export function DocumentShareReview({
  requestId,
  onChanged,
  surface = "inline",
}: {
  requestId: string;
  onChanged: () => void;
  /**
   * "sheet": the consent sheet paints a grouped background, so actionable
   * sections read as cards. "inline": the host is already a card (chat), so
   * sections stay flat rows.
   */
  surface?: "sheet" | "inline";
}) {
  const { user } = useAuth();
  // Viewer access goes to the Google account linked to this One sign-in, so
  // the recipient opens each original as that account, not the browser default.
  const googleEmail =
    user?.providerData?.find((provider) => provider?.providerId === "google.com")?.email ?? null;
  const { isVaultUnlocked, getVaultOwnerToken } = useVault();
  if (!user || !isVaultUnlocked)
    return <BodyText role="status">Unlock your vault to review.</BodyText>;
  return (
    <UnlockedDocumentReview
      key={`${user.uid}:${requestId}:${snapshotVaultSessionEpoch()}`}
      requestId={requestId}
      getToken={getVaultOwnerToken}
      onChanged={onChanged}
      googleEmail={googleEmail}
      surface={surface}
    />
  );
}

function UnlockedDocumentReview({
  requestId,
  getToken,
  onChanged,
  googleEmail,
  surface,
}: {
  requestId: string;
  getToken: () => string | null;
  onChanged: () => void;
  googleEmail: string | null;
  surface: "sheet" | "inline";
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [activity, setActivity] = useState<Activity>("loading");
  const [stage, setStage] = useState<PrepareStage | null>(null);
  const [findingSince, setFindingSince] = useState<number | null>(null);
  const [stalled, setStalled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trustFuture, setTrustFuture] = useState(false);
  // Files A left unticked for this review revision; every file starts selected.
  const [unselected, setUnselected] = useState<{ key: string; ids: string[] }>({
    key: "",
    ids: [],
  });
  const serial = useRef(0);
  const alive = useRef(false);
  // A decision is never overlapped; it may supersede a load, a search included.
  const busy = useRef<"none" | Kind>("none");
  // The in-flight run is a background poll the person never asked for.
  const quiet = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const polls = useRef(0);
  const lastStatusKey = useRef("");
  const preparedRevision = useRef<number | null>(null);
  const statusTarget = useRef<HTMLDivElement>(null);
  const trustTitleId = useId();
  const trustDescriptionId = useId();
  const now = useCoarseClock(1000);

  const apply = useCallback((next: Snapshot | null) => {
    setSnapshot(next);
    if (!next) setStage(null);
    setFindingSince((previous) =>
      isFinding(next) ? (previous ?? Date.now()) : null,
    );
    // Real progress refills the poll budget.
    const key = next ? `${next.status.status}:${next.status.revision}` : "";
    if (key !== lastStatusKey.current) {
      lastStatusKey.current = key;
      polls.current = 0;
      setStalled(false);
    }
  }, []);

  const load = useCallback<Action>(
    async (token, guard, report) => {
      guard();
      let status = await DriveSharingService.status(token, requestId, guard);
      guard();
      if (status.direction !== "incoming" || !UNDECIDED.has(status.status))
        return {
          status,
          delivery: await DriveSharingService.delivery(token, requestId, guard),
        };
      const review = await DriveSharingService.review(token, requestId, guard);
      guard();
      // Worker-held, ready, or already tried for this revision: no search.
      if (
        status.status !== "pending" ||
        preparedRevision.current === status.revision
      )
        return { status, review };
      // Who asked and why render now; files follow when the search ends.
      report.publish({ status, review });
      preparedRevision.current = status.revision;
      report.enter();
      let posted = false;
      let answered = false;
      // At most one fallback POST per revision; the server lease allows one claim.
      const post = async () => {
        posted = true;
        try {
          await DriveSharingService.prepare(token, requestId, guard);
        } catch (cause) {
          guard();
          if (isHard(cause)) throw cause;
        }
      };
      try {
        const outcome = await DriveSharingService.prepareStream(
          token,
          requestId,
          guard,
          { onStage: report.stage, signal: report.signal },
        );
        answered = outcome !== "interrupted";
      } catch (cause) {
        guard();
        if (cause instanceof StreamUnavailable) await post();
        else if (isHard(cause)) throw cause;
      }
      report.stage(null);
      guard();
      status = await DriveSharingService.status(token, requestId, guard);
      guard();
      // The stream never reached the server: ask once the plain way.
      if (!posted && !answered && status.status === "pending") {
        await post();
        guard();
        status = await DriveSharingService.status(token, requestId, guard);
        guard();
      }
      // A trust rule can approve during preparation.
      if (status.direction !== "incoming" || !UNDECIDED.has(status.status))
        return {
          status,
          delivery: await DriveSharingService.delivery(token, requestId, guard),
        };
      return {
        status,
        review: await DriveSharingService.review(token, requestId, guard),
      };
    },
    [requestId],
  );

  const run = useCallback(
    async (
      action: Action,
      kind: Kind,
      presentation: Activity | null,
      focusStatus = false,
    ) => {
      if (!alive.current || busy.current === "decide") return;
      // A click supersedes a quiet poll; loads otherwise never overlap.
      if (kind === "load" && busy.current === "load" && !(presentation && quiet.current))
        return;
      const token = getToken();
      if (!token) {
        // Nothing can load without the owner token; say so instead of spinning.
        apply(null);
        setError("Unlock your vault to review.");
        setActivity("idle");
        return;
      }
      const epoch = snapshotVaultSessionEpoch();
      const operation = ++serial.current;
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      const current = () =>
        alive.current &&
        operation === serial.current &&
        isVaultSessionEpochCurrent(epoch) &&
        getToken() === token;
      const guard = () => {
        if (!current()) throw new DriveSharingError("session_changed");
      };
      let focused = false;
      const report: Report = {
        publish: (next) => {
          if (current()) apply(next);
        },
        enter: () => {
          if (!current()) return;
          // A long search never blocks Decline, and it is no longer quiet.
          busy.current = "load";
          quiet.current = false;
          setStage(null);
          setActivity("finding_files");
          setFindingSince((previous) => previous ?? Date.now());
        },
        stage: (next) => {
          if (current()) setStage(next);
        },
        // Accepted work is announced now, not after a search that may follow.
        acknowledged: () => {
          if (!focusStatus || focused || !current()) return;
          focused = true;
          statusTarget.current?.focus();
        },
        signal: abort.signal,
      };
      busy.current = kind;
      quiet.current = presentation === null;
      // Polls pass no presentation: nothing on screen changes while they run.
      if (presentation) {
        setActivity(presentation);
        setError(null);
      }
      try {
        guard();
        const result = await action(token, guard, report);
        if (!current()) return;
        apply(result);
      } catch (cause) {
        if (!current()) return;
        preparedRevision.current = null;
        // A failed read never leaves a review on screen, full or partial.
        apply(null);
        setError(errorCopy(cause));
      } finally {
        if (operation === serial.current) {
          busy.current = "none";
          controller.current = null;
          if (alive.current) {
            if (!current()) apply(null);
            setActivity("idle");
            setStage(null);
            if (
              focusStatus &&
              current() &&
              (!focused || document.activeElement === document.body)
            )
              statusTarget.current?.focus();
          }
        }
      }
    },
    [apply, getToken],
  );

  const mutate = (
    action: (token: string, guard: SessionGuard) => Promise<unknown>,
    presentation: Activity,
  ) => {
    void run(
      async (token, guard, report) => {
        await action(token, guard);
        guard();
        // Acknowledged work is reconciled even when the next GET fails.
        onChanged();
        report.acknowledged();
        polls.current = 0;
        setStalled(false);
        return load(token, guard, report);
      },
      "decide",
      presentation,
      true,
    );
  };

  useEffect(() => {
    alive.current = true;
    void run(load, "load", "loading");
    const operations = serial;
    const prepared = preparedRevision;
    const pending = controller;
    return () => {
      alive.current = false;
      operations.current += 1;
      busy.current = "none";
      pending.current?.abort();
      pending.current = null;
      // A remount may ask again; the server lease keeps it to one claim.
      prepared.current = null;
    };
  }, [load, run]);

  const review = snapshot?.review;
  const removal = snapshot?.revocation;
  // Stays true while a decision or refresh runs, so the layout never jumps.
  const finding = activity === "finding_files" || isFinding(snapshot);
  const stillWorking = finding && activity === "idle" && stalled;
  // A retryable failure: the worker tries again in minutes, so polling can't see it.
  const retryLater =
    !!review &&
    snapshot?.status.direction === "incoming" &&
    review.status === "pending" &&
    !!review.preparationError;
  const pendingOutcomes = !!snapshot?.delivery?.files.some(
    (file) =>
      IN_FLIGHT.has(file.status) || IN_FLIGHT.has(file.revocationStatus ?? ""),
  );
  const pollable =
    !!snapshot &&
    !removal &&
    !retryLater &&
    (["pending", "preparing", "approved"].includes(snapshot.status.status) ||
      !!snapshot.delivery?.files.some((file) =>
        IN_FLIGHT.has(file.revocationStatus ?? ""),
      ));

  usePeriodicTask(
    `document-share-review:${requestId}`,
    POLL_MS,
    () => {
      // A tick that cannot run never spends the budget.
      if (busy.current !== "none") return undefined;
      if (polls.current++ < POLL_BUDGET) return run(load, "load", null);
      setStalled(true);
      return undefined;
    },
    { enabled: pollable && !stalled && activity === "idle" },
  );

  useEffect(() => setTrustFuture(false), [review?.reviewDigest]);
  const locked = activity !== "idle" && activity !== "finding_files";
  const canApprove =
    !finding &&
    review?.status === "review_ready" &&
    !!review.canApprove &&
    !!review.expiresAt &&
    Date.parse(review.expiresAt) > now;
  // A new review revision starts with every file selected again.
  const reviewKey = review ? `${review.revision}:${review.reviewDigest}` : "";
  const unselectedIds = unselected.key === reviewKey ? unselected.ids : [];
  const selectedIds = (review?.files ?? [])
    .map((file) => file.documentId)
    .filter((id) => !unselectedIds.includes(id));
  const allSelected = !!review && selectedIds.length === review.files.length;
  const groupSurface =
    surface === "sheet"
      ? {}
      : { shellClassName: "rounded-none bg-transparent shadow-none" };

  const refresh = () => {
    void run(
      async (token, guard, report) => {
        polls.current = 0;
        setStalled(false);
        // An explicit refresh may retry a search once.
        preparedRevision.current = null;
        return load(token, guard, report);
      },
      "load",
      "loading",
    );
  };
  const decide = (action: "decline" | "cancel" | "review/refresh") => {
    if (!snapshot) return;
    const revision = review?.revision ?? snapshot.status.revision;
    mutate(
      (token, guard) =>
        DriveSharingService.decide(token, requestId, action, revision, guard),
      action === "decline"
        ? "declining"
        : action === "cancel"
          ? "cancelling"
          : "restarting",
    );
  };
  const prepareRemoval = () => {
    if (!snapshot) return;
    const shown = snapshot;
    void run(
      async (token, guard) => ({
        ...shown,
        revocation: await DriveSharingService.prepareRevocation(
          token,
          requestId,
          guard,
        ),
      }),
      "decide",
      "preparing_removal",
    );
  };

  const statusLine =
    activity === "loading"
      ? ACTIVITY_LABELS.loading
      : activity === "finding_files"
        ? STAGE_LABELS[stage ?? "starting"]
        : activity !== "idle"
          ? ACTIVITY_LABELS[activity]
          : !snapshot
            ? error
              ? "Couldn't load request"
              : ACTIVITY_LABELS.loading
            : stillWorking
              ? "Still finding files"
              : finding
                ? STAGE_LABELS.starting
                : retryLater
                  ? "Search didn't finish"
                  : (STATUS_LABELS[snapshot.status.status] ??
                    "Check request status");
  const spinning =
    activity !== "idle" || (finding && !stillWorking) || (!snapshot && !error);
  const statusHint = stillWorking
    ? "Check again in a minute."
    : finding &&
        (activity === "idle" || activity === "finding_files") &&
        findingSince !== null &&
        now - findingSince >= SLOW_AFTER_MS
      ? "This can take a minute."
      : null;
  // For the requester, approved means grants are still being delivered.
  const outgoingOpen =
    snapshot?.status.direction === "outgoing" &&
    (UNDECIDED.has(snapshot.status.status) ||
      snapshot.status.status === "approved");
  const showRefreshStatus =
    !removal && (!snapshot || stalled || pendingOutcomes || outgoingOpen);
  const delivery = snapshot?.delivery;
  const outgoing = snapshot?.status.direction === "outgoing";

  return (
    <section
      aria-label="Document sharing review"
      className="min-w-0 space-y-4 break-words"
      data-testid="document-share-review"
    >
      {/* The one status node: fixed position, never keyed, so focus survives. */}
      <div
        ref={statusTarget}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        className="min-w-0"
      >
        <div className="flex min-h-6 items-center gap-2">
          {spinning ? (
            <Loader2
              aria-hidden="true"
              className="h-4 w-4 shrink-0 text-muted-foreground motion-safe:animate-spin"
            />
          ) : null}
          <BodyText as="span">{statusLine}</BodyText>
        </div>
        {statusHint ? (
          <HelperText as="span" className="mt-0.5 block">
            {statusHint}
          </HelperText>
        ) : null}
      </div>
      {error ? <HelperText role="alert">{error}</HelperText> : null}

      {!snapshot && !error ? (
        <div aria-hidden="true" className="space-y-4">
          <Skeleton className="h-5 w-2/3 rounded" />
          <div className={HAIRLINES}>
            {[0, 1, 2].map((index) => (
              <div
                key={index}
                className="flex min-h-11 items-center justify-between gap-4 py-2.5"
              >
                <Skeleton className="h-3.5 w-16 rounded" />
                <Skeleton className="h-3.5 w-36 rounded" />
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {review && !removal ? (
        <>
          <BodyText className="whitespace-pre-wrap [overflow-wrap:anywhere]">
            “{review.purpose.purpose}”
          </BodyText>
          <dl className={HAIRLINES}>
            <Fact label="Share with" value={review.recipientEmail} />
            {review.purpose.periodStart ? (
              <Fact
                label="Period"
                value={`${review.purpose.periodStart} – ${review.purpose.periodEnd}`}
              />
            ) : null}
            <Fact label="Access" value="Viewer, until removed" />
          </dl>

          {finding || review.files.length > 0 ? (
            <div aria-busy={finding || undefined}>
              <SettingsGroup
                embedded
                title="Files"
                description={
                  <HelperText as="span">
                    Originals stay in Drive. The recipient sees later edits.
                  </HelperText>
                }
                {...groupSurface}
              >
                {finding
                  ? [0, 1, 2].map((index) => (
                      <div
                        key={index}
                        aria-hidden="true"
                        className="flex min-h-[56px] items-center justify-between gap-4 px-[var(--settings-row-px)]"
                      >
                        <Skeleton
                          className={cn(
                            "h-4 rounded",
                            index === 1 ? "w-2/5" : "w-3/5",
                            stillWorking && "motion-safe:animate-none",
                          )}
                        />
                        <Skeleton
                          className={cn(
                            "size-5 rounded-[4px]",
                            stillWorking && "motion-safe:animate-none",
                          )}
                        />
                      </div>
                    ))
                  : [
                      review.files.length > 1 ? (
                        <SettingsRow
                          key="all"
                          asChild
                          className="motion-step-enter"
                          title="Select all"
                          disabled={locked || !canApprove}
                          trailing={
                            <Checkbox
                              aria-label="Select all"
                              className={CHECKBOX_CLASS}
                              checked={allSelected}
                              disabled={locked || !canApprove}
                              onCheckedChange={(checked) =>
                                setUnselected({
                                  key: reviewKey,
                                  ids:
                                    checked === true
                                      ? []
                                      : review.files.map(
                                          (file) => file.documentId,
                                        ),
                                })
                              }
                            />
                          }
                        >
                          <label className="cursor-pointer" />
                        </SettingsRow>
                      ) : null,
                      ...review.files.map((file) => (
                        <SettingsRow
                          key={file.documentId}
                          asChild
                          className="motion-step-enter"
                          title={file.name}
                          disabled={locked || !canApprove}
                          trailing={
                            <Checkbox
                              aria-label={file.name}
                              className={CHECKBOX_CLASS}
                              checked={selectedIds.includes(file.documentId)}
                              disabled={locked || !canApprove}
                              onCheckedChange={(checked) =>
                                setUnselected({
                                  key: reviewKey,
                                  ids:
                                    checked === true
                                      ? unselectedIds.filter(
                                          (id) => id !== file.documentId,
                                        )
                                      : [...unselectedIds, file.documentId],
                                })
                              }
                            />
                          }
                        >
                          <label className="cursor-pointer" />
                        </SettingsRow>
                      )),
                    ]}
              </SettingsGroup>
            </div>
          ) : null}

          {!finding && review.coverage ? (
            <section aria-label="Coverage">
              <dl className={HAIRLINES}>
                <Fact
                  label="Coverage"
                  value={
                    review.coverage.gaps.length > 0 ||
                    review.coverage.status === "partial"
                      ? "Partial"
                      : review.coverage.status === "complete"
                        ? "Looks complete"
                        : "Unknown"
                  }
                />
              </dl>
              <HelperText className="pt-2">{review.coverage.summary}</HelperText>
              {review.coverage.gaps.length > 0 || review.coverage.truncated ? (
                <ul
                  aria-label="Missing coverage"
                  className="mt-1 divide-y divide-border/60"
                >
                  {review.coverage.gaps.map((gap, index) => (
                    <li key={index} className="py-2">
                      <HelperText as="span" className="[overflow-wrap:anywhere]">
                        {gap}
                      </HelperText>
                    </li>
                  ))}
                  {review.coverage.truncated ? (
                    <li className="py-2">
                      <HelperText as="span">Files were only partly read.</HelperText>
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </section>
          ) : null}

          {!finding && review.files.length === 0 ? (
            review.preparationError === "no_relevant_files" ? (
              <div>
                <BodyText>Your private agent found no matching files.</BodyText>
                <HelperText>Add them to Drive, then refresh.</HelperText>
              </div>
            ) : review.preparationError === "no_ready_files" ? (
              <BodyText>
                Matching files couldn&apos;t be read, for example
                password-protected or scanned PDFs.
              </BodyText>
            ) : review.preparationError === "preparation_unavailable" ? (
              <BodyText>Couldn&apos;t prepare suggestions.</BodyText>
            ) : (
              <BodyText>Suggestions are not ready yet.</BodyText>
            )
          ) : null}

          {!finding && review.canTrustFutureRequests ? (
            <SettingsGroup embedded {...groupSurface}>
              <SettingsRow
                asChild
                disabled={locked || !canApprove || !allSelected}
                title={
                  <span id={trustTitleId}>
                    Trust {review.recipientEmail} for future requests
                  </span>
                }
                description={
                  <HelperText as="span" id={trustDescriptionId}>
                    {TRUST_DESCRIPTION}
                  </HelperText>
                }
                trailing={
                  <Checkbox
                    aria-labelledby={trustTitleId}
                    aria-describedby={trustDescriptionId}
                    className={CHECKBOX_CLASS}
                    checked={trustFuture && allSelected}
                    disabled={locked || !canApprove || !allSelected}
                    onCheckedChange={(checked) =>
                      setTrustFuture(checked === true)
                    }
                  />
                }
              >
                <label className="cursor-pointer" />
              </SettingsRow>
            </SettingsGroup>
          ) : null}

          {!finding && review.files.length > 0 && !canApprove ? (
            <HelperText>Refresh suggestions before sharing.</HelperText>
          ) : null}

          {finding ? (
            <FlowActionGroup
              primary={
                <Button size="prominent" disabled>
                  Share files
                </Button>
              }
              secondary={
                <Button
                  size="standard"
                  variant="none"
                  disabled={locked}
                  onClick={() => decide("decline")}
                >
                  Decline
                </Button>
              }
            />
          ) : review.files.length === 0 ? (
            <FlowActionGroup
              primary={
                <Button
                  size="prominent"
                  disabled={activity !== "idle"}
                  onClick={() => decide("review/refresh")}
                >
                  Refresh suggestions
                </Button>
              }
              secondary={
                <Button
                  size="standard"
                  variant="none"
                  disabled={locked}
                  onClick={() => decide("decline")}
                >
                  Decline
                </Button>
              }
            />
          ) : (
            <FlowActionGroup
              primary={
                <Button
                  size="prominent"
                  disabled={locked || !canApprove || selectedIds.length === 0}
                  onClick={() =>
                    mutate(
                      (token, guard) =>
                        trustFuture && allSelected
                          ? DriveSharingService.approve(
                              token,
                              requestId,
                              review,
                              guard,
                              selectedIds,
                              true,
                              "any_requested_drive_file",
                            )
                          : DriveSharingService.approve(
                              token,
                              requestId,
                              review,
                              guard,
                              selectedIds,
                            ),
                      "sharing",
                    )
                  }
                >
                  {allSelected
                    ? "Share files"
                    : `Share ${selectedIds.length} of ${review.files.length} files`}
                </Button>
              }
              secondary={
                <Button
                  size="standard"
                  variant="none"
                  disabled={locked}
                  onClick={() => decide("decline")}
                >
                  Decline
                </Button>
              }
              tertiary={
                <Button
                  size="standard"
                  variant="none"
                  disabled={activity !== "idle"}
                  onClick={() => decide("review/refresh")}
                >
                  Refresh suggestions
                </Button>
              }
            />
          )}
        </>
      ) : null}

      {delivery && !removal ? (
        <>
          {delivery.files.length > 0 ? (
            <SettingsGroup embedded title="Files" {...groupSurface}>
              {delivery.files.map((file, index) => (
                <SettingsRow
                  key={file.grantId ?? index}
                  title={file.name}
                  description={
                    <>
                      <HelperText as="span" className="block">
                        {OUTCOME_LABELS[file.status] ?? "Check status"}
                      </HelperText>
                      {file.revocationStatus && file.status !== "removed" ? (
                        <HelperText as="span" className="block">
                          {file.revocationStatus === "queued" ||
                          file.revocationStatus === "dispatching"
                            ? "Removal: pending"
                            : "Removal: check status"}
                        </HelperText>
                      ) : null}
                    </>
                  }
                  trailing={
                    file.openUrl ? (
                      <Button
                        asChild
                        size="sm"
                        variant="none"
                        effect="fade"
                        className="min-h-11"
                      >
                        <a
                          href={
                            outgoing && googleEmail
                              ? `${file.openUrl}?authuser=${encodeURIComponent(googleEmail)}`
                              : file.openUrl
                          }
                          target="_blank"
                          rel="noopener noreferrer"
                          referrerPolicy="no-referrer"
                          aria-label="Open in Google Drive"
                        >
                          Open
                          <ExternalLink aria-hidden="true" className="ml-1.5 h-4 w-4" />
                        </a>
                      </Button>
                    ) : undefined
                  }
                />
              ))}
            </SettingsGroup>
          ) : outgoingOpen ? null : (
            <BodyText>Nothing was shared.</BodyText>
          )}

          {outgoing ? (
            <>
              {delivery.files.length > 0 ? (
                <HelperText>
                  {googleEmail
                    ? `Shared with ${googleEmail}. Open while signed in to that Google account.`
                    : "Open while signed in to your linked Google account."}
                </HelperText>
              ) : null}
              {UNDECIDED.has(snapshot.status.status) ? (
                <SettingsGroup embedded {...groupSurface}>
                  <SettingsRow
                    title="Cancel request"
                    disabled={locked}
                    onClick={() => decide("cancel")}
                  />
                </SettingsGroup>
              ) : null}
            </>
          ) : (
            <>
              <SettingsGroup embedded {...groupSurface}>
                <SettingsRow
                  asChild
                  title="Manage in Google Drive"
                  trailing={
                    <ExternalLink
                      aria-hidden="true"
                      className="h-4 w-4 text-[color:var(--app-tertiary-label)]"
                    />
                  }
                >
                  <a
                    href="https://drive.google.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    referrerPolicy="no-referrer"
                  />
                </SettingsRow>
                {delivery.files.some(
                  (file) => file.managed && file.status !== "removed",
                ) ? (
                  <SettingsRow
                    title="Review removal"
                    tone="destructive"
                    disabled={locked}
                    onClick={prepareRemoval}
                  />
                ) : null}
              </SettingsGroup>
              <HelperText>
                Disconnecting Drive doesn&apos;t remove Google access. Other
                access may remain after removal.
              </HelperText>
            </>
          )}
        </>
      ) : null}

      {removal ? (
        <>
          <ul aria-label="Exact access to remove" className={HAIRLINES}>
            {removal.files.map((file) => (
              <li key={file.grantId} className="py-2.5">
                <MediumRowLabel as="p" className="[overflow-wrap:anywhere]">
                  {file.name}
                </MediumRowLabel>
                <HelperText className="[overflow-wrap:anywhere]">
                  {file.recipientEmail}
                </HelperText>
              </li>
            ))}
          </ul>
          <HelperText>
            Removes only the recorded Viewer access. Other permissions may still
            give access.
          </HelperText>
          <FlowActionGroup
            primary={
              <Button
                size="prominent"
                variant="destructive"
                disabled={locked || Date.parse(removal.expiresAt) <= now}
                onClick={() =>
                  mutate(
                    (token, guard) =>
                      DriveSharingService.revoke(
                        token,
                        requestId,
                        removal,
                        guard,
                      ),
                    "removing",
                  )
                }
              >
                Remove access
              </Button>
            }
            secondary={
              <Button
                size="standard"
                variant="none"
                disabled={activity !== "idle"}
                onClick={refresh}
              >
                Cancel
              </Button>
            }
          />
        </>
      ) : null}

      {showRefreshStatus ? (
        <Button
          size="standard"
          variant="none"
          disabled={activity !== "idle"}
          onClick={refresh}
        >
          Refresh status
        </Button>
      ) : null}
    </section>
  );
}
