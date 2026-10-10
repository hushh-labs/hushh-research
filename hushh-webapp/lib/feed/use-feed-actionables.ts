"use client";

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

import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { useFeedLiveRefresh, useFeedPendingConsentRefresh } from "@/lib/feed/use-feed-live-refresh";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import {
  CACHE_KEYS,
  CACHE_TTL,
  CacheService,
} from "@/lib/services/cache-service";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import { isLocationRequestPending } from "@/lib/one-location/request-expiry";
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
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { projectFeedDriveProgress, type FeedDriveProgress } from "@/lib/feed/drive-request-progress";
import {
  describeFeedDrivePayment,
  projectFeedDrivePayments,
} from "@/lib/feed/drive-request-payment";
import { useFeedPaymentClock } from "@/lib/feed/use-feed-payment-clock";
import { useFeedPaymentContext } from "@/lib/feed/use-feed-payment-context";
import { DriveRequestPaymentService } from "@/lib/services/drive-request-payment-service";
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
} from "@/lib/consent/document-request-price";
import { driveSharingSelectionId, isDriveSharingEntry } from "@/lib/consent/drive-query-consent";
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
import {
  isLocationConsent,
  locationConsentSummary,
} from "@/lib/consent/location-consent";
import { OneLocationService } from "@/lib/one-location/service";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { isAndroid } from "@/lib/capacitor/platform";
import type {
  OneLocationAccessRequest,
  OneLocationCircleMemberInvite,
  OneLocationGrant,
} from "@/lib/one-location/types";
import { buildOneLocationNotificationHref } from "@/lib/one-location/notifications";
import {
  ConnectionsService,
  type ConnectionRequest,
} from "@/lib/services/connections-service";
import { buildKaiMarketRoute } from "@/lib/navigation/routes";

/**
 * Subset of SettingsRow's icon-well tones (that type is not exported). Feed
 * rows use "capability": a bare duotone registry glyph, the same one Profile
 * uses for the same concept, never a coloured tile (hushh-icon-theme).
 */
export type FeedIconTone =
  "capability" | "accent" | "blue" | "purple" | "green" | "orange" | "red" | "gray";

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
  /** Whole-row link (e.g. consent Review deep-link). */
  href?: string | null;
  /** Whole-row imperative action (e.g. resume a running debate). */
  onSelect?: () => void;
  chevron?: boolean;
  actions: FeedActionButton[];
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
  count: number;
  loading: boolean;
  error: string | null;
  retry: () => Promise<void>;
  /** A revoked/expired SOS card is sitting in `actionables` with nothing left
   * to act on — only the Feed page's existing Clear button can remove it. */
  hasClearableSmsEmergencies: boolean;
  /** Dismisses every revoked/expired SOS card currently shown. Wired into the
   * Feed page's existing Clear button so it clears SOS notifications too. */
  clearSmsEmergencies: () => void;
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
  purpose: string | null;
  recipientEmail: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  /** The terms have not loaded; Allow stays off until the owner can read them. */
  detailsPending: boolean;
  busy: boolean;
  error: string | null;
  /** Whole-dollar cents, or null when no payment is required. */
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
  purpose: string;
  recipientEmail: string;
  periodStart: string | null;
  periodEnd: string | null;
};

function decisionErrorCode(cause: unknown): string {
  return cause instanceof DriveSharingError ? cause.code : "request_failed";
}

