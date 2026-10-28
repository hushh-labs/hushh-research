"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { DocumentPackageDetails, DocumentPackageActions, PackageFact as Fact } from "@/components/consent/document-package-review";
import {
  documentRequestSetupState,
  documentRequestSetupHref,
  documentRequestSetupLabel,
  GOOGLE_DRIVE_CONNECTOR_ID,
} from "@/lib/consent/document-request-setup";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { ExternalLink, Loader2, RefreshCw } from "@/components/icons";
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
  DOCUMENT_REQUEST_PRICE_RULE,
  DocumentRequestPriceSheet,
  ONE_COPY_ALLOW_DISCLOSURE,
} from "@/components/consent/document-request-price-sheet";
import { DocumentRequestRequesterPanel } from "@/components/consent/document-request-requester-panel";
import { BackgroundDocumentLink } from "./background-document-files";
import { HostedDocumentPanel } from "@/components/consent/hosted-document-panel";
import { DocumentPayoutAccountCard } from "@/components/consent/document-payout-account";
import { ProfileConnectorsLink } from "@/components/profile/profile-connectors-link";
import {
  formatDocumentRequestPrice,
  isValidDocumentRequestPriceCents,
} from "@/lib/consent/document-request-price";
import { DOCUMENT_FLOW_TEXT_SCALE, periodConflictNote } from "@/lib/consent/document-request-flow";
import { documentRequestEmptyOutcomeLabel, partialDocumentDeliveryState } from "@/lib/consent/document-request-delivery-state";
import {
  effectiveRequesterPaymentState,
  REQUESTER_PAYMENT_TITLES,
} from "@/lib/consent/document-request-payment-view";
import { presentOwnerReviewRequest } from "@/lib/consent/document-request-requester-view";
import { documentPayoutStatusCopy } from "@/lib/consent/document-payout-status";
import { useArmedAction } from "@/lib/ui/use-armed-action";
import {
  DriveSharingError,
  DriveSharingService,
  StreamUnavailable,
  type PrepareStage,
  type SharingStatus,
  type SharingReview,
  type OwnerDocumentPayout,
  type SharingDelivery,
  type SharingRequestContext,
  type SharingRevocationReview,
  type DriveBulkShareFilePage,
  type DriveBulkShareCounts,
  type DriveBulkShareIssue,
  type DriveBulkReasonCode,
  type DriveBulkFileOutcome,
  type DriveBulkShareView,
} from "@/lib/services/drive-sharing-service";
import { DriveSearchService, isDriveSearchSelectionReady, type DriveSearchResults } from "@/lib/services/drive-search-service";

type Snapshot = {
  status: SharingStatus;
  review?: SharingReview;
  ownerPayout?: OwnerDocumentPayout | null;
  delivery?: SharingDelivery;
  revocation?: SharingRevocationReview;
  /** The requester's own terms; absent for the owner and for requests without them. */
  context?: SharingRequestContext | null;
};
type SessionGuard = () => void;
/** What the sheet is doing right now; "idle" means only background polls. */
type Activity =
  | "idle"
  | "loading"
  | "finding_files"
  | "sharing"
  | "retrying_share"
  | "allowing"
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
const PAYOUT_ELIGIBLE_TERMINAL = new Set(["approved", "completed", "partial"]);
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
  partial: "Review sharing and search results",
  no_match: "No files were shared",
  no_files_shared: "No files were shared",
  management_only: "Manage recorded access",
};
const ACTIVITY_LABELS: Record<Exclude<Activity, "idle" | "finding_files">, string> = {
  loading: "Loading request…",
  sharing: "Sharing…",
  retrying_share: "Retrying sharing…",
  allowing: "Allowing…",
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
// A decision-grade success action needs a darker fill so white label text stays
// legible in both colour schemes. The general success token is intentionally
// lighter and pairs with dark text in status surfaces.
const ALLOW_CLASS = cn(
  "border-transparent bg-[color:var(--app-success-deep)] text-white",
  "hover:bg-[color:color-mix(in_srgb,var(--app-success-deep)_88%,black_12%)] hover:text-white",
);
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
  sharing_rate_limited: { reason: "Google Drive limited how many files you could share at once.", action: "Sharing waits and retries a few times before it stops." },
  recipient_needs_google_account: { reason: "The recipient's email isn't a Google account.", action: "They need to link a Google account, then request again." },
  drive_policy_blocked: { reason: "Your Google Workspace settings block sharing this file with them.", action: "Ask your Workspace admin or shared drive manager." },
  unavailable: { reason: "Sharing could not be completed.", action: "Check the file in Google Drive." },
};

/** The owner's issue copy; the requester's lives in document-request-requester-panel. */
function issueText(reason: DriveBulkReasonCode): string {
  return `${ISSUE_COPY[reason].reason} ${ISSUE_COPY[reason].action}`;
}

function OutcomeSummary({ counts, issues }: {
  counts: DriveBulkShareCounts; issues?: DriveBulkShareIssue[];
}) {
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
    {issues?.length ? <ul className="space-y-2" aria-label="Sharing issues">
      {issues.map(issue => <li key={issue.reasonCode}><HelperText>
        {issue.count.toLocaleString()} {issue.count === 1 ? "file" : "files"}: {issueText(issue.reasonCode)}
      </HelperText></li>)}
    </ul> : null}
  </div>;
}

function OriginalLink({ url, googleEmail }: { url: string; googleEmail: string | null }) {
  const target = new URL(url);
  if (googleEmail) target.searchParams.set("authuser", googleEmail);
  return <Button data-consent-role="compact-action" asChild size="sm" variant="none" effect="fade" className="min-h-11">
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
    {outcome.reasonCode ? ` · ${issueText(outcome.reasonCode)}` : ""}
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
  if (code === "request_unavailable")
    return "This document request is no longer available.";
  if (code === "request_expired") return "This document request expired.";
  // Cancel or decline after payment or sharing began (the server's paid guard).
  if (code === "request_paid") return "Payment or sharing already started. Refresh to see it.";
  if (code === "owner_payout_required") return "Link payouts to continue.";
  if (code === "owner_price_required") return "Set your request price to continue.";
  if (code === "payout_unavailable") return "Payments are unavailable. Try again later.";
  if (code === "owner_share_expired")
    return "This document search expired. Start a new request.";
  return "Refresh to try again.";
}

/** Why the price sheet could not allow the request. */
function allowErrorCopy(cause: unknown, allowCents: boolean): string {
  const code = cause instanceof DriveSharingError ? cause.code : "request_failed";
  if (code === "invalid_payment_amount" || code === "invalid_argument")
    return allowCents ? DOCUMENT_REQUEST_PRICE_RULE : "Choose a whole-dollar price from $1 to $500.";
  if (code === "review_changed" || code === "request_already_decided")
    return "This request changed. Check it and try again.";
  return errorCopy(cause);
}

function isDurableReview(review: SharingReview | undefined): boolean {
  return !review?.agentPackage && review?.durableAvailable === true;
}

function requestSetup(snapshot: Snapshot | null) {
  if (!snapshot || !UNDECIDED.has(snapshot.status.status)) return null;
  const setup = documentRequestSetupState({ ...snapshot.status, ...snapshot.review });
  // A prepared package supplies a suggested price; the owner edits it in Allow.
  return snapshot.review?.agentPackage && setup === "price" ? null : setup;
}

/**
 * A request from outside the Trusted circle waiting for the owner's Allow or
 * Deny. The price is chosen inside Allow; any other setup comes first.
 */
function isOwnerDecision(snapshot: Snapshot | null): boolean {
  const setup = requestSetup(snapshot);
  const agentPackage = snapshot?.review?.agentPackage;
  if (snapshot?.review?.v1LiveRequest === true && agentPackage) return false;
  if (agentPackage) return snapshot?.status.direction === "incoming" &&
    UNDECIDED.has(snapshot.status.status) && agentPackage.status === "ready" &&
    agentPackage.canAllow && !!agentPackage.digest && agentPackage.selectedCount > 0 &&
    setup === null;
  return snapshot?.status.direction === "incoming" &&
    snapshot.status.status === "pending" &&
    (snapshot.review?.allowAvailable === true || snapshot.review?.priceOnlyAvailable === true) &&
    (setup === null || setup === "price");
}

/**
 * A failed, limited, stopped or incomplete search never shares more by itself:
 * the server resumes automatic batches only for a complete search. The owner
 * reviews it like a manual request, where Search again is the next step.
 */
function automaticSearchEnded(review: SharingReview | undefined): boolean {
  const search = review?.search;
  return !!search && (["failed", "limited", "stopped"].includes(search.status) || search.incompleteSearch);
}

function isAutomaticSharingActive(review: SharingReview | undefined): boolean {
  return !review?.agentPackage && review?.trustedAuto === true && review.priceOnlyAvailable !== true &&
    review.search?.coverage?.ownerReviewRequired !== true &&
    !automaticSearchEnded(review) &&
    documentRequestSetupState(review) === null &&
    review.preparationError !== "trusted_relationship_changed" &&
    review.preparationError !== "preparation_unavailable";
}

/**
 * An open autoshare request whose requester has not paid. Its order, and the
 * owner's earning row with it, exist from Allow; the server sends the owner
 * payment setup fields only until that order is paid. Copy only: Decline and
 * Stop are re-checked by the server.
 */
function awaitingAutosharePayment(snapshot: Snapshot | null): boolean {
  const review = snapshot?.review;
  return !!snapshot && UNDECIDED.has(snapshot.status.status) && review?.autoshare === true &&
    review.paymentRequired === true && typeof review.paymentsReady === "boolean";
}

