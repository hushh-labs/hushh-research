"use client";

import { consentSummary } from "@/lib/feed/feed-consent-summary";
import { isAnswerRequestEntry } from "@/lib/consent/answer-request-consent";
import { AnswerRequestService } from "@/lib/services/answer-request-service";
import { AuthService } from "@/lib/services/auth-service";
import {
  documentRequestEntrySetup,
  documentRequestSetupHref,
  documentRequestSetupLabel,
  GOOGLE_DRIVE_CONNECTOR_ID,
  isDocumentRequestSetupStep,
  type DocumentRequestSetupStep,
} from "@/lib/consent/document-request-setup";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ComponentType } from "react";
import type { LucideIcon } from "@/components/icons";
import { Info } from "@/components/icons";
import {
  ConsentAgentIcon,
  EmergencyRowIcon,
  FinanceAgentIcon,
  JoinRowIcon,
  LocationAgentIcon,
  PeopleRowIcon,
} from "@/components/icons/agents";

import { listConsentTaskPages } from "@/lib/services/consent-task-pages";
import { isIncomingLocationRequestActionable, isActiveSmsEmergencyGrant, isSmsEmergencyGrant } from "./feed-task-projections";
export { isIncomingLocationRequestActionable, isActiveSmsEmergencyGrant, isSmsEmergencyGrant } from "./feed-task-projections";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { currentConsentInvalidationEpoch } from "@/lib/cache/consent-read-after-write";
import { getAuthSessionGeneration } from "@/lib/auth/session-owner";
import {
  isConsentChangeWorthRefreshing,
  useFeedLiveRefresh,
  useFeedPendingConsentRefresh,
} from "@/lib/feed/use-feed-live-refresh";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import {
  CACHE_KEYS,
  CACHE_TTL,
  CacheService,
} from "@/lib/services/cache-service";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import {
  locationApproveActionLabel,
  locationAskPromptLine,
} from "@/lib/one-location/duration-copy";
import {
  DebateRunManagerService,
  type DebateRunTask,
} from "@/lib/services/debate-run-manager";
import {
  AppBackgroundTaskService,
  type AppBackgroundTask,
  isAppBackgroundTaskVisible,
} from "@/lib/services/app-background-task-service";
import {
  CONSENT_CENTER_PAGE_SIZE,
  ConsentCenterService,
  type ConsentCenterEntry,
} from "@/lib/services/consent-center-service";
import {
  CONSENT_ACTION_COMPLETE_EVENT,
  CONSENT_STATE_CHANGED_EVENT,
  dispatchConsentStateChanged,
} from "@/lib/consent/consent-events";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { feedDeviceOnlySosClearStorageKey } from "@/lib/feed/feed-clear-watermark";
import { FeedService } from "@/lib/services/feed-service";
import { shouldSkipReviewerBackgroundWritesForAutomation } from "@/lib/testing/native-test";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { periodConflictNote } from "@/lib/consent/document-request-flow";
import {
  projectFeedDriveProgress,
  type FeedDriveProgress,
} from "@/lib/feed/drive-request-progress";
import {
  describeFeedDrivePayment,
  projectFeedDrivePayments,
} from "@/lib/feed/drive-request-payment";
import { useFeedPaymentClock } from "@/lib/feed/use-feed-payment-clock";
import { useFeedPaymentContext } from "@/lib/feed/use-feed-payment-context";
import { DriveRequestPaymentService, drivePaymentErrorMessage } from "@/lib/services/drive-request-payment-service";
import {
  DriveSharingError,
  DriveSharingService,
  type SharingReview,
  type SharingSessionGuard,
} from "@/lib/services/drive-sharing-service";
import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
} from "@/lib/vault/session-epoch";
import {
  ownerDocumentDecision,
  type OwnerDocumentDecision,
} from "@/lib/consent/document-request-decision";
import {
  formatDocumentRequestPrice,
  isValidDocumentRequestPriceCents,
  isValidWholeDollarRequestPriceCents,
} from "@/lib/consent/document-request-price";
import {
  driveSharingSelectionId,
  isDriveSharingEntry,
} from "@/lib/consent/drive-query-consent";
import { resolveConsentRequesterLabel } from "@/lib/consent/consent-display";
import { parseConsentInstant } from "@/lib/consent/consent-owner-copy";
import {
  groupPendingConsentRequests,
  isOwnerConsentQueueEntry,
  type OwnerConsentRequest,
} from "@/lib/consent/owner-consent-request";
import {
  useOwnerConsentDecision,
  type OwnerConsentUnlockPrompt,
} from "@/lib/consent/use-owner-consent-decision";
import { OneLocationService } from "@/lib/one-location/service";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { isAndroid } from "@/lib/capacitor/platform";
import type {
  OneLocationAccessRequest,
  OneLocationCircleMemberInvite,
  OneLocationGrant,
} from "@/lib/one-location/types";
import { buildOneLocationNotificationHref, buildOneLocationWorkflowHref } from "@/lib/one-location/notifications";
import {
  openProfilePane,
  profileConnectorsLocation,
} from "@/lib/navigation/profile-pane";
import {
  ConnectionsService,
  type ConnectionRequest,
} from "@/lib/services/connections-service";
import { buildKaiMarketRoute } from "@/lib/navigation/routes";
import { useAgentDeploymentFollow } from "@/lib/feed/use-agent-deployment-follow";
import { useAgentUpdateFeedCard } from "@/lib/feed/agent-update-feed-card";
import type { AgentUpdateStatus } from "@/lib/feed/agent-update-status";
import type { AgentTodo } from "@/lib/services/todo-list-pkm-service";

/**
 * Subset of SettingsRow's icon-well tones (that type is not exported). Feed
 * rows use "capability": a bare duotone registry glyph, the same one Profile
 * uses for the same concept, never a coloured tile (hushh-icon-theme).
 */
export type FeedIconTone =
  | "capability"
  | "accent"
  | "blue"
  | "purple"
  | "green"
  | "orange"
  | "red"
  | "gray";

/** A registry glyph (`@/components/icons/agents`) or a legacy line icon. */
export type FeedIcon = ComponentType<{ className?: string }>;

/** `success` is a decision's green positive answer (Allow beside a red Deny). */
export type FeedActionTone = "primary" | "ghost" | "danger" | "success";

export interface FeedActionButton {
  key: string;
  label: string;
  tone: FeedActionTone;
  run: () => Promise<void> | void;
  disabled?: boolean;
  /** Irreversible action — the row requires a second confirming tap. */
  confirm?: boolean;
  /**
   * Show only this icon on a phone (the label stays the accessible name and
   * returns from `sm` up). Used for a row's quiet Details action, so the two
   * decision buttons keep one line at 375px and up.
   */
  phoneIcon?: LucideIcon;
}

/**
 * A live, actionable item for the Feed's "Needs you" zone. Unlike the
 * historical `feed_events` log, these come straight from the domain's live
 * stores/services so the action is real and current (Instagram pins its
 * "follow requests" the same way, above the chronological activity).
 */
export interface FeedActionable {
  id: string;
  /** Only explicit unresolved owner work participates in the private To-do list. */
  todo?: AgentTodo;
  icon: FeedIcon;
  iconTone: FeedIconTone;
  /** Person identity to render before falling back to the domain icon. */
  person?: {
    displayName: string;
    photoUrl: string | null;
  } | null;
  /** Running work animates its leading glyph. */
  spinning?: boolean;
  title: string;
  description: string;
  updateProgress?: AgentUpdateStatus;
  /** Whole-row link (e.g. consent Review deep-link). */
  href?: string | null;
  /** Whole-row imperative action (e.g. resume a running debate). */
  onSelect?: () => void;
  chevron?: boolean;
  actions: FeedActionButton[];
  /** Phone controls for the same actions or their existing full review surface. */
  phoneActions?: FeedActionButton[];
  sortAt: number;
  /**
   * Real-world instant to render as the row's local time label.
   * Distinct from `sortAt` (which falls back to when the row was first seen so
   * ordering never breaks) — null/absent exactly when there is no real
   * timestamp to show the user (a consent entry with no `issued_at`, or any
   * connection request, whose payload carries no timestamp at all).
   * `FeedActionableRow` omits the label entirely rather than fabricating one.
   */
  displayTimestamp?: number | null;
  /** Presentation identity only; source grants and clear operations stay independent. */
  smsEmergency?: { senderId: string };
  /**
   * High-priority visual treatment. "emergency" rows (an incoming SMS · Save My
   * Soul alert) render with prominent red styling and sort above everything else.
   */
  emphasis?: "emergency";
}

export interface UseFeedActionablesResult {
  actionables: FeedActionable[];
  /** Passive Trusted Circle work, separate from tasks that need an answer. */
  inProgress: FeedDriveProgress[];
  progressOverflow: Array<{ label: string; href: string }>;
  progressLoading: boolean;
  progressError: string | null;
  inventoryIncomplete?: boolean;
  count: number;
  loading: boolean;
  error: string | null;
  retry: () => Promise<void>;
  /** A revoked/expired SOS card is sitting in `actionables` with nothing left
   * to act on — only the Feed page's existing Clear button can remove it. */
  hasClearableSmsEmergencies: boolean;
  /** Clears every revoked/expired SOS card currently shown, for this account
   * on every device. Wired into the Feed page's existing Clear button. The
   * server saves it first. If the server cannot (an older backend, a failed
   * request or a locked vault), the clear is kept on this device and saved to
   * the server on a later visit; it never rejects for that. */
  clearSmsEmergencies: () => Promise<void>;
  /** Open while an inline Allow or Don't allow waits for the vault. */
  consentUnlockPrompt: OwnerConsentUnlockPrompt;
  /** Open while Allow on a document request waits for the owner's price. */
  documentPricePrompt: DocumentPricePrompt;
}

/**
 * The price step behind Allow on a document request from someone outside the
 * owner's Trusted circle. The Feed renders it once; the row only opens it.
 * Allow waits for the request's terms, read from the owner's review.
 */
export interface DocumentPricePrompt {
  open: boolean;
  requesterLabel: string;
  /** False for a free request: Allow sends no price. */
  paymentRequired: boolean;
  lockedAmountCents: number | null;
  initialAmountCents?: number | null;
  /** The estimate the requester saw when sending; display only, never a fixed price. */
  estimateCents?: number | null;
  /**
   * The request's own price rule from its review. A whole-dollar request
   * refuses cents, so its price step never offers them.
   */
  moneyPolicy?: "legacy_whole_dollars" | "drive_cents";
  priceOnly?: boolean;
  /** The review asks for a One copy: the sheet shows its terms and Allow accepts them. */
  oneCopyRequested?: boolean;
  purpose: string | null;
  recipientEmail: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  /** One short line when the note names a longer span than the picked dates. */
  periodNote?: string | null;
  /** The terms have not loaded; Allow stays off until the owner can read them. */
  detailsPending: boolean;
  busy: boolean;
  error: string | null;
  /** Integer US cents, or null when no payment is required. */
  submit: (amountCents: number | null) => void;
  cancel: () => void;
}

type DocumentPriceTarget = OwnerDocumentDecision & {
  entryId: string;
  requesterLabel: string;
};

