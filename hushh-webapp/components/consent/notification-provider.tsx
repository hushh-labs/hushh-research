"use client";

/**
 * Consent Notification Provider
 * =============================
 *
 * Shows toast notifications for pending consent requests.
 * Uses FCM for all platforms (web + native).
 *
 * Architecture (pure push -- zero polling):
 * - Initialize FCM when user logs in
 * - FCM push arrives → extract consent data from payload → show toast
 * - One-time fetch on vault unlock to catch requests that arrived while offline
 * - NO interval-based polling anywhere
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
import { X } from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { Icon } from "@/lib/morphy-ux/ui";
import { useVault } from "@/lib/vault/vault-context";
import { useConsentActions, type PendingConsent } from "@/lib/consent";
import { ApiService } from "@/lib/services/api-service";
import { useAuth } from "@/hooks/use-auth";
import {
  initializeFCM,
  FCM_MESSAGE_EVENT,
  type FCMInitStatus,
} from "@/lib/notifications";
import { CacheService, CACHE_KEYS, CACHE_TTL } from "@/lib/services/cache-service";
import { resolveConsentNavigationTarget } from "@/lib/consent/consent-sheet-route";
import { dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import { parseSSEBlocks } from "@/lib/streaming/sse-parser";
import {
  getSessionItem,
  removeSessionItem,
  setSessionItem,
} from "@/lib/utils/session-storage";
import { assignWindowLocation } from "@/lib/utils/browser-navigation";
import { ROUTES } from "@/lib/navigation/routes";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Domain icon mapping for consent toasts. Uses emojis since toasts are plain text.
 * Backend-provided scope_description is preferred when available (line ~325).
 */
const DOMAIN_EMOJI: Record<string, string> = {
  financial: "💰",
  subscriptions: "💳",
  health: "❤️",
  travel: "✈️",
  food: "🍕",
  professional: "💼",
  entertainment: "🎬",
  shopping: "🛍️",
  social: "👥",
  location: "📍",
  general: "📋",
};

const formatScope = (scope: string): { label: string; emoji: string } => {
  // Extract domain from attr.{domain}.* pattern
  const attrMatch = scope.match(/^attr\.([a-zA-Z0-9_]+)/);
  if (attrMatch?.[1]) {
    const domain = attrMatch[1];
    const emoji = DOMAIN_EMOJI[domain] ?? "📋";
    const isWildcard = scope.endsWith(".*");
    const label = isWildcard
      ? `${domain.charAt(0).toUpperCase() + domain.slice(1)} Data`
      : scope
          .replace(/^attr\./, "")
          .replace(/\.\*$/, "")
          .replace(/[._]/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase());
    return { label, emoji };
  }

  // Static scopes
  if (scope === "vault.owner") return { label: "Full Vault Access", emoji: "🔐" };
  if (scope === "pkm.read") return { label: "Personal Data", emoji: "📖" };
  if (scope === "pkm.write") return { label: "Write Personal Data", emoji: "✏️" };

  return { label: scope.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), emoji: "📋" };
};

/**
 * Build a PendingConsent object from an FCM data payload.
 * The backend now includes scope, agent_id, and scope_description in the
 * FCM data message so the frontend can render the toast without fetching.
 */