/** Waiting in the durable queue; past the server's threshold it says so plainly. */
function queueLabel(queue: { queuedAt?: string; queueDelayed?: boolean } | undefined, now: number): string {
  if (queue?.queueDelayed !== true) return "Waiting to start";
  const waited = queue.queuedAt ? Math.floor((now - Date.parse(queue.queuedAt)) / 60_000) : NaN;
  return Number.isFinite(waited) && waited >= 1
    ? `Taking longer than usual · ${waited < 60 ? `${waited} min` : `${Math.floor(waited / 60)} hr`}`
    : "Taking longer than usual";
}

/** Confirmed access so far across this request's batches. */
function sharingProgressLabel(counts: DriveBulkShareCounts): string {
  return `Sharing files · ${(counts.shared + counts.alreadyShared).toLocaleString()} shared so far`;
}

/**
 * Owner-only: matches without confirmed Drive sharing permission for this
 * account, usually because someone else owns them. Automatic sharing leaves
 * them out; the requester never receives search counts.
 */
function ownerOnlyMatchesLabel(count: number): string {
  return count === 1
    ? "1 of these can only be shared by its owner."
    : `${count.toLocaleString()} of these can only be shared by their owners.`;
}

function needsSearchRefresh(review: SharingReview | undefined): boolean {
  const search = review?.search;
  const coverage = search?.coverage;
  return search?.status === "completed" && (
    coverage?.shareabilityVerified !== true ||
    (!review?.bulkShare && coverage.ownerReviewRequired === true &&
      coverage.timeIntent === undefined)
  );
}