/** What the owner reads before Allow, and the revision Allow answers. */
type DocumentPriceTerms = {
  revision: number;
  paymentRequired: boolean;
  lockedAmountCents: number | null;
  initialAmountCents?: number | null;
  estimateCents: number | null;
  moneyPolicy: "legacy_whole_dollars" | "drive_cents";
  priceOnly?: boolean;
  oneCopyRequested: boolean;
  purpose: string;
  recipientEmail: string;
  periodStart: string | null;
  periodEnd: string | null;
  periodNote: string | null;
};

const WHOLE_DOLLAR_PRICE_RULE = "Choose a whole-dollar price from $1 to $500.";

function decisionErrorCode(cause: unknown): string {
  return cause instanceof DriveSharingError ? cause.code : "request_failed";
}

/** What the owner reads when Allow or Deny did not go through. Never server text. */
export function documentDecisionErrorCopy(code: string): string {
  switch (code) {
    case "owner_payout_required":
      return "Link payouts to continue.";
    case "owner_price_required":
      return "Set your request price to continue.";
    case "payout_unavailable":
      return "Payments are unavailable. Try again later.";
    case "invalid_payment_amount":
      return "Choose a price from $0.50 to $500.";
    // The server says request_already_decided for every closed state as well:
    // answered elsewhere, cancelled, expired or already allowed.
    case "review_changed":
    case "request_changed":
    case "request_already_decided":
      return "This request changed. Check it and try again.";
    case "request_unavailable":
      return "This request is no longer available.";
    case "request_expired":
      return "This request expired.";
    case "date_range_required":
      return "Ask them to send a new request with exact start and end dates.";
    case "connection_required":
      return "You're no longer connected with this person.";
    case "reconnect_required":
    case "connection_changed":
      return "Reconnect Google Drive, then try again.";
    case "verify_google_identity_required":
      return "Verify your Google identity to continue.";
    case "sharing_unavailable":
    case "connector_unavailable":
      return "Document sharing isn't available right now.";
    case "session_changed":
      return "Unlock your vault, then try again.";
    default:
      return "That didn't go through. Try again.";
  }
}

/** The server owns whether an incoming Drive request needs the owner's help. */
export function isConsentFeedActionable(entry: ConsentCenterEntry): boolean {
  if (
    entry.kind === "connection_request" ||
    entry.kind === "outgoing_request"
  ) {
    return false;
  }
  if (!isDriveSharingEntry(entry)) return true;
  return (
    entry.metadata?.direction === "incoming" &&
    entry.metadata?.owner_attention_required !== false
  );
}

/**
 * The Feed row for one owner request: the headline, the reason, and the three
 * things a person can do about it. Exported so the row's wording and its
 * actions are testable without mounting the whole hook.
 */
export function ownerConsentRequestActionable(
  request: OwnerConsentRequest,
  handlers: {
    allow: (request: OwnerConsentRequest) => Promise<boolean>;
    deny: (request: OwnerConsentRequest) => Promise<boolean>;
    openDetails: () => void;
    onDecided: (key: string) => void;
    sortAt: number;
  },
): FeedActionable {
  // Preserve the authored reason as supporting copy.
  const reason = String(request.reason || "").trim();
  const decisionActions: FeedActionButton[] = request.complete
    ? [
        {
          // One tap: the decline waits behind a five-second Undo toast
          // (lib/consent/deferred-consent-decline.ts), which replaces the old
          // armed second tap, the same as the Consent Center's ✗.
          key: "deny",
          label: "Don't allow",
          tone: "ghost",
          run: async () => {
            if (await handlers.deny(request)) handlers.onDecided(request.key);
          },
        },
        {
          key: "allow",
          label: "Allow",
          tone: "primary",
          run: async () => {
            if (await handlers.allow(request)) handlers.onDecided(request.key);
          },
        },
      ]
    : [];
  return {
    id: `consent:${request.key}`,
    todo: { source: "consent", title: `Review ${request.headline}`, href: request.detailsHref },
    icon: ConsentAgentIcon,
    iconTone: "capability",
    person: request.isPerson
      ? {
          displayName: request.requesterLabel,
          photoUrl: request.requesterPhotoUrl,
        }
      : null,
    title: request.headline,
    description: request.complete
      ? reason || "Waiting for your answer"
      : "Still arriving. Open Details to review it.",
    onSelect: handlers.openDetails,
    phoneActions: [{ key: "review", label: "Review", tone: "primary", run: handlers.openDetails }],
    actions: [
      {
        key: "details",
        label: "Details",
        tone: "ghost",
        phoneIcon: Info,
        run: handlers.openDetails,
      },
      ...decisionActions,
    ],
    sortAt: handlers.sortAt,
    displayTimestamp: request.requestedAt,
  };
}

