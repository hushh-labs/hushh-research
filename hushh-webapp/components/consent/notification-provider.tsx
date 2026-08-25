"use client";

/**
 * Consent Notification Provider
 * =============================
 *
 * Reconciles notification-driven state for all platforms (web + native).
 *
 * Architecture:
 * - Initialize FCM when user logs in
 * - FCM push arrives → refresh the durable Feed and owning domain state
 * - One-time fetch on vault unlock to catch requests that arrived while offline
 * - One Location reconciles on resume/focus and at a low-frequency safety interval
 *
 * Product rule:
 * - Routine notifications are Feed-only while the app is active.
 * - The operating system owns routine presentation while the app is inactive.
 * - Hydration and historical reconciliation never create popup UI.
 * - Emergency SMS remains the explicit safety exception and uses the shared
 *   foreground alarm surface without a duplicate iOS/browser banner.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Capacitor } from "@capacitor/core";
import { useVault } from "@/lib/vault/vault-context";
import { type PendingConsent } from "@/lib/consent";
import { ApiService } from "@/lib/services/api-service";
import { useAuth } from "@/hooks/use-auth";
import {
  initializeFCM,
  prepareFCMListeners,
  clearDeliveredConsentNotifications,
  FCM_MESSAGE_EVENT,
  type FCMInitStatus,
} from "@/lib/notifications";
import {
  CacheService,
  CACHE_KEYS,
  CACHE_TTL,
} from "@/lib/services/cache-service";
import {
  CONSENT_STATE_CHANGED_EVENT,
  dispatchConsentStateChanged,
} from "@/lib/consent/consent-events";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { resolveConsentRequesterLabel } from "@/lib/consent/consent-display";
import { parseSSEBlocks } from "@/lib/streaming/sse-parser";
import {
  getSessionItem,
  removeSessionItem,
  setSessionItem,
} from "@/lib/utils/session-storage";
import { ROUTES } from "@/lib/navigation/routes";
import {
  buildOneLocationNotificationHref,
  buildOneLocationWorkflowHref,
  dismissOneLocationShareNotification,
  isOneLocationGrantUnwatched,
  isOneLocationSmsEmergencyAlert,
  locationShareNotificationCopy,
  locationWorkflowNotificationCopy,
  markOneLocationGrantOpened,
  oneLocationSectionForWorkflowNotificationType,
  playOneLocationNotificationSound,
  privacySafeOneLocationNotificationBody,
  privacySafeOneLocationNotificationLabel,
  recordOneLocationShareNotification,
  recordOneLocationWorkflowNotification,
  type OneLocationWorkflowNotificationType,
} from "@/lib/one-location/notifications";
import { OneLocationService } from "@/lib/one-location/service";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import { buildOneLocationNotificationPayloads } from "@/lib/one-location/notification-reconciliation";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import { EmergencySmsNotificationToast } from "@/components/one-location/emergency-sms-notification-toast";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";

// ============================================================================
// Helpers
// ============================================================================

function isTransientFetchFailure(error: unknown): boolean {
  return error instanceof TypeError && /failed to fetch/i.test(error.message);
}

type ConsentOpenAcknowledgementResult =
  | "acknowledged"
  | "retryable_failure"
  | "permanent_failure";

const CONSENT_OPEN_ACK_RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000] as const;

function isRetryableConsentOpenStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Build a PendingConsent object from an FCM data payload.
 * The backend now includes scope, agent_id, and scope_description in the
 * FCM data message so the frontend can render the toast without fetching.
 */
function consentFromFCMPayload(
  data: Record<string, string>,
): PendingConsent | null {
  const requestId = data.request_id;
  if (!requestId) return null;
  return {
    id: requestId,
    developer: resolveConsentRequesterLabel({
      requesterLabel: data.requester_label,
      counterpartLabel: data.counterpart_label,
      developer: data.agent_label,
      counterpartEmail: data.requester_email,
      counterpartSecondaryLabel: data.requester_secondary_label,
      counterpartId: data.requester_entity_id,
      agentId: data.agent_id,
    }),
    developerImageUrl: data.requester_image_url || undefined,
    developerWebsiteUrl: data.requester_website_url || undefined,
    scope: data.scope || "",
    scopeDescription: data.scope_description || undefined,
    requestedAt: Date.now(),
    approvalTimeoutAt: data.approval_timeout_at
      ? Number(data.approval_timeout_at)
      : undefined,
    expiryHours: data.expiry_hours ? Number(data.expiry_hours) : undefined,
    bundleId: data.bundle_id || undefined,
    requestUrl: data.request_url || data.deep_link || undefined,
    reason: data.reason || undefined,
    isScopeUpgrade: data.is_scope_upgrade === "true",
    existingGrantedScopes: data.existing_granted_scopes
      ? String(data.existing_granted_scopes)
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : undefined,
    additionalAccessSummary: data.additional_access_summary || undefined,
  };
}

const pendingConsentRequestByUser = new Map<
  string,
  Promise<PendingConsent[]>
>();

async function loadPendingConsentsOnce(
  userId: string,
  vaultOwnerToken: string,
  options?: { forceRefresh?: boolean },
): Promise<PendingConsent[]> {
  const forceRefresh = Boolean(options?.forceRefresh);
  const cache = CacheService.getInstance();
  const cacheKey = CACHE_KEYS.PENDING_CONSENTS(userId);
  if (!forceRefresh) {
    const cached = cache.get<PendingConsent[]>(cacheKey);
    if (Array.isArray(cached)) return cached;
  }

  const existing = pendingConsentRequestByUser.get(userId);
  if (existing) return existing;

  const request = (async () => {
    const response = await ApiService.getPendingConsents(
      userId,
      vaultOwnerToken,
    );
    if (!response.ok) return [];
    const json = await response.json().catch(() => ({}));
    const pending = Array.isArray(json.pending)
      ? (json.pending as PendingConsent[])
      : [];
    cache.set(cacheKey, pending, CACHE_TTL.MEDIUM);
    return pending;
  })().finally(() => {
    if (pendingConsentRequestByUser.get(userId) === request) {
      pendingConsentRequestByUser.delete(userId);
    }
  });

  pendingConsentRequestByUser.set(userId, request);
  return request;
}

export type ConsentNotificationDeliveryMode =
  "push_active" | "push_blocked" | "push_failed_fallback_active" | "inbox_only";

type ConsentNotificationStateValue = {
  deliveryMode: ConsentNotificationDeliveryMode;
  deliveryDetail: string | null;
  pendingCount: number;
  retryPushRegistration: () => void;
  isRetryingPushRegistration: boolean;
};

type PersistedDeliveryState = {
  status: FCMInitStatus;
  detail: string | null;
  updatedAt: number;
};

const DELIVERY_STATE_SESSION_KEY_PREFIX = "consent_delivery_state";
const QUEUED_PENDING_CONSENTS_SESSION_KEY_PREFIX = "queued_pending_consents";
const REVIEWED_PENDING_CONSENTS_SESSION_KEY_PREFIX =
  "reviewed_pending_consents";