/** The private agent is still looking for files for this incoming request. */
function isFinding(snapshot: Snapshot | null): boolean {
  const review = snapshot?.review;
  if (review?.agentPackage) return snapshot?.status.direction === "incoming" &&
    UNDECIDED.has(snapshot.status.status) && review.agentPackage.status === "preparing" &&
    review.preparationError !== "background_preparation_required";
  if (requestSetup(snapshot) || review?.preparationError === "date_range_required" || isOwnerDecision(snapshot)) return false;
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

const HAIRLINES = "divide-y divide-border/60 border-y border-border/60";

export function DocumentShareReview({
  requestId,
  onChanged,
  surface = "inline",
  counterpartLabel = null,
}: {
  requestId: string;
  onChanged: () => void;
  /** The other person's name, for "Waiting for Ankit to allow". */
  counterpartLabel?: string | null;
  /**
   * "sheet": the consent sheet paints a grouped background, so actionable
   * sections read as cards. "inline": the host is already a card (chat), so
   * sections stay flat rows.
   */
  surface?: "sheet" | "inline";
}) {
  const { user, userId } = useAuth();
  // Viewer access goes to the Google account linked to this One sign-in, so
  // the recipient opens each original as that account, not the browser default.
  const googleEmail =
    user?.providerData?.find((provider) => provider?.providerId === "google.com")?.email ?? null;
  const { isVaultUnlocked, getVaultOwnerToken } = useVault();
  if (!userId || !isVaultUnlocked)
    return <BodyText role="status">Unlock your vault to review.</BodyText>;
  return (
    <UnlockedDocumentReview
      key={`${userId}:${requestId}:${snapshotVaultSessionEpoch()}`}
      requestId={requestId}
      getToken={getVaultOwnerToken}
      onChanged={onChanged}
      googleEmail={googleEmail}
      surface={surface}
      counterpartLabel={counterpartLabel}
    />
  );
}

function UnlockedDocumentReview({
  requestId,
  getToken,
  onChanged,
  googleEmail,
  surface,
  counterpartLabel,
}: {
  requestId: string;
  getToken: () => string | null;
  onChanged: () => void;
  googleEmail: string | null;
  surface: "sheet" | "inline";
  counterpartLabel: string | null;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [activity, setActivity] = useState<Activity>("loading");
  const [stage, setStage] = useState<PrepareStage | null>(null);
  const [findingSince, setFindingSince] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trustFuture, setTrustFuture] = useState(false);
  const [priceOpen, setPriceOpen] = useState(false);
  const [ownerAccessDays, setOwnerAccessDays] = useState<number | null>(null);
  const openedPricePackageKey = useRef<string | null>(null);
  const [allowError, setAllowError] = useState<string | null>(null);
  // Deny is irreversible: a second tap confirms, as on the Feed row.
  const denyConfirm = useArmedAction();
  // Files A left unticked for this review revision; every file starts selected.
  const [unselected, setUnselected] = useState<{ key: string; ids: string[] }>({
    key: "",
    ids: [],
  });
  const [excluded, setExcluded] = useState<{ jobId: string; positions: number[] }>({ jobId: "", positions: [] });
  const [reviewSelected, setReviewSelected] = useState<{ jobId: string; positions: number[] }>({ jobId: "", positions: [] });
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
  const searchPageSerial = useRef(0);
  const searchPageKey = useRef("");
  const bulkPageSerial = useRef(0);
  const bulkPageKey = useRef("");
  // The requester's terms never change once sent: read them once per sheet. A
  // definitive "none" (older free requests) is remembered too; a transient
  // failure is asked again on the next load.
  const requesterTerms = useRef<{ revision: number; value: SharingRequestContext | null } | null>(null);
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
      if (status.hostedDelivery) return { status };
      const optionalOutgoingDelivery = async (): Promise<SharingDelivery | undefined> => {
        try {
          return await DriveSharingService.delivery(token, requestId, guard);
        } catch (cause) {
          if (
            cause instanceof DriveSharingError &&
            [
              "recipient_verification_unavailable",
              "recipient_changed",
              "recipient_google_identity_required",
              "recipient_verified_email_required",
            ].includes(cause.code)
          ) return undefined;
          throw cause;
        }
      };
      const pendingOwnerDelivery = async (review: SharingReview): Promise<SharingDelivery | undefined> => {
        if (!review.bulkShare) return undefined;
        const delivery = await DriveSharingService.delivery(token, requestId, guard);
        guard();
        return delivery.canStopAccess || delivery.accessStopStatus || delivery.bulkShareId
          ? delivery
          : undefined;
      };
      // Optional: a request without requester terms (or an older server) still loads.
      const requesterContext = async (): Promise<SharingRequestContext | null> => {
        if (requesterTerms.current?.revision === status.revision &&
            (!status.payment?.packageDisclosureRequired || (requesterTerms.current.value?.packageDisclosure &&
              requesterTerms.current.value.requestRevision === status.revision)))
          return requesterTerms.current.value;
        try {
          const value = await DriveSharingService.requesterContext(token, requestId, guard);
          guard();
          requesterTerms.current = { revision: status.revision, value };
          return value;
        } catch (cause) {
          guard();
          if (cause instanceof DriveSharingError && cause.code === "session_changed") throw cause;
          if (cause instanceof DriveSharingError && cause.code === "request_unavailable")
            requesterTerms.current = { revision: status.revision, value: null };
          return null;
        }
      };
      if (status.direction !== "incoming")
        return {
          status,
          delivery: await optionalOutgoingDelivery(),
          context: await requesterContext(),
        };
      if (!UNDECIDED.has(status.status)) {
        const delivery = await DriveSharingService.delivery(token, requestId, guard);
        guard();
        if (!delivery.bulkShareId && !PAYOUT_ELIGIBLE_TERMINAL.has(status.status))
          return { status, delivery };
        try {
          const review = await DriveSharingService.review(token, requestId, guard);
          guard();
          // A legacy terminal delivery without a bulk share still needs the
          // owner payout projection, but not a second file-review UI.
          return delivery.bulkShareId
            ? { status, delivery, review }
            : { status, delivery, ownerPayout: review.ownerPayout };
        } catch (cause) {
          guard();
          if (cause instanceof DriveSharingError &&
              ["invalid_response", "session_changed"].includes(cause.code))
            throw cause;
          // Delivery remains usable when its older review endpoint is gone.
          return { status, delivery };
        }
      }
      let review = await DriveSharingService.review(token, requestId, guard);
      guard();
      // Package preparation belongs to the server. Never enter legacy file selection.
      if (review.agentPackage) {
        const delivery = review.agentPackage.status === "allowed" ? await pendingOwnerDelivery(review) : undefined;
        return { status, review, ...(delivery ? { delivery } : {}) };
      }
      // Setup precedes any search; returning to this review cannot bypass it.
      if (requestSetup({ status, review })) return { status, review };
      // Nothing searches Drive until the owner allows the request.
      if (isOwnerDecision({ status, review })) return { status, review };
      if (isDurableReview(review)) {
        if (isAutomaticSharingActive(review)) {
          const delivery = await pendingOwnerDelivery(review);
          return delivery ? { status, review, delivery } : { status, review };
        }
        const legacyJob = needsSearchRefresh(review) ? review.search?.jobId ?? null : null;
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
        const delivery = await pendingOwnerDelivery(review);
        return delivery ? { status, review, delivery } : { status, review };
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
        return status.direction === "incoming"
          ? { status, delivery: await DriveSharingService.delivery(token, requestId, guard) }
          : {
              status,
              delivery: await optionalOutgoingDelivery(),
              context: await requesterContext(),
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
    };
  }, [load, run]);

  useEffect(() => {
    const reconcile = (event: Event) => {
      const detail = (event as CustomEvent<{ requestId?: string }>).detail;
      if (detail?.requestId && detail.requestId !== requestId &&
          detail.requestId !== `document_share_request:${requestId}`) return;
      void run(load, "load", "idle");
    };
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, reconcile);
    return () => window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, reconcile);
  }, [load, requestId, run]);

  const review = snapshot?.review;
  // The request's sealed price rule: only an older whole-dollar request
  // refuses cents (the 2026-10-17 first-Allow 422). New requests take $0.50+.
  const allowCents = review?.wholeDollarPrice !== true;
  const v1ManualReview = review?.v1ManualReview === true;
  const requestedAccessDays = review?.requestedAccessDays ?? 30;
  const accessDayChoices = [7, 30, 90].filter(days => days <= requestedAccessDays);
  if (!accessDayChoices.includes(requestedAccessDays)) accessDayChoices.push(requestedAccessDays);
  const selectedAccessDays = ownerAccessDays !== null && accessDayChoices.includes(ownerAccessDays)
    ? ownerAccessDays : requestedAccessDays;
  const agentPackage = snapshot?.status.direction === "incoming" ? review?.agentPackage : undefined;
  const v1Package = review?.v1LiveRequest === true && !!agentPackage;
  const packageDecisionKey = agentPackage
    ? `${agentPackage.revision}:${agentPackage.digest ?? ""}`
    : null;
  const removal = snapshot?.revocation;
  const search = review?.search;
  const bulkShare = review?.bulkShare;
  const ownerDecision = isOwnerDecision(snapshot);
  const priceOnly = !agentPackage && ownerDecision && review?.priceOnlyAvailable === true;
  // An autoshare request's Allow takes the requester's estimate (or the
  // owner's price) in one tap, when that price fits its sealed rule. An older
  // request keeps its price step.
  const quickAllowCandidate = review?.priceCents ?? review?.estimateCents ?? null;
  const quickAllowCents = review?.autoshare === true &&
    isValidDocumentRequestPriceCents(quickAllowCandidate) &&
    (allowCents || quickAllowCandidate % 100 === 0) ? quickAllowCandidate : null;
  const ownerPeriodNote = review?.periodConflict === "request_mentions_longer_span"
    ? periodConflictNote(review.purpose.purpose, review.purpose.periodStart, review.purpose.periodEnd, "owner")
    : null;
  const setup = requestSetup(snapshot);
  const automaticSharing = isAutomaticSharingActive(review);
  const awaitingPayment = awaitingAutosharePayment(snapshot);
  const ownerReviewRequired = review?.search?.coverage?.ownerReviewRequired === true;
  const progressive = review?.progressiveAllowed === true;
  const batches = review?.batches ?? [];
  const batchCount = review?.batchCount ?? batches.length;
  const claimedPositions = review?.claimedPositions ?? [];
  const recoverablePositions = review?.recoverablePositions ?? [];
  const durableReview = isDurableReview(review);
  const legacySearch = needsSearchRefresh(review);
  const searchReady = !legacySearch && isDriveSearchSelectionReady(search);
  const searchJobId = !agentPackage && search && (!bulkShare || progressive) && !legacySearch ? search.jobId : null;
  const searchInProgress = search?.status === "queued" || search?.status === "running";
  // A live V1 request streams evaluation progress from the search status,
  // while file pages remain limited to the existing manual review lane.
  const v1EvaluationInProgress = v1Package && agentPackage.status === "preparing" &&
    (search?.evaluation?.status === "pending" || search?.evaluation?.status === "running");
  const streamJobId = v1EvaluationInProgress ? search?.jobId ?? null : searchJobId;
  const streamInProgress = v1EvaluationInProgress || searchInProgress && !!searchJobId;
  const bulkPreviewId = agentPackage ? null : bulkShare?.shareId ?? null;
  const manualSelectionClosed = v1ManualReview && (
    !!snapshot && !UNDECIDED.has(snapshot.status.status) ||
    !!bulkShare && bulkShare.status !== "review_ready");

  useEffect(() => {
    if (!streamJobId || !streamInProgress) return;
    const token = getToken();
    if (!token) return;
    const epoch = snapshotVaultSessionEpoch();
    const controller = new AbortController();
    const guard = () => {
      if (controller.signal.aborted || !alive.current ||
        !isVaultSessionEpochCurrent(epoch) || getToken() !== token)
        throw new DriveSharingError("session_changed");
    };
    // The stream carries status revisions, never file content. Review GET is
    // the authority for candidate pages and Allow/Deny. The normal poll stays
    // active if this connection is interrupted or the server lacks SSE.
    void DriveSearchService.streamStatus(token, streamJobId, guard, () => {
      if (busy.current === "none") void run(load, "load", null);
    }, controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [getToken, load, run, streamJobId, streamInProgress]);

  useEffect(() => { setSearchCursor(null); setSearchPrevious([]); }, [search?.jobId]);
  useEffect(() => { setBulkCursor(null); setBulkPrevious([]); }, [bulkShare?.shareId]);

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
  const pollable = agentPackage
    ? !!snapshot && !removal && (pendingOutcomes ||
      UNDECIDED.has(snapshot.status.status) && review?.preparationError !== "background_preparation_required" &&
      (agentPackage.status === "preparing" || agentPackage.status === "allowed"))
    : !!snapshot &&
    !removal &&
    !retryLater &&
    // Nothing runs while the owner decides.
    !ownerDecision &&
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
  // The price sheet belongs to one open decision; it never reopens by itself.
  useEffect(() => {
    if (!ownerDecision) setPriceOpen(false);
  }, [ownerDecision]);
  // Keep an opened sheet tied to its exact package. A newly loaded package must
  // not close a sheet that the owner just opened for that same package.
  useEffect(() => {
    if (priceOpen && openedPricePackageKey.current !== packageDecisionKey) {
      setPriceOpen(false);
      setAllowError(null);
    }
  }, [packageDecisionKey, priceOpen]);
  useEffect(() => setAllowError(null), [packageDecisionKey]);
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
  const reviewSelectedPositions = search && reviewSelected.jobId === search.jobId ? reviewSelected.positions : [];
  const selectedRecoveryPositions = search && recoverySelected.jobId === search.jobId ? recoverySelected.positions : [];
  const blockedPositions = search && unshareableSeen.jobId === search.jobId ? unshareableSeen.positions : [];
  const manualExcludedCount = excludedPositions.filter(position => !blockedPositions.includes(position)).length;
  const selectedPositions = progressive && searchPage && search
    ? searchPage.files.filter(file => file.shareable === true &&
        (ownerReviewRequired
          ? !claimedPositions.includes(file.position) && reviewSelectedPositions.includes(file.position)
          : recoverablePositions.includes(file.position)
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
  const openPriceSheet = () => {
    denyConfirm.disarm();
    openedPricePackageKey.current = packageDecisionKey;
    setAllowError(null);
    setPriceOpen(true);
  };
  const closePriceSheet = () => {
    if (activity === "allowing") return;
    setPriceOpen(false);
    setAllowError(null);
  };
  const allow = (amountCents: number | null) => {
    if (!snapshot?.review || !isOwnerDecision(snapshot)) return;
    const revision = snapshot.review.revision;
    void run(
      async (token, guard, report) => {
        try {
          const packageTerms = snapshot.review!.agentPackage;
          const submit = !packageTerms && snapshot.review!.priceOnlyAvailable
            ? DriveSharingService.setRequestPrice.bind(DriveSharingService)
            : DriveSharingService.allow.bind(DriveSharingService);
          const input = packageTerms
            ? { revision, amountCents, packageRevision: packageTerms.revision, packageDigest: packageTerms.digest! }
            : { revision, amountCents };
          await submit(token, requestId, { ...input, ...(snapshot.review!.oneCopyRequested ? { oneCopyAccepted: true } : {}) }, guard);
        } catch (cause) {
          guard();
          // Read again: the sheet stays open only while the request can still be allowed.
          setAllowError(allowErrorCopy(cause, allowCents));
          return load(token, guard, report);
        }
        guard();
        setPriceOpen(false);
        setAllowError(null);
        // Acknowledged work is reconciled even when the next GET fails.
        onChanged();
        report.acknowledged();
        return load(token, guard, report);
      },
      "decide",
      "allowing",
      true,
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

  // Allowed (or Trusted) and waiting in the durable queue: nothing has
  // started, so the sheet says so and never spins. Never "paused".
  const automaticQueued = automaticSharing && !search && !bulkShare &&
    review?.preparationError !== "date_range_required" &&
    review?.preparationError !== "background_preparation_required" &&
    !["completed", "partial", "no_match"].includes(snapshot?.status.status ?? "");
  // A completed latest batch cannot stand in for all progressive batches.
  const requestDeliveryCounts = snapshot?.delivery?.counts ?? review?.aggregateCounts;
  const partialDeliveryState = snapshot?.status.status === "partial"
    ? partialDocumentDeliveryState({
      total: requestDeliveryCounts?.total,
      available: requestDeliveryCounts && requestDeliveryCounts.shared + requestDeliveryCounts.alreadyShared,
      pending: requestDeliveryCounts && requestDeliveryCounts.pending + requestDeliveryCounts.unknown,
    }) : null;
  const partialDeliveryLine = partialDeliveryState === "available"
    ? "Files shared · Request incomplete"
    : partialDeliveryState === "checking" ? "Checking file access"
    : partialDeliveryState === "unavailable"
      ? bulkShare && ["stopped", "failed"].includes(bulkShare.status)
        ? BULK_STATUS_LABELS[bulkShare.status] : "Sharing incomplete"
    : partialDeliveryState === "unknown" ? "Review sharing and search results" : null;
  // Started work that no worker has moved past the server's threshold (for
  // example while the drains are paused): stop claiming work, never spin.
  const automaticDelayed = automaticSharing && typeof review?.workDelayedSince === "string" &&
    review?.preparationError !== "date_range_required" &&
    review?.preparationError !== "background_preparation_required";
  const durableStatus = snapshot?.status.direction === "incoming" &&
    snapshot.status.status === "no_match"
    ? documentRequestEmptyOutcomeLabel(snapshot.status.outcomeReason)
    : automaticSharing
    ? review?.preparationError === "date_range_required"
      ? "Exact dates needed"
      : review?.preparationError === "background_preparation_required"
      ? "Background Drive access needed"
      : automaticDelayed
        ? queueLabel({ queuedAt: review?.workDelayedSince, queueDelayed: true }, now)
      : bulkShare && ["queued", "running"].includes(bulkShare.status)
        ? sharingProgressLabel(review?.aggregateCounts ?? bulkShare.counts)
        : search && ["queued", "running"].includes(search.status)
          ? `Searching Drive · ${search.matched.toLocaleString()} file candidates`
          // Autoshare: a finished search waits on the requester, never on an owner review.
          : awaitingPayment && search ? "Waiting for payment"
          : bulkShare ? BULK_STATUS_LABELS[bulkShare.status]
            : ["completed", "partial"].includes(snapshot?.status.status ?? "") ? "Sharing finished"
              : search ? "Waiting to share"
                : queueLabel(review, now)
    : progressive && search && ["queued", "running"].includes(search.status)
    ? `Searching Drive · ${search.matched.toLocaleString()} file candidates${batchCount ? ` · ${batchCount.toLocaleString()} ${batchCount === 1 ? "batch" : "batches"} started` : ""}`
    : bulkShare
    ? bulkShare.status === "review_ready"
      ? `${bulkShare.fileCount.toLocaleString()} files selected for sharing`
      : BULK_STATUS_LABELS[bulkShare.status]
    : legacySearch
      ? "Updating file access checks"
    : !search && searchStartFailed.current
      ? "Search unavailable"
      : searchReady
      ? `${search.matched.toLocaleString()} file candidates to review`
        : search?.status === "failed"
          ? "Search failed"
          : search?.status === "limited" || search?.incompleteSearch
            ? "Search incomplete"
          : search?.status === "stopped"
            ? "Search stopped"
          : search
            ? `Searching Drive · ${search.matched.toLocaleString()} file candidates`
            : null;
  // The requester's sheet reads the same durable queue from the status.
  const requesterQueued = snapshot?.status.direction === "outgoing" &&
    snapshot.status.status === "pending" && typeof snapshot.status.queuedAt === "string";
  const requesterDelayed = snapshot?.status.direction === "outgoing" &&
    snapshot.status.status === "pending" && typeof snapshot.status.workDelayedSince === "string";
  const outgoingStatus = snapshot?.status.direction === "outgoing" ? snapshot.status : null;
  // The Consent Center's generic label is not a name.
  const ownerName = counterpartLabel?.trim() && counterpartLabel.trim() !== "Document request"
    ? counterpartLabel.trim() : "the owner";
  const sentCount = snapshot?.delivery?.sharedCount ?? 0;
  const sentSoFar = `${sentCount.toLocaleString()} sent so far`;
  const requesterPayment = outgoingStatus?.payment;
  // As of now: a checkout deadline passes on the device without a refetch.
  const requesterPaymentState = requesterPayment
    ? effectiveRequesterPaymentState(requesterPayment, now) : null;
  const requesterLine = !outgoingStatus
    ? null
    : outgoingStatus.awaitingOwnerAllow === true && UNDECIDED.has(outgoingStatus.status)
      ? `Waiting for ${ownerName} to allow`
    : requesterPaymentState === "payable" && requesterPayment && requesterPayment.amountCents !== null
      ? `Pay ${formatDocumentRequestPrice(requesterPayment.amountCents)} to get the files`
    : requesterPaymentState === "link_expired"
      ? REQUESTER_PAYMENT_TITLES.linkExpired
    : requesterPaymentState === "request_expired"
      ? REQUESTER_PAYMENT_TITLES.requestExpired
    : outgoingStatus.status === "completed" && sentCount > 0
      ? `All files sent · ${sentCount.toLocaleString()} ${sentCount === 1 ? "file" : "files"}`
    // Autoshare refunds what it could not send; the payment row says how much.
    : outgoingStatus.status === "partial" && sentCount > 0 && requesterPayment?.autoshare === true
      ? `Files sent · ${sentCount.toLocaleString()}`
    : outgoingStatus.status === "no_files_shared" && sentCount === 0
      ? documentRequestEmptyOutcomeLabel(outgoingStatus.outcomeReason)
    // Stalled or still queued work says so; it never reads as running.
    : requesterDelayed
      ? `${queueLabel({ queuedAt: outgoingStatus.workDelayedSince, queueDelayed: true }, now)}${
        sentCount > 0 ? ` · ${sentSoFar}` : ""}`
    : requesterQueued
      ? queueLabel(outgoingStatus, now)
    : sentCount > 0 && (UNDECIDED.has(outgoingStatus.status) || outgoingStatus.status === "approved" ||
        ["queued", "running"].includes(snapshot?.delivery?.bulkStatus ?? ""))
      ? `Sending files · ${sentSoFar}`
    : outgoingStatus.autoshare === true && UNDECIDED.has(outgoingStatus.status)
      ? "Finding files"
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
            : snapshot.status.direction === "incoming" && snapshot.status.status === "no_match"
              ? documentRequestEmptyOutcomeLabel(snapshot.status.outcomeReason)
            : agentPackage && review?.preparationError === "background_preparation_required"
              ? "Background Drive access needed"
            : v1Package && UNDECIDED.has(snapshot.status.status)
              ? ({ preparing: "Finding files", ready: "Request prepared",
                  no_match: "No matching files", unavailable: "Couldn't check this request",
                  stale: "Checking request", allowed: "Request prepared" } as const)[agentPackage.status]
            : agentPackage?.confidenceBasis === "provider_search" && UNDECIDED.has(snapshot.status.status)
              ? ({ preparing: "Finding files", ready: "Files ready", no_match: "No matching files",
                  unavailable: "Couldn’t check files", stale: "Files changed", allowed: "Sharing allowed" } as const)[agentPackage.status]
            : agentPackage && UNDECIDED.has(snapshot.status.status)
              ? ({ preparing: "Preparing your file package", ready: agentPackage.coverageStatus === "partial" ? "Incomplete package"
                  : agentPackage.coverageStatus === "unknown" ? "Unable to verify"
                  : agentPackage.canAllow ? "Package ready for your decision" : "Packet not ready to allow",
                  no_match: "No packet prepared for this request", unavailable: "Package preparation unavailable",
                  stale: "Package needs a fresh assessment", allowed: "Package allowed" } as const)[agentPackage.status]
            : setup && !ownerDecision
              ? documentRequestSetupLabel(setup, snapshot.status.direction === "incoming")
            : ownerDecision
              ? priceOnly ? "Set price" : "Needs your decision"
            : partialDeliveryState === "unknown" && requesterPayment?.autoshare === true && requesterLine
              ? requesterLine
            : partialDeliveryLine
              ? partialDeliveryLine
            : durableReview && durableStatus
              ? durableStatus
              : requesterLine
                ? requesterLine
              : snapshot.status.direction === "outgoing" &&
                (snapshot.delivery?.sharedCount ?? 0) > 0 &&
                (UNDECIDED.has(snapshot.status.status) || snapshot.status.status === "approved" ||
                  ["queued", "running"].includes(snapshot.delivery?.bulkStatus ?? ""))
                ? `${snapshot.delivery!.sharedCount!.toLocaleString()} files available; more may arrive`
              : requesterDelayed
                ? queueLabel({ queuedAt: snapshot.status.workDelayedSince, queueDelayed: true }, now)
              : snapshot.delivery?.bulkStatus
                ? BULK_STATUS_LABELS[snapshot.delivery.bulkStatus]
              : requesterQueued
                ? queueLabel(snapshot.status, now)
              : stillWorking
              ? "Still finding files"
              : finding
                ? STAGE_LABELS.starting
                : retryLater
                  ? "Search didn't finish"
                  : (STATUS_LABELS[snapshot.status.status] ??
                    "Check request status");
  const spinning =
    activity !== "idle" || (finding && !stillWorking && !automaticQueued && !automaticDelayed) ||
    (!snapshot && !error);
  const statusHint = activity === "idle" && automaticQueued
    ? review?.queueDelayed === true
      ? "This request is saved and continues automatically."
      : review?.ownerAllowed === true
        ? "Request allowed. The Drive search starts soon."
        : "The Drive search starts soon."
    : activity === "idle" && requesterQueued
      ? snapshot.status.queueDelayed === true
        ? "Your request is saved and continues automatically."
        : "The Drive search starts soon."
    : activity === "idle" && automaticDelayed
      ? "This request is saved and continues automatically."
    : activity === "idle" && requesterDelayed
      ? "Your request is saved and continues automatically."
    : stillWorking
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
  const payoutProjection = snapshot?.ownerPayout ?? review?.ownerPayout;
  const ownerPayout = !outgoing && payoutProjection
    ? awaitingPayment && payoutProjection.status === "awaiting_delivery"
      ? { status: "Waiting for payment", earnings: null }
      : documentPayoutStatusCopy(payoutProjection)
    : null;
  // The owner's one retry for files Google Drive could not share. The requester
  // may ask for it; whether it can run stays with this batch view.
  const retryUnshared = !outgoing && bulkShare && bulkShare.status !== "review_ready" &&
    bulkShare.canRetry === true && (bulkShare.retryableCount ?? 0) > 0 ? (
      <Button data-consent-role="primary-action" size="prominent" disabled={locked}
        onClick={() => mutate((token, guard) => DriveSharingService.retryBulkShare(token, bulkShare, guard), "retrying_share")}>
        Retry {bulkShare.retryableCount?.toLocaleString()} {bulkShare.retryableCount === 1 ? "file" : "files"}
      </Button>
    ) : null;
  const reviewAsk = outgoing ? null : delivery?.reviewRequest ?? null;
  const reloadDetails = () => {
    onChanged();
    void run(load, "load", "idle");
  };

  return (
    <section
      aria-label="Document sharing review"
      className={cn("consent-presentation-surface min-w-0 space-y-4 break-words", DOCUMENT_FLOW_TEXT_SCALE)}
      data-testid="document-share-review"
    >
      {/* Hosted delivery owns its status and next action in its panel. */}
      {!snapshot?.status.hostedDelivery ? <div
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
      </div> : null}
      {/* Only the owner acts on setup; the requester's status line just says it waits. */}
      {setup && !ownerDecision && snapshot?.status.direction === "incoming" ? (
        <div className="space-y-2">
          <HelperText>{setup === "drive" ? "Needed to find the requested files."
            : setup === "payouts" ? "Link your bank before this request can continue."
              : setup === "price" ? "Choose your default document request price."
                : "This request will resume when payments are available."}</HelperText>
          {setup === "drive" ? <Button data-consent-role="compact-action" size="standard" asChild>
            <ProfileConnectorsLink connectorId={GOOGLE_DRIVE_CONNECTOR_ID}>
              {documentRequestSetupLabel(setup, true)}
            </ProfileConnectorsLink>
          </Button> : setup !== "unavailable" ? <Button data-consent-role="compact-action" size="standard" asChild>
            <Link href={documentRequestSetupHref(setup, buildConsentCenterHref("pending", {
              requestId: `document_share_request:${requestId}`, requestView: "received",
            }))}>{documentRequestSetupLabel(setup, true)}</Link>
          </Button> : null}
        </div>
      ) : null}
      {ownerPayout ? (
        <div className="rounded-xl border border-border/60 p-3" aria-label="Document earnings">
          <BodyText className="font-medium">{ownerPayout.status}</BodyText>
          {ownerPayout.earnings ? (
            <HelperText className="mt-1">{ownerPayout.earnings} after Hushh&apos;s commission and the actual processing fee.</HelperText>
          ) : null}
        </div>
      ) : null}
      {reviewAsk && !removal ? (
        <div className="space-y-3 rounded-xl border border-border/60 p-3" role="note" aria-label="Review request">
          <div>
            <BodyText className="font-medium">Review requested</BodyText>
            <HelperText className="mt-1">{presentOwnerReviewRequest(reviewAsk, retryUnshared !== null)}</HelperText>
          </div>
          {/* The manual batch view shows the same Retry below. */}
          {automaticSharing ? retryUnshared : null}
        </div>
      ) : null}
      {payoutProjection && ["awaiting_delivery", "awaiting_account"].includes(payoutProjection.status) ? (
        <DocumentPayoutAccountCard compact />
      ) : null}
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

      {!outgoing && snapshot?.status.oneCopyRequested && PAYOUT_ELIGIBLE_TERMINAL.has(snapshot.status.status) ? <BackgroundDocumentLink requestId={requestId} /> : null}
      {snapshot?.status.hostedDelivery ? <HostedDocumentPanel requestId={requestId} onChanged={onChanged} /> : null}
      {outgoing && snapshot && !snapshot.status.hostedDelivery && !removal ? (
        <DocumentRequestRequesterPanel
          requestId={requestId}
          status={snapshot.status}
          delivery={snapshot.delivery}
          context={snapshot.context ?? null}
          locked={locked}
          surface={surface}
          onCancel={() => decide("cancel")}
          onChanged={reloadDetails}
        />
      ) : null}

      {review && v1Package && agentPackage && !removal ? <>
        <BodyText className="whitespace-pre-wrap [overflow-wrap:anywhere]">“{review.purpose.purpose}”</BodyText>
        <dl className={HAIRLINES}>
          <Fact label="Share with" value={review.recipientEmail} />
          {review.requesterProfile?.type === "ria" ? <Fact label="Requester"
            value={`${review.requesterProfile.legalName ?? review.requesterProfile.displayName ?? "Advisor"} · Verified RIA`} /> : null}
          {review.purpose.periodStart ? <Fact label={agentPackage.confidenceBasis === "provider_search" ? "Search period" : "Period"} value={`${review.purpose.periodStart} – ${review.purpose.periodEnd}`} /> : null}
          <Fact label="Access" value={review.requestedAccessDays != null
            ? `Viewer for ${review.approvedAccessDays ?? review.requestedAccessDays} days`
            : "Viewer, until removed"} />
        </dl>
        {review.preparationError === "background_preparation_required" ? <div className="space-y-3">
          <HelperText>Turn on background Drive access to continue.</HelperText>
          <Button data-consent-role="primary-action" size="prominent" disabled={locked} onClick={enableBackground}>Enable background Drive access</Button>
        </div> : null}
        {(agentPackage.provisionalFiles?.length || agentPackage.selectedFiles?.length || agentPackage.candidateCount > 0) ?
          <details className="text-sm"><summary data-consent-role="utility" className="min-h-11 cursor-pointer py-3">View details</summary>
            {review.requesterProfile?.type === "ria" || review.reason ? <dl className={HAIRLINES}>
              {review.requesterProfile?.firmName ? <Fact label="Firm" value={review.requesterProfile.firmName} /> : null}
              {review.requesterProfile?.crd ? <Fact label="CRD" value={review.requesterProfile.crd} /> : null}
              {review.reason ? <Fact label="Reason" value={review.reason} /> : null}
            </dl> : null}
            <HelperText>{agentPackage.evaluatedCount.toLocaleString()} of {agentPackage.candidateCount.toLocaleString()} candidates checked
              {agentPackage.pendingCount ? ` · ${agentPackage.pendingCount.toLocaleString()} remaining` : ""}</HelperText>
            {(agentPackage.provisionalFiles ?? agentPackage.selectedFiles)?.length ? <ul className="divide-y divide-border/60" aria-label="Files checked so far">
              {(agentPackage.provisionalFiles ?? agentPackage.selectedFiles ?? []).map(file => <li key={file.position} className="py-2">
                <HelperText className="[overflow-wrap:anywhere]">{file.name}</HelperText>
                <HelperText>Agent match {file.confidenceScore}/100 · Value {file.weightageOutOf10}/10</HelperText>
              </li>)}
            </ul> : null}
            {(agentPackage.provisionalFiles?.length || agentPackage.selectedFiles?.length) ?
              <HelperText>Scores are Agent One assessments, not measured accuracy.</HelperText> : null}
          </details> : null}
        {review.trustedAuto !== true && snapshot && UNDECIDED.has(snapshot.status.status) ? <Button data-consent-role="compact-action"
          size="standard" variant={denyConfirm.armed ? "destructive" : "none"}
          disabled={locked} aria-label={denyConfirm.ariaLabel("Deny")}
          onClick={() => denyConfirm.activate(() => decide("decline"))}>
          {denyConfirm.label("Deny")}
        </Button> : null}
      </> : null}

      {review?.oneCopyRequested && ownerDecision && !removal && !priceOnly ? <HelperText>{ONE_COPY_ALLOW_DISCLOSURE}</HelperText> : null}
      {review && agentPackage && !v1Package && !removal ? <>
        <DocumentPackageDetails review={review} agentPackage={agentPackage} hairlines={HAIRLINES} />
        {review.preparationError === "package_existing_access_requires_review" ?
          <BodyText>The requester already has access to part of this packet. Checkout is paused.</BodyText>
        : review.preparationError === "payment_not_ready" ?
          <BodyText>Current access could not be verified. Checkout is paused.</BodyText>
        : review.preparationError === "background_preparation_required" ? <div className="space-y-3">
          <BodyText>Turn on background access so Agent One can prepare this packet.</BodyText>
          <Button data-consent-role="primary-action" size="prominent" disabled={locked} onClick={enableBackground}>Enable background Drive access</Button>
        </div> : <HelperText>{agentPackage.status === "preparing"
          ? "Agent One is preparing this packet."
          : agentPackage.status === "allowed"
            ? review.paymentRequired ? "The requester pays before this approved package is shared." : "Your approved package is being shared."
          : agentPackage.confidenceBasis === "provider_search" && agentPackage.status === "ready"
            ? "Files matched the Drive search. Their contents were not read."
          : agentPackage.status === "ready"
            ? agentPackage.canAllow ? "Allow this packet at the suggested price, or edit it."
              : agentPackage.coverageStatus === "partial" ? "Coverage is incomplete."
              : agentPackage.coverageStatus === "unknown" ? "Coverage could not be verified."
              : "This packet needs a fresh assessment before Allow."
          : agentPackage.status === "no_match"
            ? "Agent One could not prepare a packet for this request."
          : agentPackage.status === "stale"
            ? "This packet needs a fresh assessment."
            : "Agent One couldn’t finish checking this request."}</HelperText>}
        <DocumentPackageActions review={review} agentPackage={agentPackage}
          undecided={!!snapshot && UNDECIDED.has(snapshot.status.status)} locked={locked}
          ownerDecision={ownerDecision} denyConfirm={denyConfirm} allowClass={ALLOW_CLASS}
          onAllow={allow} onDecline={() => decide("decline")} onEditPrice={openPriceSheet} />
        {allowError && !priceOpen ? <HelperText role="alert">{allowError}</HelperText> : null}
        <DocumentRequestPriceSheet
          moneyPolicy="drive_cents"
          open={priceOpen && ownerDecision}
          requesterLabel={review.recipientEmail}
          purpose={review.purpose.purpose}
          recipientEmail={review.recipientEmail}
          periodStart={review.purpose.periodStart}
          periodEnd={review.purpose.periodEnd}
          periodNote={ownerPeriodNote}
          paymentRequired={review.paymentRequired === true}
          description={review.paymentRequired ? "Allow this exact package at your chosen price. Files are shared after the requester pays." : "Allow your private agent to share this exact package."}
          oneCopyRequested={review.oneCopyRequested === true}
          estimateCents={review.estimateCents ?? null}
          initialAmountCents={agentPackage.suggestedPriceCents ?? review.priceCents ?? null}
          busy={activity === "allowing"}
          error={allowError}
          onSubmit={allow}
          onCancel={closePriceSheet}
        />
      </> : null}

      {review && !agentPackage && ownerDecision && !removal ? <>
        <BodyText className="whitespace-pre-wrap [overflow-wrap:anywhere]">“{review.purpose.purpose}”</BodyText>
        <dl className={HAIRLINES}>
          <Fact label="Share with" value={review.recipientEmail} />
          {review.purpose.periodStart ? (
            <Fact label="Period" value={`${review.purpose.periodStart} – ${review.purpose.periodEnd}`} />
          ) : null}
          <Fact label="Access" value="Viewer, until removed" />
          {review.paymentRequired === true && quickAllowCents !== null && !priceOnly ? (
            <Fact label="Price" value={formatDocumentRequestPrice(quickAllowCents)} />
          ) : null}
        </dl>
        {review.paymentRequired === true && quickAllowCents !== null && !priceOnly ? (
          <HelperText>You get this minus a 3% fee and Stripe&apos;s fee.</HelperText>
        ) : null}
        {ownerPeriodNote ? <HelperText>{ownerPeriodNote}</HelperText> : null}
        <HelperText>{priceOnly ? "Set a price for this request. Files are shared after payment." : review.autoshare === true
          ? review.paymentRequired === true
            ? "Allow and Agent One sends every matching file you can share once they pay."
            : "Allow and Agent One sends every matching file you can share."
          : review.paymentRequired === true
          ? "Allow to set a price and search Drive. You may need to choose the exact files before payment and sharing."
          : "Allow Agent One to search Drive. You may need to choose the exact files before sharing."}</HelperText>
        <FlowActionGroup
          primary={
            <Button data-consent-role="primary-action" size="prominent" variant="none" className={ALLOW_CLASS} disabled={locked}
              onClick={() => {
                // One tap at the requester's estimate; Edit price opens the sheet.
                if (!priceOnly && (review.paymentRequired !== true || quickAllowCents !== null))
                  allow(review.paymentRequired === true ? quickAllowCents : null);
                else openPriceSheet();
              }}>
              {priceOnly ? "Set price" : "Allow"}
            </Button>
          }
          secondary={priceOnly ? undefined :
            <Button data-consent-role="primary-action" size="prominent" variant={denyConfirm.armed ? "destructive" : "none"}
              className={denyConfirm.armed ? undefined : "text-destructive hover:text-destructive"}
              disabled={locked} aria-label={denyConfirm.ariaLabel("Deny")}
              onClick={() => denyConfirm.activate(() => decide("decline"))}>
              {denyConfirm.label("Deny")}
            </Button>
          }
        />
        {review.paymentRequired === true && !priceOnly ? (
          <Button data-consent-quiet-action="true" data-consent-role="compact-action" size="standard" variant="none" disabled={locked} onClick={openPriceSheet}>Edit price</Button>
        ) : null}
        {allowError && !priceOpen ? <HelperText role="alert">{allowError}</HelperText> : null}
        <DocumentRequestPriceSheet
          moneyPolicy={allowCents ? "drive_cents" : "legacy_whole_dollars"}
          open={priceOpen}
          requesterLabel={review.recipientEmail}
          purpose={review.purpose.purpose}
          recipientEmail={review.recipientEmail}
          periodStart={review.purpose.periodStart}
          periodEnd={review.purpose.periodEnd}
          periodNote={ownerPeriodNote}
          paymentRequired={review.paymentRequired === true}
          oneCopyRequested={review.oneCopyRequested === true}
          estimateCents={review.estimateCents ?? null}
          initialAmountCents={review.priceCents ?? null}
          priceOnly={priceOnly}
          busy={activity === "allowing"}
          error={allowError}
          onSubmit={allow}
          onCancel={closePriceSheet}
        />
      </> : null}

      {review && automaticSharing && !removal ? <>
        <BodyText className="whitespace-pre-wrap [overflow-wrap:anywhere]">“{review.purpose.purpose}”</BodyText>
        <dl className={HAIRLINES}>
          <Fact label="Share with" value={review.recipientEmail} />
          {review.purpose.periodStart ? (
            <Fact label="Period" value={`${review.purpose.periodStart} – ${review.purpose.periodEnd}`} />
          ) : null}
          <Fact label="Access" value="Viewer, until removed" />
          {review.ownerAllowed === true && typeof review.priceCents === "number" ? (
            <Fact label="Price" value={formatDocumentRequestPrice(review.priceCents)} />
          ) : null}
        </dl>
        {review.preparationError === "date_range_required" ? (
          <BodyText>This request needs exact start and end dates. Ask the requester to send a new request with both dates.</BodyText>
        ) : review.preparationError === "background_preparation_required" ? <div className="space-y-3">
          <BodyText>Turn on background access so Agent One can resume this request.</BodyText>
          <Button data-consent-role="primary-action" size="prominent" disabled={locked} onClick={enableBackground}>Enable background Drive access</Button>
        </div> : <HelperText>
          {review.autoshare === true
            ? `${review.paymentRequired === true ? "After payment, " : ""}Agent One sends every matching file you can share, in batches. You can close this.`
            : "Agent One searches Drive and shares selected files. You can close this window; the requester sees each original only after Google Drive confirms access."}
        </HelperText>}
        {ownerPeriodNote ? <HelperText>{ownerPeriodNote}</HelperText> : null}
        {search && review.preparationError !== "date_range_required" ? <HelperText>{search.matched.toLocaleString()} file candidates{review.autoshare === true && search.status === "completed" ? "" : " so far"}
          {search.status === "running" ? " · search continues" : ""}</HelperText> : null}
        {search && review.preparationError !== "date_range_required" && search.unshareableCount ? (
          <HelperText>{ownerOnlyMatchesLabel(search.unshareableCount)}</HelperText>
        ) : null}
        {/* Autoshare: the owner can decline until the requester pays, since nothing
            is shared before payment; once a paid batch exists, Review removal
            stops it. Older requests keep their rule: until a batch is frozen. */}
        {(review.autoshare === true && review.paymentRequired === true ? awaitingPayment
          : review.ownerAllowed === true && snapshot?.status.status === "pending" &&
            !bulkShare && batchCount === 0 && !review.aggregateCounts) ? (
          <Button data-consent-role="compact-action" size="standard" variant={denyConfirm.armed ? "destructive" : "none"}
            className={denyConfirm.armed ? undefined : "text-destructive hover:text-destructive"}
            disabled={locked} aria-label={denyConfirm.ariaLabel("Decline")}
            onClick={() => denyConfirm.activate(() => decide("decline"))}>
            {denyConfirm.label("Decline")}
          </Button>
        ) : null}
        {review.aggregateCounts || bulkShare ? <div className="space-y-3">
          <OutcomeSummary counts={review.aggregateCounts ?? bulkShare!.counts} issues={bulkShare?.issues} />
          {bulkPage?.files.length ? <SettingsGroup embedded title="Latest files" {...groupSurface}>
            {bulkPage.files.map(file => <SettingsRow key={file.position} title={file.name}
              description={file.outcomes?.length ? <FileOutcomes outcomes={file.outcomes} /> : undefined}
              trailing={file.openUrl ? <OriginalLink url={file.openUrl} googleEmail={googleEmail} /> : undefined} />)}
          </SettingsGroup> : null}
        </div> : null}
      </> : null}

      {snapshot?.status.direction === "incoming" && snapshot.status.outcomeReason === "matching_files_unshareable" ? (
        <HelperText>
          {snapshot.status.matchedFileCount ? `${snapshot.status.matchedFileCount} files found. ` : ""}
          No matching file has confirmed sharing permission from your connected account.
          Open Google Drive and ask the file owner or shared drive manager to check sharing permissions.
          Payment does not change file permissions.
        </HelperText>
      ) : null}

      {review && !agentPackage && !setup && durableReview && !automaticSharing && !ownerDecision && !removal ? (
        <>
          {review.trustedAuto && review.preparationError === "trusted_relationship_changed" ?
            <BodyText>{review.ownerAllowed === true
              // An allowed request was never Trusted Circle work; only the connection changed.
              ? "This request needs a manual review before sharing."
              : "Trusted Circle changed. Review this request manually before sharing."}</BodyText> : null}
          {review.trustedAuto && review.preparationError === "preparation_unavailable" ?
            <BodyText>Automatic sharing could not finish. Review and share the files yourself.</BodyText> : null}
          {review.trustedAuto && !review.preparationError && automaticSearchEnded(review) ?
            <BodyText>Automatic sharing stopped because the Drive search didn&apos;t finish. Review and share the files yourself.</BodyText> : null}
          <BodyText className="whitespace-pre-wrap [overflow-wrap:anywhere]">
            “{review.purpose.purpose}”
          </BodyText>
          <dl className={HAIRLINES}>
            <Fact label="Share with" value={review.recipientEmail} />
            {review.requesterProfile?.type === "ria" ? <>
              <Fact label="Requester" value={`${review.requesterProfile.legalName ?? review.requesterProfile.displayName ?? "Advisor"} · Verified RIA`} />
              {review.requesterProfile.firmName ? <Fact label="Firm" value={review.requesterProfile.firmName} /> : null}
              {review.requesterProfile.crd ? <Fact label="CRD" value={review.requesterProfile.crd} /> : null}
            </> : null}
            {review.reason ? <Fact label="Reason" value={review.reason} /> : null}
            {search?.coverage?.requestedPeriod || review.purpose.periodStart ? (
              <Fact label="Period" value={search?.coverage?.requestedPeriod
                ? `${search.coverage.requestedPeriod.start} – ${search.coverage.requestedPeriod.end}`
                : `${review.purpose.periodStart} – ${review.purpose.periodEnd}`} />
            ) : null}
            <Fact label="Access" value={v1ManualReview && review.requestedAccessDays != null
              ? `Viewer for ${review.approvedAccessDays ?? review.requestedAccessDays} days`
              : "Viewer, until removed"} />
          </dl>

          {search?.coverage ? <div className="space-y-1" aria-label="Search coverage">
            <HelperText>{v1ManualReview
              ? `${review?.verifiedCount?.toLocaleString() ?? 0} files checked against the request. Select the exact files to share.`
              : searchReady
              ? search?.coverage?.providerPagesExhausted
                ? "Search finished; file contents and dates not checked."
                : "Selected candidates available; more files may exist."
              : legacySearch
                ? "Earlier results need a new sharing permission check."
              : progressive
                ? "Drive is still finding files. You can share a reviewed batch while it continues."
                : "Search is not complete. Additional matching files may exist."}</HelperText>
            <HelperText>{search.coverage.corpora.includes("member_shared_drives") ? "Your files and shared drives" : "Your files"}
              {` · ${search.coverage.providerRowsScanned.toLocaleString()} Drive results scanned`}</HelperText>
            {!v1ManualReview && (search.coverage.excludedByDateCount || search.coverage.deduplicatedCount) ? <HelperText>
              {[search.coverage.excludedByDateCount > 0 ? `${search.coverage.excludedByDateCount.toLocaleString()} excluded by file dates` : null,
                search.coverage.deduplicatedCount > 0 ? `${search.coverage.deduplicatedCount.toLocaleString()} duplicate matches omitted` : null].filter(Boolean).join(" · ")}
            </HelperText> : null}
            {!v1ManualReview && (search.coverage.excludedByTopicCount ?? 0) > 0 ? <HelperText>
              {search.coverage.excludedByTopicCount?.toLocaleString()} files in matching folders were excluded because their names did not match this request. Review Drive if a document is missing.
            </HelperText> : null}
            {v1ManualReview ? <HelperText>
              Only Agent One&apos;s verified matches can be selected.
            </HelperText> : ownerReviewRequired ? <HelperText>
              Dates inside files haven&apos;t been checked. Select the exact files before sharing.
            </HelperText> : search.coverage.requestedPeriod ? <HelperText>
              Dates match file names first, then creation or modification dates. Dates inside file contents were not checked.
            </HelperText> : null}
          </div> : null}
          {search && bulkShare ? <div className="space-y-1">
            <HelperText>{v1ManualReview
              ? `${review?.verifiedCount?.toLocaleString() ?? 0} verified files · ${batchCount.toLocaleString()} ${batchCount === 1 ? "batch" : "batches"} started`
              : progressive
              ? `${search.matched.toLocaleString()} file candidates${search.status === "completed" ? "" : " so far"} · ${batchCount.toLocaleString()} ${batchCount === 1 ? "batch" : "batches"} started`
              : `${search.matched.toLocaleString()} file candidates · ${bulkShare.fileCount.toLocaleString()} selected for sharing`}</HelperText>
            {(search.unshareableCount ?? 0) > 0 ? <HelperText>
              {search.unshareableCount?.toLocaleString()} unavailable file candidates were not included.
            </HelperText> : null}
          </div> : null}

          {(!bulkShare || progressive) && search && !manualSelectionClosed ? (
            <>
              <HelperText>{v1ManualReview
                ? `${review?.verifiedCount?.toLocaleString() ?? 0} verified ${review?.verifiedCount === 1 ? "file" : "files"}. Select from this page.`
                : progressive
                ? `${search.matched.toLocaleString()} file candidates${search.status === "completed" ? "" : " so far"}. Review and share up to 25 files from this page${search.status === "completed" ? "." : "; more can arrive while you work."}`
                : searchReady
                ? `${search.matched.toLocaleString()} file candidates. Select the files to share.`
                : legacySearch
                  ? "Checking this request's Drive files again before sharing."
                : ["limited", "failed", "stopped"].includes(search.status) || search.incompleteSearch
                  ? `${search.matched.toLocaleString()} file candidates. More files may exist.`
                  : `${search.matched.toLocaleString()} file candidates so far. Search continues after you leave.`}</HelperText>
              {(search.unshareableCount ?? 0) > 0 ? <HelperText>
                {search.unshareableCount?.toLocaleString()} files have no confirmed sharing permission and won&apos;t be included.
              </HelperText> : null}
              {legacySearch ? <HelperText>Earlier files cannot be selected while the new check runs.</HelperText> :
              <div aria-label="Drive file candidates" aria-busy={searchPageLoading}>
                <SettingsGroup embedded title={v1ManualReview ? "Verified files" : ownerReviewRequired ? "Files to review" : progressive ? "File candidates so far" : "File candidates"}
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
                        : v1ManualReview && file.confidenceScore !== undefined && file.weightageOutOf10 !== undefined
                        ? `Agent match ${file.confidenceScore}/100 · Value ${file.weightageOutOf10}/10`
                        : undefined}
                      disabled={locked || file.shareable === false || progressive &&
                        (file.shareable !== true || alreadyClaimed || bulkShare?.status === "review_ready")}
                      trailing={
                        <Checkbox
                          aria-label={file.name}
                          className={CHECKBOX_CLASS}
                          checked={file.shareable !== false && (ownerReviewRequired
                            ? !alreadyClaimed && reviewSelectedPositions.includes(file.position)
                            : recoverable
                            ? selectedRecoveryPositions.includes(file.position)
                            : !excludedPositions.includes(file.position) && !alreadyClaimed)}
                          disabled={locked || file.shareable === false || progressive &&
                            (file.shareable !== true || alreadyClaimed || bulkShare?.status === "review_ready")}
                          onCheckedChange={checked => {
                            if (ownerReviewRequired) {
                              setReviewSelected({ jobId: search.jobId,
                                positions: checked === true
                                  ? [...new Set([...reviewSelectedPositions, file.position])]
                                  : reviewSelectedPositions.filter(position => position !== file.position) });
                              return;
                            }
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
                      <label data-consent-role="form-label" className="cursor-pointer" />
                    </SettingsRow>
                    );
                  })}
                </SettingsGroup>
              </div>}
              {searchPageLoading ? <HelperText>Loading files…</HelperText> : null}
              {searchPageError ? <div><HelperText role="alert">Couldn&apos;t load files.</HelperText>
                <Button data-consent-role="compact-action" size="standard" variant="none" data-consent-quiet-action="true" onClick={() => setSearchPageRetry(value => value + 1)}>Try again</Button></div> : null}
              {searchPrevious.length || searchPage?.nextCursor ? (
                <div className="flex flex-wrap gap-2">
                  <Button data-consent-role="compact-action" size="standard" variant="none" data-consent-quiet-action="true" disabled={searchPageLoading || !searchPrevious.length}
                    onClick={() => { setSearchCursor(searchPrevious.at(-1) ?? null); setSearchPrevious(items => items.slice(0, -1)); }}>
                    Previous
                  </Button>
                  <Button data-consent-role="compact-action" size="standard" variant="none" data-consent-quiet-action="true" disabled={searchPageLoading || !searchPage?.nextCursor}
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
                  <Button data-consent-role="primary-action" size="prominent" disabled={locked || !searchPage || searchPageError || selectedCount === 0 ||
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
                secondary={batchCount === 0 ? <Button data-consent-role="compact-action" size="standard" variant="none" disabled={locked} onClick={() => decide("decline")}>Decline</Button> : undefined}
                tertiary={(["limited", "failed", "stopped"].includes(search.status) ||
                  legacySearch && activity === "idle" && (searchStartFailed.current || checkedLegacyJob.current === search.jobId)) ?
                  <Button data-consent-role="compact-action" size="standard" variant="none" disabled={locked}
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
                primary={<Button data-consent-role="primary-action" size="prominent" disabled>Share files</Button>}
                secondary={<Button data-consent-role="compact-action" size="standard" variant="none" disabled={locked} onClick={() => decide("decline")}>Decline</Button>}
                tertiary={searchStartFailed.current ? <Button data-consent-role="compact-action" size="standard" variant="none" disabled={locked}
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
            {["queued", "running"].includes(bulkShare.status) ? <HelperText>
              {ownerReviewRequired && review.paymentRequired === true
                ? "Files are shared after payment."
                : "Sharing continues after you leave."}
            </HelperText> : null}
            {retryUnshared}
          </> : null}

          {bulkShare ? (
            <>
              {bulkShare.status === "review_ready" ? legacySearch
                ? <HelperText role="alert">This selection predates the sharing permission check. Ask for a new document request before sharing.</HelperText>
                : <HelperText>{bulkShare.fileCount.toLocaleString()} files selected for this batch. Review the originals, then share.</HelperText> : null}
              {bulkShare.status === "review_ready" && ownerReviewRequired && review.paymentRequired === true ?
                <HelperText>The requester pays after you approve these files.</HelperText> : null}
              {bulkShare.status === "review_ready" && v1ManualReview && review.requestedAccessDays != null ? <div className="space-y-2">
                <label htmlFor="owner-access-days" data-consent-role="form-label" className="block text-sm">Access period</label>
                <select id="owner-access-days" data-consent-input="true" value={selectedAccessDays}
                  onChange={event => setOwnerAccessDays(Number(event.target.value))}
                  disabled={locked}
                  className="block min-h-11 w-full cursor-pointer rounded-md border border-input bg-background px-3 text-sm font-normal">
                  {accessDayChoices.map(days => <option key={days} value={days}>{days} days</option>)}
                </select>
              </div> : null}
              <div aria-label={bulkShare.status === "review_ready" ? "Files selected for sharing" : "Original file outcomes"} aria-busy={bulkPageLoading}>
                <SettingsGroup embedded title="Original files" description="Originals stay in Drive. The recipient sees later edits." {...groupSurface}>
                  {bulkPage?.files.map(file => <SettingsRow key={file.position} title={file.name}
                    description={file.outcomes?.length ? <FileOutcomes outcomes={file.outcomes} /> : undefined}
                    trailing={file.openUrl ? <OriginalLink url={file.openUrl} googleEmail={googleEmail} /> : undefined} />)}
                </SettingsGroup>
              </div>
              {bulkPageLoading ? <HelperText>Loading files…</HelperText> : null}
              {bulkPageError ? <div><HelperText role="alert">Couldn&apos;t load files.</HelperText>
                <Button data-consent-role="compact-action" size="standard" variant="none" data-consent-quiet-action="true" onClick={() => setBulkPageRetry(value => value + 1)}>Try again</Button></div> : null}
              {bulkPrevious.length || bulkPage?.nextCursor ? (
                <div className="flex flex-wrap gap-2">
                  <Button data-consent-role="compact-action" size="standard" variant="none" data-consent-quiet-action="true" disabled={bulkPageLoading || !bulkPrevious.length}
                    onClick={() => { setBulkCursor(bulkPrevious.at(-1) ?? null); setBulkPrevious(items => items.slice(0, -1)); }}>Previous</Button>
                  <Button data-consent-role="compact-action" size="standard" variant="none" data-consent-quiet-action="true" disabled={bulkPageLoading || !bulkPage?.nextCursor}
                    onClick={() => { setBulkPrevious(items => [...items, bulkCursor]); setBulkCursor(bulkPage?.nextCursor ?? null); }}>Next 25</Button>
                </div>
              ) : null}
              {bulkShare.status === "review_ready" ? <FlowActionGroup
                primary={<Button data-consent-role="primary-action" size="prominent" disabled={locked || legacySearch || !bulkPage || bulkPageError || bulkPageLoading}
                  onClick={() => mutate((token, guard) => v1ManualReview && review.requestedAccessDays != null
                    ? DriveSharingService.approveBulkShare(token, bulkShare, guard, selectedAccessDays)
                    : DriveSharingService.approveBulkShare(token, bulkShare, guard), "sharing")}>
                  {legacySearch ? "New request needed" : `${v1ManualReview ? "Approve" : "Share"} ${bulkShare.fileCount.toLocaleString()} ${bulkShare.fileCount === 1 ? "file" : "files"}`}
                </Button>}
                secondary={batchCount === 0 ? <Button data-consent-role="compact-action" size="standard" variant="none" disabled={locked} onClick={() => decide("decline")}>Decline</Button> : undefined}
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

      {review && !agentPackage && !setup && !durableReview && !automaticSharing && !ownerDecision && !removal ? (
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
                          <label data-consent-role="form-label" className="cursor-pointer" />
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
                          <label data-consent-role="form-label" className="cursor-pointer" />
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
                <BodyText>This search found no file candidates.</BodyText>
                <HelperText>Try a broader request or add files to Drive.</HelperText>
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
                <label data-consent-role="form-label" className="cursor-pointer" />
              </SettingsRow>
            </SettingsGroup>
          ) : null}

          {!finding && review.files.length > 0 && !canApprove ? (
            <HelperText>Refresh suggestions before sharing.</HelperText>
          ) : null}

          {finding ? (
            <FlowActionGroup
              primary={
                <Button data-consent-role="primary-action" size="prominent" disabled>
                  Share files
                </Button>
              }
              secondary={
                <Button data-consent-role="compact-action"
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
                <Button data-consent-quiet-action="true" data-consent-role="primary-action"
                  size="prominent"
                  disabled={activity !== "idle"}
                  onClick={() => decide("review/refresh")}
                >
                  Refresh suggestions
                </Button>
              }
              secondary={
                <Button data-consent-role="compact-action"
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
                <Button data-consent-role="primary-action"
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
                <Button data-consent-role="compact-action"
                  size="standard"
                  variant="none"
                  disabled={locked}
                  onClick={() => decide("decline")}
                >
                  Decline
                </Button>
              }
              tertiary={
                <Button data-consent-quiet-action="true" data-consent-role="compact-action"
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

      {delivery && !delivery.bulkShareId && !outgoing && !removal ? (
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
                      <Button data-consent-role="compact-action"
                        asChild
                        size="sm"
                        variant="none"
                        effect="fade"
                        className="min-h-11"
                      >
                        <a
                          href={file.openUrl}
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
          ) : delivery.canStopAccess || delivery.accessStopStatus ? null : (
            <BodyText>Nothing was shared.</BodyText>
          )}

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
                {delivery.canStopAccess ? (
                  <SettingsRow
                    title="Stop access"
                    ariaLabel="Stop access"
                    description="Prevent pending files from being shared."
                    tone="destructive"
                    disabled={locked}
                    onClick={prepareRemoval}
                  />
                ) : delivery.accessStopStatus && delivery.files.length === 0 ? (
                  <SettingsRow
                    title={delivery.accessStopStatus === "pending"
                      ? "Stopping access"
                      : delivery.accessStopStatus === "removed"
                        ? "Sharing stopped"
                        : "Check remaining access"}
                  />
                ) : null}
              </SettingsGroup>
              <HelperText>
                Disconnecting Drive doesn&apos;t remove Google access. Other
                access may remain after removal.
              </HelperText>
        </>
      ) : null}

      {delivery?.bulkShareId && !outgoing && !removal ? (
        <SettingsGroup embedded title="Shared files" {...groupSurface}>
          <SettingsRow
            title={delivery.accessStopStatus === "pending"
              ? "Stopping access"
              : delivery.accessStopStatus === "removed"
                ? "Access removed"
                : delivery.accessStopStatus === "needs_attention"
                  ? "Some access needs review"
                  : `${(delivery.sharedCount ?? 0).toLocaleString()} files shared`}
            description={delivery.accessStopStatus === "pending"
              ? "Checking Google Drive permissions…"
              : delivery.accessStopStatus === "removed"
                ? "One's Viewer access was removed."
                : delivery.accessStopStatus === "needs_attention"
                  ? "Check remaining access in Google Drive."
                  : "You can stop access anytime."}
          />
          {delivery.accessStopStatus === "needs_attention" ? (
            <SettingsRow asChild title="Manage in Google Drive" trailing={<ExternalLink aria-hidden="true" className="h-4 w-4 text-[color:var(--app-tertiary-label)]" />}>
              <a href="https://drive.google.com" target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" />
            </SettingsRow>
          ) : null}
          {!delivery.accessStopStatus ? (
            <SettingsRow
              title="Review removal"
              tone="destructive"
              disabled={locked}
              onClick={prepareRemoval}
            />
          ) : null}
        </SettingsGroup>
      ) : null}

      {removal ? (
        <>
          {removal.files.length ? (
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
          ) : (
            <BodyText>
              {removal.affectedCount
                ? `Stop this request and check ${removal.affectedCount.toLocaleString()} file permissions.`
                : removal.pendingCount
                  ? "Stop this request and check pending file permissions."
                  : "Stop this request before files are shared."}
            </BodyText>
          )}
          {(removal.pendingCount ?? 0) > 0 ? (
            <HelperText>
              {removal.pendingCount?.toLocaleString()} {removal.pendingCount === 1 ? "grant is" : "grants are"} still settling.
            </HelperText>
          ) : null}
          <HelperText>
            Removes only the recorded Viewer access. Other permissions may still
            give access.
          </HelperText>
          <FlowActionGroup
            primary={
              <Button data-consent-role="primary-action"
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
                Stop access
              </Button>
            }
            secondary={
              <Button data-consent-quiet-action="true" data-consent-role="compact-action"
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
        <Button data-consent-role="compact-action"
          size="standard"
          variant="none"
          disabled={activity !== "idle"}
          onClick={refresh}
        >
          <RefreshCw
            aria-hidden="true"
            className={cn(
              "mr-2 size-4",
              activity !== "idle" && "animate-spin motion-reduce:animate-none",
            )}
          />
          Refresh status
        </Button>
      ) : null}
    </section>
  );
}
