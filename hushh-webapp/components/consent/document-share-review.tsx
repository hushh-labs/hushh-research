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
import { ExternalConnectorService } from "@/lib/services/external-connector-service";
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
  type DriveBulkShareFilePage,
  type SharingDeliveryFilePage,
  type DriveBulkShareCounts,
  type DriveBulkShareIssue,
  type DriveBulkReasonCode,
  type DriveBulkFileOutcome,
  type DriveBulkShareView,
} from "@/lib/services/drive-sharing-service";
import type { DriveSearchResults } from "@/lib/services/drive-search-service";

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
  | "retrying_share"
  | "declining"
  | "cancelling"
  | "restarting"
  | "preparing_share"
  | "preparing_removal"
  | "enabling_background"
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
const POLL_SLOW_MS = 15_000;
const SLOW_AFTER_MS = 15_000;
const STILL_WORKING_AFTER_MS = 120_000;
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
  partial: "Sharing incomplete",
  no_match: "No matching files found",
  no_files_shared: "No files were shared",
  management_only: "Manage recorded access",
};
const ACTIVITY_LABELS: Record<Exclude<Activity, "idle" | "finding_files">, string> = {
  loading: "Loading request…",
  sharing: "Sharing…",
  retrying_share: "Retrying sharing…",
  declining: "Declining…",
  cancelling: "Cancelling…",
  restarting: "Starting a new search…",
  preparing_share: "Preparing review…",
  preparing_removal: "Preparing removal…",
  enabling_background: "Enabling background Drive access…",
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
const SEARCH_FILE_UNAVAILABLE: Record<NonNullable<DriveSearchResults["files"][number]["unavailableReason"]>, string> = {
  shortcut_target_unavailable: "Shortcut target unavailable",
  source_not_shareable: "Your Google account cannot share this file",
  shareability_unverified: "Sharing permission could not be verified",
};
const BULK_STATUS_LABELS: Record<DriveBulkShareView["status"], string> = {
  review_ready: "Ready for review", queued: "Sharing in progress", running: "Sharing in progress",
  completed: "Sharing complete", partial: "Sharing incomplete", stopped: "Sharing stopped", failed: "Sharing failed",
};
const ISSUE_COPY: Record<DriveBulkReasonCode, { reason: string; action: string }> = {
  source_changed: { reason: "The file changed after review.", action: "Review it again before sharing." },
  source_not_shareable: { reason: "Your Google account cannot share this file.", action: "Open it in Google Drive and ask its owner or shared drive manager to check sharing permissions." },
  recipient_changed: { reason: "The recipient's Google account changed.", action: "Verify their linked account before making a new request." },
  connection_changed: { reason: "The Drive connection changed.", action: "Reconnect Drive before making a new request." },
  stopped: { reason: "Sharing was stopped.", action: "These files were not shared." },
  sharing_unavailable: { reason: "Sharing is disabled.", action: "Enable Drive sharing before making a new request." },
  date_range_required: { reason: "This request needs exact dates.", action: "Make a new request with a start and end date." },
  retry_limit: { reason: "Google Drive could not finish after several attempts.", action: "Make a new request to try again." },
  provider_unavailable: { reason: "Google Drive could not finish sharing.", action: "Try again when Google Drive is available." },
  permission_rejected: { reason: "Google Drive denied sharing.", action: "Check the file's sharing permissions in Google Drive." },
  permission_outcome_unknown: { reason: "The sharing result has not been confirmed.", action: "Check access in Google Drive before trying again." },
  permission_catalog_incomplete: { reason: "Google Drive could not confirm existing access.", action: "Check access in Google Drive before trying again." },
  unavailable: { reason: "Sharing could not be completed.", action: "Check the file in Google Drive." },
};

function issueText(reason: DriveBulkReasonCode, recipient: boolean): string {
  if (recipient) {
    if (reason === "date_range_required") return "This request needs exact dates. Make a new request with a start and end date.";
    if (reason === "source_not_shareable") return "The owner's Google account lacks sharing permission. Ask them to contact the file owner or shared drive manager.";
    if (reason === "permission_rejected") return "Google Drive denied sharing. The owner can check the file's sharing permissions.";
    if (reason === "permission_outcome_unknown" || reason === "permission_catalog_incomplete")
      return "The result has not been confirmed. The owner can check access in Google Drive.";
    if (reason === "stopped") return "The owner stopped sharing these files.";
    if (reason === "provider_unavailable") return "Google Drive could not finish sharing. The owner can retry the unshared files.";
    return "These files were not shared. The owner can review them in Google Drive.";
  }
  return `${ISSUE_COPY[reason].reason} ${ISSUE_COPY[reason].action}`;
}

function OutcomeSummary({ counts, issues, recipient = false }: {
  counts: DriveBulkShareCounts; issues?: DriveBulkShareIssue[]; recipient?: boolean;
}) {
  const unconfirmed = Math.max(0, counts.total - counts.shared - counts.alreadyShared);
  const rows = [
    [counts.shared, "newly shared"], [counts.alreadyShared, "already had access"],
    [counts.skipped, "not shared"], [counts.failed, "failed"], [counts.needsReview, "needs review"],
    [counts.unknown, "checking the outcome"], [counts.pending, "waiting to share"],
  ] as const;
  return <div className="min-w-0 space-y-2" aria-label="Sharing outcomes">
    <BodyText>{(counts.shared + counts.alreadyShared).toLocaleString()} of {counts.total.toLocaleString()} files available</BodyText>
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {rows.filter(([count]) => count > 0).map(([count, label]) =>
        <HelperText key={label}>{count.toLocaleString()} {label}</HelperText>)}
    </div>
    {recipient && unconfirmed > 0 ? <HelperText>
      Only confirmed available files appear here. Ask the owner to review the {unconfirmed.toLocaleString()} {unconfirmed === 1 ? "file" : "files"} not confirmed available.
    </HelperText> : null}
    {issues?.length ? <ul className="space-y-2" aria-label="Sharing issues">
      {issues.map(issue => <li key={issue.reasonCode}><HelperText>
        {issue.count.toLocaleString()} {issue.count === 1 ? "file" : "files"}: {issueText(issue.reasonCode, recipient)}
      </HelperText></li>)}
    </ul> : null}
  </div>;
}

function OriginalLink({ url, googleEmail }: { url: string; googleEmail: string | null }) {
  const target = new URL(url);
  if (googleEmail) target.searchParams.set("authuser", googleEmail);
  return <Button asChild size="sm" variant="none" effect="fade" className="min-h-11">
    <a href={target.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" aria-label="Open in Google Drive">
      Open original <ExternalLink aria-hidden="true" className="ml-1.5 h-4 w-4" />
    </a>
  </Button>;
}

function FileOutcomes({ outcomes }: { outcomes: DriveBulkFileOutcome[] }) {
  return <div className="space-y-1">{outcomes.map((outcome, index) => <HelperText as="span" className="block" key={index}>
    {outcome.reasonCode === "permission_rejected" ? "Denied by Google Drive" :
      outcome.status === "skipped" ? "Not shared" : outcome.status === "failed" ? "Sharing failed" :
        outcome.status === "present_unattributed" || outcome.status === "absent" ? "Review needed" :
          OUTCOME_LABELS[outcome.status] ?? "Review needed"}
    {outcome.reasonCode ? ` · ${issueText(outcome.reasonCode, false)}` : ""}
  </HelperText>)}</div>;
}

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
  if (code === "date_range_required")
    return "Ask the requester to send a new request with exact start and end dates.";
  return "Refresh to try again.";
}

function isDurableReview(review: SharingReview | undefined): boolean {
  return review?.durableAvailable === true;
}

function isAutomaticSharingActive(review: SharingReview | undefined): boolean {
  return review?.trustedAuto === true &&
    review.preparationError !== "trusted_relationship_changed" &&
    review.preparationError !== "preparation_unavailable";
}

/** The private agent is still looking for files for this incoming request. */
function isFinding(snapshot: Snapshot | null): boolean {
  const review = snapshot?.review;
  if (review?.preparationError === "date_range_required") return false;
  if (isDurableReview(review))
    return !!review && !review.bulkShare &&
      (!review.search || ["queued", "running"].includes(review.search.status));
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
  const [error, setError] = useState<string | null>(null);
  const [trustFuture, setTrustFuture] = useState(false);
  // Files A left unticked for this review revision; every file starts selected.
  const [unselected, setUnselected] = useState<{ key: string; ids: string[] }>({
    key: "",
    ids: [],
  });
  const [excluded, setExcluded] = useState<{ jobId: string; positions: number[] }>({ jobId: "", positions: [] });
  // Recovery requires an affirmative tick; fresh unclaimed files retain their default selection.
  const [recoverySelected, setRecoverySelected] = useState<{ jobId: string; positions: number[] }>({ jobId: "", positions: [] });
  const [unshareableSeen, setUnshareableSeen] = useState<{ jobId: string; positions: number[] }>({ jobId: "", positions: [] });
  const [searchCursor, setSearchCursor] = useState<string | null>(null);
  const [searchPrevious, setSearchPrevious] = useState<(string | null)[]>([]);
  const [searchPage, setSearchPage] = useState<DriveSearchResults | null>(null);
  const [searchPageLoading, setSearchPageLoading] = useState(false);
  const [searchPageError, setSearchPageError] = useState(false);
  const [searchPageRetry, setSearchPageRetry] = useState(0);
  const [bulkCursor, setBulkCursor] = useState<string | null>(null);
  const [bulkPrevious, setBulkPrevious] = useState<(string | null)[]>([]);
  const [bulkPage, setBulkPage] = useState<DriveBulkShareFilePage | null>(null);
  const [bulkPageLoading, setBulkPageLoading] = useState(false);
  const [bulkPageError, setBulkPageError] = useState(false);
  const [bulkPageRetry, setBulkPageRetry] = useState(0);
  const [deliveryCursor, setDeliveryCursor] = useState<string | null>(null);
  const [deliveryPrevious, setDeliveryPrevious] = useState<(string | null)[]>([]);
  const [deliveryPage, setDeliveryPage] = useState<SharingDeliveryFilePage | null>(null);
  const [deliveryPageLoading, setDeliveryPageLoading] = useState(false);
  const [deliveryPageError, setDeliveryPageError] = useState(false);
  const [deliveryPageRetry, setDeliveryPageRetry] = useState(0);
  const searchPageSerial = useRef(0);
  const searchPageKey = useRef("");
  const bulkPageSerial = useRef(0);
  const bulkPageKey = useRef("");
  const deliveryPageSerial = useRef(0);
  const deliveryPageKey = useRef("");
  const serial = useRef(0);
  const alive = useRef(false);
  // A decision is never overlapped; it may supersede a load, a search included.
  const busy = useRef<"none" | Kind>("none");
  // The in-flight run is a background poll the person never asked for.
  const quiet = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const preparedRevision = useRef<number | null>(null);
  const searchStartFailed = useRef(false);
  const checkedLegacyJob = useRef<string | null>(null);
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
  }, []);

  const load = useCallback<Action>(
    async (token, guard, report) => {
      guard();
      let status = await DriveSharingService.status(token, requestId, guard);
      guard();
      if (status.direction !== "incoming")
        return { status, delivery: await DriveSharingService.delivery(token, requestId, guard) };
      if (!UNDECIDED.has(status.status)) {
        const delivery = await DriveSharingService.delivery(token, requestId, guard);
        guard();
        return delivery.bulkShareId
          ? { status, delivery, review: await DriveSharingService.review(token, requestId, guard) }
          : { status, delivery };
      }
      let review = await DriveSharingService.review(token, requestId, guard);
      guard();
      if (isDurableReview(review)) {
        if (isAutomaticSharingActive(review)) return { status, review };
        const legacyJob = review.search?.status === "completed" &&
          review.search.coverage?.shareabilityVerified !== true ? review.search.jobId : null;
        if ((status.status === "pending" || status.status === "review_ready") &&
          !review.bulkShare && !searchStartFailed.current &&
          (!review.search || status.status === "pending" && legacyJob !== null && checkedLegacyJob.current !== legacyJob)) {
          report.publish({ status, review });
          report.enter();
          try {
            await DriveSharingService.startRequestSearch(token, requestId, guard);
            if (legacyJob) checkedLegacyJob.current = legacyJob;
            searchStartFailed.current = false;
          } catch (cause) {
            guard();
            searchStartFailed.current = true;
            setError(cause instanceof DriveSharingError &&
              ["reconnect_required", "connection_changed", "date_range_required"].includes(cause.code)
              ? errorCopy(cause) : "Couldn't start the full search. Try again.");
            return { status, review };
          }
          guard();
          status = await DriveSharingService.status(token, requestId, guard);
          guard();
          review = await DriveSharingService.review(token, requestId, guard);
          guard();
        }
        return { status, review };
      }
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
          {
            onStage: report.stage,
            signal: report.signal,
          },
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
      searchPageSerial.current += 1;
      bulkPageSerial.current += 1;
      deliveryPageSerial.current += 1;
    };
  }, [load, run]);

  const review = snapshot?.review;
  const removal = snapshot?.revocation;
  const search = review?.search;
  const bulkShare = review?.bulkShare;
  const automaticSharing = isAutomaticSharingActive(review);
  const progressive = review?.progressiveAllowed === true;
  const batches = review?.batches ?? [];
  const batchCount = review?.batchCount ?? batches.length;
  const claimedPositions = review?.claimedPositions ?? [];
  const recoverablePositions = review?.recoverablePositions ?? [];
  const durableReview = isDurableReview(review);
  const legacySearch = search?.status === "completed" && search.coverage?.shareabilityVerified !== true;
  const searchReady = search?.status === "completed" && !search.incompleteSearch &&
    search.coverage?.providerPagesExhausted !== false && search.coverage?.shareabilityVerified === true;
  const searchJobId = search && (!bulkShare || progressive) && !legacySearch ? search.jobId : null;
  const bulkPreviewId = bulkShare?.shareId ?? null;
  const deliveryBulkId = snapshot?.status.direction === "outgoing"
    ? snapshot.delivery?.bulkShareId ?? null : null;
  const deliveredCount = snapshot?.delivery?.sharedCount ?? 0;

  useEffect(() => { setSearchCursor(null); setSearchPrevious([]); }, [search?.jobId]);
  useEffect(() => { setBulkCursor(null); setBulkPrevious([]); }, [bulkShare?.shareId]);
  useEffect(() => { setDeliveryCursor(null); setDeliveryPrevious([]); }, [deliveryBulkId]);

  useEffect(() => {
    const ticket = ++searchPageSerial.current;
    if (!searchJobId) { searchPageKey.current = ""; setSearchPage(null); setSearchPageError(false); return; }
    const token = getToken();
    if (!token) { setSearchPage(null); setSearchPageError(true); return; }
    const epoch = snapshotVaultSessionEpoch();
    const guard = () => {
      if (!alive.current || ticket !== searchPageSerial.current ||
        !isVaultSessionEpochCurrent(epoch) || getToken() !== token)
        throw new DriveSharingError("session_changed");
    };
    const pageKey = `${searchJobId}:${searchCursor ?? "first"}`;
    if (searchPageKey.current !== pageKey) {
      searchPageKey.current = pageKey;
      setSearchPage(null);
    }
    setSearchPageLoading(true); setSearchPageError(false);
    void DriveSharingService.requestSearchFiles(token, requestId, searchJobId, guard, searchCursor)
      .then(page => {
        guard();
        setSearchPage(page);
        const blocked = page.files.filter(file => file.shareable === false).map(file => file.position);
        if (blocked.length) {
          setUnshareableSeen(current => ({ jobId: searchJobId,
            positions: [...new Set([...(current.jobId === searchJobId ? current.positions : []), ...blocked])] }));
          setExcluded(current => ({ jobId: searchJobId,
            positions: [...new Set([...(current.jobId === searchJobId ? current.positions : []), ...blocked])] }));
        }
      })
      .catch(() => { try { guard(); } catch { return; } setSearchPage(null); setSearchPageError(true); })
      .finally(() => { if (ticket === searchPageSerial.current) setSearchPageLoading(false); });
    return () => { searchPageSerial.current += 1; };
  }, [getToken, requestId, searchJobId, search?.matched, searchCursor, searchPageRetry]);

  useEffect(() => {
    const ticket = ++bulkPageSerial.current;
    if (!bulkPreviewId) { bulkPageKey.current = ""; setBulkPage(null); setBulkPageError(false); return; }
    const token = getToken();
    if (!token) { setBulkPage(null); setBulkPageError(true); return; }
    const epoch = snapshotVaultSessionEpoch();
    const guard = () => {
      if (!alive.current || ticket !== bulkPageSerial.current ||
        !isVaultSessionEpochCurrent(epoch) || getToken() !== token)
        throw new DriveSharingError("session_changed");
    };
    const pageKey = `${bulkPreviewId}:${bulkCursor ?? "first"}`;
    if (bulkPageKey.current !== pageKey) { bulkPageKey.current = pageKey; setBulkPage(null); }
    setBulkPageLoading(true); setBulkPageError(false);
    void DriveSharingService.bulkShareFiles(token, bulkPreviewId, guard, bulkCursor)
      .then(page => { guard(); setBulkPage(page); })
      .catch(() => { try { guard(); } catch { return; } setBulkPage(null); setBulkPageError(true); })
      .finally(() => { if (ticket === bulkPageSerial.current) setBulkPageLoading(false); });
    return () => { bulkPageSerial.current += 1; };
  }, [getToken, bulkPreviewId, bulkCursor, bulkPageRetry, bulkShare?.revision,
    bulkShare?.counts.processed, bulkShare?.counts.unknown, bulkShare?.counts.pending]);

  useEffect(() => {
    const ticket = ++deliveryPageSerial.current;
    if (!deliveryBulkId || deliveredCount === 0) {
      deliveryPageKey.current = "";
      setDeliveryPage(null); setDeliveryPageError(false); return;
    }
    const token = getToken();
    if (!token) { setDeliveryPage(null); setDeliveryPageError(true); return; }
    const epoch = snapshotVaultSessionEpoch();
    const guard = () => {
      if (!alive.current || ticket !== deliveryPageSerial.current ||
        !isVaultSessionEpochCurrent(epoch) || getToken() !== token)
        throw new DriveSharingError("session_changed");
    };
    const pageKey = `${deliveryBulkId}:${deliveryCursor ?? "first"}`;
    if (deliveryPageKey.current !== pageKey) {
      deliveryPageKey.current = pageKey;
      setDeliveryPage(null);
    }
    setDeliveryPageLoading(true); setDeliveryPageError(false);
    void DriveSharingService.deliveryFiles(token, requestId, guard, deliveryCursor)
      .then(page => { guard(); setDeliveryPage(page); })
      .catch(() => { try { guard(); } catch { return; } setDeliveryPage(null); setDeliveryPageError(true); })
      .finally(() => { if (ticket === deliveryPageSerial.current) setDeliveryPageLoading(false); });
    return () => { deliveryPageSerial.current += 1; };
  }, [getToken, requestId, deliveryBulkId, deliveredCount, deliveryCursor, deliveryPageRetry]);
  // Stays true while a decision or refresh runs, so the layout never jumps.
  const finding = activity === "finding_files" || (isFinding(snapshot) && !searchStartFailed.current);
  const stillWorking =
    finding &&
    activity === "idle" &&
    findingSince !== null &&
    now - findingSince >= STILL_WORKING_AFTER_MS;
  // A retryable failure: the worker tries again in minutes, so polling can't see it.
  const retryLater =
    !!review &&
    snapshot?.status.direction === "incoming" &&
    review.status === "pending" &&
    !!review.preparationError &&
    !(review.trustedAuto && ["trusted_auto_queued", "trusted_auto_active", "trusted_relationship_changed", "preparation_unavailable"].includes(review.preparationError));
  const pendingOutcomes = !!snapshot?.delivery?.files.some(
    (file) =>
      IN_FLIGHT.has(file.status) || IN_FLIGHT.has(file.revocationStatus ?? ""),
  ) || !!snapshot?.delivery?.bulkStatus && ["queued", "running"].includes(snapshot.delivery.bulkStatus);
  const pollable =
    !!snapshot &&
    !removal &&
    !retryLater &&
    (durableReview && snapshot.status.direction === "incoming"
      ? ((!search && !searchStartFailed.current) || ["queued", "running"].includes(search?.status ?? "") ||
          batches.some(batch => ["queued", "running"].includes(batch.status) ||
            batch.counts.pending > 0 || batch.counts.unknown > 0) ||
          !!bulkShare && (["queued", "running"].includes(bulkShare.status) ||
            bulkShare.status !== "review_ready" &&
              (bulkShare.counts.pending > 0 || bulkShare.counts.unknown > 0)))
      : ["pending", "preparing", "approved"].includes(snapshot.status.status) ||
        !!snapshot.delivery?.bulkStatus && ["queued", "running"].includes(snapshot.delivery.bulkStatus) ||
        !!snapshot.delivery?.files.some((file) =>
          IN_FLIGHT.has(file.revocationStatus ?? ""),
        ));

  usePeriodicTask(
    `document-share-review:${requestId}`,
    stillWorking ? POLL_SLOW_MS : POLL_MS,
    () => {
      if (busy.current !== "none") return undefined;
      return run(load, "load", null);
    },
    { enabled: pollable && activity === "idle" },
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
  const excludedPositions = search && excluded.jobId === search.jobId ? excluded.positions : [];
  const selectedRecoveryPositions = search && recoverySelected.jobId === search.jobId ? recoverySelected.positions : [];
  const blockedPositions = search && unshareableSeen.jobId === search.jobId ? unshareableSeen.positions : [];
  const manualExcludedCount = excludedPositions.filter(position => !blockedPositions.includes(position)).length;
  const selectedPositions = progressive && searchPage && search
    ? searchPage.files.filter(file => file.shareable === true &&
        (recoverablePositions.includes(file.position)
          ? selectedRecoveryPositions.includes(file.position)
          : !claimedPositions.includes(file.position) && !excludedPositions.includes(file.position)))
      .map(file => file.position)
    : [];
  const selectedCount = progressive ? selectedPositions.length : search
    ? Math.max(0, search.matched - (search.unshareableCount ?? 0) - manualExcludedCount) : 0;
  const groupSurface =
    surface === "sheet"
      ? {}
      : { shellClassName: "rounded-none bg-transparent shadow-none" };

  const refresh = () => {
    void run(
      async (token, guard, report) => {
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
  const retryDurableSearch = () => {
    if (!snapshot) return;
    const shown = snapshot;
    searchStartFailed.current = false;
    void run(
      async (token, guard, report) => {
        try {
          await DriveSharingService.startRequestSearch(token, requestId, guard);
          guard();
        } catch (cause) {
          guard();
          searchStartFailed.current = true;
          setError(errorCopy(cause));
          return shown;
        }
        onChanged();
        return load(token, guard, report);
      },
      "load",
      "restarting",
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

  const enableBackground = () => {
    void run(
      async (token, guard, report) => {
        await ExternalConnectorService.setLiveBackground(token, true);
        guard();
        onChanged();
        report.acknowledged();
        return load(token, guard, report);
      },
      "decide",
      "enabling_background",
      true,
    );
  };

  const durableStatus = snapshot?.status.direction === "incoming" &&
    snapshot.status.status === "no_match"
    ? "No matching files found"
    : automaticSharing
    ? review?.preparationError === "date_range_required"
      ? "Exact dates needed"
      : review?.preparationError === "background_preparation_required"
      ? "Background Drive access needed"
      : bulkShare && ["queued", "running"].includes(bulkShare.status)
        ? "Sharing matching files"
        : search && ["queued", "running"].includes(search.status)
          ? `Finding matching files · ${search.matched.toLocaleString()} found`
          : bulkShare ? BULK_STATUS_LABELS[bulkShare.status]
            : ["completed", "partial"].includes(snapshot?.status.status ?? "") ? "Sharing finished"
              : "Preparing automatic sharing"
    : progressive && search && ["queued", "running"].includes(search.status)
    ? `Searching Drive · ${search.matched.toLocaleString()} found${batchCount ? ` · ${batchCount.toLocaleString()} ${batchCount === 1 ? "batch" : "batches"} started` : ""}`
    : bulkShare
    ? bulkShare.status === "review_ready"
      ? `Ready to share ${bulkShare.fileCount.toLocaleString()} files`
      : BULK_STATUS_LABELS[bulkShare.status]
    : legacySearch
      ? "Updating file access checks"
    : !search && searchStartFailed.current
      ? "Search unavailable"
      : searchReady
      ? `${search.matched.toLocaleString()} files found`
        : search?.status === "failed"
          ? "Search failed"
          : search?.status === "limited" || search?.incompleteSearch
            ? "Search incomplete"
          : search?.status === "stopped"
            ? "Search stopped"
          : search
            ? `Searching Drive · ${search.matched.toLocaleString()} found`
            : null;
  const statusLine =
    activity === "loading"
      ? ACTIVITY_LABELS.loading
      : activity === "finding_files"
        ? durableStatus ?? STAGE_LABELS[stage ?? "starting"]
        : activity !== "idle"
          ? ACTIVITY_LABELS[activity]
          : !snapshot
            ? error
              ? "Couldn't load request"
              : ACTIVITY_LABELS.loading
            : durableReview && durableStatus
              ? durableStatus
              : snapshot.status.direction === "outgoing" &&
                (snapshot.delivery?.sharedCount ?? 0) > 0 &&
                (UNDECIDED.has(snapshot.status.status) || snapshot.status.status === "approved" ||
                  ["queued", "running"].includes(snapshot.delivery?.bulkStatus ?? ""))
                ? `${snapshot.delivery!.sharedCount!.toLocaleString()} files available; more may arrive`
              : snapshot.delivery?.bulkStatus
                ? BULK_STATUS_LABELS[snapshot.delivery.bulkStatus]
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
    ? "You can come back later."
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
    !removal && (!snapshot || pendingOutcomes || outgoingOpen);
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

      {review && automaticSharing && !removal ? <>
        <BodyText className="whitespace-pre-wrap [overflow-wrap:anywhere]">“{review.purpose.purpose}”</BodyText>
        <dl className={HAIRLINES}>
          <Fact label="Share with" value={review.recipientEmail} />
          <Fact label="Access" value="Viewer, until removed" />
        </dl>
        {review.preparationError === "date_range_required" ? (
          <BodyText>This request needs exact start and end dates. Ask the requester to send a new request with both dates.</BodyText>
        ) : review.preparationError === "background_preparation_required" ? <div className="space-y-3">
          <BodyText>Background Drive access is off. This request is paused and will resume automatically when you turn it on.</BodyText>
          <HelperText>One may read relevant files and send excerpts to Gemini while you&apos;re away. You can turn this off again in Connections. The requester sees an original file only after Google Drive confirms access.</HelperText>
          <Button size="prominent" disabled={locked} onClick={enableBackground}>Enable background Drive access</Button>
        </div> : <HelperText>
          Matching files are found and shared automatically. You can close this window; the requester sees each original only after Google Drive confirms access.
        </HelperText>}
        {search && review.preparationError !== "date_range_required" ? <HelperText>{search.matched.toLocaleString()} matching files found so far
          {search.status === "running" ? " · search continues" : ""}</HelperText> : null}
        {review.aggregateCounts || bulkShare ? <div className="space-y-3">
          <OutcomeSummary counts={review.aggregateCounts ?? bulkShare!.counts} issues={bulkShare?.issues} />
          {bulkPage?.files.length ? <SettingsGroup embedded title="Latest files" {...groupSurface}>
            {bulkPage.files.map(file => <SettingsRow key={file.position} title={file.name}
              description={file.outcomes?.length ? <FileOutcomes outcomes={file.outcomes} /> : undefined}
              trailing={file.openUrl ? <OriginalLink url={file.openUrl} googleEmail={googleEmail} /> : undefined} />)}
          </SettingsGroup> : null}
        </div> : null}
      </> : null}

      {review && durableReview && !automaticSharing && !removal ? (
        <>
          {review.trustedAuto && review.preparationError === "trusted_relationship_changed" ?
            <BodyText>Trusted Circle changed. Review this request manually before sharing.</BodyText> : null}
          {review.trustedAuto && review.preparationError === "preparation_unavailable" ?
            <BodyText>Automatic sharing could not finish. Review and share the files yourself.</BodyText> : null}
          <BodyText className="whitespace-pre-wrap [overflow-wrap:anywhere]">
            “{review.purpose.purpose}”
          </BodyText>
          <dl className={HAIRLINES}>
            <Fact label="Share with" value={review.recipientEmail} />
            {search?.coverage?.requestedPeriod || review.purpose.periodStart ? (
              <Fact label="Period" value={search?.coverage?.requestedPeriod
                ? `${search.coverage.requestedPeriod.start} – ${search.coverage.requestedPeriod.end}`
                : `${review.purpose.periodStart} – ${review.purpose.periodEnd}`} />
            ) : null}
            <Fact label="Access" value="Viewer, until removed" />
          </dl>

          {search?.coverage ? <div className="space-y-1" aria-label="Search coverage">
            <HelperText>{searchReady
              ? "All returned Drive pages checked."
              : legacySearch
                ? "Earlier results need a new sharing permission check."
              : progressive
                ? "Drive is still finding files. You can share a reviewed batch while it continues."
                : "Search is not complete. Additional matching files may exist."}</HelperText>
            <HelperText>{search.coverage.corpora.includes("member_shared_drives") ? "Your files and shared drives" : "Your files"}
              {` · ${search.coverage.providerRowsScanned.toLocaleString()} results checked`}</HelperText>
            {search.coverage.excludedByDateCount || search.coverage.deduplicatedCount ? <HelperText>
              {[search.coverage.excludedByDateCount > 0 ? `${search.coverage.excludedByDateCount.toLocaleString()} outside the requested dates` : null,
                search.coverage.deduplicatedCount > 0 ? `${search.coverage.deduplicatedCount.toLocaleString()} duplicate matches omitted` : null].filter(Boolean).join(" · ")}
            </HelperText> : null}
            {(search.coverage.excludedByTopicCount ?? 0) > 0 ? <HelperText>
              {search.coverage.excludedByTopicCount?.toLocaleString()} files in matching folders were excluded because their names did not match this request. Review Drive if a document is missing.
            </HelperText> : null}
            {search.coverage.requestedPeriod ? <HelperText>
              Dates match file names first, then creation or modification dates. Dates inside file contents were not checked.
            </HelperText> : null}
          </div> : null}
          {search && bulkShare ? <div className="space-y-1">
            <HelperText>{progressive
              ? `${search.matched.toLocaleString()} matching files found${search.status === "completed" ? "" : " so far"} · ${batchCount.toLocaleString()} ${batchCount === 1 ? "batch" : "batches"} started`
              : `${search.matched.toLocaleString()} matching files found · ${bulkShare.fileCount.toLocaleString()} selected for sharing`}</HelperText>
            {(search.unshareableCount ?? 0) > 0 ? <HelperText>
              {search.unshareableCount?.toLocaleString()} unavailable matches were not included.
            </HelperText> : null}
          </div> : null}

          {(!bulkShare || progressive) && search ? (
            <>
              <HelperText>{progressive
                ? `${search.matched.toLocaleString()} found${search.status === "completed" ? "" : " so far"}. Review and share up to 25 files from this page${search.status === "completed" ? "." : "; more can arrive while you work."}`
                : searchReady
                ? `${search.matched.toLocaleString()} matching files. Select the files to share.`
                : legacySearch
                  ? "Checking this request's Drive files again before sharing."
                : ["limited", "failed", "stopped"].includes(search.status) || search.incompleteSearch
                  ? `${search.matched.toLocaleString()} found. Some files may be missing.`
                  : `${search.matched.toLocaleString()} found so far. Search continues after you leave.`}</HelperText>
              {(search.unshareableCount ?? 0) > 0 ? <HelperText>
                {search.unshareableCount?.toLocaleString()} files have no confirmed sharing permission and won&apos;t be included.
              </HelperText> : null}
              {legacySearch ? <HelperText>Earlier files cannot be selected while the new check runs.</HelperText> :
              <div aria-label="Matching Drive files" aria-busy={searchPageLoading}>
                <SettingsGroup embedded title={progressive ? "Files found so far" : "Files"}
                  description={progressive ? `Choose from this page. Shared and queued files cannot be selected again.${recoverablePositions.length ? " Files skipped by automatic sharing need your selection." : ""}` : undefined}
                  {...groupSurface}>
                  {searchPage?.files.map(file => {
                    const recoverable = progressive && recoverablePositions.includes(file.position);
                    const alreadyClaimed = progressive && claimedPositions.includes(file.position) && !recoverable;
                    return (
                    <SettingsRow
                      key={file.position}
                      asChild
                      title={file.name}
                      description={file.shareable === false
                        ? file.unavailableReason ? SEARCH_FILE_UNAVAILABLE[file.unavailableReason] : "Can't share this file"
                        : recoverable
                        ? "Automatic sharing stopped before this file was sent. Select it to review and share."
                        : alreadyClaimed
                        ? "Already in a sharing batch"
                        : undefined}
                      disabled={locked || file.shareable === false || progressive &&
                        (file.shareable !== true || alreadyClaimed || bulkShare?.status === "review_ready")}
                      trailing={
                        <Checkbox
                          aria-label={file.name}
                          className={CHECKBOX_CLASS}
                          checked={file.shareable !== false && (recoverable
                            ? selectedRecoveryPositions.includes(file.position)
                            : !excludedPositions.includes(file.position) && !alreadyClaimed)}
                          disabled={locked || file.shareable === false || progressive &&
                            (file.shareable !== true || alreadyClaimed || bulkShare?.status === "review_ready")}
                          onCheckedChange={checked => {
                            if (recoverable) {
                              setRecoverySelected({ jobId: search.jobId,
                                positions: checked === true
                                  ? [...new Set([...selectedRecoveryPositions, file.position])]
                                  : selectedRecoveryPositions.filter(position => position !== file.position) });
                              return;
                            }
                            setExcluded({ jobId: search.jobId,
                              positions: checked === true
                                ? excludedPositions.filter(position => position !== file.position)
                                : [...excludedPositions, file.position] });
                          }}
                        />
                      }
                    >
                      <label className="cursor-pointer" />
                    </SettingsRow>
                    );
                  })}
                </SettingsGroup>
              </div>}
              {searchPageLoading ? <HelperText>Loading files…</HelperText> : null}
              {searchPageError ? <div><HelperText role="alert">Couldn&apos;t load files.</HelperText>
                <Button size="standard" variant="none" onClick={() => setSearchPageRetry(value => value + 1)}>Try again</Button></div> : null}
              {searchPrevious.length || searchPage?.nextCursor ? (
                <div className="flex flex-wrap gap-2">
                  <Button size="standard" variant="none" disabled={searchPageLoading || !searchPrevious.length}
                    onClick={() => { setSearchCursor(searchPrevious.at(-1) ?? null); setSearchPrevious(items => items.slice(0, -1)); }}>
                    Previous
                  </Button>
                  <Button size="standard" variant="none" disabled={searchPageLoading || !searchPage?.nextCursor}
                    onClick={() => { setSearchPrevious(items => [...items, searchCursor]); setSearchCursor(searchPage?.nextCursor ?? null); }}>
                    Next 25
                  </Button>
                </div>
              ) : null}
              {progressive && search.status === "running" && !searchPage?.nextCursor ?
                <HelperText>New pages appear here as Drive finds more files. You can leave and return.</HelperText> : null}
              {progressive && searchPage?.files.length && selectedCount === 0 ?
                <HelperText>All available files on this page are already in a batch or were deselected.</HelperText> : null}
              <FlowActionGroup
                primary={
                  <Button size="prominent" disabled={locked || !searchPage || searchPageError || selectedCount === 0 ||
                    (progressive
                      ? legacySearch || bulkShare?.status === "review_ready" ||
                        !["running", "completed"].includes(search.status) || search.incompleteSearch ||
                        search.coverage?.shareabilityVerified !== true
                      : !searchReady)}
                    onClick={() => mutate(
                      (token, guard) => progressive
                        ? DriveSharingService.prepareRequestBatch(token, requestId, search, selectedPositions, guard)
                        : DriveSharingService.prepareRequestBulk(token, requestId, search, excludedPositions, guard),
                      "preparing_share",
                    )}>
                    {progressive && !legacySearch && ["running", "completed"].includes(search.status)
                      ? bulkShare?.status === "review_ready" ? "Finish this batch" :
                        `Review ${selectedCount.toLocaleString()} ${selectedCount === 1 ? "file" : "files"}`
                      : searchReady ? `Review ${selectedCount.toLocaleString()} files` : legacySearch ? "Updating file access" :
                      ["limited", "failed", "stopped"].includes(search.status) ? "Search incomplete" : "Search in progress"}
                  </Button>
                }
                secondary={batchCount === 0 ? <Button size="standard" variant="none" disabled={locked} onClick={() => decide("decline")}>Decline</Button> : undefined}
                tertiary={(["limited", "failed", "stopped"].includes(search.status) ||
                  legacySearch && activity === "idle" && (searchStartFailed.current || checkedLegacyJob.current === search.jobId)) ?
                  <Button size="standard" variant="none" disabled={locked}
                    onClick={retryDurableSearch}>
                    Search again
                  </Button> : undefined}
              />
            </>
          ) : null}

          {!bulkShare && !search ? (
            <>
              {review.files.length > 0 ? (
                <SettingsGroup embedded title="Earlier suggestions" {...groupSurface}>
                  {review.files.map(file => <SettingsRow key={file.documentId} title={file.name} />)}
                </SettingsGroup>
              ) : null}
              <HelperText>{searchStartFailed.current
                ? "Full search needed before sharing."
                : "Search continues after you leave."}</HelperText>
              <FlowActionGroup
                primary={<Button size="prominent" disabled>Share files</Button>}
                secondary={<Button size="standard" variant="none" disabled={locked} onClick={() => decide("decline")}>Decline</Button>}
                tertiary={searchStartFailed.current ? <Button size="standard" variant="none" disabled={locked}
                  onClick={retryDurableSearch}>
                  Search again
                </Button> : undefined}
              />
            </>
          ) : null}

          {bulkShare && bulkShare.status !== "review_ready" ? <>
            {progressive ? <HelperText>Latest batch · {bulkShare.fileCount.toLocaleString()} files</HelperText> : null}
            <OutcomeSummary counts={bulkShare.counts} issues={bulkShare.issues} />
            {bulkShare.status === "partial" && bulkShare.counts.shared > 0 ?
              <HelperText>Review the newly shared originals below. Remove any unintended access in Google Drive.</HelperText> : null}
            {["queued", "running"].includes(bulkShare.status) ? <HelperText>Sharing continues after you leave.</HelperText> : null}
            {bulkShare.canRetry === true && (bulkShare.retryableCount ?? 0) > 0 ?
              <Button size="prominent" disabled={locked}
                onClick={() => mutate((token, guard) => DriveSharingService.retryBulkShare(token, bulkShare, guard), "retrying_share")}>
                Retry {bulkShare.retryableCount?.toLocaleString()} {bulkShare.retryableCount === 1 ? "file" : "files"}
              </Button> : null}
          </> : null}

          {bulkShare ? (
            <>
              {bulkShare.status === "review_ready" ? legacySearch
                ? <HelperText role="alert">This selection predates the sharing permission check. Ask for a new document request before sharing.</HelperText>
                : <HelperText>{bulkShare.fileCount.toLocaleString()} files selected for this batch. Review the originals, then share.</HelperText> : null}
              <div aria-label={bulkShare.status === "review_ready" ? "Files ready to share" : "Original file outcomes"} aria-busy={bulkPageLoading}>
                <SettingsGroup embedded title="Original files" description="Originals stay in Drive. The recipient sees later edits." {...groupSurface}>
                  {bulkPage?.files.map(file => <SettingsRow key={file.position} title={file.name}
                    description={file.outcomes?.length ? <FileOutcomes outcomes={file.outcomes} /> : undefined}
                    trailing={file.openUrl ? <OriginalLink url={file.openUrl} googleEmail={googleEmail} /> : undefined} />)}
                </SettingsGroup>
              </div>
              {bulkPageLoading ? <HelperText>Loading files…</HelperText> : null}
              {bulkPageError ? <div><HelperText role="alert">Couldn&apos;t load files.</HelperText>
                <Button size="standard" variant="none" onClick={() => setBulkPageRetry(value => value + 1)}>Try again</Button></div> : null}
              {bulkPrevious.length || bulkPage?.nextCursor ? (
                <div className="flex flex-wrap gap-2">
                  <Button size="standard" variant="none" disabled={bulkPageLoading || !bulkPrevious.length}
                    onClick={() => { setBulkCursor(bulkPrevious.at(-1) ?? null); setBulkPrevious(items => items.slice(0, -1)); }}>Previous</Button>
                  <Button size="standard" variant="none" disabled={bulkPageLoading || !bulkPage?.nextCursor}
                    onClick={() => { setBulkPrevious(items => [...items, bulkCursor]); setBulkCursor(bulkPage?.nextCursor ?? null); }}>Next 25</Button>
                </div>
              ) : null}
              {bulkShare.status === "review_ready" ? <FlowActionGroup
                primary={<Button size="prominent" disabled={locked || legacySearch || !bulkPage || bulkPageError || bulkPageLoading}
                  onClick={() => mutate((token, guard) => DriveSharingService.approveBulkShare(token, bulkShare, guard), "sharing")}>
                  {legacySearch ? "New request needed" : `Share ${bulkShare.fileCount.toLocaleString()} ${bulkShare.fileCount === 1 ? "file" : "files"}`}
                </Button>}
                secondary={batchCount === 0 ? <Button size="standard" variant="none" disabled={locked} onClick={() => decide("decline")}>Decline</Button> : undefined}
              /> : null}
            </>
          ) : null}
          {progressive && review.aggregateCounts && batchCount > 1 ? <OutcomeSummary counts={review.aggregateCounts} /> : null}
          {progressive && batchCount > 1 ? <SettingsGroup embedded title="Sharing batches"
            description={`${batchCount.toLocaleString()} batches prepared${batchCount > batches.length ? `. Showing the latest ${batches.length}.` : "."}`}
            {...groupSurface}>
            {batches.map((batch, index) => <SettingsRow key={batch.shareId}
              title={`Batch ${(batchCount - index).toLocaleString()} · ${batch.fileCount.toLocaleString()} ${batch.fileCount === 1 ? "file" : "files"}`}
              description={`${BULK_STATUS_LABELS[batch.status]} · ${(batch.counts.shared + batch.counts.alreadyShared).toLocaleString()} available`} />)}
          </SettingsGroup> : null}
        </>
      ) : null}

      {review && !durableReview && !automaticSharing && !removal ? (
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

      {delivery && !delivery.bulkShareId && !removal ? (
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

      {delivery?.bulkShareId && outgoing && !removal ? (
        <>
          {delivery.counts ? <OutcomeSummary counts={delivery.counts} issues={delivery.issues} recipient /> :
            <BodyText>{(delivery.sharedCount ?? 0).toLocaleString()} of {(delivery.fileCount ?? 0).toLocaleString()} files available</BodyText>}
          {delivery.bulkStatus && ["queued", "running"].includes(delivery.bulkStatus) ?
            <HelperText>Sharing continues after you leave.</HelperText> : null}
          {deliveryPage?.files.length ? (
            <SettingsGroup embedded title="Available files" description="These links open the originals in Google Drive." {...groupSurface}>
              {deliveryPage.files.map((file, index) => (
                <SettingsRow
                  key={file.grantId ?? index}
                  title={file.name}
                  trailing={file.openUrl ? <OriginalLink url={file.openUrl} googleEmail={googleEmail} /> : undefined}
                />
              ))}
            </SettingsGroup>
          ) : delivery.sharedCount === 0 && snapshot?.status.status === "approved" ? (
            <HelperText>Files appear as sharing finishes.</HelperText>
          ) : null}
          {deliveryPageLoading ? <HelperText>Loading files…</HelperText> : null}
          {deliveryPageError ? <div><HelperText role="alert">Couldn&apos;t load shared files.</HelperText>
            <Button size="standard" variant="none" onClick={() => setDeliveryPageRetry(value => value + 1)}>Try again</Button></div> : null}
          {deliveryPrevious.length || deliveryPage?.nextCursor ? (
            <div className="flex flex-wrap gap-2">
              <Button size="standard" variant="none" disabled={deliveryPageLoading || !deliveryPrevious.length}
                onClick={() => { setDeliveryCursor(deliveryPrevious.at(-1) ?? null); setDeliveryPrevious(items => items.slice(0, -1)); }}>Previous</Button>
              <Button size="standard" variant="none" disabled={deliveryPageLoading || !deliveryPage?.nextCursor}
                onClick={() => { setDeliveryPrevious(items => [...items, deliveryCursor]); setDeliveryCursor(deliveryPage?.nextCursor ?? null); }}>Next 25</Button>
            </div>
          ) : null}
          {deliveryPage?.files.length ? <HelperText>{googleEmail
            ? `Shared with ${googleEmail}. Open while signed in to that Google account.`
            : "Open while signed in to your linked Google account."}</HelperText> : null}
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