function getDeliveryStateSessionKey(userId: string) {
  return `${DELIVERY_STATE_SESSION_KEY_PREFIX}:${userId}`;
}

function getQueuedPendingConsentsSessionKey(userId: string) {
  return `${QUEUED_PENDING_CONSENTS_SESSION_KEY_PREFIX}:${userId}`;
}

function getReviewedPendingConsentsSessionKey(userId: string) {
  return `${REVIEWED_PENDING_CONSENTS_SESSION_KEY_PREFIX}:${userId}`;
}

function deliveryModeFromInitStatus(
  status: FCMInitStatus,
): ConsentNotificationDeliveryMode {
  if (status === "push_active") return "push_active";
  if (status === "push_not_requested") return "inbox_only";
  if (status === "push_blocked") return "push_blocked";
  return "push_failed_fallback_active";
}

function readPersistedDeliveryState(
  userId: string,
): PersistedDeliveryState | null {
  try {
    const raw = getSessionItem(getDeliveryStateSessionKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedDeliveryState>;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.status !== "string" ||
      typeof parsed.updatedAt !== "number"
    ) {
      return null;
    }
    return {
      status: parsed.status as FCMInitStatus,
      detail: typeof parsed.detail === "string" ? parsed.detail : null,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

function persistDeliveryState(userId: string, state: PersistedDeliveryState) {
  try {
    setSessionItem(getDeliveryStateSessionKey(userId), JSON.stringify(state));
  } catch {
    // Ignore session storage write failures.
  }
}

function clearPersistedDeliveryState(userId: string) {
  try {
    removeSessionItem(getDeliveryStateSessionKey(userId));
  } catch {
    // Ignore session storage cleanup failures.
  }
}

function readQueuedPendingConsents(userId: string): PendingConsent[] {
  try {
    const raw = getSessionItem(getQueuedPendingConsentsSessionKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingConsent[]) : [];
  } catch {
    return [];
  }
}

function writeQueuedPendingConsents(userId: string, pending: PendingConsent[]) {
  try {
    setSessionItem(
      getQueuedPendingConsentsSessionKey(userId),
      JSON.stringify(pending),
    );
  } catch {
    // Ignore session storage write failures.
  }
}

function queuePendingConsent(
  userId: string,
  consent: PendingConsent,
): PendingConsent[] {
  const existing = readQueuedPendingConsents(userId);
  const key = consent.bundleId || consent.id;
  const next = [
    ...existing.filter((item) => (item.bundleId || item.id) !== key),
    consent,
  ];
  writeQueuedPendingConsents(userId, next);
  return next;
}

function removeQueuedPendingConsent(
  userId: string,
  requestId?: string,
  bundleId?: string,
) {
  const next = readQueuedPendingConsents(userId).filter(
    (item) => item.id !== requestId && item.bundleId !== bundleId,
  );
  writeQueuedPendingConsents(userId, next);
  return next;
}

function clearQueuedPendingConsents(userId: string) {
  try {
    removeSessionItem(getQueuedPendingConsentsSessionKey(userId));
  } catch {
    // Ignore session storage cleanup failures.
  }
}

function reviewedConsentKeys(requestId?: string, bundleId?: string): string[] {
  const requestKey = String(requestId || "").trim();
  const bundleKey = String(bundleId || "").trim();
  if (requestKey && bundleKey) {
    return [requestKey, `${bundleKey}::${requestKey}`];
  }
  if (requestKey) {
    return [requestKey];
  }
  if (bundleKey) {
    return [`bundle::${bundleKey}`];
  }
  return [];
}

function markPendingConsentReviewed(
  _userId: string,
  requestId?: string,
  bundleId?: string,
  existing?: Set<string>,
): Set<string> {
  const next = new Set<string>(existing ?? []);
  for (const key of reviewedConsentKeys(requestId, bundleId)) {
    next.add(key);
  }
  return next;
}

function clearReviewedPendingConsents(userId: string) {
  try {
    removeSessionItem(getReviewedPendingConsentsSessionKey(userId));
  } catch {
    // Ignore session storage cleanup failures.
  }
}

function shouldPrioritizeConsentHydration(pathname: string): boolean {
  const normalized = String(pathname || "")
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  return normalized.startsWith("/one/profile") || normalized.startsWith("/ria");
}

function shouldPrioritizeConsentRealtime(pathname: string): boolean {
  const normalized = String(pathname || "")
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  return (
    normalized.startsWith("/agent") ||
    normalized.startsWith(ROUTES.CONSENTS) ||
    normalized.startsWith(ROUTES.LEGACY_CONSENTS) ||
    normalized.startsWith("/one") ||
    normalized.startsWith("/ria")
  );
}

function isConsentWorkspaceRoute(pathname: string): boolean {
  const normalized = String(pathname || "")
    .trim()
    .toLowerCase();
  return (
    normalized.startsWith(ROUTES.CONSENTS) ||
    normalized.startsWith(ROUTES.LEGACY_CONSENTS)
  );
}

function isOneLocationNotificationType(value: unknown): boolean {
  return String(value || "")
    .trim()
    .toLowerCase()
    .startsWith("location_");
}

function isOneLocationWorkflowNotificationType(
  value: unknown,
): value is OneLocationWorkflowNotificationType {
  return (
    value === "location_share_created" ||
    value === "location_access_approved" ||
    value === "location_share_revoked" ||
    value === "location_share_shortened" ||
    value === "location_share_duration_changed" ||
    value === "location_share_expired" ||
    value === "location_access_request" ||
    value === "location_access_denied" ||
    value === "location_access_request_withdrawn" ||
    value === "location_referral_invite" ||
    value === "location_public_invite_submitted" ||
    value === "location_one_network_joined" ||
    value === "location_circle_member_invite" ||
    value === "location_circle_member_invite_accepted" ||
    value === "location_circle_code_joined" ||
    value === "location_circle_member_added"
  );
}

function oneLocationOwnerLabel(data: Record<string, string>): string {
  return privacySafeOneLocationNotificationLabel(
    String(data.owner_display_label || "").trim() ||
      String(data.owner_label || "").trim(),
  );
}

function oneLocationRequesterLabel(data: Record<string, string>): string {
  return privacySafeOneLocationNotificationLabel(
    String(data.requester_display_label || "").trim() ||
      String(data.requester_label || "").trim(),
    "Someone",
  );
}

function oneLocationReferringLabel(data: Record<string, string>): string {
  return privacySafeOneLocationNotificationLabel(
    String(data.referring_display_label || "").trim(),
  );
}

function oneLocationVisitorLabel(data: Record<string, string>): string {
  return privacySafeOneLocationNotificationLabel(
    String(data.visitor_display_label || "").trim() ||
      String(data.visitor_label || "").trim(),
    "Someone",
  );
}

function oneLocationNetworkLabel(data: Record<string, string>): string {
  return privacySafeOneLocationNotificationLabel(
    String(data.network_display_label || "").trim() ||
      String(data.invitee_display_label || "").trim() ||
      String(data.inviter_display_label || "").trim() ||
      // Being added to a Circle names the person who did it. The key differs
      // because nobody was invited here -- and if this ladder cannot see it,
      // the toast says "A trusted person" while the banner beside it says the
      // name, which is the #5422 split all over again.
      String(data.added_by_label || "").trim(),
  );
}

function oneLocationNotificationId(data: Record<string, string>): string {
  const base =
    String(data.grant_id || "").trim() ||
    String(data.approved_grant_id || "").trim() ||
    String(data.request_id || "").trim() ||
    String(data.submission_id || "").trim() ||
    String(data.referral_id || "").trim() ||
    String(data.connection_id || "").trim() ||
    String(data.invite_id || "").trim() ||
    String(data.notification_tag || "").trim();
  // A still-pending request whose ask CHANGED is a new event on the same row.
  // De-dup is keyed by (type, id) and persists in localStorage, so without the
  // revision somebody who asked for an hour and then for four would have the
  // second ask swallowed — and the owner would be left approving the first
  // number, having never been told it moved.
  const revision = String(data.notification_revision || "").trim();
  return base && revision && revision !== "1" ? `${base}#${revision}` : base;
}

/**
 * Format an optional coordinate pair as a human-readable fallback, e.g.
 * "10.7904° N, 78.7047° E". Returns undefined unless both values are finite, so
 * a missing/partial point simply omits the coordinate fallback.
 */
function formatOptionalCoordinates(
  latRaw: unknown,
  lngRaw: unknown,
): string | undefined {
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  const latHemisphere = lat >= 0 ? "N" : "S";
  const lngHemisphere = lng >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(4)}° ${latHemisphere}, ${Math.abs(lng).toFixed(4)}° ${lngHemisphere}`;
}

function oneLocationPayloadRoute(
  data: Record<string, string>,
  fallback: string,
): string {
  const requestedRoute = String(
    data.request_url || data.deep_link || "",
  ).trim();
  if (
    requestedRoute === "/one/location" ||
    requestedRoute.startsWith("/one/location?") ||
    requestedRoute.startsWith("/one/location/")
  ) {
    return requestedRoute;
  }
  return fallback;
}

type OneLocationPresentationOptions = {
  present?: boolean;
  source?: "live" | "reconcile";
};

type QueuedOneLocationNotification = {
  data: Record<string, string>;
  present: boolean;
};

const ConsentNotificationStateContext =
  createContext<ConsentNotificationStateValue>({
    deliveryMode: "inbox_only",
    deliveryDetail: null,
    pendingCount: 0,
    retryPushRegistration: () => {},
    isRetryingPushRegistration: false,
  });

// ============================================================================
// Main Provider
// ============================================================================

export function ConsentNotificationProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const isNativePlatform = Capacitor.isNativePlatform();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const consentRouteRequestId = String(
    searchParams.get("requestId") || "",
  ).trim();
  const consentRouteBundleId = String(
    searchParams.get("bundleId") || "",
  ).trim();
  const notificationRequestId = String(
    searchParams.get("notificationRequestId") || "",
  ).trim();
  const notificationBundleId = String(
    searchParams.get("notificationBundleId") || "",
  ).trim();
  const { isVaultUnlocked, getVaultOwnerToken } = useVault();
  const [pendingCount, setPendingCount] = useState(0);
  const [deliveryMode, setDeliveryMode] =
    useState<ConsentNotificationDeliveryMode>("inbox_only");
  const [deliveryDetail, setDeliveryDetail] = useState<string | null>(null);
  const [fcmInitStatus, setFcmInitStatus] = useState<FCMInitStatus | null>(
    null,
  );
  const [fcmInitGeneration, setFcmInitGeneration] = useState(0);
  const [isRetryingPushRegistration, setIsRetryingPushRegistration] =
    useState(false);
  const { user } = useAuth();
  const lastAuthenticatedUidRef = useRef<string | null>(null);
  // Track which message identities have already been ingested this session.
  const ingestedMessageIdsRef = useRef(new Set<string>());
  const knownPendingConsentIdsRef = useRef(new Set<string>());
  const acknowledgedNotificationOpenIdsRef = useRef(new Set<string>());
  const notificationOpenAcksInFlightRef = useRef(new Set<string>());
  const reviewedIdsRef = useRef(new Set<string>());
  const queuedOneLocationNotificationsRef = useRef<
    QueuedOneLocationNotification[]
  >([]);
  const oneLocationReconcilePromiseRef = useRef<Promise<void> | null>(null);
  const lastOneLocationReconcileWarningRef = useRef(0);
  const consentReconcilePromiseRef = useRef<Promise<void> | null>(null);

  const acknowledgePendingConsent = useCallback(
    async (
      consent: Pick<PendingConsent, "id" | "bundleId">,
      openedVia: "review_button" | "consent_route" | "deep_link",
    ): Promise<ConsentOpenAcknowledgementResult> => {
      if (!user?.uid) return "permanent_failure";
      const next = markPendingConsentReviewed(
        user.uid,
        consent.id,
        consent.bundleId,
        reviewedIdsRef.current,
      );
      reviewedIdsRef.current = next;
      const vaultOwnerToken = getVaultOwnerToken();
      if (!vaultOwnerToken) return "retryable_failure";
      try {
        const response = await ApiService.markPendingConsentOpened({
          userId: user.uid,
          vaultOwnerToken,
          requestId: consent.id,
          bundleId: consent.bundleId,
          openedVia,
        });
        if (response instanceof Response && !response.ok) {
          console.warn(
            `[NotificationProvider] Consent-open acknowledgement failed: ${response.status}`,
          );
          return isRetryableConsentOpenStatus(response.status)
            ? "retryable_failure"
            : "permanent_failure";
        }
        return "acknowledged";
      } catch (error) {
        console.warn(
          "[NotificationProvider] Failed to acknowledge pending consent:",
          error,
        );
        return "retryable_failure";
      } finally {
        if (isNativePlatform) {
          void clearDeliveredConsentNotifications({
            requestId: consent.id,
            bundleId: consent.bundleId,
          });
        }
      }
    },
    [getVaultOwnerToken, isNativePlatform, user?.uid],
  );

  const showOneLocationShareNotification = useCallback(
    (
      data: Record<string, string>,
      options: OneLocationPresentationOptions = {},
    ) => {
      if (!user?.uid) return;
      const grantId = String(data.grant_id || data.grantId || "").trim();
      if (!grantId) return;
      const ownerLabel = oneLocationOwnerLabel(data);
      const created = recordOneLocationShareNotification({
        userId: user.uid,
        grantId,
        ownerLabel,
        expiresAt: data.expires_at,
        durationHours: data.duration_hours,
        shareKind: data.share_kind,
        shareMessage: data.share_message,
      });
      dispatchConsentStateChanged({
        source: "one_location_notification",
        requestId: grantId,
        notificationType: data.type || "location_share_created",
      });
      const isEmergencySms = isOneLocationSmsEmergencyAlert({
        shareKind: data.share_kind,
        notificationProfile: data.notification_profile,
      });
      // Routine notification cards are owned by Feed. The only foreground
      // popup retained here is the safety-critical Save My Soul alarm.
      if (!created || options.present === false || !isEmergencySms) return;

      const toastKey = `one-location-share:${grantId}`;
      const href = oneLocationPayloadRoute(
        data,
        buildOneLocationNotificationHref(grantId),
      );
      const generatedCopy = locationShareNotificationCopy({
        ownerLabel,
        shareKind: data.share_kind,
        shareMessage: data.share_message,
      });
      const title =
        String(data.notification_title || "").trim() || generatedCopy.title;
      const description = privacySafeOneLocationNotificationBody(
        data.notification_body,
        generatedCopy.description,
      );
      // Forward-compatible last-known location for the emergency toast. The
      // share point is end-to-end encrypted, so these are only present when a
      // coarse locality is explicitly attached to the alert; when absent the
      // toast omits the location line entirely (never a broken/pending state).
      const emergencyAddress =
        String(
          data.last_known_address ||
            data.formatted_address ||
            data.share_location_label ||
            "",
        ).trim() || null;
      const emergencyCoordinatesFallback = formatOptionalCoordinates(
        data.share_point_lat,
        data.share_point_lng,
      );
      playOneLocationNotificationSound(data.share_kind);

      toast(
        <EmergencySmsNotificationToast
          title={title}
          description={description}
          address={emergencyAddress}
          coordinatesFallback={emergencyCoordinatesFallback}
          onOpen={() => {
            markOneLocationGrantOpened(user.uid, grantId);
            toast.dismiss(toastKey);
            router.push(href, { scroll: false });
          }}
        />,
        {
          id: toastKey,
          duration: 30000,
          position: "top-center",
          className:
            "one-location-emergency-toast !border-red-500 !bg-red-600 !text-white !shadow-xl !shadow-red-950/25",
        },
      );
    },
    [router, user?.uid],
  );

  const showOneLocationWorkflowNotification = useCallback(
    (
      data: Record<string, string>,
      options: OneLocationPresentationOptions = {},
    ) => {
      if (!user?.uid) return;
      const msgType = data.type;
      if (!isOneLocationWorkflowNotificationType(msgType)) return;

      if (msgType === "location_share_created") {
        showOneLocationShareNotification(data, options);
        return;
      }

      const grantId = String(
        data.grant_id || data.approved_grant_id || "",
      ).trim();
      const requestId = String(data.request_id || "").trim();
      const referralId = String(data.referral_id || "").trim();
      const submissionId = String(data.submission_id || "").trim();
      const connectionId = String(data.connection_id || "").trim();
      const inviteId = String(data.invite_id || "").trim();
      const id = oneLocationNotificationId(data);
      if (!id) return;

      if (
        msgType === "location_share_revoked" ||
        msgType === "location_share_expired"
      ) {
        if (grantId && isOneLocationGrantUnwatched(user.uid, grantId)) {
          return;
        }
        if (grantId) {
          toast.dismiss(`one-location-share:${grantId}`);
          dismissOneLocationShareNotification(grantId);
        }
      }
      if (msgType === "location_access_approved" && grantId) {
        toast.dismiss(`one-location-share:${grantId}`);
        dismissOneLocationShareNotification(grantId);
      }

      const generatedCopy = locationWorkflowNotificationCopy({
        type: msgType,
        ownerLabel: oneLocationOwnerLabel(data),
        requesterLabel: oneLocationRequesterLabel(data),
        referringLabel: oneLocationReferringLabel(data),
        visitorLabel: oneLocationVisitorLabel(data),
        networkLabel: oneLocationNetworkLabel(data),
        // Which Circle they were added to. Only the added-to-a-Circle line
        // uses it; everything else ignores it.
        circleName: data.circle_name || null,
        // How much time the ask is about. Both delivery paths carry these —
        // the FCM payload from the service, and the reconciliation payload
        // built from state — so the popup names the same number the feed and
        // the approvals card do.
        requestedDurationHours: data.requested_duration_hours || null,
        requestedDurationMode: data.requested_duration_mode || null,
        isExtension: String(data.is_extension || "").trim() === "true",
        extendsGrantExpiresAt: data.extends_grant_expires_at || null,
        grantedDurationHours: data.duration_hours || null,
        grantedDurationMode: data.duration_mode || null,
        // Which lane ended. Stamped by the service on the revoke payload,
        // because the grant is gone by the time this arrives -- the client
        // cannot look the kind up from a share that no longer exists.
        shareKind: data.share_kind || null,
      });
      const copy = {
        title:
          String(data.notification_title || "").trim() || generatedCopy.title,
        description: privacySafeOneLocationNotificationBody(
          data.notification_body,
          generatedCopy.description,
        ),
      };
      const routeHref = oneLocationPayloadRoute(
        data,
        buildOneLocationWorkflowHref({
          grantId,
          requestId,
          referralId,
          submissionId,
          // Land the recipient on the section that owns this event - e.g. an
          // access request opens the Inbox "Needs your review" (approvals) section.
          section: oneLocationSectionForWorkflowNotificationType(msgType),
          openGrant: msgType === "location_access_approved",
        }),
      );

      recordOneLocationWorkflowNotification({
        userId: user.uid,
        notificationType: msgType,
        id,
        title: copy.title,
        description: copy.description,
        routeHref,
        metadata: {
          grantId: grantId || null,
          requestId: requestId || null,
          referralId: referralId || null,
          submissionId: submissionId || null,
          connectionId: connectionId || null,
          inviteId: inviteId || null,
        },
      });
      dispatchConsentStateChanged({
        source: "one_location_notification",
        requestId:
          requestId ||
          grantId ||
          referralId ||
          submissionId ||
          connectionId ||
          inviteId,
        notificationType: msgType,
      });
    },
    [showOneLocationShareNotification, user?.uid],
  );

  useEffect(() => {
    if (!user?.uid || queuedOneLocationNotificationsRef.current.length === 0)
      return;
    const queued = queuedOneLocationNotificationsRef.current;
    queuedOneLocationNotificationsRef.current = [];
    for (const notification of queued) {
      const targetUserId = String(notification.data.user_id || "").trim();
      if (targetUserId && targetUserId !== user.uid) continue;
      showOneLocationWorkflowNotification(notification.data, {
        present: notification.present,
        source: "live",
      });
    }
  }, [showOneLocationWorkflowNotification, user?.uid]);

  // Initialize FCM when user logs in (stable dependency: user?.uid).
  // Important: use the authenticated user object from our auth context.
  // This app can sign into a dedicated Firebase auth app, so `getAuth().currentUser`
  // may be null even while `useAuth()` is correctly authenticated.
  const retryPushRegistration = useCallback(() => {
    if (!user) return;
    clearPersistedDeliveryState(user.uid);
    setIsRetryingPushRegistration(true);
    setFcmInitGeneration((current) => current + 1);
  }, [user]);

  useEffect(() => {
    void prepareFCMListeners().catch((error) => {
      console.warn(
        "[NotificationProvider] Push listener setup will retry:",
        error,
      );
    });
  }, []);

  useEffect(() => {
    if (!user) {
      if (lastAuthenticatedUidRef.current) {
        clearPersistedDeliveryState(lastAuthenticatedUidRef.current);
        clearQueuedPendingConsents(lastAuthenticatedUidRef.current);
        clearReviewedPendingConsents(lastAuthenticatedUidRef.current);
      }
      lastAuthenticatedUidRef.current = null;
      ingestedMessageIdsRef.current = new Set<string>();
      knownPendingConsentIdsRef.current = new Set<string>();
      acknowledgedNotificationOpenIdsRef.current = new Set<string>();
      notificationOpenAcksInFlightRef.current = new Set<string>();
      reviewedIdsRef.current = new Set<string>();
      setFcmInitStatus(null);
      setFcmInitGeneration(0);
      setDeliveryMode("inbox_only");
      setDeliveryDetail(null);
      setPendingCount(0);
      setIsRetryingPushRegistration(false);
      return;
    }

    let cancelled = false;
    if (lastAuthenticatedUidRef.current !== user.uid) {
      ingestedMessageIdsRef.current = new Set<string>();
      knownPendingConsentIdsRef.current = new Set<string>();
      acknowledgedNotificationOpenIdsRef.current = new Set<string>();
      notificationOpenAcksInFlightRef.current = new Set<string>();
    }
    lastAuthenticatedUidRef.current = user.uid;
    reviewedIdsRef.current = new Set<string>();

    const run = async () => {
      const shouldRestoreFromSession = fcmInitGeneration === 0;
      if (shouldRestoreFromSession) {
        const persisted = readPersistedDeliveryState(user.uid);
        if (persisted) {
          if (cancelled) return;
          setFcmInitStatus(persisted.status);
          setDeliveryDetail(persisted.detail);
          setDeliveryMode(deliveryModeFromInitStatus(persisted.status));
          console.info(
            "[NotificationProvider] Restored delivery state:",
            persisted,
          );
          console.info(
            "[NotificationProvider] Revalidating FCM delivery state after restore...",
          );
        }
      }

      try {
        const idToken = await user.getIdToken();
        const result = await initializeFCM(user.uid, idToken, {
          requestPermission: fcmInitGeneration > 0,
        });
        if (cancelled) return;

        persistDeliveryState(user.uid, {
          status: result.status,
          detail: result.detail ?? null,
          updatedAt: Date.now(),
        });
        setFcmInitStatus(result.status);
        setDeliveryDetail(result.detail ?? null);
        setDeliveryMode(deliveryModeFromInitStatus(result.status));
        console.info("[NotificationProvider] Delivery init:", result);
      } catch (err) {
        if (cancelled) return;
        const detail = err instanceof Error ? err.message : "fcm_init_failed";
        console.error("[NotificationProvider] FCM initialization failed:", err);
        persistDeliveryState(user.uid, {
          status: "push_failed",
          detail,
          updatedAt: Date.now(),
        });
        setFcmInitStatus("push_failed");
        setDeliveryMode("push_failed_fallback_active");
        setDeliveryDetail(detail);
      } finally {
        if (!cancelled) {
          setIsRetryingPushRegistration(false);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [fcmInitGeneration, user]);

  useEffect(() => {
    if (!user || Capacitor.isNativePlatform()) return;
    const initStatus = fcmInitStatus;
    if (!initStatus || initStatus === "push_active") return;

    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let idleHandle: number | null = null;
    let delayedConnectTimer: ReturnType<typeof setTimeout> | null = null;
    const abortController = new AbortController();
    const prioritizeRealtime = shouldPrioritizeConsentRealtime(pathname);

    if (!prioritizeRealtime) {
      setDeliveryMode(
        initStatus === "push_blocked" ? "push_blocked" : "inbox_only",
      );
      return;
    }

    const connect = async () => {
      try {
        const idToken = await user.getIdToken();
        console.info("[NotificationProvider] Opening consent SSE fallback...");
        const response = await ApiService.apiFetchStream(
          `/api/consent/events/${encodeURIComponent(user.uid)}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${idToken}`,
            },
            signal: abortController.signal,
            cache: "no-store",
          },
        );

        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => "");
          throw new Error(detail || `consent_sse_${response.status}`);
        }

        if (cancelled) return;

        setDeliveryMode(
          initStatus === "push_blocked"
            ? "push_blocked"
            : "push_failed_fallback_active",
        );

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let remainder = "";

        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;
          const parsed = parseSSEBlocks(
            decoder.decode(value, { stream: true }),
            remainder,
          );
          remainder = parsed.remainder;

          for (const frame of parsed.events) {
            if (frame.event !== "consent_update") continue;
            try {
              const payload = JSON.parse(frame.data) as Record<string, string>;
              const normalizedAction = String(payload.action || "")
                .trim()
                .toUpperCase();
              const type =
                payload.type === "connection_request"
                  ? "connection_request"
                  : normalizedAction === "REQUESTED"
                    ? "consent_request"
                    : normalizedAction === "NOTIFICATION_OPENED"
                      ? "consent_opened"
                      : "consent_resolved";
              window.dispatchEvent(
                new CustomEvent(FCM_MESSAGE_EVENT, {
                  detail: {
                    data: {
                      ...payload,
                      type,
                    },
                  },
                }),
              );
            } catch (error) {
              console.warn(
                "[NotificationProvider] Failed to parse SSE payload:",
                error,
              );
            }
          }
        }

        if (!cancelled) {
          throw new Error("consent_sse_stream_closed");
        }
      } catch (error) {
        if (cancelled || abortController.signal.aborted) return;
        console.warn(
          "[NotificationProvider] Consent SSE fallback failed:",
          error,
        );
        setDeliveryMode("inbox_only");
        setDeliveryDetail(
          error instanceof Error ? error.message : "consent_sse_failed",
        );
        reconnectTimer = globalThis.setTimeout(
          () => {
            void connect();
          },
          prioritizeRealtime ? 3000 : 6000,
        );
      }
    };

    if (prioritizeRealtime) {
      void connect();
    } else if (
      typeof window !== "undefined" &&
      "requestIdleCallback" in window
    ) {
      const requestIdle = window.requestIdleCallback as (
        callback: IdleRequestCallback,
        options?: IdleRequestOptions,
      ) => number;
      const cancelIdle = window.cancelIdleCallback as (handle: number) => void;
      idleHandle = requestIdle(
        () => {
          void connect();
        },
        { timeout: 5000 },
      );

      return () => {
        cancelled = true;
        abortController.abort();
        if (reconnectTimer) {
          globalThis.clearTimeout(reconnectTimer);
        }
        if (idleHandle !== null) {
          cancelIdle(idleHandle);
        }
      };
    } else {
      delayedConnectTimer = globalThis.setTimeout(() => {
        void connect();
      }, 3000);
    }

    return () => {
      cancelled = true;
      abortController.abort();
      if (reconnectTimer) {
        globalThis.clearTimeout(reconnectTimer);
      }
      if (delayedConnectTimer) {
        globalThis.clearTimeout(delayedConnectTimer);
      }
    };
  }, [fcmInitStatus, pathname, user]);

  useEffect(() => {
    if (!user || !isVaultUnlocked) return;
    if (pathname !== ROUTES.CONSENTS) return;
    if (!consentRouteRequestId && !consentRouteBundleId) return;
    void acknowledgePendingConsent(
      {
        id: consentRouteRequestId,
        bundleId: consentRouteBundleId || undefined,
      },
      "consent_route",
    );
  }, [
    acknowledgePendingConsent,
    consentRouteBundleId,
    consentRouteRequestId,
    isVaultUnlocked,
    pathname,
    user,
  ]);

  // A system-notification body tap still lands on Feed, but the consent
  // request identity rides along as non-sensitive query metadata. Waiting for
  // vault unlock here preserves cold-start behavior without persisting the
  // memory-only vault key or sending a reminder acknowledgement too early.
  useEffect(() => {
    if (!user || !isVaultUnlocked || pathname !== ROUTES.ONE_FEED) return;
    if (!notificationRequestId && !notificationBundleId) return;
    const acknowledgementId =
      `${user.uid}::${notificationBundleId}::${notificationRequestId}`;
    if (acknowledgedNotificationOpenIdsRef.current.has(acknowledgementId)) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
    let retryIndex = 0;
    let canRetry = true;

    const clearRetryTimer = () => {
      if (retryTimer === null) return;
      globalThis.clearTimeout(retryTimer);
      retryTimer = null;
    };

    const scheduleRetry = (attempt: () => void, delayOverride?: number) => {
      if (
        cancelled ||
        !canRetry ||
        acknowledgedNotificationOpenIdsRef.current.has(acknowledgementId)
      ) {
        return;
      }
      clearRetryTimer();
      const delay =
        delayOverride ??
        CONSENT_OPEN_ACK_RETRY_DELAYS_MS[
          Math.min(retryIndex, CONSENT_OPEN_ACK_RETRY_DELAYS_MS.length - 1)
        ];
      if (delayOverride === undefined) retryIndex += 1;
      retryTimer = globalThis.setTimeout(attempt, delay);
    };

    const attemptAcknowledgement = async () => {
      if (
        cancelled ||
        !canRetry ||
        acknowledgedNotificationOpenIdsRef.current.has(acknowledgementId)
      ) {
        return;
      }
      if (notificationOpenAcksInFlightRef.current.has(acknowledgementId)) {
        scheduleRetry(() => void attemptAcknowledgement(), 250);
        return;
      }

      notificationOpenAcksInFlightRef.current.add(acknowledgementId);
      const result = await acknowledgePendingConsent(
        {
          id: notificationRequestId,
          bundleId: notificationBundleId || undefined,
        },
        "deep_link",
      );
      notificationOpenAcksInFlightRef.current.delete(acknowledgementId);

      if (result === "acknowledged") {
        acknowledgedNotificationOpenIdsRef.current.add(acknowledgementId);
        clearRetryTimer();
        return;
      }
      if (cancelled) return;
      if (result === "permanent_failure") {
        canRetry = false;
        clearRetryTimer();
        return;
      }
      scheduleRetry(() => void attemptAcknowledgement());
    };

    const handleOnline = () => {
      if (!canRetry) return;
      retryIndex = 0;
      clearRetryTimer();
      void attemptAcknowledgement();
    };

    window.addEventListener("online", handleOnline);
    void attemptAcknowledgement();
    return () => {
      cancelled = true;
      clearRetryTimer();
      window.removeEventListener("online", handleOnline);
    };
  }, [
    acknowledgePendingConsent,
    isVaultUnlocked,
    notificationBundleId,
    notificationRequestId,
    pathname,
    user,
  ]);

  useEffect(() => {
    if (!user || isVaultUnlocked) return;
    setPendingCount(readQueuedPendingConsents(user.uid).length);
  }, [isVaultUnlocked, user]);

  // Listen for FCM messages -- extract consent data directly from payload (no HTTP fetch)
  useEffect(() => {
    if (!user) return;

    const handleConsentStateChanged = (event: Event) => {
      const detail =
        (event as CustomEvent<Record<string, unknown>>).detail || {};
      const action = String(detail.action || "")
        .trim()
        .toLowerCase();
      if (action !== "approve" && action !== "deny" && action !== "cancel")
        return;

      const requestId = String(detail.requestId || "").trim();
      const bundleId = String(detail.bundleId || "").trim();
      const next = markPendingConsentReviewed(
        user.uid,
        requestId,
        bundleId,
        reviewedIdsRef.current,
      );
      reviewedIdsRef.current = next;
      if (requestId) knownPendingConsentIdsRef.current.delete(requestId);
      if (requestId || bundleId) {
        toast.dismiss(bundleId || requestId);
        if (Capacitor.isNativePlatform()) {
          void clearDeliveredConsentNotifications({
            requestId,
            bundleId,
          });
        }
      }
    };

    window.addEventListener(
      CONSENT_STATE_CHANGED_EVENT,
      handleConsentStateChanged,
    );
    return () =>
      window.removeEventListener(
        CONSENT_STATE_CHANGED_EVENT,
        handleConsentStateChanged,
      );
  }, [user]);

  useEffect(() => {
    const handleFCMMessage = (event: Event) => {
      const customEvent = event as CustomEvent;
      const detail = customEvent.detail || {};

      // FCM web SDK puts data in detail.data, native in detail.notification.data or detail.data
      const data: Record<string, string> =
        detail.data || detail.notification?.data || {};

      const msgType = data.type;

      if (
        data.user_id &&
        user?.uid &&
        String(data.user_id).trim() !== user.uid
      ) {
        return;
      }

      // Dedup: skip if we've already processed this exact message
      const msgId =
        data.message_id ||
        data.request_id ||
        data.bundle_id ||
        data.grant_id ||
        data.submission_id ||
        data.referral_id ||
        data.connection_id ||
        data.invite_id ||
        data.transfer_id ||
        "";
      const msgVersion =
        data.notification_revision ||
        data.notification_sequence ||
        data.request_revision ||
        "initial";
      const dedupKey = `${msgType}:${msgId}:${msgVersion}`;
      if (msgId && ingestedMessageIdsRef.current.has(dedupKey)) return;
      if (msgId) ingestedMessageIdsRef.current.add(dedupKey);

      // Push is a wake-up signal; Feed remains the only routine in-app
      // presentation surface. This also covers notification families added in
      // the future even when they have no provider-specific branch yet.
      dispatchFeedStateChanged("action");

      if (isOneLocationNotificationType(msgType)) {
        const notification = detail.notification || detail;
        const locationData = {
          ...data,
          notification_title: String(notification.title || "").trim(),
          notification_body: String(notification.body || "").trim(),
        };
        const isEmergencySms = isOneLocationSmsEmergencyAlert({
          shareKind: data.share_kind,
          notificationProfile: data.notification_profile,
        });
        const shouldPresent =
          isEmergencySms &&
          (isNativePlatform ||
            (typeof document !== "undefined" &&
              document.visibilityState === "visible"));
        if (!user?.uid) {
          queuedOneLocationNotificationsRef.current = [
            ...queuedOneLocationNotificationsRef.current.filter(
              (notification) =>
                `${notification.data.type}:${oneLocationNotificationId(notification.data)}` !==
                dedupKey,
            ),
            { data: locationData, present: shouldPresent },
          ].slice(-50);
          return;
        }
        showOneLocationWorkflowNotification(locationData, {
          present: shouldPresent,
          source: "live",
        });
        return;
      }

      if (msgType === "consent_request") {
        const consent = consentFromFCMPayload(data);
        if (!consent) return;
        const isNewPendingRequest =
          !knownPendingConsentIdsRef.current.has(consent.id);
        knownPendingConsentIdsRef.current.add(consent.id);

        // A remote request changes the canonical Consent Center even while its
        // page is open. Invalidate the shared cache and let the page perform
        // one retained-data background refresh; do not wait for a navigation.
        if (user?.uid) {
          CacheSyncService.onConsentMutated(user.uid);
        }

        if (!isVaultUnlocked) {
          if (user?.uid) {
            const queued = queuePendingConsent(user.uid, consent);
            setPendingCount(Math.max(queued.length, 1));
            dispatchConsentStateChanged({
              source: "fcm_queued",
              requestId: consent.id,
              reconcile: true,
            });
          } else {
            setPendingCount((prev) => prev + 1);
            dispatchConsentStateChanged({ source: "fcm_queued" });
          }
          return;
        }

        if (isNewPendingRequest) {
          setPendingCount((prev) => Math.max(prev, 0) + 1);
        }
        dispatchConsentStateChanged({
          source: "fcm_live",
          requestId: consent.id,
          reconcile: true,
        });
      } else if (msgType === "consent_opened") {
        const requestId = data.request_id;
        const bundleId =
          typeof data.bundle_id === "string" ? data.bundle_id : undefined;
        const toastKey = bundleId || requestId;
        if (user?.uid) {
          const next = markPendingConsentReviewed(
            user.uid,
            requestId,
            bundleId,
            reviewedIdsRef.current,
          );
          for (const key of next) {
            reviewedIdsRef.current.add(key);
          }
          removeQueuedPendingConsent(user.uid, requestId, bundleId);
        }
        if (toastKey) {
          toast.dismiss(toastKey);
        }
        if (isNativePlatform) {
          void clearDeliveredConsentNotifications({
            requestId,
            bundleId,
          });
        }
        dispatchConsentStateChanged({
          source: "fcm_opened",
          requestId,
          bundleId,
        });
      } else if (msgType === "consent_resolved") {
        // A consent was resolved (approved/denied/revoked) -- dismiss any matching toast
        const requestId = data.request_id;
        if (requestId) knownPendingConsentIdsRef.current.delete(requestId);
        const toastKey = data.bundle_id || requestId;
        if (user?.uid) {
          CacheSyncService.onConsentMutated(user.uid);
          reviewedIdsRef.current = markPendingConsentReviewed(
            user.uid,
            requestId,
            data.bundle_id,
            reviewedIdsRef.current,
          );
        }
        if (toastKey) {
          toast.dismiss(toastKey);
          setPendingCount((prev) => Math.max(0, prev - 1));
        }
        if (user?.uid) {
          const queued = removeQueuedPendingConsent(
            user.uid,
            requestId,
            data.bundle_id,
          );
          setPendingCount((prev) =>
            Math.max(queued.length, Math.max(0, prev - 1)),
          );
        }
        if (isNativePlatform) {
          void clearDeliveredConsentNotifications({
            requestId,
            bundleId: data.bundle_id,
          });
        }
        dispatchConsentStateChanged({
          source: "fcm_resolved",
          requestId,
          reconcile: true,
        });
      } else if (msgType === "connection_request") {
        // Connection requests follow the same Feed-first foreground policy as
        // every other routine notification. Invalidate the owning data so both
        // Feed and the Consent Center can expose the actionable request.
        if (user?.uid) {
          CacheSyncService.onConsentMutated(user.uid);
        }
        dispatchConsentStateChanged({
          source: "fcm_connection_request",
          reconcile: true,
        });
      }
    };

    window.addEventListener(FCM_MESSAGE_EVENT, handleFCMMessage);
    return () =>
      window.removeEventListener(FCM_MESSAGE_EVENT, handleFCMMessage);
  }, [
    isNativePlatform,
    isVaultUnlocked,
    showOneLocationWorkflowNotification,
    user?.uid,
  ]);

  const reconcileOneLocationNotifications = useCallback(async () => {
    if (!user?.uid || !isVaultUnlocked || !fcmInitStatus) return;
    if (oneLocationReconcilePromiseRef.current) {
      return oneLocationReconcilePromiseRef.current;
    }

    const request = (async () => {
      const vaultOwnerToken = getVaultOwnerToken();
      if (!vaultOwnerToken) return;
      const state = await OneLocationStateResource.load(user.uid, () =>
        OneLocationService.getState(vaultOwnerToken),
      );
      // Location owns a single memory-only server-state resource. Publishing
      // reconciliation results here lets the Location route update instantly
      // from the same push/resume read instead of issuing a second foreground
      // request and briefly falling back to a loader.
      // Reconciliation is a state-repair path, never a presentation source.
      // Historical rows must not become new popup notifications after a fresh
      // install, storage reset, resume, or visibility change.
      const payloads = buildOneLocationNotificationPayloads(state, user.uid, {
        isGrantUnwatched: (grantId) =>
          isOneLocationGrantUnwatched(user.uid, grantId),
      });
      for (const payload of payloads) {
        showOneLocationWorkflowNotification(payload, {
          present: false,
          source: "reconcile",
        });
      }
      dispatchFeedStateChanged("action");
    })()
      .catch((error) => {
        const now = Date.now();
        if (now - lastOneLocationReconcileWarningRef.current >= 60_000) {
          lastOneLocationReconcileWarningRef.current = now;
          console.warn(
            "[NotificationProvider] One Location catch-up failed:",
            error,
          );
        }
      })
      .finally(() => {
        if (oneLocationReconcilePromiseRef.current === request) {
          oneLocationReconcilePromiseRef.current = null;
        }
      });

    oneLocationReconcilePromiseRef.current = request;
    return request;
  }, [
    fcmInitStatus,
    getVaultOwnerToken,
    isVaultUnlocked,
    showOneLocationWorkflowNotification,
    user?.uid,
  ]);

  useEffect(() => {
    if (!user?.uid || !isVaultUnlocked || !fcmInitStatus) return;

    const reconcileWhenVisible = () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      )
        return;
      void reconcileOneLocationNotifications();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") reconcileWhenVisible();
    };

    reconcileWhenVisible();
    window.addEventListener("focus", reconcileWhenVisible);
    window.addEventListener("online", reconcileWhenVisible);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    const removeLifecycleListener =
      appInteractionCoordinator.subscribeLifecycle(() => {
        if (
          appInteractionCoordinator.getLifecycleSnapshot().state === "active"
        ) {
          reconcileWhenVisible();
        }
      });

    const intervalMs = deliveryMode === "push_active" ? 5 * 60_000 : 30_000;
    const intervalId = window.setInterval(reconcileWhenVisible, intervalMs);

    return () => {
      window.removeEventListener("focus", reconcileWhenVisible);
      window.removeEventListener("online", reconcileWhenVisible);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.clearInterval(intervalId);
      removeLifecycleListener();
    };
  }, [
    deliveryMode,
    fcmInitStatus,
    isVaultUnlocked,
    reconcileOneLocationNotifications,
    user?.uid,
  ]);

  // One-time state catch-up on vault unlock. Pending items stay in Feed and the
  // Consent Center; historical hydration never replays popup UI.
  useEffect(() => {
    if (!isVaultUnlocked) return;

    const uid = user?.uid;
    if (!uid) return;

    let cancelled = false;

    const queuedPending = readQueuedPendingConsents(uid);
    // Do not erase a push that arrived between mount and this hydration
    // effect. The authoritative fetch below replaces the set once it returns;
    // until then, merge session/cache evidence with live ingress.
    const knownPendingIds = new Set(knownPendingConsentIdsRef.current);
    for (const consent of queuedPending) {
      if (consent.id) knownPendingIds.add(consent.id);
    }
    knownPendingConsentIdsRef.current = knownPendingIds;
    if (!cancelled && queuedPending.length > 0) {
      setPendingCount((prev) => Math.max(prev, queuedPending.length));
      dispatchConsentStateChanged({ source: "queued_pending" });
    }

    const cachedPending = CacheService.getInstance().peek<PendingConsent[]>(
      CACHE_KEYS.PENDING_CONSENTS(uid),
    );
    const hasCachedPending =
      Array.isArray(cachedPending?.data) && cachedPending.data.length > 0;
    if (!cancelled && Array.isArray(cachedPending?.data)) {
      for (const consent of cachedPending.data) {
        if (consent.id) knownPendingIds.add(consent.id);
      }
      knownPendingConsentIdsRef.current = knownPendingIds;
      setPendingCount(knownPendingIds.size);
      dispatchConsentStateChanged({ source: "cached_pending" });
    }

    const runFetch = async () => {
      try {
        const vaultOwnerToken = getVaultOwnerToken();
        if (!vaultOwnerToken) return;
        const pending = await loadPendingConsentsOnce(uid, vaultOwnerToken, {
          forceRefresh: true,
        });
        if (cancelled) return;
        clearQueuedPendingConsents(uid);
        knownPendingConsentIdsRef.current = new Set(
          pending.map((consent) => consent.id).filter(Boolean),
        );
        setPendingCount(pending.length);
        dispatchConsentStateChanged({ source: "hydrated_pending" });
        dispatchFeedStateChanged("action");
      } catch (err) {
        if (cancelled) return;
        if (isTransientFetchFailure(err)) {
          console.warn("[NotificationProvider] Initial fetch error:", err);
        } else {
          console.error("[NotificationProvider] Initial fetch error:", err);
        }
        if (queuedPending.length > 0) {
          clearQueuedPendingConsents(uid);
        }
      }
    };

    const prioritizeFetch =
      queuedPending.length > 0 || shouldPrioritizeConsentHydration(pathname);
    const shouldFetchInBackground =
      !isConsentWorkspaceRoute(pathname) &&
      (prioritizeFetch || hasCachedPending);

    if (prioritizeFetch && shouldFetchInBackground) {
      void runFetch();
      return () => {
        cancelled = true;
      };
    }

    if (!shouldFetchInBackground) {
      return () => {
        cancelled = true;
      };
    }

    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      const requestIdle = window.requestIdleCallback as (
        callback: IdleRequestCallback,
        options?: IdleRequestOptions,
      ) => number;
      const cancelIdle = window.cancelIdleCallback as (handle: number) => void;
      const handle = requestIdle(
        () => {
          void runFetch();
        },
        { timeout: 4000 },
      );

      return () => {
        cancelled = true;
        cancelIdle(handle);
      };
    }

    const timeoutId = globalThis.setTimeout(() => {
      void runFetch();
    }, 2000);

    return () => {
      cancelled = true;
      globalThis.clearTimeout(timeoutId);
    };
  }, [getVaultOwnerToken, isVaultUnlocked, pathname, user?.uid]);

  // Push is authoritative when it is available. If a browser/device cannot
  // keep that channel, reconcile only while visible at a deliberately bounded
  // cadence. This writes the same memory cache the consent surfaces already
  // render from, so a missed push repairs state without a blocking route load.
  const reconcilePendingConsents = useCallback(async () => {
    if (!user?.uid || !isVaultUnlocked) return;
    if (consentReconcilePromiseRef.current) {
      return consentReconcilePromiseRef.current;
    }
    const request = (async () => {
      const vaultOwnerToken = getVaultOwnerToken();
      if (!vaultOwnerToken) return;
      const pending = await loadPendingConsentsOnce(user.uid, vaultOwnerToken, {
        forceRefresh: true,
      });
      knownPendingConsentIdsRef.current = new Set(
        pending.map((consent) => consent.id).filter(Boolean),
      );
      setPendingCount(pending.length);
      dispatchConsentStateChanged({ source: "fallback_reconciled" });
    })()
      .catch((error) => {
        if (!isTransientFetchFailure(error)) {
          console.warn(
            "[NotificationProvider] Consent fallback reconciliation failed:",
            error,
          );
        }
      })
      .finally(() => {
        if (consentReconcilePromiseRef.current === request) {
          consentReconcilePromiseRef.current = null;
        }
      });
    consentReconcilePromiseRef.current = request;
    return request;
  }, [getVaultOwnerToken, isVaultUnlocked, user?.uid]);

  useEffect(() => {
    if (!user?.uid || !isVaultUnlocked || deliveryMode === "push_active") {
      return;
    }
    const reconcileWhenVisible = () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      ) {
        return;
      }
      void reconcilePendingConsents();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") reconcileWhenVisible();
    };
    window.addEventListener("focus", reconcileWhenVisible);
    window.addEventListener("online", reconcileWhenVisible);
    document.addEventListener("visibilitychange", onVisibilityChange);
    const intervalId = window.setInterval(reconcileWhenVisible, 5 * 60_000);
    return () => {
      window.removeEventListener("focus", reconcileWhenVisible);
      window.removeEventListener("online", reconcileWhenVisible);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.clearInterval(intervalId);
    };
  }, [deliveryMode, isVaultUnlocked, reconcilePendingConsents, user?.uid]);

  return (
    <ConsentNotificationStateContext.Provider
      value={{
        deliveryMode,
        deliveryDetail,
        pendingCount,
        retryPushRegistration,
        isRetryingPushRegistration,
      }}
    >
      {children}
    </ConsentNotificationStateContext.Provider>
  );
}

// ============================================================================
// Pending Count Hook (pure push -- no polling)
// ============================================================================

/**
 * Returns the number of pending consent requests.
 * Count is maintained via FCM push events and the one-time initial fetch.
 * NO interval-based polling.
 */
export function usePendingConsentCount() {
  const context = useContext(ConsentNotificationStateContext);
  return context.pendingCount;
}

export function useConsentNotificationState() {
  return useContext(ConsentNotificationStateContext);
}