function toTimestamp(value?: string | number | null): number {
  if (value == null) return 0;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * Same idea as `toTimestamp` but yields `null` (not `0`) when there is no
 * source value or it doesn't parse — used for `displayTimestamp`, where the
 * absence of a real instant must suppress the row's time label rather than
 * silently rendering an epoch-zero date.
 */
function toDisplayTimestamp(value?: string | number | null): number | null {
  if (value == null) return null;
  const ts = toTimestamp(value);
  return ts > 0 ? ts : null;
}







/**
 * SOS clears kept on this device only: an older release's, or one the server
 * could not save yet. The list is copied to the server on a visit, then the
 * copied ids are removed (see useFeedActionables).
 */
function readDeviceOnlySmsClearIds(userId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(feedDeviceOnlySosClearStorageKey(userId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function writeDeviceOnlySmsClearIds(userId: string, ids: Set<string>): void {
  try {
    const key = feedDeviceOnlySosClearStorageKey(userId);
    if (ids.size === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    // Storage disabled: the clear still applies for this visit via state.
  }
}

function rememberDeviceOnlySmsClearIds(userId: string, ids: readonly string[]): void {
  const next = readDeviceOnlySmsClearIds(userId);
  for (const id of ids) next.add(id);
  writeDeviceOnlySmsClearIds(userId, next);
}

/** Removes only the copied ids: a clear kept while the copy ran stays queued. */
function forgetDeviceOnlySmsClearIds(userId: string, copied: Set<string>): void {
  const remaining = readDeviceOnlySmsClearIds(userId);
  for (const id of copied) remaining.delete(id);
  writeDeviceOnlySmsClearIds(userId, remaining);
}

export function notifyFeedActionResolved(): void {
  dispatchConsentStateChanged({ source: "feed_actionable" });
  dispatchFeedStateChanged();
}

export function classifyDebateFeedState(
  task: DebateRunTask,
): "running" | "ready" | "failed_save" | null {
  if (task.dismissedAt) return null;
  if (task.status === "running") return "running";
  if (task.persistenceState === "failed") return "failed_save";
  if (
    task.status === "completed" &&
    (task.persistenceState === "pending" || task.persistenceState === "saved")
  ) {
    return "ready";
  }
  return null;
}

/**
 * A completed run must open through its durable PKM history identity. A live
 * `run_id` route depends on the task still being undisposed in session state,
 * which is intentionally no longer true once the Feed item is settled.
 */
export function buildDebateFeedAnalysisHref(
  runId: string,
  settled: boolean,
): string {
  return settled
    ? buildKaiMarketRoute("analysis", { analysis_id: `run:${runId}` })
    : buildKaiMarketRoute("analysis", { focus: "active", run_id: runId });
}

export function useFeedActionables({ enabled = true, allPending = false }: { enabled?: boolean; allPending?: boolean } = {}): UseFeedActionablesResult {
  const router = useRouter();
  const { user, userId: ownerId } = useAuth();
  const { vaultOwnerToken: ownerToken, getVaultOwnerToken } = useVault();
  const vaultOwnerToken = enabled ? ownerToken : null;
  const userId = enabled ? ownerId : null;
  const agentFollow = useAgentDeploymentFollow({ enabled: Boolean(userId), userId });
  const agentUpdateCard = useAgentUpdateFeedCard({
    userId,
    update: agentFollow.update,
    deploymentTarget: agentFollow.deploymentTarget,
    availableVersion: agentFollow.status?.availableRelease?.version ?? null,
    onResolved: notifyFeedActionResolved,
  });
  const authGeneration = getAuthSessionGeneration();
  const consentReadLifecycle = {
    requestScope: `consent:${authGeneration}`,
    getRequestVersion: () => currentConsentInvalidationEpoch(userId),
    isRequestCurrent: () => getAuthSessionGeneration() === authGeneration,
  };
  const checkoutScope = useRef<{ userId: string | null } | null>(null);
  const checkoutRows = useRef<FeedActionable[]>([]);
  useEffect(() => {
    const scope = { userId };
    checkoutScope.current = scope;
    return () => { if (checkoutScope.current === scope) checkoutScope.current = null; };
  }, [userId]);
  const currentCheckout = useCallback((owner: string, rowId: string, actionKey: string, label: string) => {
    const scope = checkoutScope.current;
    const epoch = snapshotVaultSessionEpoch();
    return () => scope !== null && scope.userId === owner && checkoutScope.current === scope &&
      isVaultSessionEpochCurrent(epoch) && checkoutRows.current.some(row => row.id === rowId &&
        row.actions.some(action => action.key === actionKey && action.label === label && !action.disabled));
  }, []);
  // Ended SOS cards the server confirmed cleared during this visit, hidden
  // until the refreshed Location state carries `recipientClearedAt`.
  const [serverClearedSmsIds, setServerClearedSmsIds] = useState<Set<string>>(
    () => new Set(),
  );
  // An older release's device-only clears stay hidden while they are copied.
  const [deviceOnlySmsClearIds, setDeviceOnlySmsClearIds] = useState<
    Set<string>
  >(() => (userId ? readDeviceOnlySmsClearIds(userId) : new Set()));
  const deviceOnlySmsCopyRef = useRef<string | null>(null);
  const cache = useMemo(() => CacheService.getInstance(), []);
  const consentDecision = useOwnerConsentDecision({ userId });
  const readConsentPage = (options: Parameters<typeof ConsentCenterService.listEntries>[0]) =>
    allPending ? listConsentTaskPages(options, () => getAuthSessionGeneration() === authGeneration)
      : ConsentCenterService.listEntries(options);

  // Requests answered from this row disappear the moment the answer lands,
  // before the refetch that confirms it; the refetch then simply agrees.
  const [settledConsentKeys, setSettledConsentKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const markConsentSettled = useCallback((key: string) => {
    setSettledConsentKeys((current) => {
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      return next;
    });
  }, []);
  const unmarkConsentSettled = useCallback((key: string) => {
    setSettledConsentKeys((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }, []);
  const { declineWithUndo: declineConsentWithUndo } = consentDecision;
  // Don't allow hides the row at once; Undo or a failed deny brings it back.
  const declineConsentRequest = useCallback(
    (request: OwnerConsentRequest) =>
      declineConsentWithUndo(request, {
        onHide: () => markConsentSettled(request.key),
        onRestore: () => unmarkConsentSettled(request.key),
      }),
    [declineConsentWithUndo, markConsentSettled, unmarkConsentSettled],
  );
  // Allow on a document request asks for a price first. The target outlives
  // `open` so the sheet keeps its copy while it closes.
  const [priceTarget, setPriceTarget] = useState<DocumentPriceTarget | null>(
    null,
  );
  const [priceOpen, setPriceOpen] = useState(false);
  const [priceTerms, setPriceTerms] = useState<DocumentPriceTerms | null>(null);
  const [priceBusy, setPriceBusy] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);
  // State lags a render; the ref closes the double-submit window.
  const priceBusyRef = useRef(false);
  // Only the latest terms read may change the sheet.
  const priceLoadRef = useRef(0);
  useEffect(() => {
    setSettledConsentKeys(new Set());
    priceLoadRef.current += 1;
    setPriceOpen(false);
    setPriceTarget(null);
    setPriceTerms(null);
    setPriceError(null);
  }, [userId]);

  // Revoked/expired SOS cards stay in the feed as a historical alert until the
  // recipient explicitly clears them (see the Clear action below). The clear
  // is stored on the server for the account, so it holds on every device.
  useEffect(() => {
    setServerClearedSmsIds(new Set());
    setDeviceOnlySmsClearIds(
      userId ? readDeviceOnlySmsClearIds(userId) : new Set(),
    );
  }, [userId]);

  // ── Debate + background-task live stores (in-memory, synchronous) ──
  const [debateState, setDebateState] = useState(() =>
    DebateRunManagerService.getState(),
  );
  const [appTaskState, setAppTaskState] = useState(() =>
    AppBackgroundTaskService.getState(),
  );
  useEffect(() => DebateRunManagerService.subscribe(setDebateState), []);
  useEffect(() => AppBackgroundTaskService.subscribe(setAppTaskState), []);

  // ── Consent pending (canonical one:consents lane, refetch on mutation) ──
  const [consentTick, setConsentTick] = useState(0);
  useEffect(() => {
    const bump = (event: Event) => {
      // Ignore the same local re-announcements as Feed's live reconciler.
      if (!isConsentChangeWorthRefreshing(event)) return;
      setConsentTick((value) => value + 1);
    };
    window.addEventListener(CONSENT_ACTION_COMPLETE_EVENT, bump);
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, bump);
    return () => {
      window.removeEventListener(CONSENT_ACTION_COMPLETE_EVENT, bump);
      window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, bump);
    };
  }, []);

  const consentSummaryResource = useStaleResource({
    ...consentReadLifecycle,
    cacheKey: userId
      ? CACHE_KEYS.CONSENT_CENTER_SUMMARY(userId, "one:consents")
      : "consent_center_summary_guest",
    refreshKey: `one:consents:${consentTick}`,
    enabled: Boolean(userId),
    retainOnInvalidate: true,
    // `options.force` is honoured alongside the mutation tick: the consent
    // services keep their own caches, so a live refresh that dropped the flag
    // would re-read the same cached page it was trying to move past.
    load: async (options) => {
      const idToken = await user?.getIdToken();
      if (!ownerId || !idToken || getAuthSessionGeneration() !== authGeneration) throw new Error("Sign in to review consents");
      return ConsentCenterService.getSummary({
        idToken,
        userId: ownerId,
        mode: "consents",
        force: consentTick > 0 || Boolean(options?.force),
      });
    },
  });
  const pendingConsentCount =
    consentSummaryResource.data?.counts.pending ?? null;

  const listedPendingCountRef = useRef<number | null>(null);
  const consentListResource = useStaleResource({
    ...consentReadLifecycle,
    cacheKey: userId
      ? `${CACHE_KEYS.CONSENT_CENTER_LIST(
          userId,
          "one:consents",
          "pending",
          "",
          1,
          CONSENT_CENTER_PAGE_SIZE,
        )}${allPending ? ":todos-all" : ""}`
      : "consent_center_list_guest",
    refreshKey: `one:consents:${consentTick}:${pendingConsentCount ?? "?"}`,
    enabled: Boolean(userId) && (pendingConsentCount ?? 0) > 0,
    retainOnInvalidate: true,
    load: async (options) => {
      const idToken = await user?.getIdToken();
      if (!ownerId || !idToken || getAuthSessionGeneration() !== authGeneration) throw new Error("Sign in to review consents");
      // A new pending count means a request arrived or left: the service's own
      // cached page predates it, so read past it.
      const countChanged =
        listedPendingCountRef.current !== pendingConsentCount;
      listedPendingCountRef.current = pendingConsentCount;
      return readConsentPage({
        idToken,
        userId: ownerId,
        mode: "consents",
        surface: "pending",
        page: 1,
        limit: CONSENT_CENTER_PAGE_SIZE,
        force: consentTick > 0 || Boolean(options?.force) || countChanged,
      });
    },
  });

  // The owner queue above stays at 20 for fast decisions. Progress reads a
  // separate bounded first page so its discovery does not depend on the
  // actionable summary count (which only describes requests needing action).
  const progressPageSize = 100;
  const receivedOverflowResource = useStaleResource({
    ...consentReadLifecycle,
    cacheKey: userId
      ? `${CACHE_KEYS.CONSENT_CENTER_LIST(
          userId,
          "one:consents",
          "pending",
          "",
          1,
          progressPageSize,
        )}${allPending ? ":todos-all" : ""}`
      : "feed_received_progress_guest",
    refreshKey: `one:consents:progress:${consentTick}:${pendingConsentCount ?? "?"}`,
    enabled: Boolean(userId),
    retainOnInvalidate: true,
    load: async (options) => {
      const idToken = await user?.getIdToken();
      if (!ownerId || !idToken || getAuthSessionGeneration() !== authGeneration) throw new Error("Sign in to view requests");
      return readConsentPage({
        idToken,
        userId: ownerId,
        mode: "consents",
        surface: "pending",
        page: 1,
        limit: progressPageSize,
        force: consentTick > 0 || Boolean(options?.force),
      });
    },
  });
  // B's sent requests are absent from A's received count and list. Fetching
  // this lane independently is necessary even when Needs you is empty.
  const sentProgressResource = useStaleResource({
    ...consentReadLifecycle,
    cacheKey: userId
      ? `${CACHE_KEYS.CONSENT_CENTER_LIST(
          userId,
          "one:consents:sent",
          "pending",
          "",
          1,
          progressPageSize,
        )}${allPending ? ":todos-all" : ""}`
      : "feed_sent_progress_guest",
    refreshKey: `one:consents:sent:progress:${consentTick}`,
    enabled: Boolean(userId),
    retainOnInvalidate: true,
    load: async (options) => {
      const idToken = await user?.getIdToken();
      if (!ownerId || !idToken || getAuthSessionGeneration() !== authGeneration) throw new Error("Sign in to view requests");
      return readConsentPage({
        idToken,
        userId: ownerId,
        mode: "consents",
        surface: "pending",
        requestView: "sent",
        page: 1,
        limit: progressPageSize,
        force: consentTick > 0 || Boolean(options?.force),
      });
    },
  });
  // A first confirmed file promotes the same pending request into Active for
  // access management. Keep the live status through the remaining background
  // search without changing that bucket or displaying unconfirmed file data.
  const activeProgressResource = useStaleResource({
    ...consentReadLifecycle,
    cacheKey: userId
      ? `${CACHE_KEYS.CONSENT_CENTER_LIST(
          userId,
          "one:consents",
          "active",
          "",
          1,
          progressPageSize,
        )}${allPending ? ":todos-all" : ""}`
      : "feed_active_progress_guest",
    refreshKey: `one:consents:active:progress:${consentTick}`,
    enabled: Boolean(userId),
    retainOnInvalidate: true,
    load: async (options) => {
      const idToken = await user?.getIdToken();
      if (!ownerId || !idToken || getAuthSessionGeneration() !== authGeneration) throw new Error("Sign in to view requests");
      return readConsentPage({
        idToken,
        userId: ownerId,
        mode: "consents",
        surface: "active",
        page: 1,
        limit: progressPageSize,
        force: consentTick > 0 || Boolean(options?.force),
      });
    },
  });

  // ── Location access requests (vault-gated read) ──
  // Shares the canonical ONE_LOCATION_STATE cache with the Location workspace,
  // so this loader write-throughs via OneLocationStateResource (which owns that
  // key) rather than leaving the shared snapshot stale; useStaleResource only
  // peeks the cache, so without the write the SWR warm-render never happens.
  const locationResource = useStaleResource({
    cacheKey: userId
      ? CACHE_KEYS.ONE_LOCATION_STATE(userId)
      : "one_location_state_guest",
    enabled: Boolean(userId) && Boolean(vaultOwnerToken),
    load: async () => {
      if (!vaultOwnerToken)
        throw new Error("Unlock to review location requests");
      const state = await OneLocationService.getState(vaultOwnerToken);
      if (userId) OneLocationStateResource.write(userId, state);
      return state;
    },
  });

  // ── Incoming connection requests ──
  // Keyed on the same tick as the consent lanes: a connection request can be
  // answered from the Consent Center rather than here, and that surface only
  // announces itself through CONSENT_ACTION_COMPLETE_EVENT. Without the key
  // this resource never re-runs, so an accepted request stays on the feed as
  // though it were still waiting.
  const connectionsResource = useStaleResource({
    cacheKey: userId
      ? CACHE_KEYS.CONNECTIONS_INCOMING(userId)
      : "connections_incoming_guest",
    refreshKey: `connections:${consentTick}`,
    enabled: Boolean(userId),
    load: async () => {
      const idToken = await user?.getIdToken();
      if (!idToken) throw new Error("Sign in to review connections");
      const requests = await ConnectionsService.listRequests({
        idToken,
        direction: "incoming",
      });
      // Write-through so a revisit renders instantly (useStaleResource peeks
      // the cache but never populates it; the loader owns that here).
      if (userId) {
        cache.set(
          CACHE_KEYS.CONNECTIONS_INCOMING(userId),
          requests,
          CACHE_TTL.SHORT,
        );
      }
      return requests;
    },
  });

  const openAnalysis = useCallback(
    (runId: string, settleReadyState = false) => {
      const href = buildDebateFeedAnalysisHref(runId, settleReadyState);
      if (settleReadyState) {
        DebateRunManagerService.dismissTask(runId);
      }
      router.push(href);
    },
    [router],
  );

  // Google Drive opens over this screen, as every Connectors entry does, so
  // closing it returns here. Payouts and price are Profile pages of their own.
  const openDocumentRequestSetup = useCallback(
    (step: DocumentRequestSetupStep) => {
      if (step === "drive") {
        openProfilePane(
          window.location.pathname,
          window.location.search,
          profileConnectorsLocation(GOOGLE_DRIVE_CONNECTOR_ID),
          { returnsToOrigin: true },
        );
        return;
      }
      router.push(documentRequestSetupHref(step));
    },
    [router],
  );

  // Pull stable slices out of the resource wrappers (which useStaleResource
  // returns fresh every render) so the memo below depends on the actual data
  // + the stable refresh callbacks, not the changing wrapper identity.
  const locationRequests = locationResource.data?.requests;
  const receivedGrants = locationResource.data?.receivedGrants;
  const circleMemberInvites = locationResource.data?.circleMemberInvites;
  const locationRefresh = locationResource.refresh;
  const connectionRequests = connectionsResource.data;
  const connectionsRefresh = connectionsResource.refresh;
  const consentItems = consentListResource.data?.items;
  const receivedOverflowItems = receivedOverflowResource.data?.items;
  const sentProgressItems = sentProgressResource.data?.items;
  const activeProgressItems = activeProgressResource.data?.items;
  const consentSummaryRefresh = consentSummaryResource.refresh;
  const consentListRefresh = consentListResource.refresh;
  const receivedOverflowRefresh = receivedOverflowResource.refresh;
  const sentProgressRefresh = sentProgressResource.refresh;
  const activeProgressRefresh = activeProgressResource.refresh;

  // ── Document requests from outside the Trusted circle: Allow or Deny ──
  // Both answers go out on this vault session's owner token only. A lock,
  // unlock or account switch mid-request ends it as session_changed.
  const documentSessionGuard = useCallback(
    (token: string): SharingSessionGuard => {
      const epoch = snapshotVaultSessionEpoch();
      return () => {
        if (
          !isVaultSessionEpochCurrent(epoch) ||
          getVaultOwnerToken() !== token
        ) {
          throw new DriveSharingError("session_changed");
        }
      };
    },
    [getVaultOwnerToken],
  );

  const refreshDocumentRequests = useCallback(async () => {
    await Promise.all([
      consentSummaryRefresh({ force: true }),
      consentListRefresh({ force: true }),
      receivedOverflowRefresh({ force: true }),
    ]);
  }, [consentListRefresh, consentSummaryRefresh, receivedOverflowRefresh]);

  // The answered row leaves now; the forced refetch then agrees. Recording the
  // mutation first keeps that refetch off the proxy's pre-decision copy.
  const settleDocumentRequest = useCallback(
    (entryId: string) => {
      markConsentSettled(entryId);
      if (userId) CacheSyncService.onConsentMutated(userId);
      notifyFeedActionResolved();
      void refreshDocumentRequests();
    },
    [markConsentSettled, refreshDocumentRequests, userId],
  );

  const declineDocumentRequest = useCallback(
    async (entryId: string, decision: OwnerDocumentDecision) => {
      // The token as of the tap, not the render, so a renewal in between is
      // not mistaken for a different session.
      const token = getVaultOwnerToken();
      if (!token) return;
      try {
        await DriveSharingService.decide(
          token,
          decision.requestId,
          "decline",
          decision.revision,
          documentSessionGuard(token),
        );
      } catch (cause) {
        toast.error(documentDecisionErrorCopy(decisionErrorCode(cause)));
        // The request may have moved on; show what the server has now.
        await refreshDocumentRequests();
        return;
      }
      settleDocumentRequest(entryId);
    },
    [
      documentSessionGuard,
      getVaultOwnerToken,
      refreshDocumentRequests,
      settleDocumentRequest,
    ],
  );

  /**
   * Refuse a Request scope question from the Feed row.
   *
   * Only the refusal is inline. Allow is not: approving this question binds
   * the exact information it may use and a price, and neither fits on a row.
   * Allow opens the review that shows both, so nothing is ever granted from a
   * control that did not show what it was granting.
   */
  const declineAnswerRequest = useCallback(
    async (requestId: string) => {
      try {
        const token = await AuthService.getIdToken();
        if (!token) throw new Error("Sign in to decline this question.");
        await AnswerRequestService.decline(token, requestId);
      } catch (cause) {
        toast.error(
          cause instanceof Error
            ? cause.message
            : "That could not be declined.",
        );
        return;
      }
      // The row leaves "Needs you" on the next read: a declined request is
      // terminal, so it moves to history rather than being hidden locally.
      dispatchConsentStateChanged({
        userId: ownerId,
        requestId: `answer_request:${requestId}`,
      });
    },
    [ownerId],
  );

  // The Feed row carries no request text. Allow therefore reads the owner's
  // vault-protected review first: the sheet shows its purpose, period,
  // recipient and access, and Allow answers that review's revision. A request
  // that can no longer be allowed closes the sheet and refreshes the rows.
  const loadDocumentTerms = useCallback(
    async (target: DocumentPriceTarget) => {
      const load = ++priceLoadRef.current;
      const token = getVaultOwnerToken();
      if (!token) {
        setPriceError(documentDecisionErrorCopy("session_changed"));
        return;
      }
      let review: SharingReview;
      try {
        review = await DriveSharingService.review(
          token,
          target.requestId,
          documentSessionGuard(token),
        );
      } catch (cause) {
        if (load === priceLoadRef.current) {
          setPriceError(documentDecisionErrorCopy(decisionErrorCode(cause)));
        }
        return;
      }
      if (load !== priceLoadRef.current) return;
      if (review.agentPackage || (target.priceOnly && review.oneCopyRequested === true)) {
        // Package approval requires the owner to read its current assessment. A
        // Trusted One copy request is never priced alone: it needs the full Allow.
        priceLoadRef.current += 1;
        setPriceOpen(false);
        setPriceTerms(null);
        setPriceError(null);
        router.push(buildConsentCenterHref("pending", {
          requestId: target.entryId, from: "/one/feed",
        }));
        return;
      }
      if (
        (target.priceOnly
          ? review.priceOnlyAvailable
          : review.allowAvailable) !== true
      ) {
        priceLoadRef.current += 1;
        setPriceOpen(false);
        setPriceError(null);
        if (review.ownerAllowed === true) {
          // An Allow already landed, for example one whose answer was lost.
          settleDocumentRequest(target.entryId);
          toast.info(
            typeof review.priceCents === "number"
              ? `Already allowed at ${formatDocumentRequestPrice(review.priceCents)}.`
              : "Already allowed.",
          );
        } else {
          toast.info(documentDecisionErrorCopy("request_changed"));
          void refreshDocumentRequests();
        }
        return;
      }
      setPriceTerms({
        revision: review.revision,
        paymentRequired: review.paymentRequired === true,
        // A non-trusted Allow sets this request's price; a draft quote is not an order.
        lockedAmountCents: null,
        initialAmountCents: review.priceCents ?? null,
        // Display only: a missing or malformed estimate never blocks pricing.
        estimateCents: isValidDocumentRequestPriceCents(review.estimateCents)
          ? review.estimateCents
          : null,
        // On 2026-10-17 a cents price on a whole-dollar request got a 422.
        moneyPolicy: review.wholeDollarPrice === true ? "legacy_whole_dollars" : "drive_cents",
        priceOnly: target.priceOnly === true,
        // Sealed with the request; only the review says whether Allow covers a One copy.
        oneCopyRequested: review.oneCopyRequested === true,
        purpose: review.purpose.purpose,
        recipientEmail: review.recipientEmail,
        periodStart: review.purpose.periodStart,
        periodEnd: review.purpose.periodEnd,
        // The picked dates win; the owner reads why, where Allow is confirmed.
        periodNote: review.periodConflict === "request_mentions_longer_span"
          ? periodConflictNote(review.purpose.purpose, review.purpose.periodStart,
            review.purpose.periodEnd, "owner")
          : null,
      });
    },
    [
      documentSessionGuard,
      getVaultOwnerToken,
      refreshDocumentRequests,
      settleDocumentRequest,
      router,
    ],
  );

  // Allow only opens the price step and returns, so the row is never locked
  // behind a sheet the owner may simply cancel.
  const openDocumentPrice = useCallback(
    (target: DocumentPriceTarget) => {
      if (priceBusyRef.current) return;
      setPriceTarget(target);
      setPriceTerms(null);
      setPriceError(null);
      setPriceOpen(true);
      void loadDocumentTerms(target);
    },
    [loadDocumentTerms],
  );

  const submitDocumentPrice = useCallback(
    async (amountCents: number | null) => {
      const target = priceTarget;
      const terms = priceTerms;
      if (!priceOpen || !target || !terms || priceBusyRef.current) return;
      const token = getVaultOwnerToken();
      if (!token) {
        setPriceError(documentDecisionErrorCopy("session_changed"));
        return;
      }
      // A free request never carries a price; a paid one never goes without.
      const price = terms.paymentRequired ? amountCents : null;
      const validPrice = terms.moneyPolicy === "legacy_whole_dollars"
        ? isValidWholeDollarRequestPriceCents : isValidDocumentRequestPriceCents;
      if (terms.paymentRequired && !validPrice(price)) {
        setPriceError(terms.moneyPolicy === "legacy_whole_dollars"
          ? WHOLE_DOLLAR_PRICE_RULE : documentDecisionErrorCopy("invalid_payment_amount"));
        return;
      }
      priceBusyRef.current = true;
      setPriceBusy(true);
      setPriceError(null);
      try {
        const submit = terms.priceOnly
          ? DriveSharingService.setRequestPrice.bind(DriveSharingService)
          : DriveSharingService.allow.bind(DriveSharingService);
        await submit(
          token,
          target.requestId,
          {
            revision: terms.revision,
            amountCents: price,
            // The owner read the One copy terms in this sheet. A Drive-only
            // request refuses an acceptance, so it is sent only when asked.
            ...(terms.oneCopyRequested && !terms.priceOnly ? { oneCopyAccepted: true } : {}),
          },
          documentSessionGuard(token),
        );
      } catch (cause) {
        const code = decisionErrorCode(cause);
        setPriceError(code === "invalid_payment_amount" && terms.moneyPolicy === "legacy_whole_dollars"
          ? WHOLE_DOLLAR_PRICE_RULE : documentDecisionErrorCopy(code));
        // Read the request again before another try: the sheet stays open
        // only while it can still be allowed, at its current revision.
        setPriceTerms(null);
        void loadDocumentTerms(target);
        void refreshDocumentRequests();
        return;
      } finally {
        priceBusyRef.current = false;
        setPriceBusy(false);
      }
      setPriceOpen(false);
      settleDocumentRequest(target.entryId);
      toast.success(
        terms.priceOnly
          ? `Price set at ${formatDocumentRequestPrice(price!)}.`
          : price === null
            ? "Allowed. Files are shared as they're found."
            : `Allowed at ${formatDocumentRequestPrice(price)}. Files are shared after payment.`,
      );
    },
    [
      documentSessionGuard,
      getVaultOwnerToken,
      loadDocumentTerms,
      priceOpen,
      priceTarget,
      priceTerms,
      refreshDocumentRequests,
      settleDocumentRequest,
    ],
  );

  const documentPricePrompt = useMemo<DocumentPricePrompt>(
    () => ({
      open: priceOpen,
      requesterLabel: priceTarget?.requesterLabel ?? "",
      paymentRequired:
        priceTerms?.paymentRequired ?? priceTarget?.paymentRequired ?? false,
      lockedAmountCents: priceTerms?.lockedAmountCents ?? null,
      initialAmountCents: priceTerms?.initialAmountCents ?? null,
      estimateCents: priceTerms?.estimateCents ?? null,
      moneyPolicy: priceTerms?.moneyPolicy ?? "drive_cents",
      priceOnly: priceTerms?.priceOnly ?? priceTarget?.priceOnly ?? false,
      oneCopyRequested: priceTerms?.oneCopyRequested === true && priceTerms.priceOnly !== true,
      purpose: priceTerms?.purpose ?? null,
      recipientEmail: priceTerms?.recipientEmail ?? null,
      periodStart: priceTerms?.periodStart ?? null,
      periodEnd: priceTerms?.periodEnd ?? null,
      periodNote: priceTerms?.periodNote ?? null,
      detailsPending: priceTerms === null,
      busy: priceBusy,
      error: priceError,
      submit: (amountCents) => {
        void submitDocumentPrice(amountCents);
      },
      cancel: () => {
        if (priceBusyRef.current) return;
        // A terms read still in flight must not reopen or retitle the sheet.
        priceLoadRef.current += 1;
        setPriceOpen(false);
        setPriceError(null);
      },
    }),
    [
      priceBusy,
      priceError,
      priceOpen,
      priceTarget,
      priceTerms,
      submitDocumentPrice,
    ],
  );

  const receivedProgress = useMemo(() => {
    return projectFeedDriveProgress(receivedOverflowItems ?? []);
  }, [receivedOverflowItems]);
  const sentProgress = useMemo(
    () => projectFeedDriveProgress(sentProgressItems ?? []),
    [sentProgressItems],
  );
  const sentPayments = useMemo(
    () => projectFeedDrivePayments(sentProgressItems ?? []),
    [sentProgressItems],
  );
  const paymentContexts = useFeedPaymentContext(
    userId,
    vaultOwnerToken,
    sentPayments.map((payment) => payment.requestId),
  );
  const hasLivePaymentDeadline = sentPayments.some(
    (payment) =>
      payment.status === "ready" &&
      payment.expiresAt !== null &&
      payment.expiresAt > Date.now(),
  );
  const paymentClockNow = useFeedPaymentClock(hasLivePaymentDeadline);
  const activeProgress = useMemo(
    () => projectFeedDriveProgress(activeProgressItems ?? []),
    [activeProgressItems],
  );
  const inProgress = useMemo(() => {
    const byRequest = new Map<string, FeedDriveProgress>();
    for (const row of [
      ...receivedProgress,
      ...sentProgress,
      ...activeProgress,
    ]) {
      byRequest.set(row.id, row);
    }
    return [...byRequest.values()].sort(
      (a, b) => (b.requestedAt ?? 0) - (a.requestedAt ?? 0),
    );
  }, [receivedProgress, sentProgress, activeProgress]);
  const progressOverflow = useMemo(() => {
    const links: Array<{ label: string; href: string }> = [];
    if (receivedOverflowResource.data?.has_more) {
      links.push({
        label: "View all received requests",
        href: buildConsentCenterHref("pending", { from: "/one/feed" }),
      });
    }
    if (sentProgressResource.data?.has_more) {
      links.push({
        label: "View all sent requests",
        href: buildConsentCenterHref("pending", {
          requestView: "sent",
          from: "/one/feed",
        }),
      });
    }
    if (activeProgressResource.data?.has_more) {
      links.push({
        label: "View all active requests",
        href: buildConsentCenterHref("active", { from: "/one/feed" }),
      });
    }
    return links;
  }, [
    receivedOverflowResource.data?.has_more,
    sentProgressResource.data?.has_more,
    activeProgressResource.data?.has_more,
  ]);

  // When a row genuinely has no arrival time, remember when it was first seen.
  //
  // These rows used to call `Date.now()` inline, inside the memo — so every
  // recompute minted a brand-new "now" and they jumped back above rows carrying
  // real timestamps. Harmless while the Feed only built its list once; with the
  // live refresh above, the order would reshuffle on every tick. A first-seen
  // stamp is stable across refreshes AND is the honest answer to "when did this
  // reach me", so arrival order between two untimed rows is preserved.
  const firstSeenAtRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    firstSeenAtRef.current = new Map();
  }, [userId]);
  const firstSeenAt = useCallback((id: string) => {
    const remembered = firstSeenAtRef.current.get(id);
    if (remembered !== undefined) return remembered;
    const now = Date.now();
    firstSeenAtRef.current.set(id, now);
    return now;
  }, []);

  // "Needs you" is the half of the Feed that is a to-do list, so a stale one is
  // worse than a stale history: it offers Approve on a request somebody already
  // answered elsewhere. Every source behind it re-checks on the same live signal
  // the list and the tab badge use.
  const refreshActionables = useCallback(async () => {
    if (!userId) return;
    await Promise.all([
      consentSummaryRefresh({ force: true }),
      consentListRefresh({ force: true }),
      receivedOverflowRefresh({ force: true }),
      sentProgressRefresh({ force: true }),
      activeProgressRefresh({ force: true }),
      locationRefresh({ force: true }),
      connectionsRefresh({ force: true }),
    ]);
  }, [
    userId,
    connectionsRefresh,
    consentListRefresh,
    consentSummaryRefresh,
    receivedOverflowRefresh,
    sentProgressRefresh,
    activeProgressRefresh,
    locationRefresh,
  ]);

  useFeedLiveRefresh(
    useCallback(() => {
      void refreshActionables();
    }, [refreshActionables]),
    Boolean(userId),
  );

  // Requests waiting on this person reach "Needs you" within about 10s while
  // the Feed is on screen, through the same cached resources as above. The
  // list only loads while the summary counts something pending.
  useFeedPendingConsentRefresh(
    useCallback(
      () =>
        Promise.all([
          consentSummaryRefresh({ force: true }),
          consentListRefresh({ force: true }),
        ]),
      [consentListRefresh, consentSummaryRefresh],
    ),
    Boolean(userId),
  );

  // Discovery happens on mount/focus and the 45s Feed cadence. Only a request
  // already doing automatic work earns a 10s status refresh; idle accounts do
  // not fetch three broad pages every 10s.
  useFeedPendingConsentRefresh(
    useCallback(
      () =>
        Promise.all([
          receivedOverflowRefresh({ force: true }),
          sentProgressRefresh({ force: true }),
          activeProgressRefresh({ force: true }),
        ]),
      [receivedOverflowRefresh, sentProgressRefresh, activeProgressRefresh],
    ),
    Boolean(userId) && (inProgress.length > 0 || sentPayments.length > 0),
  );

  // A visible live SOS earns a faster server status refresh, including expiry
  // and revocation. Reuse the shared visible-only clock; never infer an ended
  // emergency from this device's wall clock.
  useFeedPendingConsentRefresh(
    useCallback(() => locationRefresh({ force: true }), [locationRefresh]),
    Boolean(userId) && (receivedGrants ?? []).some(isActiveSmsEmergencyGrant),
  );

  // Revoked/expired SOS cards stay in the feed as a historical alert instead
  // of vanishing the moment the sender cancels — but there is nothing left to
  // act on, so only the Feed page's existing Clear button removes them (no
  // separate per-row control). The clear is saved on the server for this
  // account, so it holds on other devices and after signing in again.
  const isClearedSmsEmergency = useCallback(
    (grant: OneLocationGrant) =>
      Boolean(grant.recipientClearedAt) ||
      serverClearedSmsIds.has(grant.id) ||
      deviceOnlySmsClearIds.has(grant.id),
    [serverClearedSmsIds, deviceOnlySmsClearIds],
  );

  const clearableSmsEmergencyIds = useMemo(
    () =>
      (receivedGrants ?? [])
        .filter(
          (grant) =>
            isSmsEmergencyGrant(grant) &&
            !isActiveSmsEmergencyGrant(grant) &&
            !isClearedSmsEmergency(grant),
        )
        .map((grant) => grant.id),
    [receivedGrants, isClearedSmsEmergency],
  );

  // Server first, so the clear holds on every device. If the server cannot
  // save it (an older backend without the route, a failed request, or a
  // locked vault), keep the clear on this device the way older releases did:
  // the cards leave now, and the device-only copy below saves it later.
  const clearSmsEmergencies = useCallback(async () => {
    if (!userId || clearableSmsEmergencyIds.length === 0) return;
    const grantIds = clearableSmsEmergencyIds;
    try {
      if (!vaultOwnerToken) throw new Error("vault_locked");
      const cleared = await FeedService.clearSosCards({ vaultOwnerToken, grantIds });
      setServerClearedSmsIds((current) => new Set([...current, ...cleared]));
      OneLocationStateResource.invalidate(userId);
      void locationRefresh({ force: true });
    } catch {
      rememberDeviceOnlySmsClearIds(userId, grantIds);
      setDeviceOnlySmsClearIds((current) => new Set([...current, ...grantIds]));
    }
  }, [userId, vaultOwnerToken, clearableSmsEmergencyIds, locationRefresh]);

  // Copy device-only clears to the server, then forget the copied ids here.
  // If the copy fails, the list stays hidden and is retried on a later visit.
  useEffect(() => {
    if (!userId || !vaultOwnerToken || !receivedGrants || shouldSkipReviewerBackgroundWritesForAutomation()) return;
    const scope = checkoutScope.current;
    const epoch = snapshotVaultSessionEpoch();
    const isEffectCurrent = () => scope !== null && scope.userId === userId && checkoutScope.current === scope &&
      isVaultSessionEpochCurrent(epoch) && getVaultOwnerToken() === vaultOwnerToken &&
      !shouldSkipReviewerBackgroundWritesForAutomation();
    if (!isEffectCurrent() || deviceOnlySmsCopyRef.current === userId) return;
    const deviceOnly = readDeviceOnlySmsClearIds(userId);
    if (deviceOnly.size === 0) return;
    deviceOnlySmsCopyRef.current = userId;
    const grantIds = receivedGrants
      .filter(
        (grant) =>
          deviceOnly.has(grant.id) &&
          isSmsEmergencyGrant(grant) &&
          !isActiveSmsEmergencyGrant(grant) &&
          !grant.recipientClearedAt,
      )
      .map((grant) => grant.id);
    void (async () => {
      try {
        if (!isEffectCurrent()) return;
        if (grantIds.length > 0) {
          const cleared = await FeedService.clearSosCards({
            vaultOwnerToken,
            grantIds,
            isEffectCurrent,
          });
          if (!isEffectCurrent()) return;
          setServerClearedSmsIds((current) => new Set([...current, ...cleared]));
        }
        if (isEffectCurrent()) forgetDeviceOnlySmsClearIds(userId, deviceOnly);
      } catch {
        // The device list stays hidden here until a later visit copies it.
      }
    })();
  }, [userId, vaultOwnerToken, receivedGrants, getVaultOwnerToken]);

  const actionables = useMemo<FeedActionable[]>(() => {
    if (!userId) return [];
    const items: FeedActionable[] = [];

    if (agentUpdateCard) items.push({ ...agentUpdateCard, sortAt: firstSeenAt(agentUpdateCard.id) });
    // One current setup action per request. SSE refreshes this same projection
    // after bank setup or price save; no independent account-state cache can
    // keep an obsolete CTA alive.
    const setupEntryIds = new Set<string>();
    const setupCandidates = new Map(
      [...(receivedOverflowItems ?? []), ...(consentItems ?? [])].map(
        (entry) => [entry.id, entry],
      ),
    );
    for (const entry of setupCandidates.values()) {
      if (entry.metadata?.direction !== "incoming") continue;
      const setup = documentRequestEntrySetup(entry);
      if (!setup || (setup === "price" && ownerDocumentDecision(entry)))
        continue;
      setupEntryIds.add(entry.id);
      const row = {
        id: `consent:${entry.id}`,
        ...(isDocumentRequestSetupStep(setup) ? { todo: {
          key: `consent:${entry.id}:setup:${setup}`, source: "drive" as const,
          title: documentRequestSetupLabel(setup, true),
          href: documentRequestSetupHref(setup, "/one/todos"),
        } } : {}),
        icon: ConsentAgentIcon,
        iconTone: "capability",
        title: resolveConsentRequesterLabel({
          counterpartLabel: entry.counterpart_label,
        }),
        sortAt:
          parseConsentInstant(entry.issued_at) ??
          firstSeenAt(`consent:${entry.id}`),
        displayTimestamp: parseConsentInstant(entry.issued_at),
      } as const;
      if (!isDocumentRequestSetupStep(setup)) {
        items.push({
          ...row,
          description: documentRequestSetupLabel(setup, true),
          href: buildConsentCenterHref("pending", {
            requestId: entry.id,
            from: "/one/feed",
          }),
          chevron: true,
          actions: [],
        });
        continue;
      }
      // The button names the step, so the row says only what waits on it. A
      // row with an action is not a link: its tap takes the same step.
      const openStep = () => openDocumentRequestSetup(setup);
      items.push({
        ...row,
        description: "Requested a document",
        onSelect: openStep,
        actions: [
          {
            key: `setup-${setup}`,
            label: documentRequestSetupLabel(setup, true),
            tone: "primary",
            run: openStep,
          },
        ],
      });
    }

    for (const payment of sentPayments) {
      const displayPayment = describeFeedDrivePayment(
        payment,
        paymentClockNow,
        paymentContexts[payment.requestId],
      );
      const paymentIsNonActionable = displayPayment.status !== "ready";
      const packetReviewRequired = payment.packageDisclosureRequired === true || !!paymentContexts[payment.requestId]?.packageDisclosure;
      const paymentAction = paymentIsNonActionable
        ? []
        : packetReviewRequired ? [{ key: "review-packet", label: "Review packet", tone: "primary" as const,
          run: () => router.push(buildConsentCenterHref("pending", {
            requestId: `document_share_request:${payment.requestId}`, requestView: "sent", from: "/one/feed",
          })),
        }] : [
            {
              key: "pay",
              // The order's price: the owner's, or $10 in the Trusted circle.
              label: `Pay ${formatDocumentRequestPrice(payment.amountCents)}`,
              tone: "primary" as const,
              run: async () => {
                const current = currentCheckout(userId, `drive-payment:${payment.requestId}`, "pay",
                  `Pay ${formatDocumentRequestPrice(payment.amountCents)}`);
                if (!current()) return;
                try {
                  const idToken = await user?.getIdToken();
                  if (!current()) return;
                  if (!idToken) throw new Error("Sign in to continue");
                  const checkoutUrl = await DriveRequestPaymentService.checkout(
                    idToken,
                    payment.requestId,
                  );
                  if (!current()) return;
                  if (typeof checkoutUrl === "string") window.location.assign(checkoutUrl);
                  else {
                    CacheSyncService.onConsentMutated(userId);
                    notifyFeedActionResolved();
                    await Promise.all([refreshDocumentRequests(), sentProgressRefresh({ force: true })]);
                  }
                } catch (cause) {
                  if (!current()) return;
                  toast.error(drivePaymentErrorMessage(cause));
                  void refreshDocumentRequests();
                }
              },
            },
          ];
      items.push({
        id: `drive-payment:${payment.requestId}`,
        ...(!paymentIsNonActionable ? { todo: {
          source: "drive" as const, title: displayPayment.title,
          href: buildConsentCenterHref("pending", { requestId: `document_share_request:${payment.requestId}`, requestView: "sent", from: "/one/todos" }),
        } } : {}),
        icon: ConsentAgentIcon,
        iconTone: "capability",
        title: displayPayment.title,
        description: displayPayment.description,
        href: paymentIsNonActionable ? payment.href : undefined,
        onSelect: paymentIsNonActionable ? undefined : () => router.push(buildConsentCenterHref("pending", {
          requestId: `document_share_request:${payment.requestId}`, requestView: "sent", from: "/one/feed",
        })),
        chevron: paymentIsNonActionable,
        actions: paymentAction,
        sortAt:
          payment.requestedAt ??
          firstSeenAt(`drive-payment:${payment.requestId}`),
        displayTimestamp: payment.requestedAt,
      });
    }

    // Consent. A request someone sent the owner is ONE row however many
    // items it names ("Kushal wants your Food preferences · dinner"), with
    // Allow and Don't allow inline. Both go through the shared approve and
    // deny path (`useOwnerConsentDecision` -> `useConsentActions`), which
    // builds the encrypted export on this device; a locked vault opens the
    // unlock prompt first and the same decision runs once it is open.
    // Requests with their own ceremony (location, Mail, marketplace, Drive,
    // invitations) keep routing to it.
    if ((pendingConsentCount ?? 0) > 0) {
      const queueEntries: ConsentCenterEntry[] = [];
      for (const entry of consentItems ?? []) {
        // Incoming connection requests reach this lane too — the Consent
        // Center folds them into its `pending` surface from the very same
        // ConnectionsService the connections lane below reads. Rendering both
        // put one request in "Needs you" twice (a chevron-only consent row and
        // the real one). The connections lane owns them: it carries the inline
        // Confirm/Decline and the scoped Review route.
        if (!isConsentFeedActionable(entry) || setupEntryIds.has(entry.id))
          continue;
        if (isOwnerConsentQueueEntry(entry)) {
          queueEntries.push(entry);
          continue;
        }
        // A document request from outside the Trusted circle that the server
        // says the owner can answer now gets Deny and Allow inline. Anything
        // else (background access, waiting on payment) keeps its chevron row.
        const requesterLabel = resolveConsentRequesterLabel({
          counterpartLabel: entry.counterpart_label,
          counterpartEmail: entry.counterpart_email,
          counterpartSecondaryLabel: entry.counterpart_secondary_label,
          counterpartId: entry.counterpart_id,
        });
        if (isAnswerRequestEntry(entry)) {
          const state = String(entry.metadata?.request_status || entry.status);
          const owner = entry.metadata?.role === "owner";
          const requestId = entry.request_id || "";
          const question = String(entry.metadata?.question || "").trim();
          const amountCents =
            typeof entry.metadata?.amount_cents === "number"
              ? entry.metadata.amount_cents
              : null;
          // What the resolver suggested is not evidence that an answer
          // exists. The owner's device prepares the answer at approval and
          // says whether the approved information yielded anything; only that
          // decides whether there is something to buy.
          const staged = entry.metadata?.answer_staged === true;
          const stagedEmpty = staged && entry.metadata?.answer_has_content === false;
          // Approved, but the owner's device has not reported yet: it may be
          // locked, offline or still reading. Saying "not found" here would
          // be a guess, and offering a price would be one too.
          const preparing = state === "approved" && !staged;
          const href = buildConsentCenterHref("pending", {
            requestId: entry.id,
            from: "/one/feed",
          });
          // "Pay $5 · what is your age?" reads as one sentence, the way the
          // document lane's row does, so the price is decided before the tap.
          const payLabel =
            amountCents === null
              ? null
              : `Pay ${formatDocumentRequestPrice(amountCents)}`;
          const description = owner
            ? state === "approved" && !staged
              ? "Retry answer preparation"
              : state === "pending_resolution"
                ? "Matching the question to your memory"
                : state === "answering"
              ? "Write answer"
              : stagedEmpty
                ? "Nothing of yours answers this question"
                : "Set price"
            : stagedEmpty
              ? "Answer not found"
              : preparing
                ? entry.metadata?.preparation_overdue === true
                  ? "Ask them to unlock memory and retry preparation"
                  : "Their answer is being prepared"
                : state === "approved"
                  ? // Approved and prepared: a price exists. Without the
                    // amount in this projection the row still reaches the card.
                    (payLabel ?? "Review price and pay")
                  : state === "answered"
                    ? "Open the answer"
                    : "Waiting for them to set a price";
          // Deny is inline because a refusal grants nothing. Allow opens the
          // review: approving binds the exact information and the price, and
          // neither can be shown on a row.
          const ownerDeciding = owner && state === "awaiting_owner" && !stagedEmpty;
          // Pay is offered only against a prepared answer that has content.
          const requesterPaying =
            !owner &&
            state === "approved" &&
            staged &&
            !stagedEmpty &&
            Boolean(payLabel);
          const actions: FeedActionButton[] = ownerDeciding
            ? [
                {
                  key: "deny-answer",
                  label: "Deny",
                  tone: "danger",
                  confirm: true,
                  run: () => declineAnswerRequest(requestId),
                },
                {
                  key: "allow-answer",
                  label: "Allow",
                  tone: "success",
                  run: () => router.push(href),
                },
              ]
            : requesterPaying
              ? [
                  {
                    key: "pay-answer",
                    label: payLabel!,
                    tone: "primary",
                    // Straight to Checkout, like the document lane's Pay. The
                    // price was decided before the tap, so a second screen
                    // only to press Pay again is a step with no decision in it.
                    run: async () => {
                      const current = currentCheckout(userId, `consent:${requestId}`, "pay-answer", payLabel!);
                      if (!current()) return;
                      try {
                        const token = await AuthService.getIdToken();
                        if (!current()) return;
                        if (!token) throw new Error("Sign in to continue");
                        const checkoutUrl = await AnswerRequestService.checkout(token, requestId);
                        if (!current()) return;
                        window.location.assign(checkoutUrl);
                      } catch {
                        if (!current()) return;
                        // Paying is its own rollout gate: the request and its
                        // price stand even when checkout cannot open, and
                        // nothing has been charged.
                        toast.error("Checkout couldn't open. You weren't charged.");
                      }
                    },
                  },
                ]
              : stagedEmpty || preparing
                ? []
                : [
                    {
                      key: "review-answer",
                      label: owner
                        ? state === "answering"
                          ? "Write answer"
                          : "Review question"
                        : state === "approved"
                          ? "Review price and pay"
                          : "Open",
                      tone: "primary",
                      run: () => router.push(href),
                    },
                  ];
          items.push({
            id: `consent:${entry.id}`,
            ...((owner && !preparing && !stagedEmpty && !["pending_resolution", "answered"].includes(state)) || requesterPaying ? { todo: {
              key: `consent:${entry.id}:${state}`, source: "consent" as const,
              title: `Review request from ${requesterLabel}`, href,
            } } : {}),
            icon: ConsentAgentIcon,
            iconTone: "capability",
            title:
              requesterPaying && question
                ? `${payLabel} · ${question}`
                : requesterLabel,
            description,
            href,
            ...(actions.length ? { onSelect: () => router.push(href) } : {}),
            chevron: actions.length === 0,
            actions,
            sortAt:
              parseConsentInstant(entry.issued_at) ??
              firstSeenAt(`consent:${entry.id}`),
            displayTimestamp: parseConsentInstant(entry.issued_at),
          });
          continue;
        }
        const documentDecision = ownerDocumentDecision(entry);
        if (documentDecision && settledConsentKeys.has(entry.id)) continue;
        const reviewHref = buildConsentCenterHref("pending", {
          requestId: driveSharingSelectionId(entry),
          from: "/one/feed",
        });
        const entryId = entry.id;
        items.push({
          id: `consent:${entry.id}`,
          todo: {
            key: `consent:${entry.id}:review`,
            source: isDriveSharingEntry(entry) ? "drive" : "consent",
            title: `Review request from ${requesterLabel}`,
            href: buildConsentCenterHref("pending", { requestId: driveSharingSelectionId(entry), from: "/one/todos" }),
          },
          icon: ConsentAgentIcon,
          iconTone: "capability",
          person:
            ["ria", "investor", "person"].includes(entry.counterpart_type) &&
            (entry.counterpart_id || entry.counterpart_image_url)
              ? {
                  displayName: requesterLabel,
                  photoUrl: entry.counterpart_image_url ?? null,
                }
              : null,
          title: requesterLabel,
          description: consentSummary(entry),
          href: reviewHref,
          // A row with inline actions is not a link; its tap opens the same review.
          ...(documentDecision
            ? { onSelect: () => router.push(reviewHref) }
            : {}),
          chevron: !documentDecision,
          actions: documentDecision
            ? [
                ...(!documentDecision.priceOnly
                  ? [
                      {
                        key: "deny",
                        label: "Deny",
                        tone: "danger",
                        disabled: !vaultOwnerToken,
                        confirm: true,
                        run: () =>
                          declineDocumentRequest(entryId, documentDecision),
                      } satisfies FeedActionButton,
                    ]
                  : []),
                {
                  key: "allow",
                  label: documentDecision.priceOnly ? "Set price" : "Allow",
                  tone: "success",
                  disabled: !vaultOwnerToken,
                  run: () =>
                    openDocumentPrice({
                      ...documentDecision,
                      entryId,
                      requesterLabel,
                    }),
                },
              ]
            : [],
          // `issued_at` when the backend populated it — never the expiry, which
          // is in the future and would sort this above everything. Otherwise
          // when it was first seen, so it holds its place across refreshes.
          sortAt:
            (parseConsentInstant(entry.issued_at) ?? 0) ||
            firstSeenAt(`consent:${entry.id}`),
          // Real only when the backend happened to populate issued_at — never
          // fabricate a "just now" time label for this type.
          displayTimestamp: parseConsentInstant(entry.issued_at),
        });
      }

      for (const request of groupPendingConsentRequests(queueEntries)) {
        if (settledConsentKeys.has(request.key)) continue;
        items.push(
          ownerConsentRequestActionable(request, {
            allow: consentDecision.allow,
            deny: declineConsentRequest,
            openDetails: () => router.push(request.detailsHref),
            onDecided: markConsentSettled,
            sortAt:
              request.requestedAt ?? firstSeenAt(`consent:${request.key}`),
          }),
        );
      }

      // The Feed intentionally loads only the first Consent Center page. When
      // the authoritative summary says more requests exist, keep the queue
      // complete by ending the loaded slice with a route to the full workspace
      // instead of silently making request 21+ unreachable from Feed.
      const loadedConsentCount = consentItems?.length ?? 0;
      const remainingConsentCount =
        (pendingConsentCount ?? 0) - loadedConsentCount;
      if (consentItems && remainingConsentCount > 0) {
        items.push({
          id: "consent:overflow",
          icon: ConsentAgentIcon,
          iconTone: "capability",
          title: "View all pending requests",
          description: `${remainingConsentCount} more pending ${remainingConsentCount === 1 ? "request is" : "requests are"} waiting in Consent Center.`,
          href: buildConsentCenterHref("pending", { from: "/one/feed" }),
          chevron: true,
          actions: [],
          // Keep this navigation affordance below real actionable rows.
          sortAt: 0,
          displayTimestamp: null,
        });
      }
    }

    // Keep each incident and its original sent time. Feed groups these by
    // sender and separates ended alerts from pending tasks.
    const smsEmergencies = (receivedGrants ?? []).filter(
      (grant) =>
        isSmsEmergencyGrant(grant) &&
        grant.recipientUserId === userId && grant.ownerUserId !== userId &&
        // A live SOS always shows; only an ended one can be cleared.
        (isActiveSmsEmergencyGrant(grant) || !isClearedSmsEmergency(grant)),
    );
    for (const grant of smsEmergencies) {
      const label = grant.ownerDisplayName?.trim() || "A contact";
      const isLive = isActiveSmsEmergencyGrant(grant);
      const sentAt = toDisplayTimestamp(grant.createdAt);
      const status = isLive ? "Active" : grant.status === "revoked" ? "Revoked"
        : grant.status === "expired" ? "Expired" : "Ended";
      items.push({
        id: `sms-emergency:${grant.id}`,
        icon: EmergencyRowIcon,
        iconTone: "capability",
        person:
          label !== "A contact"
            ? {
                displayName: label,
                photoUrl: grant.ownerPhotoUrl ?? null,
              }
            : null,
        // Only a still-live alert gets the pinned Live treatment. Ended
        // incidents remain in the sender's recent-alert disclosure.
        emphasis: isLive ? "emergency" : undefined,
        smsEmergency: { senderId: grant.ownerUserId },
        // SMS is the product's Save My Soul lane.
        title: label,
        description: `Emergency SMS · ${status}`,
        href: isLive ? buildOneLocationNotificationHref(grant.id) : null,
        chevron: isLive,
        actions: [],
        sortAt: sentAt ?? firstSeenAt(`sms-emergency:${grant.id}`),
        displayTimestamp: sentAt,
      });
    }

    // Location access requests — inline Approve / Deny. Only requests the
    // viewer owns (and did not send) are actionable; outgoing requests must not
    // surface here as a self-addressed "wants to see your location" card.
    //
    // Approve grants exactly what was asked for. It used to send a flat
    // durationHours: 1, so answering a four-hour ask from here handed out one
    // hour -- and the card never said what had been asked, so the owner had no
    // way to notice.
    const pendingLocation = (locationRequests ?? []).filter(
      (request: OneLocationAccessRequest) =>
        isIncomingLocationRequestActionable(request, userId),
    );
    for (const request of pendingLocation) {
      const label = request.requesterDisplayName?.trim() || "Someone";
      items.push({
        id: `location:${request.id}`,
        todo: {
          source: "location", title: `Review ${label}'s location request`,
          href: buildOneLocationWorkflowHref({ requestId: request.id }),
        },
        icon: LocationAgentIcon,
        iconTone: "capability",
        person:
          label !== "Someone"
            ? {
                displayName: label,
                photoUrl: request.requesterPhotoUrl ?? null,
              }
            : null,
        title: label,
        onSelect: () => router.push(buildOneLocationWorkflowHref({ requestId: request.id })),
        phoneActions: [{
          key: "review", label: "Review", tone: "primary",
          run: () => router.push(buildOneLocationWorkflowHref({ requestId: request.id })),
        }],
        // Names the amount, and says when it is extra time on a live share.
        description:
          request.message?.trim() || locationAskPromptLine(request, Date.now()),
        actions: [
          {
            key: "deny",
            label: "Deny",
            tone: "ghost",
            disabled: !vaultOwnerToken,
            confirm: true,
            run: async () => {
              if (!vaultOwnerToken) return;
              await OneLocationService.denyRequest({
                vaultOwnerToken,
                requestId: request.id,
              });
              if (userId) OneLocationStateResource.invalidate(userId);
              notifyFeedActionResolved();
              await locationRefresh({ force: true });
            },
          },
          {
            key: "approve",
            label: locationApproveActionLabel(request, Date.now()),
            tone: "primary",
            disabled: !vaultOwnerToken,
            run: async () => {
              if (!vaultOwnerToken) return;
              // No durationHours: omitting it means the server grants the
              // amount that was requested, falling back to an hour only when
              // the ask named none. Naming a number here is what silently
              // turned a four-hour ask into a one-hour grant.
              await OneLocationService.approveRequest({
                vaultOwnerToken,
                requestId: request.id,
                approvalMode: "manual",
              });
              if (userId) OneLocationStateResource.invalidate(userId);
              notifyFeedActionResolved();
              await locationRefresh({ force: true });
            },
          },
        ],
        sortAt:
          toTimestamp(request.requestedAt) ||
          firstSeenAt(`location:${request.id}`),
        displayTimestamp: toDisplayTimestamp(request.requestedAt),
      });
    }

    // Circle invitations — inline Accept / Decline. The state read already
    // scopes these to incoming + pending, but re-filter so a widened server
    // response can never surface someone else's invite as actionable here.
    const pendingCircleInvites = (circleMemberInvites ?? []).filter(
      (invite: OneLocationCircleMemberInvite) =>
        invite.inviteeUserId === userId && invite.status === "pending",
    );
    for (const invite of pendingCircleInvites) {
      const label = invite.inviterDisplayName?.trim() || "Someone";
      const circleName = invite.circleName?.trim() || "a Circle";
      items.push({
        id: `circle-invite:${invite.id}`,
        todo: {
          source: "location", title: `Review invitation to ${circleName}`,
          href: buildOneLocationWorkflowHref({ circleInviteId: invite.id }),
        },
        icon: PeopleRowIcon,
        iconTone: "capability",
        person:
          label !== "Someone"
            ? {
                displayName: label,
                photoUrl: invite.inviterPhotoUrl ?? null,
              }
            : null,
        title: label,
        description: `Invited you to join ${circleName}.`,
        onSelect: () => router.push(buildOneLocationWorkflowHref({ circleInviteId: invite.id })),
        phoneActions: [{
          key: "review", label: "Review", tone: "primary",
          run: () => router.push(buildOneLocationWorkflowHref({ circleInviteId: invite.id })),
        }],
        actions: [
          {
            key: "decline",
            label: "Decline",
            tone: "ghost",
            disabled: !vaultOwnerToken,
            confirm: true,
            run: async () => {
              if (!vaultOwnerToken) return;
              await OneLocationService.declineNamedCircleMemberInvite({
                vaultOwnerToken,
                inviteId: invite.id,
              });
              if (userId) OneLocationStateResource.invalidate(userId);
              notifyFeedActionResolved();
              await locationRefresh({ force: true });
            },
          },
          {
            key: "accept",
            label: "Accept",
            tone: "primary",
            disabled: !vaultOwnerToken,
            run: async () => {
              if (!vaultOwnerToken) return;
              await OneLocationService.acceptNamedCircleMemberInvite({
                vaultOwnerToken,
                inviteId: invite.id,
              });
              if (userId) OneLocationStateResource.invalidate(userId);
              notifyFeedActionResolved();
              await locationRefresh({ force: true });
            },
          },
        ],
        sortAt:
          toTimestamp(invite.createdAt) ||
          firstSeenAt(`circle-invite:${invite.id}`),
        displayTimestamp: toDisplayTimestamp(invite.createdAt),
      });
    }

    // Scoped connection requests require the Consent Center review surface.
    // A feed shortcut must never turn an omitted scope decision into a silent
    // decline (or, worse, an implied approval).
    const pendingConnections = (connectionRequests ?? []).filter(
      (request: ConnectionRequest) => request.status === "pending",
    );
    for (const request of pendingConnections) {
      const label = request.counterpartDisplayName?.trim() || "Someone";
      const requiresScopeReview = (request.scopes?.length ?? 0) > 0;
      const reviewHref = buildConsentCenterHref("pending", {
        requestId: request.id,
      });
      const connectionRow: FeedActionable = {
        id: `connection:${request.id}`,
        todo: { source: "connections", title: `Review ${label}'s connection request`, href: reviewHref },
        icon: JoinRowIcon,
        iconTone: "capability",
        person:
          label !== "Someone"
            ? {
                displayName: label,
                photoUrl: request.counterpartPhotoUrl ?? null,
              }
            : null,
        title: label,
        // "with you" is already clear: the request is in your Feed.
        description: request.message?.trim() || "Wants to connect",
        href: requiresScopeReview ? reviewHref : null,
        actions: requiresScopeReview
          ? [
              {
                key: "review",
                label: "Review",
                tone: "primary",
                disabled: !userId,
                run: () => router.push(reviewHref),
              },
            ]
          : [
              // Google Play user-generated content policy: report the request
              // (and its message) to the Hussh team. The server also declines
              // it and blocks the sender. Android only, so iOS and web Feed
              // rows stay exactly as they are.
              ...(isAndroid()
                ? [
                    {
                      key: "report",
                      label: "Report",
                      tone: "danger" as const,
                      disabled: !userId,
                      confirm: true,
                      run: async () => {
                        const idToken = await user?.getIdToken();
                        if (!idToken) return;
                        await ConnectionsService.report({
                          idToken,
                          requestId: request.id,
                          reason: "inappropriate",
                        });
                        toast.success(
                          "Reported. This person can't send you another request.",
                        );
                        CacheSyncService.onConnectionCapabilityMutated(userId);
                        notifyFeedActionResolved();
                        await connectionsRefresh({ force: true });
                      },
                    },
                  ]
                : []),
              {
                key: "decline",
                label: "Decline",
                tone: "ghost",
                disabled: !userId,
                confirm: true,
                run: async () => {
                  const idToken = await user?.getIdToken();
                  if (!idToken) return;
                  await ConnectionsService.reject({
                    idToken,
                    requestId: request.id,
                  });
                  CacheSyncService.onConnectionCapabilityMutated(userId);
                  notifyFeedActionResolved();
                  await connectionsRefresh({ force: true });
                },
              },
              {
                key: "confirm",
                label: "Confirm",
                tone: "primary",
                disabled: !userId,
                run: async () => {
                  const idToken = await user?.getIdToken();
                  if (!idToken) return;
                  await ConnectionsService.accept({
                    idToken,
                    requestId: request.id,
                  });
                  CacheSyncService.onConnectionGraphMutated(userId);
                  notifyFeedActionResolved();
                  await connectionsRefresh({ force: true });
                },
              },
            ],
        // ConnectionRequest (lib/services/connections-service.ts) carries no
        // timestamp field at all, so first-seen is the only honest ordering.
        sortAt: firstSeenAt(`connection:${request.id}`),
        // Still never fabricate a visible time label from it.
        displayTimestamp: null,
      };
      const reportAction = connectionRow.actions.find(action => action.key === "report");
      if (reportAction) {
        connectionRow.onSelect = () => router.push(reviewHref);
        connectionRow.phoneActions = [reportAction, {
          key: "review", label: "Review", tone: "primary",
          run: () => router.push(reviewHref),
        }];
      }
      items.push(connectionRow);
    }

    // Kai debates remain visible while running and after completion until the
    // person opens or dismisses the ready result. The debate manager remains
    // the authority; Feed is only its consumer-safe projection.
    const debateTasks = debateState.tasks.filter(
      (task: DebateRunTask) => task.userId === userId && !task.dismissedAt,
    );
    for (const task of debateTasks) {
      const feedState = classifyDebateFeedState(task);
      if (!feedState) continue;
      const running = feedState === "running";
      const ready = feedState === "ready";
      const failedSave = feedState === "failed_save";
      const persisted = ready && task.persistenceState === "saved";
      const statusText = running
        ? task.streamState === "reconnecting"
          ? "Reconnecting…"
          : task.streamState === "paused"
            ? "Updates paused"
            : "Analyzing…"
        : ready
          ? task.persistenceState === "pending"
            ? "Analysis ready. Saving to history…"
            : "Analysis ready to review."
          : "Analysis is ready, but could not be saved. Retry to keep it in history.";
      const actions: FeedActionButton[] = [];
      if (running) {
        actions.push({
          key: "cancel",
          label: "Cancel",
          tone: "danger",
          disabled: !vaultOwnerToken,
          confirm: true,
          run: async () => {
            if (!vaultOwnerToken) return;
            await DebateRunManagerService.cancelRun({
              runId: task.runId,
              userId: task.userId,
              vaultOwnerToken,
            });
          },
        });
      } else if (failedSave) {
        actions.push({
          key: "retry",
          label: "Retry",
          tone: "primary",
          run: async () => {
            await DebateRunManagerService.retryTaskPersistence(task.runId);
          },
        });
        actions.push({
          key: "dismiss",
          label: "Dismiss",
          tone: "ghost",
          run: () => DebateRunManagerService.dismissTask(task.runId),
        });
      } else {
        actions.push({
          key: "open",
          label: "Open",
          tone: "primary",
          run: () => openAnalysis(task.runId, persisted),
        });
        actions.push({
          key: "dismiss",
          label: "Dismiss",
          tone: "ghost",
          run: () => DebateRunManagerService.dismissTask(task.runId),
        });
      }
      items.push({
        id: `debate:${task.runId}`,
        todo: !running && task.persistenceState !== "pending"
          ? { key: `debate:${task.runId}:${failedSave ? "save" : "review"}`, source: "kai", title: failedSave ? `Save ${task.ticker || "analysis"}` : `Review ${task.ticker || "analysis"}`, href: failedSave ? "/one/feed" : buildDebateFeedAnalysisHref(task.runId, persisted) }
          : undefined,
        icon: FinanceAgentIcon,
        iconTone: "capability",
        spinning: running || task.persistenceState === "pending",
        title: task.ticker || "Analysis",
        description: statusText,
        onSelect:
          running || ready
            ? () => openAnalysis(task.runId, persisted)
            : undefined,
        chevron: running || ready,
        actions,
        sortAt:
          toTimestamp(task.updatedAt || task.startedAt) ||
          firstSeenAt(`debate:${task.runId}`),
        displayTimestamp: toDisplayTimestamp(task.updatedAt || task.startedAt),
      });
    }

    // Running and failed background work stays actionable. A failed task must
    // not silently disappear from Feed: the owner route explains recovery,
    // while Dismiss lets the user acknowledge work they no longer need.
    const appTasks = appTaskState.tasks.filter(
      (task: AppBackgroundTask) =>
        task.userId === userId &&
        !task.dismissedAt &&
        isAppBackgroundTaskVisible(task) &&
        (task.status === "running" || task.status === "failed"),
    );
    for (const task of appTasks) {
      const running = task.status === "running";
      const actions: FeedActionButton[] = [];
      if (task.routeHref) {
        const href = task.routeHref;
        actions.push({
          key: "open",
          label: "Open",
          tone: "primary",
          run: () => router.push(href),
        });
      }
      if (!running) {
        actions.push({
          key: "dismiss",
          label: "Dismiss",
          tone: "ghost",
          run: () => {
            AppBackgroundTaskService.dismissTask(task.taskId);
            notifyFeedActionResolved();
          },
        });
      }
      items.push({
        id: `task:${task.taskId}`,
        todo: !running && task.routeHref
          ? { key: `task:${task.taskId}:${task.startedAt}`, source: "agent", title: `Review ${task.title}`, href: task.routeHref }
          : undefined,
        icon: FinanceAgentIcon,
        iconTone: "capability",
        spinning: running,
        title: task.title,
        description: running
          ? task.description || "Working in the background…"
          : task.error ||
            task.description ||
            "This background task needs attention.",
        actions,
        sortAt:
          toTimestamp(task.updatedAt || task.startedAt) ||
          firstSeenAt(`task:${task.taskId}`),
        displayTimestamp: toDisplayTimestamp(task.updatedAt || task.startedAt),
      });
    }

    return items.sort((a, b) => {
      // Emergency SMS alerts pin to the very top, then the rest stays in
      // descending recency order.
      const aEmergency = a.emphasis === "emergency" ? 1 : 0;
      const bEmergency = b.emphasis === "emergency" ? 1 : 0;
      if (aEmergency !== bEmergency) return bEmergency - aEmergency;
      return b.sortAt - a.sortAt;
    });
    // Depend on the resources' `data` + stable `refresh` (not the wrapper
    // objects, which useStaleResource returns fresh every render) so this memo
    // only recomputes when the underlying data actually changes — otherwise a
    // streaming debate's frequent ticks would rebuild every row each render.
  }, [
    appTaskState.tasks,
    agentUpdateCard,
    currentCheckout,
    refreshDocumentRequests,
    sentProgressRefresh,
    consentDecision.allow,
    declineConsentRequest,
    declineDocumentRequest,
    declineAnswerRequest,
    openDocumentPrice,
    markConsentSettled,
    settledConsentKeys,
    connectionRequests,
    connectionsRefresh,
    consentItems,
    debateState.tasks,
    isClearedSmsEmergency,
    firstSeenAt,
    locationRequests,
    receivedGrants,
    receivedOverflowItems,
    sentPayments,
    circleMemberInvites,
    locationRefresh,
    openAnalysis,
    openDocumentRequestSetup,
    pendingConsentCount,
    paymentClockNow,
    paymentContexts,
    router,
    user,
    userId,
    vaultOwnerToken,
  ]);

  useEffect(() => { checkoutRows.current = actionables; }, [actionables]);

  const loading =
    consentSummaryResource.loading ||
    consentListResource.loading ||
    locationResource.loading ||
    connectionsResource.loading;
  const error = [
    consentSummaryResource.error,
    consentListResource.error,
    locationResource.error,
    connectionsResource.error,
  ].some(Boolean)
    ? "Some pending activity couldn't refresh."
    : null;

  return {
    actionables,
    inProgress,
    progressOverflow,
    progressLoading:
      sentProgressResource.loading ||
      activeProgressResource.loading ||
      receivedOverflowResource.loading,
    progressError: [
      sentProgressResource.error,
      activeProgressResource.error,
      receivedOverflowResource.error,
    ].some(Boolean)
      ? "Some request updates couldn't refresh."
      : null,
    inventoryIncomplete: Boolean(allPending && [consentListResource.data, receivedOverflowResource.data, sentProgressResource.data, activeProgressResource.data].some(page => page?.has_more)),
    count: actionables.length,
    loading,
    error,
    retry: refreshActionables,
    hasClearableSmsEmergencies: clearableSmsEmergencyIds.length > 0,
    clearSmsEmergencies,
    consentUnlockPrompt: consentDecision.unlockPrompt,
    documentPricePrompt,
  };
}