/** What the owner reads when Allow or Deny did not go through. Never server text. */
export function documentDecisionErrorCopy(code: string): string {
  switch (code) {
    case "invalid_payment_amount":
      return "Choose a whole-dollar price from $1 to $500.";
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
  if (entry.kind === "connection_request" || entry.kind === "outgoing_request") {
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
  // The reason stands alone on its own line here, so it keeps its capital.
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

function consentSummary(entry: ConsentCenterEntry): string {
  if (entry.kind === "invite") return "Invitation waiting for your approval.";
  if (isLocationConsent(entry.metadata, entry.scope)) {
    return locationConsentSummary(entry.metadata);
  }
  return (
    entry.additional_access_summary ||
    entry.scope_description ||
    entry.reason ||
    entry.scope ||
    "A new consent request needs your review."
  );
}

/**
 * A pending location access request is actionable in the viewer's "Needs you"
 * feed only when the viewer OWNS the request (location is being asked for)
 * and did NOT send it themselves. `state.requests` carries BOTH directions, so
 * without this guard a user's own OUTGOING request leaks back onto their feed as
 * an incoming "wants to see your location" card labelled with their own name.
 * Mirrors the `pendingOwnerRequests` predicate in the Location page, plus an
 * explicit sender-≠-recipient check so a self-request never becomes actionable.
 */
export function isIncomingLocationRequestActionable(
  request: OneLocationAccessRequest,
  userId: string,
  nowMs = Date.now(),
): boolean {
  return (
    isLocationRequestPending(request, nowMs) &&
    request.ownerUserId === userId &&
    request.requesterUserId !== userId
  );
}

/**
 * A received share a contact started as an emergency SOS (SMS · Save My Soul)
 * that is still live. These surface as pinned, emergency-styled feed cards so a
 * safety alert is never buried under routine activity. The share point stays
 * end-to-end encrypted; only the emergency intent (`shareKind`) is read here.
 */
export function isActiveSmsEmergencyGrant(grant: OneLocationGrant): boolean {
  return grant.status === "active" && grant.shareKind === "sos";
}

/**
 * Any SOS grant a contact ever sent, live or revoked. Unlike
 * `isActiveSmsEmergencyGrant`, this keeps a revoked/expired SOS in the "Needs
 * you" feed as a historical alert instead of silently dropping it the instant
 * the sender cancels — a safety event must stay visible until the recipient
 * explicitly clears it.
 */
export function isSmsEmergencyGrant(grant: OneLocationGrant): boolean {
  return grant.shareKind === "sos";
}

const SMS_EMERGENCY_DISMISSED_STORAGE_PREFIX = "hushh:feed-sms-dismissed:";

function readDismissedSmsEmergencyIds(userId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(
      `${SMS_EMERGENCY_DISMISSED_STORAGE_PREFIX}${userId}`,
    );
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function writeDismissedSmsEmergencyIds(userId: string, ids: Set<string>): void {
  try {
    window.localStorage.setItem(
      `${SMS_EMERGENCY_DISMISSED_STORAGE_PREFIX}${userId}`,
      JSON.stringify([...ids]),
    );
  } catch {
    // Storage disabled — the dismiss still applies for this session via state.
  }
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

export function useFeedActionables(): UseFeedActionablesResult {
  const router = useRouter();
  const { user } = useAuth();
  const { vaultOwnerToken, getVaultOwnerToken } = useVault();
  const userId = user?.uid ?? null;
  const [dismissedSmsEmergencyIds, setDismissedSmsEmergencyIds] = useState<
    Set<string>
  >(() => new Set());
  const cache = useMemo(() => CacheService.getInstance(), []);
  const consentDecision = useOwnerConsentDecision({ userId });
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
  const [priceTerms, setPriceTerms] = useState<DocumentPriceTerms | null>(
    null,
  );
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
  // recipient explicitly clears them (see the Clear action below); the
  // per-user dismissal set persists to localStorage so it survives refreshes.
  useEffect(() => {
    if (!userId) {
      setDismissedSmsEmergencyIds(new Set());
      return;
    }
    setDismissedSmsEmergencyIds(readDismissedSmsEmergencyIds(userId));
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
      // The notification provider re-announces what it already holds in
      // cache on every route change; that is not a mutation and must not
      // force the consent summary and connections to refetch on each tab
      // switch (same filter as useConsentPendingSummaryCount).
      const detail = (event as CustomEvent<Record<string, unknown>>).detail || {};
      const source = String(detail.source || "").trim();
      if (source === "cached_pending" || source === "queued_pending") return;
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
    cacheKey: userId
      ? CACHE_KEYS.CONSENT_CENTER_SUMMARY(userId, "one:consents")
      : "consent_center_summary_guest",
    refreshKey: `one:consents:${consentTick}`,
    enabled: Boolean(userId),
    // `options.force` is honoured alongside the mutation tick: the consent
    // services keep their own caches, so a live refresh that dropped the flag
    // would re-read the same cached page it was trying to move past.
    load: async (options) => {
      const idToken = await user?.getIdToken();
      if (!user?.uid || !idToken) throw new Error("Sign in to review consents");
      return ConsentCenterService.getSummary({
        idToken,
        userId: user.uid,
        mode: "consents",
        force: consentTick > 0 || Boolean(options?.force),
      });
    },
  });
  const pendingConsentCount =
    consentSummaryResource.data?.counts.pending ?? null;

  const listedPendingCountRef = useRef<number | null>(null);
  const consentListResource = useStaleResource({
    cacheKey: userId
      ? CACHE_KEYS.CONSENT_CENTER_LIST(
          userId,
          "one:consents",
          "pending",
          "",
          1,
          CONSENT_CENTER_PAGE_SIZE,
        )
      : "consent_center_list_guest",
    refreshKey: `one:consents:${consentTick}:${pendingConsentCount ?? "?"}`,
    enabled: Boolean(userId) && (pendingConsentCount ?? 0) > 0,
    load: async (options) => {
      const idToken = await user?.getIdToken();
      if (!user?.uid || !idToken) throw new Error("Sign in to review consents");
      // A new pending count means a request arrived or left: the service's own
      // cached page predates it, so read past it.
      const countChanged = listedPendingCountRef.current !== pendingConsentCount;
      listedPendingCountRef.current = pendingConsentCount;
      return ConsentCenterService.listEntries({
        idToken,
        userId: user.uid,
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
    cacheKey: userId
      ? CACHE_KEYS.CONSENT_CENTER_LIST(userId, "one:consents", "pending", "", 1, progressPageSize)
      : "feed_received_progress_guest",
    refreshKey: `one:consents:progress:${consentTick}:${pendingConsentCount ?? "?"}`,
    enabled: Boolean(userId),
    load: async (options) => {
      const idToken = await user?.getIdToken();
      if (!user?.uid || !idToken) throw new Error("Sign in to view requests");
      return ConsentCenterService.listEntries({
        idToken, userId: user.uid, mode: "consents", surface: "pending",
        page: 1, limit: progressPageSize,
        force: consentTick > 0 || Boolean(options?.force),
      });
    },
  });
  // B's sent requests are absent from A's received count and list. Fetching
  // this lane independently is necessary even when Needs you is empty.
  const sentProgressResource = useStaleResource({
    cacheKey: userId
      ? CACHE_KEYS.CONSENT_CENTER_LIST(userId, "one:consents:sent", "pending", "", 1, progressPageSize)
      : "feed_sent_progress_guest",
    refreshKey: `one:consents:sent:progress:${consentTick}`,
    enabled: Boolean(userId),
    load: async (options) => {
      const idToken = await user?.getIdToken();
      if (!user?.uid || !idToken) throw new Error("Sign in to view requests");
      return ConsentCenterService.listEntries({
        idToken, userId: user.uid, mode: "consents", surface: "pending",
        requestView: "sent", page: 1, limit: progressPageSize,
        force: consentTick > 0 || Boolean(options?.force),
      });
    },
  });
  // A first confirmed file promotes the same pending request into Active for
  // access management. Keep the live status through the remaining background
  // search without changing that bucket or displaying unconfirmed file data.
  const activeProgressResource = useStaleResource({
    cacheKey: userId
      ? CACHE_KEYS.CONSENT_CENTER_LIST(userId, "one:consents", "active", "", 1, progressPageSize)
      : "feed_active_progress_guest",
    refreshKey: `one:consents:active:progress:${consentTick}`,
    enabled: Boolean(userId),
    load: async (options) => {
      const idToken = await user?.getIdToken();
      if (!user?.uid || !idToken) throw new Error("Sign in to view requests");
      return ConsentCenterService.listEntries({
        idToken, userId: user.uid, mode: "consents", surface: "active",
        page: 1, limit: progressPageSize,
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
        if (!isVaultSessionEpochCurrent(epoch) || getVaultOwnerToken() !== token) {
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
    [documentSessionGuard, getVaultOwnerToken, refreshDocumentRequests, settleDocumentRequest],
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
      if (review.allowAvailable !== true) {
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
        purpose: review.purpose.purpose,
        recipientEmail: review.recipientEmail,
        periodStart: review.purpose.periodStart,
        periodEnd: review.purpose.periodEnd,
      });
    },
    [
      documentSessionGuard,
      getVaultOwnerToken,
      refreshDocumentRequests,
      settleDocumentRequest,
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
      if (terms.paymentRequired && !isValidDocumentRequestPriceCents(price)) {
        setPriceError(documentDecisionErrorCopy("invalid_payment_amount"));
        return;
      }
      priceBusyRef.current = true;
      setPriceBusy(true);
      setPriceError(null);
      try {
        await DriveSharingService.allow(
          token,
          target.requestId,
          { revision: terms.revision, amountCents: price },
          documentSessionGuard(token),
        );
      } catch (cause) {
        setPriceError(documentDecisionErrorCopy(decisionErrorCode(cause)));
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
        price === null
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
      purpose: priceTerms?.purpose ?? null,
      recipientEmail: priceTerms?.recipientEmail ?? null,
      periodStart: priceTerms?.periodStart ?? null,
      periodEnd: priceTerms?.periodEnd ?? null,
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
    [priceBusy, priceError, priceOpen, priceTarget, priceTerms, submitDocumentPrice],
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
    userId, vaultOwnerToken, sentPayments.map((payment) => payment.requestId),
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
    for (const row of [...receivedProgress, ...sentProgress, ...activeProgress]) {
      byRequest.set(row.id, row);
    }
    return [...byRequest.values()].sort((a, b) => (b.requestedAt ?? 0) - (a.requestedAt ?? 0));
  }, [receivedProgress, sentProgress, activeProgress]);
  const progressOverflow = useMemo(() => {
    const links: Array<{ label: string; href: string }> = [];
    if (receivedOverflowResource.data?.has_more) {
      links.push({ label: "View all received requests", href: buildConsentCenterHref("pending", { from: "/one/feed" }) });
    }
    if (sentProgressResource.data?.has_more) {
      links.push({ label: "View all sent requests", href: buildConsentCenterHref("pending", { requestView: "sent", from: "/one/feed" }) });
    }
    if (activeProgressResource.data?.has_more) {
      links.push({ label: "View all active requests", href: buildConsentCenterHref("active", { from: "/one/feed" }) });
    }
    return links;
  }, [receivedOverflowResource.data?.has_more, sentProgressResource.data?.has_more, activeProgressResource.data?.has_more]);

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
      () => Promise.all([
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
    useCallback(() => Promise.all([
      receivedOverflowRefresh({ force: true }),
      sentProgressRefresh({ force: true }),
      activeProgressRefresh({ force: true }),
    ]), [receivedOverflowRefresh, sentProgressRefresh, activeProgressRefresh]),
    Boolean(userId) && (inProgress.length > 0 || sentPayments.length > 0),
  );

  // Revoked/expired SOS cards stay in the feed as a historical alert instead
  // of vanishing the moment the sender cancels — but there is nothing left to
  // act on, so only the Feed page's existing Clear button removes them (no
  // separate per-row control). The dismissal set persists to localStorage so
  // a clear survives refreshes.
  const clearableSmsEmergencyIds = useMemo(
    () =>
      (receivedGrants ?? [])
        .filter(
          (grant) =>
            isSmsEmergencyGrant(grant) &&
            !isActiveSmsEmergencyGrant(grant) &&
            !dismissedSmsEmergencyIds.has(grant.id),
        )
        .map((grant) => grant.id),
    [receivedGrants, dismissedSmsEmergencyIds],
  );

  const clearSmsEmergencies = useCallback(() => {
    if (!userId || clearableSmsEmergencyIds.length === 0) return;
    setDismissedSmsEmergencyIds((current) => {
      const next = new Set(current);
      for (const id of clearableSmsEmergencyIds) next.add(id);
      writeDismissedSmsEmergencyIds(userId, next);
      return next;
    });
  }, [userId, clearableSmsEmergencyIds]);

  const actionables = useMemo<FeedActionable[]>(() => {
    if (!userId) return [];
    const items: FeedActionable[] = [];

    for (const payment of sentPayments) {
      const displayPayment = describeFeedDrivePayment(payment, paymentClockNow, paymentContexts[payment.requestId]);
      const paymentIsExpired = displayPayment.status !== "ready";
      const paymentAction = paymentIsExpired
        ? []
        : [
            {
              key: "pay",
              // The order's price: the owner's, or $10 in the Trusted circle.
              label: `Pay ${formatDocumentRequestPrice(payment.amountCents)}`,
              tone: "primary" as const,
              run: async () => {
                try {
                  const idToken = await user?.getIdToken();
                  if (!idToken) throw new Error("Sign in to continue");
                  const checkoutUrl = await DriveRequestPaymentService.checkout(idToken, payment.requestId);
                  window.location.assign(checkoutUrl);
                } catch {
                  toast.error("Checkout couldn't open. Try again.");
                }
              },
            },
          ];
      items.push({
        id: `drive-payment:${payment.requestId}`,
        icon: ConsentAgentIcon,
        iconTone: "capability",
        title: displayPayment.title,
        description: displayPayment.description,
        href: paymentIsExpired ? payment.href : undefined,
        chevron: paymentIsExpired,
        actions: paymentAction,
        sortAt: payment.requestedAt ?? firstSeenAt(`drive-payment:${payment.requestId}`),
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
        if (!isConsentFeedActionable(entry)) continue;
        if (isOwnerConsentQueueEntry(entry)) {
          queueEntries.push(entry);
          continue;
        }
        // A document request from outside the Trusted circle that the server
        // says the owner can answer now gets Deny and Allow inline. Anything
        // else (background access, waiting on payment) keeps its chevron row.
        const documentDecision = ownerDocumentDecision(entry);
        if (documentDecision && settledConsentKeys.has(entry.id)) continue;
        const requesterLabel = resolveConsentRequesterLabel({
          counterpartLabel: entry.counterpart_label,
          counterpartEmail: entry.counterpart_email,
          counterpartSecondaryLabel: entry.counterpart_secondary_label,
          counterpartId: entry.counterpart_id,
        });
        const reviewHref = buildConsentCenterHref("pending", {
          requestId: driveSharingSelectionId(entry),
          from: "/one/feed",
        });
        const entryId = entry.id;
        items.push({
          id: `consent:${entry.id}`,
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
          ...(documentDecision ? { onSelect: () => router.push(reviewHref) } : {}),
          chevron: !documentDecision,
          actions: documentDecision
            ? [
                {
                  key: "deny",
                  label: "Deny",
                  tone: "danger",
                  disabled: !vaultOwnerToken,
                  confirm: true,
                  run: () => declineDocumentRequest(entryId, documentDecision),
                },
                {
                  key: "allow",
                  label: "Allow",
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

    // SMS · Save My Soul emergency alerts — a share a contact started as an
    // SOS. Rendered as pinned, emergency-styled cards at the very top of the
    // feed so a safety alert is never buried under routine activity. A
    // revoked/expired SOS stays as a historical entry ("Revoked") rather than
    // vanishing the moment the sender cancels; the Feed page's existing Clear
    // button (via `clearSmsEmergencies` above) is what removes it — no
    // separate per-row control here.
    const smsEmergencies = (receivedGrants ?? []).filter(
      (grant) =>
        isSmsEmergencyGrant(grant) && !dismissedSmsEmergencyIds.has(grant.id),
    );
    for (const grant of smsEmergencies) {
      const label = grant.ownerDisplayName?.trim() || "A contact";
      const isRevoked = !isActiveSmsEmergencyGrant(grant);
      // A revoked/expired SOS sorts and displays by when it stopped
      // mattering, not when it was triggered — mirrors the
      // `revokedAt || updatedAt || expiresAt` "stopped" convention in
      // lib/one-location/activity.ts, extended with a createdAt fallback so
      // this is never 0/null.
      const resolvedAt = isRevoked
        ? toTimestamp(grant.revokedAt) ||
          toTimestamp(grant.updatedAt) ||
          toTimestamp(grant.expiresAt) ||
          toTimestamp(grant.createdAt)
        : toTimestamp(grant.createdAt);
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
        // Only a still-live alert gets the pinned "Live" emergency treatment.
        // A revoked/expired one renders as a plain "Needs you" row (see
        // feed-page.tsx); the red siren glyph is all that's left as the
        // "this was an emergency" signal.
        emphasis: isRevoked ? undefined : "emergency",
        // "sent an SMS", not "triggered an SOS". SMS is Save my Soul, this
        // product's own name for the lane, and the rule that recipient-facing
        // copy never says "SOS" is already enforced for the notification
        // copy by one-location-sms-revoke-notification.test.ts. This row was
        // saying both at once: an "SOS" title above an "Emergency SMS" body.
        title: `${label} sent an SMS`,
        description: isRevoked
          ? "Emergency SMS - Revoked"
          : "Emergency SMS - Sent.",
        href: buildOneLocationNotificationHref(grant.id),
        chevron: true,
        actions: [],
        sortAt: resolvedAt || firstSeenAt(`sms-emergency:${grant.id}`),
        displayTimestamp: resolvedAt || null,
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
      items.push({
        id: `connection:${request.id}`,
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
        description: request.message?.trim() || "Wants to connect with you.",
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
                        toast.success("Reported. This person can't send you another request.");
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
      });
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
    consentDecision.allow,
    declineConsentRequest,
    declineDocumentRequest,
    openDocumentPrice,
    markConsentSettled,
    settledConsentKeys,
    connectionRequests,
    connectionsRefresh,
    consentItems,
    debateState.tasks,
    dismissedSmsEmergencyIds,
    firstSeenAt,
    locationRequests,
    receivedGrants,
    sentPayments,
    circleMemberInvites,
    locationRefresh,
    openAnalysis,
    pendingConsentCount,
    paymentClockNow,
    paymentContexts,
    router,
    user,
    userId,
    vaultOwnerToken,
  ]);

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
    progressLoading: sentProgressResource.loading || activeProgressResource.loading || receivedOverflowResource.loading,
    progressError: [sentProgressResource.error, activeProgressResource.error, receivedOverflowResource.error].some(Boolean)
      ? "Some request updates couldn't refresh."
      : null,
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