function consentFromFCMPayload(
  data: Record<string, string>
): PendingConsent | null {
  const requestId = data.request_id;
  if (!requestId) return null;
  return {
    id: requestId,
    developer: data.agent_label || data.agent_id || "Unknown Agent",
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

const pendingConsentRequestByUser = new Map<string, Promise<PendingConsent[]>>();

async function loadPendingConsentsOnce(
  userId: string,
  vaultOwnerToken: string
): Promise<PendingConsent[]> {
  const cache = CacheService.getInstance();
  const cacheKey = CACHE_KEYS.PENDING_CONSENTS(userId);
  const cached = cache.get<PendingConsent[]>(cacheKey);
  if (Array.isArray(cached)) return cached;

  const existing = pendingConsentRequestByUser.get(userId);
  if (existing) return existing;

  const request = (async () => {
    const response = await ApiService.getPendingConsents(userId, vaultOwnerToken);
    if (!response.ok) return [];
    const json = await response.json().catch(() => ({}));
    const pending = Array.isArray(json.pending) ? (json.pending as PendingConsent[]) : [];
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
  | "push_active"
  | "push_blocked"
  | "push_failed_fallback_active"
  | "inbox_only";

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

function getDeliveryStateSessionKey(userId: string) {
  return `${DELIVERY_STATE_SESSION_KEY_PREFIX}:${userId}`;
}

function getQueuedPendingConsentsSessionKey(userId: string) {
  return `${QUEUED_PENDING_CONSENTS_SESSION_KEY_PREFIX}:${userId}`;
}

function deliveryModeFromInitStatus(
  status: FCMInitStatus
): ConsentNotificationDeliveryMode {
  if (status === "push_active") return "push_active";
  if (status === "push_blocked") return "push_blocked";
  return "push_failed_fallback_active";
}

function readPersistedDeliveryState(userId: string): PersistedDeliveryState | null {
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
    setSessionItem(getQueuedPendingConsentsSessionKey(userId), JSON.stringify(pending));
  } catch {
    // Ignore session storage write failures.
  }
}

function queuePendingConsent(userId: string, consent: PendingConsent): PendingConsent[] {
  const existing = readQueuedPendingConsents(userId);
  const key = consent.bundleId || consent.id;
  const next = [...existing.filter((item) => (item.bundleId || item.id) !== key), consent];
  writeQueuedPendingConsents(userId, next);
  return next;
}

function removeQueuedPendingConsent(userId: string, requestId?: string, bundleId?: string) {
  const next = readQueuedPendingConsents(userId).filter(
    (item) => item.id !== requestId && item.bundleId !== bundleId
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

function shouldPrioritizeConsentHydration(pathname: string): boolean {
  const normalized = String(pathname || "").trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.startsWith("/profile") ||
    normalized.startsWith("/ria")
  );
}

function shouldPrioritizeConsentRealtime(pathname: string): boolean {
  const normalized = String(pathname || "").trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.startsWith("/consents") ||
    normalized.startsWith("/profile") ||
    normalized.startsWith("/ria")
  );
}

function isConsentWorkspaceRoute(pathname: string): boolean {
  return String(pathname || "").trim().toLowerCase().startsWith("/consents");
}

const ConsentNotificationStateContext = createContext<ConsentNotificationStateValue>({
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
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { isVaultUnlocked, getVaultOwnerToken } = useVault();
  const [pendingCount, setPendingCount] = useState(0);
  const [deliveryMode, setDeliveryMode] =
    useState<ConsentNotificationDeliveryMode>("inbox_only");
  const [deliveryDetail, setDeliveryDetail] = useState<string | null>(null);
  const [fcmInitStatus, setFcmInitStatus] = useState<FCMInitStatus | null>(null);
  const [fcmInitGeneration, setFcmInitGeneration] = useState(0);
  const [isRetryingPushRegistration, setIsRetryingPushRegistration] =
    useState(false);
  const { user } = useAuth();
  const lastAuthenticatedUidRef = useRef<string | null>(null);
  // Track which request IDs we've already toasted this session
  const toastedIdsRef = useRef(new Set<string>());

  // Use the centralized consent actions hook
  const { handleDeny } = useConsentActions({
    userId: user?.uid,
    onActionComplete: () => {
      // Decrement count optimistically after approve/deny
      setPendingCount((prev) => Math.max(0, prev - 1));
    },
  });

  // Show interactive toast for a consent request
  const showConsentToast = useCallback(
    (consent: PendingConsent) => {
      const toastKey = consent.bundleId || consent.id;
      // De-duplicate: don't show the same toast twice in one session
      if (toastedIdsRef.current.has(toastKey)) return;
      toastedIdsRef.current.add(toastKey);

      const { label, emoji } = consent.scopeDescription
        ? { label: consent.scopeDescription, emoji: "📋" }
        : formatScope(consent.scope);
      const isBundle = Boolean(consent.bundleId);
      const currentQuery = searchParams.toString();
      const currentInternalHref = `${pathname}${currentQuery ? `?${currentQuery}` : ""}`;
      const reviewTarget = resolveConsentNavigationTarget(consent.requestUrl, "pending", {
        requestId: consent.id,
        bundleId: consent.bundleId,
        from: currentInternalHref,
      });

      toast(
        <div className="flex flex-col gap-3">
          {/* Header with scope */}
          <div className="flex items-center gap-2">
            <span className="text-lg">{emoji}</span>
            <div>
              <p className="font-semibold text-sm">{consent.developer}</p>
              <p className="text-xs text-muted-foreground">
                {isBundle
                  ? "Requested a bundled portfolio review. Open your consent center to choose durations and approve."
                  : consent.additionalAccessSummary || `Wants access to your ${label}`}
              </p>
              {consent.reason ? (
                <p className="text-xs text-muted-foreground">Reason: {consent.reason}</p>
              ) : null}
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex gap-2 justify-center">
            <button
              onClick={() => {
                toast.dismiss(toastKey);
                if (reviewTarget.kind === "internal") {
                  if (
                    pathname === ROUTES.CONSENTS &&
                    reviewTarget.pathname === ROUTES.CONSENTS
                  ) {
                    router.replace(reviewTarget.href, { scroll: false });
                    return;
                  }
                  router.push(reviewTarget.href, { scroll: false });
                  return;
                }
                assignWindowLocation(reviewTarget.href);
              }}
              className="px-4 py-2 bg-foreground text-background text-sm font-medium rounded-lg flex items-center justify-center gap-1.5 transition-colors"
            >
              Review request
            </button>
            <button
              onClick={() => {
                toast.dismiss(toastKey);
                void handleDeny(consent.id);
              }}
              className="px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 text-sm font-medium rounded-lg flex items-center justify-center gap-1.5 transition-colors dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600"
            >
              <Icon icon={X} size="sm" /> Deny
            </button>
          </div>
        </div>,
        {
          id: toastKey,
          duration: 9000,
          position: "top-center",
        }
      );
    },
    [handleDeny, pathname, router, searchParams]
  );

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
    if (!user) {
      if (lastAuthenticatedUidRef.current) {
        clearPersistedDeliveryState(lastAuthenticatedUidRef.current);
        clearQueuedPendingConsents(lastAuthenticatedUidRef.current);
      }
      lastAuthenticatedUidRef.current = null;
      setFcmInitStatus(null);
      setDeliveryMode("inbox_only");
      setDeliveryDetail(null);
      setPendingCount(0);
      setIsRetryingPushRegistration(false);
      return;
    }

    let cancelled = false;
    lastAuthenticatedUidRef.current = user.uid;

    const run = async () => {
      const shouldRestoreFromSession = fcmInitGeneration === 0;
      if (shouldRestoreFromSession) {
        const persisted = readPersistedDeliveryState(user.uid);
        if (persisted) {
          if (cancelled) return;
          setFcmInitStatus(persisted.status);
          setDeliveryDetail(persisted.detail);
          setDeliveryMode(deliveryModeFromInitStatus(persisted.status));
          console.info("[NotificationProvider] Restored delivery state:", persisted);
          return;
        }
      }

      try {
        const idToken = await user.getIdToken();
        const result = await initializeFCM(user.uid, idToken);
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
      setDeliveryMode(initStatus === "push_blocked" ? "push_blocked" : "inbox_only");
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
          }
        );

        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => "");
          throw new Error(detail || `consent_sse_${response.status}`);
        }

        if (cancelled) return;

        setDeliveryMode(
          initStatus === "push_blocked"
            ? "push_blocked"
            : "push_failed_fallback_active"
        );

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let remainder = "";

        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;
          const parsed = parseSSEBlocks(
            decoder.decode(value, { stream: true }),
            remainder
          );
          remainder = parsed.remainder;

          for (const frame of parsed.events) {
            if (frame.event !== "consent_update") continue;
            try {
              const payload = JSON.parse(frame.data) as Record<string, string>;
              const type =
                payload.action === "REQUESTED"
                  ? "consent_request"
                  : "consent_resolved";
              window.dispatchEvent(
                new CustomEvent(FCM_MESSAGE_EVENT, {
                  detail: {
                    data: {
                      ...payload,
                      type,
                    },
                  },
                })
              );
            } catch (error) {
              console.warn("[NotificationProvider] Failed to parse SSE payload:", error);
            }
          }
        }

        if (!cancelled) {
          throw new Error("consent_sse_stream_closed");
        }
      } catch (error) {
        if (cancelled || abortController.signal.aborted) return;
        console.warn("[NotificationProvider] Consent SSE fallback failed:", error);
        setDeliveryMode("inbox_only");
        setDeliveryDetail(
          error instanceof Error ? error.message : "consent_sse_failed"
        );
        reconnectTimer = globalThis.setTimeout(() => {
          void connect();
        }, prioritizeRealtime ? 3000 : 6000);
      }
    };

    if (prioritizeRealtime) {
      void connect();
    } else if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      const requestIdle = window.requestIdleCallback as (
        callback: IdleRequestCallback,
        options?: IdleRequestOptions
      ) => number;
      const cancelIdle = window.cancelIdleCallback as (handle: number) => void;
      idleHandle = requestIdle(() => {
        void connect();
      }, { timeout: 5000 });

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
    if (!user || isVaultUnlocked) return;
    setPendingCount(readQueuedPendingConsents(user.uid).length);
  }, [isVaultUnlocked, user]);

  // Listen for FCM messages -- extract consent data directly from payload (no HTTP fetch)
  useEffect(() => {
    const handleFCMMessage = (event: Event) => {
      const customEvent = event as CustomEvent;
      const detail = customEvent.detail || {};

      // FCM web SDK puts data in detail.data, native in detail.notification.data or detail.data
      const data: Record<string, string> =
        detail.data || detail.notification?.data || {};

      const msgType = data.type;

      if (msgType === "consent_request") {
        const consent = consentFromFCMPayload(data);
        if (!consent) return;

        if (!isVaultUnlocked) {
          if (user?.uid) {
            const queued = queuePendingConsent(user.uid, consent);
            setPendingCount(Math.max(queued.length, 1));
            dispatchConsentStateChanged({
              source: "fcm_queued",
              requestId: consent.id,
            });
          } else {
            setPendingCount((prev) => prev + 1);
            dispatchConsentStateChanged({ source: "fcm_queued" });
          }
          return;
        }

        setPendingCount((prev) => Math.max(prev, 0) + 1);
        dispatchConsentStateChanged({
          source: "fcm_live",
          requestId: consent.id,
        });
        showConsentToast(consent);
      } else if (msgType === "consent_resolved") {
        // A consent was resolved (approved/denied/revoked) -- dismiss any matching toast
        const requestId = data.request_id;
        const toastKey = data.bundle_id || requestId;
        if (toastKey) {
          toast.dismiss(toastKey);
          toastedIdsRef.current.delete(toastKey);
          setPendingCount((prev) => Math.max(0, prev - 1));
        }
        if (user?.uid) {
          const queued = removeQueuedPendingConsent(user.uid, requestId, data.bundle_id);
          setPendingCount((prev) => Math.max(queued.length, Math.max(0, prev - 1)));
        }
        dispatchConsentStateChanged({
          source: "fcm_resolved",
          requestId,
        });
      }
    };

    window.addEventListener(FCM_MESSAGE_EVENT, handleFCMMessage);
    return () => window.removeEventListener(FCM_MESSAGE_EVENT, handleFCMMessage);
  }, [isVaultUnlocked, showConsentToast, user?.uid]);

  // ONE-TIME fetch on vault unlock to catch requests that arrived while app was closed.
  // This is the ONLY acceptable HTTP call -- not a poll, just a catch-up.
  useEffect(() => {
    if (!isVaultUnlocked) return;

    const uid = user?.uid;
    if (!uid) return;

    let cancelled = false;

    const queuedPending = readQueuedPendingConsents(uid);
    if (!cancelled && queuedPending.length > 0) {
      setPendingCount((prev) => Math.max(prev, queuedPending.length));
      dispatchConsentStateChanged({ source: "queued_pending" });
      queuedPending.forEach((consent) => showConsentToast(consent));
      clearQueuedPendingConsents(uid);
    }

    const cachedPending = CacheService.getInstance().peek<PendingConsent[]>(
      CACHE_KEYS.PENDING_CONSENTS(uid)
    );
    const hasCachedPending = Array.isArray(cachedPending?.data) && cachedPending.data.length > 0;
    if (!cancelled && Array.isArray(cachedPending?.data)) {
      setPendingCount(cachedPending.data.length);
      dispatchConsentStateChanged({ source: "cached_pending" });
      cachedPending.data.forEach((consent) => showConsentToast(consent));
      if (cachedPending.isFresh) {
        return;
      }
    }

    const runFetch = async () => {
      try {
        const vaultOwnerToken = getVaultOwnerToken();
        if (!vaultOwnerToken) return;
        const pending = await loadPendingConsentsOnce(uid, vaultOwnerToken);
        if (cancelled) return;
        setPendingCount(pending.length);
        dispatchConsentStateChanged({ source: "hydrated_pending" });
        pending.forEach((consent) => showConsentToast(consent));
      } catch (err) {
        console.error("[NotificationProvider] Initial fetch error:", err);
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
        options?: IdleRequestOptions
      ) => number;
      const cancelIdle = window.cancelIdleCallback as (handle: number) => void;
      const handle = requestIdle(() => {
        void runFetch();
      }, { timeout: 4000 });

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
  }, [getVaultOwnerToken, isVaultUnlocked, pathname, showConsentToast, user?.uid]);

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
