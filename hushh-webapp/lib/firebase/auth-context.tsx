/**
 * Firebase Auth Context
 * =====================
 *
 * React context provider for Firebase authentication state.
 * Provides user state, loading state, and auth methods.
 *
 * UPDATED FOR NATIVE (Capacitor):
 * - Includes 'vaultKey' and 'isAuthenticated' derived state.
 * - Handles Native Session Restoration on mount.
 * - Exposes 'checkAuth' to manually refreshing state (e.g. after Login).
 * - Clears sensitive data when app is backgrounded.
 */

"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  ReactNode,
  useCallback,
  useRef,
  useSyncExternalStore,
} from "react";
import { User, ConfirmationResult, onAuthStateChanged } from "firebase/auth";
import { auth, prepareRecaptchaVerifier, resetRecaptcha } from "./config";
import { NativeAuthRestoreEpoch } from "./native-auth-restore-epoch";
import { Capacitor } from "@capacitor/core";
import { AuthService } from "@/lib/services/auth-service";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { CACHE_KEYS, CacheService } from "@/lib/services/cache-service";
import { ROUTES } from "@/lib/navigation/routes";
import { OnboardingLocalService } from "@/lib/services/onboarding-local-service";
import {
  setOnboardingFlowActiveCookie,
  setOnboardingRequiredCookie,
} from "@/lib/services/onboarding-route-cookie";
import { UserLocalStateService } from "@/lib/services/user-local-state-service";
import {
  clearSessionStorage,
  removeLocalItem,
} from "@/lib/utils/session-storage";
import { ApiService, type AccountIdentity } from "@/lib/services/api-service";
import { backendPhoneIsMissing, verifiedBackendPhoneNumber } from "@/lib/auth/phone-identity";
import { setObservabilityUserId } from "@/lib/observability/identity";
import { isLocalCrmBuildEnabled } from "@/lib/connected-systems/crm-product-availability";
import {
  completeNativeSessionPrivacyValidation,
  prepareNativeSessionPrivacyValidation,
  nativeProfilePreparationExpected,
  nativeProfilePreparationRevision,
  subscribeNativeProfilePreparation,
  nativeSessionPreparationRevision,
  getNativeSessionPrivacyState,
  subscribeNativeSessionPrivacy,
  type NativeSessionPrivacyState,
} from "@/lib/capacitor/session-privacy";
import {
  AUTH_SESSION_INVALIDATED_EVENT,
  authSessionInvalidationFromSiblingTabStorageEvent,
  authSessionLandingCodeFromBackendPayload,
  authSessionInvalidationCodeFromFirebaseError,
  buildLoginRouteWithAuthSessionNotice,
  dispatchAuthSessionInvalidated,
  isAccountDeletionInProgressBackendPayload,
  isAuthSessionInvalidationCode,
  type AuthSessionInvalidationDetail,
  type AuthSessionInvalidationCode,
} from "@/lib/auth/session-invalidation";
import {
  publishValidatedAuthSessionOwner,
  AUTH_SESSION_VERIFICATION_REQUIRED_EVENT,
  snapshotValidatedAuthSessionOwner,
  getAuthSessionGeneration,
  type AuthSessionVerificationRequiredDetail,
} from "@/lib/auth/session-owner";
import { ACCOUNT_SESSION_VALIDATION_BUDGET_MS } from "@/lib/auth/account-session-policy";
import { shouldSkipAmbientIdentityHydrationForAutomation } from "@/lib/testing/native-test";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";
import { settleSignOutNotifications } from "@/lib/auth/sign-out-notifications";
import { replaceWindowLocation } from "@/lib/utils/browser-navigation";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";

// Pre-compute platform check to avoid dynamic imports in callbacks
const IS_NATIVE = typeof window !== "undefined" && Capacitor.isNativePlatform();
const WEB_AUTH_OBSERVER_WATCHDOG_MS = 10_000;
const SESSION_VERIFICATION_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000] as const;
const PHONE_RECOVERY_RETRY_DELAYS_MS = [2_000, 5_000, 15_000] as const;
const PHONE_RECOVERY_REQUEST_BUDGET_MS = 10_000;
const NATIVE_SESSION_PRIVACY_READ_BUDGET_MS = 2_000;
const ACCOUNT_DELETION_REPROBE_DEFAULT_DELAY_MS = 2_000;
const ACCOUNT_DELETION_REPROBE_MAX_DELAY_MS = 2_000;
const ACCOUNT_SESSION_STATUS_MAX_BODY_BYTES = 4_096;

type AccountSessionValidationResult =
  | { outcome: "active" | "unavailable" }
  | { outcome: "terminal"; code: AuthSessionInvalidationCode };

type AccountSessionStatusInspection =
  | { outcome: "active" }
  | { outcome: "credential_rejected" }
  | { outcome: "unavailable" }
  | { outcome: "deletion_in_progress"; response: Response }
  | {
      outcome: "terminal";
      code: "account_not_found" | "account_deleted" | "session_invalid";
    };

function withinAccountSessionValidationBudget<T>(
  promise: Promise<T>,
  deadlineMs: number,
): Promise<T> {
  const remainingMs = Math.max(0, deadlineMs - Date.now());
  if (remainingMs === 0) {
    return Promise.reject(
      Object.assign(new Error("Account session validation timed out."), {
        name: "TimeoutError",
      }),
    );
  }

  return new Promise<T>((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      reject(
        Object.assign(new Error("Account session validation timed out."), {
          name: "TimeoutError",
        }),
      );
    }, remainingMs);
    promise.then(
      (value) => {
        globalThis.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function hasJsonResponseContentType(response: Response): boolean {
  const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  const mediaType = contentType.split(";", 1)[0]?.trim() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

async function readBoundedAccountSessionStatusBody(
  response: Response,
  deadlineMs: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > ACCOUNT_SESSION_STATUS_MAX_BODY_BYTES
  ) {
    throw new Error("Account session status response is too large.");
  }

  const payload = await withinAccountSessionValidationBudget(
    response.clone().text(),
    deadlineMs,
  );
  if (
    new TextEncoder().encode(payload).byteLength >
    ACCOUNT_SESSION_STATUS_MAX_BODY_BYTES
  ) {
    throw new Error("Account session status response is too large.");
  }
  return payload;
}

function isAuthoritativeActiveSessionPayload(payload: string): boolean {
  try {
    const parsed: unknown = JSON.parse(payload);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as { active?: unknown }).active === true
    );
  } catch {
    return false;
  }
}

async function inspectAccountSessionStatusResponse(
  response: Response,
  deadlineMs: number,
): Promise<AccountSessionStatusInspection> {
  if (response.status === 200) {
    if (!hasJsonResponseContentType(response)) {
      return { outcome: "unavailable" };
    }
    try {
      const payload = await readBoundedAccountSessionStatusBody(
        response,
        deadlineMs,
      );
      return isAuthoritativeActiveSessionPayload(payload)
        ? { outcome: "active" }
        : { outcome: "unavailable" };
    } catch {
      return { outcome: "unavailable" };
    }
  }

  let payload = "";
  try {
    payload = await readBoundedAccountSessionStatusBody(response, deadlineMs);
  } catch {
    // A 423 is exclusive to the session-status lifecycle lock contract. Even
    // if a broken transport prevents reading its body, releasing Vault would
    // be less safe than treating the deletion outcome as unresolved.
    if (response.status === 423) {
      return { outcome: "deletion_in_progress", response };
    }
    return { outcome: "unavailable" };
  }

  if (response.status === 401) {
    const code = authSessionLandingCodeFromBackendPayload(payload);
    return code
      ? { outcome: "terminal", code }
      : { outcome: "credential_rejected" };
  }

  if (
    response.status === 423 &&
    isAccountDeletionInProgressBackendPayload(payload)
  ) {
    return { outcome: "deletion_in_progress", response };
  }

  return { outcome: "unavailable" };
}

function accountDeletionReprobeDelayMs(response: Response): number {
  const retryAfter = response.headers.get("Retry-After");
  const retryAfterSeconds =
    retryAfter === null ? Number.NaN : Number(retryAfter);
  if (
    retryAfter !== "" &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds >= 0
  ) {
    return Math.min(
      retryAfterSeconds * 1_000,
      ACCOUNT_DELETION_REPROBE_MAX_DELAY_MS,
    );
  }
  return ACCOUNT_DELETION_REPROBE_DEFAULT_DELAY_MS;
}

async function waitForAccountDeletionReprobe(
  response: Response,
  deadlineMs: number,
): Promise<void> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 1) {
    throw Object.assign(new Error("Account deletion re-probe timed out."), {
      name: "TimeoutError",
    });
  }

  const delayMs = Math.min(
    accountDeletionReprobeDelayMs(response),
    remainingMs - 1,
  );
  await new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, delayMs);
  });
}

function authInvalidationUserIdFromError(error: unknown): string | null {
  let current: unknown = error;
  const seen = new WeakSet<object>();
  for (let depth = 0; current != null && depth <= 4; depth += 1) {
    if (typeof current !== "object" || seen.has(current)) return null;
    seen.add(current);
    const candidate = current as { userId?: unknown; cause?: unknown };
    const userId = String(candidate.userId || "").trim();
    if (userId) return userId;
    current = candidate.cause;
  }
  return null;
}

function isGmailStartupRoute(): boolean {
  if (typeof window === "undefined") return false;
  const path = window.location.pathname;
  return (
    path.startsWith("/one/gmail") ||
    path.startsWith("/one/setup/gmail") ||
    path.startsWith("/one/email")
  );
}

function runWhenBrowserIsIdle(task: () => void): () => void {
  if (typeof window !== "undefined" && "requestIdleCallback" in window) {
    const requestIdle = window.requestIdleCallback as (
      callback: IdleRequestCallback,
      options?: IdleRequestOptions,
    ) => number;
    const cancelIdle = window.cancelIdleCallback as (handle: number) => void;
    const handle = requestIdle(task, { timeout: 4_000 });
    return () => cancelIdle(handle);
  }
  const timeout = globalThis.setTimeout(task, 1_000);
  return () => globalThis.clearTimeout(timeout);
}

function cachedBackendPhoneIdentity(userId: string): AccountIdentity | null {
  const snapshot = AccountIdentityService.peekCachedIdentity(userId);
  if (!snapshot || snapshot.isStale) return null;
  return verifiedBackendPhoneNumber(snapshot.data, userId) || backendPhoneIsMissing(snapshot.data, userId)
    ? snapshot.data : null;
}

function cachedBackendPhoneIsMissing(userId: string): boolean {
  return backendPhoneIsMissing(cachedBackendPhoneIdentity(userId), userId);
}

// ============================================================================
// Types
// ============================================================================

interface AuthContextType {
  user: User | null;
  loading: boolean;
  /** True when the backend has not authoritatively confirmed this session. */
  sessionVerificationRequired: boolean;
  phoneNumber: string | null;
  phoneNumberStatus: "loading" | "verified" | "missing" | "unavailable";
  /** Resolves only after the verified backend phone lookup has settled. */
  resolveVerifiedPhoneNumber: () => Promise<string | null>;
  // Derived state
  isAuthenticated: boolean;
  userId: string | null;
  // Methods
  startPhoneVerification: (
    phoneNumber: string,
    options?: { resendCode?: boolean },
  ) => Promise<{ autoVerified: boolean; user?: User | null }>;
  confirmPhoneVerification: (otp: string) => Promise<User>;
  startPhoneReplacement: (
    phoneNumber: string,
    options?: { resendCode?: boolean },
  ) => Promise<{ autoVerified: boolean; user?: User | null }>;
  confirmPhoneReplacement: (otp: string) => Promise<User>;
  signOut: (options?: {
    redirectTo?: string;
    /**
     * Limit this sign-out to the identity that initiated a destructive or
     * terminal action. If another tab switches Firebase to a different user
     * before teardown starts, that newer session must remain untouched.
     */
    expectedUserId?: string;
    /**
     * Skip client-side FCM token cleanup (backend unregister + native/web
     * deleteToken). Used by the account-deletion flow, where the backend
     * already destroys the account and its push tokens, so doing the cleanup
     * client-side is redundant work on the critical path the user waits on.
     */
    skipFcmCleanup?: boolean;
  }) => Promise<void>;
  checkAuth: () => Promise<void>; // Manually trigger auth check (e.g. after native login)
  setNativeUser: (user: User | null) => void; // Helper to manually set user state
  beginPostAuthSettlement: (user: User) => number;
  completePostAuthSettlement: (settlementId: number) => void;
  refreshUser: () => Promise<User | null>;
  retrySessionVerification: () => Promise<void>;
}

// ============================================================================
// Context
// ============================================================================

const AuthContext = createContext<AuthContextType | null>(null);

// ============================================================================
// Provider
// ============================================================================

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionVerificationRequired, setSessionVerificationRequired] =
    useState(false);
  const [nativePrivacyReady, setNativePrivacyReady] =
    useState<NativeSessionPrivacyState | null>(null);
  const nativePrivacyLatestRef = useRef<NativeSessionPrivacyState | null>(null);
  const nativeCompositionRevision = useSyncExternalStore(subscribeNativeProfilePreparation, nativeProfilePreparationRevision, () => 0);
  const nativePrivacyReconcileRef = useRef<() => void>(() => undefined);
  const authGateRef = useRef({ loading, sessionVerificationRequired });
  authGateRef.current = { loading, sessionVerificationRequired };
  const [confirmationResult, setConfirmationResult] =
    useState<ConfirmationResult | null>(null);
  const [nativeVerificationId, setNativeVerificationId] = useState<
    string | null
  >(null);
  const [phoneVerificationPhoneNumber, setPhoneVerificationPhoneNumber] =
    useState<string | null>(null);
  const [phoneVerificationAttempt, setPhoneVerificationAttempt] = useState<{
    userId: string;
    epoch: number;
  } | null>(null);
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);
  const [phoneNumberStatus, setPhoneNumberStatusState] = useState<AuthContextType["phoneNumberStatus"]>("loading");
  const phoneNumberStatusRef = useRef(phoneNumberStatus);
  const setPhoneNumberStatus = useCallback((status: AuthContextType["phoneNumberStatus"]) => {
    phoneNumberStatusRef.current = status;
    setPhoneNumberStatusState(status);
  }, []);

  // Hussh state
  const [userId, setUserId] = useState<string | null>(null);

  const userRef = useRef<User | null>(null);
  const phoneNumberRef = useRef<string | null>(null);
  const phoneVerificationOwnerRef = useRef<string | null>(null);
  const phoneVerificationEpochRef = useRef(0);
  const verifiedPhoneResolutionRef = useRef<{
    userId: string;
    generation: number | null;
    lifetime: number;
    promise: Promise<string | null>;
  } | null>(null);
  const authRecoveryInFlightRef = useRef(false);
  const terminalInvalidationLatchRef = useRef<{
    invalidatedUserId: string | null;
    observedAnonymous: boolean;
  } | null>(null);
  const activeSessionValidationPromiseRef = useRef<Promise<void> | null>(null);
  // A web auth observer can validate a new identity while an explicit recovery
  // check for the previously published identity is still settling. Only the
  // current observer may release this gate; otherwise the old Vault can flash
  // before the new identity has been validated and published.
  const webAuthObserverPendingRef = useRef(false);
  const signOutPromiseRef = useRef<Promise<void> | null>(null);
  const signingOutUserIdRef = useRef<string | null>(null);
  // Makes a completed UID-scoped terminal sign-out idempotent. A deleting UI
  // can finish its slower local cleanup after the central invalidation handler
  // has already navigated; its fallback must not replace the reason-bearing
  // login route or show the notice twice.
  const completedScopedSignOutUserIdRef = useRef<string | null>(null);
  const postAuthSettlementEpochRef = useRef(0);
  const signOutEpochRef = useRef(0);
  const activePostAuthSettlementRef = useRef<number | null>(null);
  // Firebase JS commonly emits `null` before the native keychain/provider has
  // finished restoring. Until this flips, native restoration owns the loading
  // state and the JS listener must not publish a false signed-out transition.
  const nativeRestoreSettledRef = useRef(!IS_NATIVE);
  const nativeRestoreEpochRef = useRef(new NativeAuthRestoreEpoch());
  const phoneRecoveryLifetimeRef = useRef(0);
  useEffect(() => {
    phoneRecoveryLifetimeRef.current += 1;
    return () => { phoneRecoveryLifetimeRef.current += 1; };
  }, []);

  const applyAuthUser = useCallback((nextUser: User | null) => {
    if (nextUser && nextUser.uid === signingOutUserIdRef.current) return;
    const terminalLatch = terminalInvalidationLatchRef.current;
    if (nextUser && terminalLatch?.invalidatedUserId === nextUser.uid) {
      // A late observer/native callback from the invalidated auth generation
      // must never republish the deleted identity while sign-out is settling.
      return;
    }
    if (!nextUser && terminalLatch && !terminalLatch.observedAnonymous) {
      terminalInvalidationLatchRef.current = {
        ...terminalLatch,
        observedAnonymous: true,
      };
    } else if (
      nextUser &&
      terminalLatch?.observedAnonymous &&
      (!terminalLatch.invalidatedUserId ||
        nextUser.uid !== terminalLatch.invalidatedUserId)
    ) {
      // Do not reopen the invalidation path merely because sign-out finished.
      // A successfully validated identity published after an observed
      // anonymous state is the only event that starts a new auth generation.
      terminalInvalidationLatchRef.current = null;
    }

    if (userRef.current?.uid !== nextUser?.uid) {
      phoneVerificationOwnerRef.current = null;
      phoneVerificationEpochRef.current += 1;
      setConfirmationResult(null);
      setNativeVerificationId(null);
      setPhoneVerificationPhoneNumber(null);
      setPhoneVerificationAttempt(null);
    }
    const cachedIdentity = nextUser?.uid
      ? AccountIdentityService.peekCachedIdentity(nextUser.uid)
      : null;
    // Web OTP persists its verified claim on the backend while the primary
    // social Firebase user remains phone-less. Publish that committed claim
    // even when Firebase republishes the same user object after verification.
    const cachedPhone = cachedIdentity?.isStale
      ? null
      : verifiedBackendPhoneNumber(cachedIdentity?.data, nextUser?.uid);
    // A provider refresh or expired view cache is not a phone removal event.
    const retainedPhone = nextUser?.uid === userRef.current?.uid ? phoneNumberRef.current : null;
    const confirmedMissing = Boolean(cachedIdentity && !cachedIdentity.isStale &&
      backendPhoneIsMissing(cachedIdentity.data, nextUser?.uid)) ||
      (Boolean(nextUser) && nextUser?.uid === userRef.current?.uid && phoneNumberStatusRef.current === "missing");
    const nextPhoneNumber = cachedPhone || (confirmedMissing ? null : retainedPhone || nextUser?.phoneNumber) || null;
    if (nextUser) {
      completedScopedSignOutUserIdRef.current = null;
    }
    userRef.current = nextUser;
    publishValidatedAuthSessionOwner(nextUser?.uid ?? null);
    if (!nextUser) {
      setSessionVerificationRequired(false);
    }
    phoneNumberRef.current = nextPhoneNumber;
    setUser(nextUser);
    setUserId(nextUser?.uid ?? null);
    setPhoneNumber(nextPhoneNumber);
    setPhoneNumberStatus(nextPhoneNumber ? "verified" : !nextUser || confirmedMissing ? "missing" : "loading");
    // Binds the cross-surface analytics identity (a salted digest, never the
    // UID) so web, iOS and Android resolve to one user in GA4. Deliberately
    // not awaited: analytics identity must never sit on the auth critical path.
    void setObservabilityUserId(nextUser?.uid ?? null);
    if (nextUser?.uid && isLocalCrmBuildEnabled()) {
      const hydrateConnectedSystems = () => {
        void import("@/lib/services/connected-systems-resource-service")
          .then(async ({ ConnectedSystemsResourceService }) => {
            await ConnectedSystemsResourceService.hydrateRegistry(nextUser.uid);
            const authToken = await nextUser.getIdToken().catch(() => null);
            if (!authToken || userRef.current?.uid !== nextUser.uid) return;
            await ConnectedSystemsResourceService.loadRegistry({
              userId: nextUser.uid,
              authToken,
            });
          })
          .catch(() => undefined);
      };
      if (isGmailStartupRoute()) {
        runWhenBrowserIsIdle(hydrateConnectedSystems);
      } else {
        hydrateConnectedSystems();
      }
    }
  }, [setPhoneNumberStatus]);

  const resolveVerifiedPhoneNumber = useCallback(async (): Promise<
    string | null
  > => {
    const currentUser = userRef.current;
    if (!currentUser?.uid) return null;
    const generation = getAuthSessionGeneration();
    const lifetime = phoneRecoveryLifetimeRef.current;
    const isCurrent = () => userRef.current?.uid === currentUser.uid &&
      generation === getAuthSessionGeneration() && lifetime === phoneRecoveryLifetimeRef.current;

    const cachedIdentity = AccountIdentityService.peekCachedIdentity(
      currentUser.uid,
    );
    const cachedPhone = cachedIdentity?.isStale
      ? null
      : verifiedBackendPhoneNumber(cachedIdentity?.data, currentUser.uid);
    if (cachedPhone) {
      phoneNumberRef.current = cachedPhone;
      setPhoneNumber(cachedPhone);
      setPhoneNumberStatus("verified");
      return cachedPhone;
    }
    if (cachedBackendPhoneIsMissing(currentUser.uid)) {
      phoneNumberRef.current = null;
      setPhoneNumber(null);
      setPhoneNumberStatus("missing");
    }
    // A real binding transfer can revoke this account's app phone while its
    // native provider still carries the old number. Do not resurrect it.
    const existingPhone = phoneNumberStatusRef.current === "missing" ? "" : String(
      phoneNumberRef.current ?? currentUser.phoneNumber ?? "",
    ).trim();
    if (existingPhone) return existingPhone;

    const inFlight = verifiedPhoneResolutionRef.current;
    if (inFlight?.userId === currentUser.uid && inFlight.generation === generation && inFlight.lifetime === lifetime) {
      return inFlight.promise;
    }

    // Returning from Messages must not replace an active OTP editor with a
    // loading/error panel. A verified positive claim may still complete it.
    const hasActivePhoneAttempt = () => phoneVerificationOwnerRef.current === currentUser.uid;
    if (!hasActivePhoneAttempt() && phoneNumberStatusRef.current !== "missing") setPhoneNumberStatus("loading");
    const promise = (async () => {
      // A non-forced read can legally return a fresh but phone-incomplete
      // shadow. Contact normalization needs an authoritative region, so this
      // missing-phone path must consult Firebase even when that cache is fresh.
      const identity = await withinAccountSessionValidationBudget(
        AccountIdentityService.refreshCurrentUserIdentity(
          currentUser,
          { force: true },
        ),
        Date.now() + PHONE_RECOVERY_REQUEST_BUDGET_MS,
      );
      if (!isCurrent()) return null;

      // A newer claim can publish after this read returns but before the
      // awaiting consumer resumes. Preserve that canonical phone evidence.
      const phoneIdentity = cachedBackendPhoneIdentity(currentUser.uid) ?? identity;
      const backendPhone = verifiedBackendPhoneNumber(phoneIdentity, currentUser.uid);
      if (backendPhone) {
        phoneNumberRef.current = backendPhone;
        setPhoneNumber(backendPhone);
        setPhoneNumberStatus("verified");
      } else if (backendPhoneIsMissing(phoneIdentity, currentUser.uid)) {
        phoneNumberRef.current = null;
        setPhoneNumber(null);
        setPhoneNumberStatus("missing");
      } else if (!phoneNumberRef.current && !hasActivePhoneAttempt()) {
        setPhoneNumberStatus(phoneNumberStatusRef.current === "missing"
          ? "missing" : "unavailable");
      }
      return backendPhone || phoneNumberRef.current;
    })();
    verifiedPhoneResolutionRef.current = {
      userId: currentUser.uid,
      generation,
      lifetime,
      promise,
    };
    try {
      return await promise;
    } catch (error) {
      if (isCurrent() && !phoneNumberRef.current && !hasActivePhoneAttempt()) {
        setPhoneNumberStatus(cachedBackendPhoneIsMissing(currentUser.uid) || phoneNumberStatusRef.current === "missing"
          ? "missing" : "unavailable");
      }
      throw error;
    } finally {
      if (verifiedPhoneResolutionRef.current?.promise === promise) {
        verifiedPhoneResolutionRef.current = null;
      }
    }
  }, [setPhoneNumberStatus]);

  useEffect(() => {
    if (!user || shouldSkipAmbientIdentityHydrationForAutomation()) return;
    const expectedUid = user.uid;
    const generation = getAuthSessionGeneration();
    let disposed = false;
    let running = false;
    let retry = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const isCurrent = () => !disposed && userRef.current?.uid === expectedUid &&
      getAuthSessionGeneration() === generation;
    const canReachBackend = () => document.visibilityState === "visible" && navigator.onLine !== false &&
      appInteractionCoordinator.getLifecycleSnapshot().state === "active";
    const clearRetry = () => {
      if (retryTimer !== null) globalThis.clearTimeout(retryTimer);
      retryTimer = null;
    };
    const freshIdentity = () => cachedBackendPhoneIdentity(expectedUid);
    const hasFreshPhoneEvidence = () => {
      const identity = freshIdentity();
      return Boolean(verifiedBackendPhoneNumber(identity, expectedUid) || backendPhoneIsMissing(identity, expectedUid));
    };
    const applyPhoneIdentity = (identity: AccountIdentity | null | undefined) => {
      if (!isCurrent()) return false;
      const verifiedPhone = verifiedBackendPhoneNumber(identity, expectedUid);
      if (verifiedPhone) {
        phoneNumberRef.current = verifiedPhone;
        setPhoneNumber(verifiedPhone);
        setPhoneNumberStatus("verified");
      } else if (backendPhoneIsMissing(identity, expectedUid)) {
        phoneNumberRef.current = null;
        setPhoneNumber(null);
        setPhoneNumberStatus("missing");
      } else return false;
      clearRetry();
      return true;
    };
    const recover = async () => {
      if (!isCurrent() || running || !canReachBackend()) return;
      if (applyPhoneIdentity(freshIdentity())) return;
      clearRetry();
      running = true;
      try {
        if (phoneNumberRef.current) {
          // A restored SDK number can be older than the durable app claim.
          // Revalidate stale/missing canonical evidence in the background,
          // retaining the displayed number if the request is unavailable.
          const identity = await withinAccountSessionValidationBudget(
            AccountIdentityService.refreshCurrentUserIdentity(user, { force: true }),
            Date.now() + PHONE_RECOVERY_REQUEST_BUDGET_MS,
          );
          applyPhoneIdentity(freshIdentity() ?? identity);
        } else await resolveVerifiedPhoneNumber();
      } catch { /* Availability stays retryable. */ }
      finally { running = false; }
      if (!isCurrent() || retry >= PHONE_RECOVERY_RETRY_DELAYS_MS.length || hasFreshPhoneEvidence()) return;
      const delay = PHONE_RECOVERY_RETRY_DELAYS_MS[retry++];
      retryTimer = globalThis.setTimeout(() => { retryTimer = null; void recover(); }, delay);
    };
    const wake = () => {
      if (!canReachBackend()) return;
      // A burst of foreground/online signals shares one recovery episode.
      if (running) return;
      clearRetry();
      if (retry >= PHONE_RECOVERY_RETRY_DELAYS_MS.length) retry = 0;
      void recover();
    };
    const cache = CacheService.getInstance();
    const unsubscribe = cache.subscribe((event) => {
      if (!isCurrent() || event.type !== "set" || event.key !== CACHE_KEYS.ACCOUNT_IDENTITY(expectedUid)) return;
      applyPhoneIdentity(freshIdentity());
    });
    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    const unsubscribeLifecycle = appInteractionCoordinator.subscribeLifecycle(() => {
      if (canReachBackend()) wake();
      else clearRetry();
    });
    const cancelIdle = isGmailStartupRoute() ? runWhenBrowserIsIdle(wake) : null;
    if (!cancelIdle) void recover();
    return () => {
      disposed = true;
      clearRetry();
      cancelIdle?.();
      unsubscribe();
      unsubscribeLifecycle();
      window.removeEventListener("online", wake);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [resolveVerifiedPhoneNumber, setPhoneNumberStatus, user]);

  const refreshUser = useCallback(async (): Promise<User | null> => {
    if (Capacitor.isNativePlatform()) {
      const restoreEpoch = nativeRestoreEpochRef.current.begin();
      nativeRestoreSettledRef.current = false;
      try {
        const nativeUser = await AuthService.restoreNativeSession();
        if (!nativeRestoreEpochRef.current.isCurrent(restoreEpoch)) {
          return userRef.current;
        }
        applyAuthUser(nativeUser);
        return nativeUser;
      } finally {
        if (nativeRestoreEpochRef.current.isCurrent(restoreEpoch)) {
          nativeRestoreSettledRef.current = true;
          setLoading(false);
        }
      }
    }

    const currentUser = auth.currentUser;
    if (currentUser) {
      await currentUser.reload().catch(() => undefined);
    }
    const refreshedUser = auth.currentUser;
    applyAuthUser(refreshedUser);
    setLoading(false);
    return refreshedUser;
  }, [applyAuthUser]);

  /**
   * Ask the backend to validate the currently cached Firebase token before
   * falling back to a forced SDK refresh. This ordering matters: Firebase's
   * client SDK maps a remotely deleted user to the generic
   * `auth/user-token-expired` error, while the backend can distinguish the
   * durable account-deletion tombstone and return AUTH_ACCOUNT_NOT_FOUND.
   */
  const validateAccountSession = useCallback(
    async (candidateUser: User): Promise<AccountSessionValidationResult> => {
      const deadlineMs = Date.now() + ACCOUNT_SESSION_VALIDATION_BUDGET_MS;
      let cachedToken: string | null = null;

      const resolveDeletionInProgress = async (
        idToken: string,
        response: Response,
      ): Promise<AccountSessionValidationResult> => {
        try {
          // The backend waited on the deletion transaction before returning
          // 423. Honor its bounded Retry-After once, while the auth/native
          // privacy gates stay closed, then require an authoritative result.
          // Never spin or auto-retry the destructive DELETE request itself.
          await waitForAccountDeletionReprobe(response, deadlineMs);
          const retryResponse = await withinAccountSessionValidationBudget(
            ApiService.getAccountSessionStatus(idToken),
            deadlineMs,
          );
          const retryInspection = await inspectAccountSessionStatusResponse(
            retryResponse,
            deadlineMs,
          );
          if (retryInspection.outcome === "active") {
            // The deletion transaction rolled back; the still-live session is
            // safe to retain.
            return { outcome: "active" };
          }
          if (retryInspection.outcome === "terminal") {
            return retryInspection;
          }
        } catch {
          // Once the backend proves deletion is underway, a timeout, network
          // loss, or unreadable follow-up is an uncertain destructive outcome
          // and must never reopen cached authenticated UI.
        }
        return { outcome: "terminal", code: "account_deletion_uncertain" };
      };

      try {
        cachedToken = await withinAccountSessionValidationBudget(
          candidateUser.getIdToken(false),
          deadlineMs,
        );
      } catch (error) {
        const code = authSessionInvalidationCodeFromFirebaseError(error);
        if (code) {
          return { outcome: "terminal", code };
        }
      }

      if (cachedToken) {
        try {
          const response = await withinAccountSessionValidationBudget(
            ApiService.getAccountSessionStatus(cachedToken),
            deadlineMs,
          );
          const inspection = await inspectAccountSessionStatusResponse(
            response,
            deadlineMs,
          );
          if (inspection.outcome === "active") return inspection;
          if (inspection.outcome === "terminal") return inspection;
          if (inspection.outcome === "deletion_in_progress") {
            return resolveDeletionInProgress(cachedToken, inspection.response);
          }
          if (inspection.outcome === "credential_rejected") {
            // A cached token can be stale for benign reasons. Revalidate it
            // through Firebase, then ask the backend once more before making a
            // terminal decision.
          } else {
            // Retrying the same unavailable endpoint with a fresh token cannot
            // establish account liveness and doubles load during an outage. Keep
            // the privacy gate closed and let the bounded recovery loop retry.
            return { outcome: "unavailable" };
          }
        } catch {
          // A transport/backend outage is not evidence of deletion, and a
          // Firebase refresh is not a substitute for the deletion tombstone
          // contract. Preserve identity while keeping protected UI sealed.
          return { outcome: "unavailable" };
        }
      }

      try {
        // Refresh through the exact identity being validated. Native and web
        // Firebase persistence can briefly disagree during restoration; using
        // the global auth singleton here could otherwise validate candidate B
        // with a stale token belonging to account A.
        const refreshedToken = await withinAccountSessionValidationBudget(
          candidateUser.getIdToken(true),
          deadlineMs,
        );
        if (refreshedToken) {
          try {
            const response = await withinAccountSessionValidationBudget(
              ApiService.getAccountSessionStatus(refreshedToken),
              deadlineMs,
            );
            const inspection = await inspectAccountSessionStatusResponse(
              response,
              deadlineMs,
            );
            if (inspection.outcome === "active") return inspection;
            if (inspection.outcome === "terminal") return inspection;
            if (inspection.outcome === "deletion_in_progress") {
              return resolveDeletionInProgress(
                refreshedToken,
                inspection.response,
              );
            }
            if (inspection.outcome === "credential_rejected") {
              return { outcome: "terminal", code: "session_invalid" };
            }
            return { outcome: "unavailable" };
          } catch {
            return { outcome: "unavailable" };
          }
        }
      } catch (error) {
        const code = authSessionInvalidationCodeFromFirebaseError(error);
        if (code) {
          return { outcome: "terminal", code };
        }
        return { outcome: "unavailable" };
      }

      // An untyped empty result is deliberately non-terminal. Native bridges
      // reject forced-empty results with a typed invalid-session code; keeping
      // this fallback conservative prevents a transient SDK-settlement gap
      // from being misreported as account deletion.
      return { outcome: "unavailable" };
    },
    [],
  );

  /**
   * Core Auth Check Logic
   * Handles both Native Restoration and Web Firebase auth
   *
   * IMPORTANT: This function MUST call setLoading(false) in ALL code paths
   * to prevent VaultLockGuard from getting stuck.
   */
  const checkAuth = useCallback(async () => {
    // Native lifecycle callbacks can arrive while an Apple credential is
    // settling or while sign-out is clearing the native keychain. Neither
    // window may start an independent restore that can republish stale state.
    if (
      signOutPromiseRef.current ||
      activePostAuthSettlementRef.current !== null
    ) {
      return;
    }

    // 1. Native Session Restoration
    if (Capacitor.isNativePlatform()) {
      const restoreEpoch = nativeRestoreEpochRef.current.begin();
      nativeRestoreSettledRef.current = false;
      let terminalInvalidationDispatched = false;
      try {
        // Native bridges can lose a callback during restoration. Bound the
        // complete read; a late result must never publish into this attempt.
        const nativeUser = await withinAccountSessionValidationBudget(
          AuthService.restoreNativeSession(),
          Date.now() + ACCOUNT_SESSION_VALIDATION_BUDGET_MS,
        );

        if (!nativeRestoreEpochRef.current.isCurrent(restoreEpoch)) {
          return;
        }

        if (nativeUser) {
          console.log("🍎 [AuthProvider] Native session restored");
          const validation = await validateAccountSession(nativeUser);
          if (!nativeRestoreEpochRef.current.isCurrent(restoreEpoch)) {
            return;
          }
          if (validation.outcome === "terminal") {
            terminalInvalidationDispatched = true;
            dispatchAuthSessionInvalidated({
              code: validation.code,
              path: "native_restore",
              userId: nativeUser.uid,
            });
            return;
          }
          if (validation.outcome === "unavailable") {
            console.warn(
              "🍎 [AuthProvider] Native session validation unavailable",
            );
            setSessionVerificationRequired(true);
          } else {
            setSessionVerificationRequired(false);
          }
          applyAuthUser(nativeUser);
        } else {
          console.log("🍎 [AuthProvider] No native session found");
          setSessionVerificationRequired(false);
          applyAuthUser(null);
        }
      } catch (_error) {
        if (!nativeRestoreEpochRef.current.isCurrent(restoreEpoch)) {
          return;
        }
        const code = authSessionInvalidationCodeFromFirebaseError(_error);
        const invalidatedUserId = authInvalidationUserIdFromError(_error);
        if (code && invalidatedUserId) {
          terminalInvalidationDispatched = true;
          dispatchAuthSessionInvalidated({
            code,
            path: "native_restore",
            userId: invalidatedUserId,
          });
          return;
        }
        console.warn("🍎 [AuthProvider] Native restore error");
        // A failed read is not proof of sign-out. Keep any known owner hidden
        // behind recovery, including when cold launch has not read a UID yet.
        setSessionVerificationRequired(true);
      } finally {
        if (!nativeRestoreEpochRef.current.isCurrent(restoreEpoch)) {
          return;
        }
        nativeRestoreSettledRef.current = true;
        // ✅ CRITICAL: Always set loading to false after native check
        // This ensures VaultLockGuard can proceed (to login or vault unlock)
        if (!terminalInvalidationDispatched) {
          setLoading(false);
        }
      }
      return; // Exit early for native - don't wait for onAuthStateChanged
    }

    // Web restoration is owned by onAuthStateChanged below. Its watchdog is
    // scoped to that initial observer subscription so it can never release a
    // later explicit-verification or sign-out loading gate.
  }, [applyAuthUser, validateAccountSession]);

  // Keep ref in sync with state
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  // Sign out
  const signOut = useCallback(
    async (options?: {
      redirectTo?: string;
      skipFcmCleanup?: boolean;
      expectedUserId?: string;
    }): Promise<void> => {
      const expectedUserId =
        String(options?.expectedUserId || "").trim() || null;
      const stillOwnsExpectedSession = (): boolean => {
        if (!expectedUserId) return true;

        const publishedUserId = userRef.current?.uid ?? null;
        if (publishedUserId && publishedUserId !== expectedUserId) return false;

        // The Firebase JS identity changes before our validated React identity is
        // published. Treat that as an ownership loss on web, but do not consult
        // it on native where the native bridge is the publication authority.
        if (!IS_NATIVE) {
          const firebaseUserId = AuthService.getCurrentUser()?.uid ?? null;
          if (firebaseUserId && firebaseUserId !== expectedUserId) return false;
        }
        return true;
      };

      // Check identity ownership before joining an existing operation. A stale
      // account-A deletion callback must never hitch a ride on, or interfere
      // with, a sign-out that belongs to account B.
      if (!stillOwnsExpectedSession()) return;
      if (
        expectedUserId &&
        completedScopedSignOutUserIdRef.current === expectedUserId
      ) {
        return;
      }
      if (signOutPromiseRef.current) {
        return signOutPromiseRef.current;
      }

      let terminalNavigationCommitted = false;
      const operation = (async () => {
        // A restore or post-auth settlement that began before sign-out must
        // never repopulate auth state. Keep the sign-out barrier active through
        // the terminal navigation below.
        nativeRestoreEpochRef.current.invalidate();
        nativeRestoreSettledRef.current = true;
        postAuthSettlementEpochRef.current += 1;
        signOutEpochRef.current += 1;
        activePostAuthSettlementRef.current = null;
        const currentUser = userRef.current;
        // A terminal native cold-restore event is dispatched before the restored
        // user is published. Retain that exact UID in the invalidation latch so
        // its local vault/cache state is still destroyed during sign-out.
        const currentUid =
          currentUser?.uid ??
          terminalInvalidationLatchRef.current?.invalidatedUserId ??
          null;
        const redirectTo = options?.redirectTo || ROUTES.HOME;
        let ownsExpectedSession = true;
        setLoading(true);
        signingOutUserIdRef.current = currentUid;
        // Withdraw the published owner immediately. Vault and realtime
        // consumers must tear down while optional notification cleanup waits.
        applyAuthUser(null);

        try {
          // Preserve notification cleanup before credential invalidation, with
          // a short budget instead of the general network-request timeout.
          if (currentUser && !options?.skipFcmCleanup) {
            await settleSignOutNotifications(currentUser);
          }

          // Clear the server-owned httpOnly session independently from the
          // native/JS Firebase credentials. Logout must not leave a valid web
          // session cookie behind merely because one auth transport failed.
          // Mail/FCM cleanup above can yield long enough for another tab to sign
          // into a different account. Re-check immediately before touching the
          // global Firebase identity or the shared web session cookie.
          ownsExpectedSession = stillOwnsExpectedSession();
          if (!ownsExpectedSession) return;

          const cleanupTasks: Promise<unknown>[] = [AuthService.signOut(currentUid)];
          // The httpOnly session cookie exists only on the web/Next.js origin.
          // Native static builds authenticate directly against the backend, where
          // `/api/auth/session` is intentionally not a route.
          if (!IS_NATIVE) {
            cleanupTasks.push(ApiService.deleteSession());
          }
          const cleanupResults = await Promise.allSettled(cleanupTasks);
          for (const result of cleanupResults) {
            if (result.status === "rejected") {
              console.error("Sign out cleanup error", result.reason);
            }
          }
        } finally {
          if (ownsExpectedSession) {
            ownsExpectedSession = stillOwnsExpectedSession();
          }
          CacheSyncService.onAuthSignedOut(currentUid);
          useOneConversationSession.getState().clearSession();
          if (currentUid) {
            await UserLocalStateService.clearForUser(currentUid);
          }

          if (!ownsExpectedSession) {
            // The newer identity owns all global state and navigation. Its auth
            // observer also owns the loading gate until validation completes.
            const replacementUserId =
              userRef.current?.uid ??
              (!IS_NATIVE ? AuthService.getCurrentUser()?.uid : null) ??
              null;
            if (
              expectedUserId &&
              terminalInvalidationLatchRef.current?.invalidatedUserId ===
                expectedUserId &&
              replacementUserId &&
              replacementUserId !== expectedUserId
            ) {
              terminalInvalidationLatchRef.current = null;
            }
            if (
              userRef.current?.uid &&
              userRef.current.uid !== expectedUserId &&
              !webAuthObserverPendingRef.current
            ) {
              setLoading(false);
            }
            return;
          }

          userRef.current = null;
          applyAuthUser(null);
          setConfirmationResult(null);
          setNativeVerificationId(null);
          setPhoneVerificationPhoneNumber(null);

          // Reset landing/onboarding entry markers so sign-out returns to Intro on "/".
          await OnboardingLocalService.clearMarketingSeen();
          await OnboardingLocalService.markForceIntroOnce();
          setOnboardingRequiredCookie(false);
          setOnboardingFlowActiveCookie(false);

          // DEFENSIVE CLEANUP: Remove any legacy vault_key from storage
          // Vault key should be managed by VaultContext (memory-only)
          removeLocalItem("vault_key");
          removeLocalItem("user_id");
          clearSessionStorage();

          if (expectedUserId) {
            completedScopedSignOutUserIdRef.current = expectedUserId;
          }

          // End the authenticated document on web as well as native. Profile
          // sheets, cached router state and old stream callbacks cannot retain
          // the previous screen and require a manual refresh to leave it.
          // Keep the loading gate held until the document unloads: releasing
          // it lets route guards issue a competing client-side /login replace
          // that cancels this navigation and strands the page on a loader.
          terminalNavigationCommitted = true;
          replaceWindowLocation(redirectTo);
        }
      })();

      signOutPromiseRef.current = operation;
      try {
        await operation;
      } finally {
        if (
          signOutPromiseRef.current === operation &&
          (!IS_NATIVE || !terminalNavigationCommitted)
        ) {
          signOutPromiseRef.current = null;
          signingOutUserIdRef.current = null;
        }
      }
    },
    [applyAuthUser],
  );

  /**
   * Revalidate an already-published identity only after an explicit recovery
   * signal. Routine focus, visibility, and native resume events intentionally do
   * not call this: the vault is memory-only and an already-unlocked screen must
   * remain stable until an authoritative auth failure or an explicit retry.
   */
  const validateActiveSession = useCallback(
    (options?: { force?: boolean }): Promise<void> => {
      const force = options?.force === true;
      const predecessor = activeSessionValidationPromiseRef.current;

      if (predecessor && !force) {
        return predecessor;
      }

      if (
        !predecessor &&
        (!userRef.current ||
          signOutPromiseRef.current ||
          terminalInvalidationLatchRef.current ||
          activePostAuthSettlementRef.current !== null)
      ) {
        return Promise.resolve();
      }

      if (userRef.current) {
        // This path is reserved for an explicit verification/recovery action;
        // lifecycle events never reach it and therefore never toggle this gate.
        setLoading(true);
      }

      let operation!: Promise<void>;
      const runValidation = async () => {
        // Resolve the identity after the predecessor settles so an auth switch
        // can never make this queued operation validate a stale User object.
        const currentUser = userRef.current;
        if (
          !currentUser ||
          signOutPromiseRef.current ||
          terminalInvalidationLatchRef.current ||
          activePostAuthSettlementRef.current !== null
        ) {
          return;
        }

        const expectedUid = currentUser.uid;

        const validation = await validateAccountSession(currentUser);
        const firebaseUserId = !IS_NATIVE
          ? (AuthService.getCurrentUser()?.uid ?? null)
          : null;
        if (
          userRef.current?.uid !== expectedUid ||
          (firebaseUserId != null && firebaseUserId !== expectedUid) ||
          activePostAuthSettlementRef.current !== null
        ) {
          return;
        }
        if (validation.outcome === "terminal") {
          if (
            !signOutPromiseRef.current &&
            !terminalInvalidationLatchRef.current
          ) {
            dispatchAuthSessionInvalidated({
              code: validation.code,
              path: "explicit_verification",
              userId: expectedUid,
            });
          }
          return;
        }
        if (validation.outcome === "unavailable") {
          console.warn(
            "🔒 [AuthProvider] Session validation unavailable; preserving session",
          );
          setSessionVerificationRequired(true);
        } else {
          setSessionVerificationRequired(false);
        }
        if (signOutPromiseRef.current || terminalInvalidationLatchRef.current) {
          return;
        }
        // A newer forced validation owns the loading gate. Its predecessor must
        // not expose cached Vault UI between the two operations.
        if (activeSessionValidationPromiseRef.current === operation) {
          if (!webAuthObserverPendingRef.current) setLoading(false);
        }
      };

      const predecessorSettled = predecessor
        ? predecessor.catch(() => undefined)
        : Promise.resolve();
      operation = predecessorSettled.then(runValidation);
      activeSessionValidationPromiseRef.current = operation;

      const clearCompletedOperation = () => {
        if (activeSessionValidationPromiseRef.current !== operation) return;
        activeSessionValidationPromiseRef.current = null;
        if (
          !signOutPromiseRef.current &&
          !terminalInvalidationLatchRef.current &&
          activePostAuthSettlementRef.current === null &&
          !webAuthObserverPendingRef.current
        ) {
          // Also releases a gate when the serialized task safely became a no-op
          // (for example, the identity disappeared through another observer).
          setLoading(false);
        }
      };
      void operation.then(clearCompletedOperation, clearCompletedOperation);
      return operation;
    },
    [validateAccountSession],
  );

  const retrySessionVerification = useCallback(async () => {
    if (IS_NATIVE && !userRef.current) {
      if (!nativeRestoreSettledRef.current) return;
      setLoading(true);
      await checkAuth();
      return;
    }
    await validateActiveSession({ force: true });
  }, [checkAuth, validateActiveSession]);

  useEffect(() => {
    if (!sessionVerificationRequired || (!userId && !IS_NATIVE)) return;

    let cancelled = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRetry = () => {
      const delay =
        SESSION_VERIFICATION_RETRY_DELAYS_MS[
          Math.min(attempt, SESSION_VERIFICATION_RETRY_DELAYS_MS.length - 1)
        ];
      retryTimer = globalThis.setTimeout(() => {
        retryTimer = null;
        if (cancelled) return;

        const canReachBackend =
          document.visibilityState === "visible" && navigator.onLine !== false;
        if (!canReachBackend) {
          attempt += 1;
          scheduleRetry();
          return;
        }

        void retrySessionVerification().finally(() => {
          if (cancelled || !authGateRef.current.sessionVerificationRequired) {
            return;
          }
          attempt += 1;
          scheduleRetry();
        });
      }, delay);
    };

    // Availability failures stay fail-closed, but no longer require a customer
    // to repeatedly press Try again after a transient backend/proxy incident.
    scheduleRetry();
    return () => {
      cancelled = true;
      if (retryTimer !== null) globalThis.clearTimeout(retryTimer);
    };
  }, [sessionVerificationRequired, userId, retrySessionVerification]);

  useEffect(() => {
    const handleAuthInvalidated = (event: Event) => {
      const customEvent = event as CustomEvent<AuthSessionInvalidationDetail>;
      const eventUserId = String(customEvent.detail?.userId || "").trim();
      const publishedUserId = userRef.current?.uid ?? null;
      const firebaseUserId = !IS_NATIVE
        ? (AuthService.getCurrentUser()?.uid ?? null)
        : null;
      const currentUserId = publishedUserId ?? firebaseUserId;
      const isCurrentNativeRestore =
        customEvent.detail?.path === "native_restore" &&
        Boolean(eventUserId) &&
        currentUserId === null;
      if (
        (eventUserId &&
          eventUserId !== currentUserId &&
          !isCurrentNativeRestore) ||
        (eventUserId && firebaseUserId && eventUserId !== firebaseUserId) ||
        (!eventUserId && !currentUserId)
      ) {
        return;
      }

      const code = isAuthSessionInvalidationCode(customEvent.detail?.code)
        ? customEvent.detail.code
        : "session_invalid";
      console.warn("🔒 [AuthProvider] Auth session invalidated:", code);
      const invalidatedUserId = eventUserId || currentUserId;
      if (
        invalidatedUserId &&
        (code === "account_not_found" || code === "account_deleted" || code === "account_deleted_ready_to_start_fresh" || code === "account_deletion_finishing")
      ) {
        // The backend or Firebase confirmed this account is gone (never an
        // uncertain outcome or a disabled account), so the device key material
        // it owned goes too -- also on sibling tabs and other devices. This
        // runs before the duplicate-signal latch so a later deletion signal is
        // not lost behind an earlier session_invalid teardown.
        void UserLocalStateService.clearDeviceSecretsForDeletedAccount(
          invalidatedUserId,
        );
      }
      if (
        terminalInvalidationLatchRef.current ||
        authRecoveryInFlightRef.current
      ) {
        return;
      }
      terminalInvalidationLatchRef.current = {
        invalidatedUserId: eventUserId || currentUserId,
        observedAnonymous: currentUserId === null,
      };

      const completeInvalidation = async () => {
        authRecoveryInFlightRef.current = true;
        try {
          await signOut({
            redirectTo: buildLoginRouteWithAuthSessionNotice(code),
            expectedUserId: eventUserId || currentUserId || undefined,
            // The backend account/session is already invalid, so authenticated
            // FCM cleanup cannot succeed and must not delay this security exit.
            skipFcmCleanup: true,
          });
        } finally {
          authRecoveryInFlightRef.current = false;
        }
      };

      void completeInvalidation();
    };

    const handleSiblingTabInvalidation = (event: StorageEvent) => {
      const detail = authSessionInvalidationFromSiblingTabStorageEvent(event);
      if (!detail) return;
      dispatchAuthSessionInvalidated(detail);
    };

    window.addEventListener(
      AUTH_SESSION_INVALIDATED_EVENT,
      handleAuthInvalidated,
    );
    window.addEventListener("storage", handleSiblingTabInvalidation);
    return () => {
      window.removeEventListener(
        AUTH_SESSION_INVALIDATED_EVENT,
        handleAuthInvalidated,
      );
      window.removeEventListener("storage", handleSiblingTabInvalidation);
    };
  }, [signOut]);

  useEffect(() => {
    const requireVerification = (event: Event) => {
      const detail = (event as CustomEvent<AuthSessionVerificationRequiredDetail>).detail;
      const owner = snapshotValidatedAuthSessionOwner();
      if (!detail || !owner || detail.userId !== owner.userId ||
          detail.generation !== owner.generation || detail.userId !== userRef.current?.uid) return;
      setSessionVerificationRequired(true);
      // Parallel protected requests can all report the same transport outage.
      // One current account check owns recovery for that identity generation.
      if (!activeSessionValidationPromiseRef.current) {
        void validateActiveSession({ force: true });
      }
    };
    window.addEventListener(AUTH_SESSION_VERIFICATION_REQUIRED_EVENT, requireVerification);
    return () => window.removeEventListener(AUTH_SESSION_VERIFICATION_REQUIRED_EVENT, requireVerification);
  }, [validateActiveSession]);

  // Initialize only after the terminal invalidation listener above exists.
  // This ordering guarantees a deleted account found during native cold
  // restoration cannot leave the auth loading gate stuck or reveal stale UI.
  useEffect(() => {
    let mounted = true;
    let webAuthRevision = 0;
    let initialWebAuthWatchdog: ReturnType<typeof setTimeout> | null = null;

    const markInitialWebAuthObserverReceived = () => {
      if (initialWebAuthWatchdog !== null) {
        globalThis.clearTimeout(initialWebAuthWatchdog);
        initialWebAuthWatchdog = null;
      }
    };

    let privacySequence = 0;
    let privacyReadFailures = 0;
    let privacyRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let foregroundRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let foregroundRetriesLeft = 0;
    let removePrivacyListener: (() => Promise<void>) | null = null;
    let privacyListenerConnecting = false;

    const schedulePrivacyRead = () => {
      if (!mounted || privacyRetryTimer !== null || privacyReadFailures >= 3) return;
      privacyRetryTimer = setTimeout(() => {
        privacyRetryTimer = null;
        connectNativePrivacyListener();
        void settleNativePrivacyProtectedSession();
      }, 500);
    };

    const scheduleForegroundRead = () => {
      if (!mounted || foregroundRetryTimer !== null || foregroundRetriesLeft <= 0 ||
          document.visibilityState !== "visible") return;
      foregroundRetriesLeft -= 1;
      foregroundRetryTimer = setTimeout(() => {
        foregroundRetryTimer = null;
        if (!mounted || document.visibilityState !== "visible") return;
        if (!nativeRestoreSettledRef.current) {
          scheduleForegroundRead();
          return;
        }
        void settleNativePrivacyProtectedSession();
      }, 250);
    };

    const settleNativePrivacyProtectedSession = async (
      deliveredState?: NativeSessionPrivacyState,
    ) => {
      const sequence = ++privacySequence;
      let privacyState: NativeSessionPrivacyState;
      try {
        privacyState = deliveredState ?? await withinAccountSessionValidationBudget(
          getNativeSessionPrivacyState(),
          Date.now() + NATIVE_SESSION_PRIVACY_READ_BUDGET_MS,
        );
      } catch {
        if (!mounted || sequence !== privacySequence) return;
        privacyReadFailures += 1;
        // Unknown bridge state is never evidence that an existing cover is gone.
        // Restore identity within its own budget, then render the existing safe
        // recovery gate while native retry/restart controls remain available.
        if (!nativeRestoreSettledRef.current) await checkAuth();
        if (!mounted || sequence !== privacySequence) return;
        setSessionVerificationRequired(true);
        if (!signOutPromiseRef.current && !terminalInvalidationLatchRef.current &&
            activePostAuthSettlementRef.current === null) setLoading(false);
        schedulePrivacyRead();
        return;
      }
      if (!mounted || sequence !== privacySequence) return;
      nativePrivacyLatestRef.current = privacyState;
      if (!privacyState.appIsActive) {
        setNativePrivacyReady(null);
        if (foregroundRetriesLeft > 0) scheduleForegroundRead();
        return;
      }
      // Cold native restoration still owns the initial auth decision. Once the
      // identity is published, resuming the app only acknowledges the native
      // privacy cover; it does not perform another account/session request or
      // toggle the React auth gate.
      const readBeforeRestore = !nativeRestoreSettledRef.current;
      if (readBeforeRestore) await checkAuth();
      if (!mounted || sequence !== privacySequence) return;
      // A foreground transition during restoration can supersede the state
      // read before restoration. Let its pending catch-up read the fresh state.
      if (readBeforeRestore && foregroundRetriesLeft > 0) {
        scheduleForegroundRead();
        return;
      }
      foregroundRetriesLeft = 0;
      if (foregroundRetryTimer !== null) {
        clearTimeout(foregroundRetryTimer);
        foregroundRetryTimer = null;
      }
      if (mounted && nativePrivacyLatestRef.current?.generation === privacyState.generation &&
          nativePrivacyLatestRef.current.appIsActive && privacyState.shielded &&
          !terminalInvalidationLatchRef.current && !signOutPromiseRef.current) {
        setNativePrivacyReady({ ...privacyState });
      }
    };

    nativePrivacyReconcileRef.current = () => {
      privacyReadFailures += 1;
      schedulePrivacyRead();
    };
    const connectNativePrivacyListener = () => {
      if (!IS_NATIVE || !mounted || removePrivacyListener || privacyListenerConnecting) return;
      privacyListenerConnecting = true;
      // Separate from pause/resume: this event also covers inactive-only cycles,
      // and arrives only after native didBecomeActive can accept an ack.
      void subscribeNativeSessionPrivacy((event) => {
        privacyReadFailures = 0;
        void settleNativePrivacyProtectedSession(event);
      }).then((handle) => {
        if (!mounted) { void handle.remove(); return; }
        removePrivacyListener = () => handle.remove();
        // Catch up with a transition that happened before subscription.
        void settleNativePrivacyProtectedSession();
      }).catch(() => {
        privacyReadFailures += 1;
        schedulePrivacyRead();
      }).finally(() => {
        privacyListenerConnecting = false;
      });
    };
    connectNativePrivacyListener();

    // WebKit can drop a native listener delivery across suspension. A foreground
    // signal only re-reads native state; the exact-generation native ack still
    // owns uncovering, and initial identity restoration stays single-owner.
    const catchUpNativePrivacyAfterForeground = () => {
      if (!IS_NATIVE || document.visibilityState !== "visible") return;
      foregroundRetriesLeft = 20;
      if (!nativeRestoreSettledRef.current) {
        scheduleForegroundRead();
        return;
      }
      void settleNativePrivacyProtectedSession();
    };
    if (IS_NATIVE) {
      document.addEventListener("visibilitychange", catchUpNativePrivacyAfterForeground);
      window.addEventListener("focus", catchUpNativePrivacyAfterForeground);
    }

    if (!IS_NATIVE) {
      initialWebAuthWatchdog = globalThis.setTimeout(() => {
        initialWebAuthWatchdog = null;
        if (!mounted || webAuthRevision !== 0) return;
        console.warn(
          "⚠️ [AuthProvider] Initial auth observer timed out - forcing loading=false",
        );
        setLoading(false);
      }, WEB_AUTH_OBSERVER_WATCHDOG_MS);
    }

    if (IS_NATIVE) {
      void settleNativePrivacyProtectedSession();
    } else {
      void checkAuth();
    }

    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      if (!mounted) return;
      markInitialWebAuthObserverReceived();

      // Native identity has one publication authority: checkAuth/refreshUser
      // for restoration and the explicit post-auth settlement for sign-in.
      if (IS_NATIVE) {
        if (!firebaseUser && !nativeRestoreSettledRef.current) {
          console.log(
            "🍎 [AuthContext] Ignoring Firebase Null State While Native Restore Is Pending",
          );
        } else {
          console.log(
            "🍎 [AuthContext] Ignoring Firebase JS State (Native Mode)",
          );
        }
        return;
      }

      const revision = ++webAuthRevision;
      const authEpoch = signOutEpochRef.current;
      if (firebaseUser && firebaseUser.uid === signingOutUserIdRef.current) return;
      if (!firebaseUser) {
        webAuthObserverPendingRef.current = false;
        applyAuthUser(null);
        if (
          !signOutPromiseRef.current &&
          !terminalInvalidationLatchRef.current
        ) {
          setLoading(false);
        }
        return;
      }

      webAuthObserverPendingRef.current = true;
      setLoading(true);
      void validateAccountSession(firebaseUser).then(
        (validation) => {
          if (!mounted || revision !== webAuthRevision ||
              authEpoch !== signOutEpochRef.current) {
            return;
          }
          if (validation.outcome === "terminal") {
            webAuthObserverPendingRef.current = false;
            dispatchAuthSessionInvalidated({
              code: validation.code,
              path: "web_restore",
              userId: firebaseUser.uid,
            });
            return;
          }
          setSessionVerificationRequired(validation.outcome === "unavailable");
          applyAuthUser(firebaseUser);
          webAuthObserverPendingRef.current = false;
          if (
            !signOutPromiseRef.current &&
            !terminalInvalidationLatchRef.current
          ) {
            setLoading(false);
          }
        },
        () => {
          if (!mounted || revision !== webAuthRevision ||
              authEpoch !== signOutEpochRef.current) return;
          // The validator is intentionally fail-soft for untyped availability
          // errors. Preserve the persisted identity and let API calls retry.
          setSessionVerificationRequired(true);
          applyAuthUser(firebaseUser);
          webAuthObserverPendingRef.current = false;
          if (
            !signOutPromiseRef.current &&
            !terminalInvalidationLatchRef.current
          ) {
            setLoading(false);
          }
        },
      );
    });

    return () => {
      mounted = false;
      if (IS_NATIVE) {
        document.removeEventListener("visibilitychange", catchUpNativePrivacyAfterForeground);
        window.removeEventListener("focus", catchUpNativePrivacyAfterForeground);
      }
      nativePrivacyReconcileRef.current = () => undefined;
      if (privacyRetryTimer !== null) clearTimeout(privacyRetryTimer);
      if (foregroundRetryTimer !== null) clearTimeout(foregroundRetryTimer);
      void removePrivacyListener?.();
      webAuthRevision += 1;
      webAuthObserverPendingRef.current = false;
      markInitialWebAuthObserverReceived();
      unsubscribe();
    };
  }, [
    applyAuthUser,
    checkAuth,
    validateAccountSession,
  ]);

  // A completed Promise is not a rendered gate. Wait for React to commit the
  // validated destination or recovery UI, then allow a WebView paint before
  // uncovering it. Two frames avoid acknowledging in the pre-paint callback.
  useEffect(() => {
    if (!IS_NATIVE || !nativePrivacyReady || loading ||
        terminalInvalidationLatchRef.current || signOutPromiseRef.current ||
        activePostAuthSettlementRef.current !== null) return;
    let cancelled = false;
    let paintedFrame: number | null = null;
    const preparationSession = getAuthSessionGeneration() ?? 0;
    const preparationRevision = nativeSessionPreparationRevision(nativePrivacyReady.generation, preparationSession,
      nativeCompositionRevision, sessionVerificationRequired);
    const releaseAfterPaint = () => {
      if (cancelled || authGateRef.current.loading ||
          nativePrivacyLatestRef.current?.generation !== nativePrivacyReady.generation ||
          !nativePrivacyLatestRef.current.appIsActive ||
          terminalInvalidationLatchRef.current || signOutPromiseRef.current ||
          activePostAuthSettlementRef.current !== null) return;
      void withinAccountSessionValidationBudget(
        (async () => {
          const owner = snapshotValidatedAuthSessionOwner();
          await prepareNativeSessionPrivacyValidation(nativePrivacyReady.generation, preparationSession,
            sessionVerificationRequired ? null : nativeProfilePreparationExpected(owner?.userId), preparationRevision);
          const current = snapshotValidatedAuthSessionOwner();
          if (cancelled || nativeProfilePreparationRevision() !== nativeCompositionRevision ||
              getAuthSessionGeneration() !== preparationSession || authGateRef.current.sessionVerificationRequired !== sessionVerificationRequired ||
              current?.generation !== owner?.generation || current?.userId !== owner?.userId) {
            throw new Error("Native composition owner changed.");
          }
          return nativePrivacyReady.profilePreparation === true
            ? completeNativeSessionPrivacyValidation(nativePrivacyReady.generation, preparationSession, preparationRevision)
            : completeNativeSessionPrivacyValidation(nativePrivacyReady.generation);
        })(),
        Date.now() + NATIVE_SESSION_PRIVACY_READ_BUDGET_MS,
      ).then((result) => {
        if (cancelled) return;
        if (result.released || !result.shielded) {
          setNativePrivacyReady((pending) =>
            pending?.generation === nativePrivacyReady.generation ? null : pending);
        } else {
          nativePrivacyReconcileRef.current();
        }
      }).catch(() => {
        if (!cancelled) nativePrivacyReconcileRef.current();
      });
    };
    const frame = requestAnimationFrame(() => {
      paintedFrame = requestAnimationFrame(releaseAfterPaint);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      if (paintedFrame !== null) cancelAnimationFrame(paintedFrame);
    };
  }, [nativePrivacyReady, loading, sessionVerificationRequired, user, nativeCompositionRevision]);

  const requirePhoneVerificationOwner = useCallback(
    (expectedUid: string | null | undefined, expectedEpoch: number) => {
      const liveWebUid = Capacitor.isNativePlatform()
        ? expectedUid
        : AuthService.getCurrentUser()?.uid;
      if (
        !expectedUid ||
        liveWebUid !== expectedUid ||
        userRef.current?.uid !== expectedUid ||
        phoneVerificationOwnerRef.current !== expectedUid ||
        phoneVerificationEpochRef.current !== expectedEpoch
      ) {
        throw new Error("Your signed-in account changed. Start phone verification again.");
      }
    },
    [],
  );

  const confirmRetainedNativePhone = useCallback(
    async (
      phone: string,
      expectedUid: string,
      expectedEpoch: number,
    ): Promise<User | null> => {
      const currentUser = userRef.current;
      if (!Capacitor.isNativePlatform() || !currentUser || phoneNumberRef.current !== phone) return null;
      // An existing app-level claim need not be linked to native Firebase.
      // Reuse it only after the backend freshly confirms this exact owner/phone.
      const identity = await AccountIdentityService.refreshCurrentUserIdentity(
        currentUser,
        { force: true, requireSuccess: true },
      );
      requirePhoneVerificationOwner(expectedUid, expectedEpoch);
      if (!identity || identity.user_id !== expectedUid) {
        throw new Error("Saved phone verification could not be confirmed. Please retry.");
      }
      if (identity.phone_verified !== true || identity.phone_number !== phone) return null;
      return currentUser;
    },
    [requirePhoneVerificationOwner],
  );

  const finalizeLinkedProviderPhone = useCallback(
    async (
      phone: string | null | undefined,
      expectedUid: string | null | undefined,
      expectedEpoch: number,
    ): Promise<User | null> => {
      if (!phone) return null;
      // Read the provider without publishing it: a previous OTP can have
      // linked successfully while its backend persistence was unavailable.
      const linkedUser = Capacitor.isNativePlatform()
        ? await AuthService.restoreNativeSession({ nativeOnly: true })
        : AuthService.getCurrentUser();
      requirePhoneVerificationOwner(expectedUid, expectedEpoch);
      if (!linkedUser || linkedUser.uid !== expectedUid) {
        throw new Error("The verified account changed. Start phone verification again.");
      }
      if (linkedUser.phoneNumber !== phone) return null;
      await AccountIdentityService.finalizeNativePhoneVerification(linkedUser, phone);
      requirePhoneVerificationOwner(expectedUid, expectedEpoch);
      return linkedUser;
    },
    [requirePhoneVerificationOwner],
  );

  const startPhoneVerification = useCallback(
    async (
      phone: string,
      options?: { resendCode?: boolean },
    ): Promise<{ autoVerified: boolean; user?: User | null }> => {
      return await (async () => {
        const expectedUid = userRef.current?.uid;
        if (!expectedUid) throw new Error("Sign in before verifying a phone number.");
        phoneVerificationOwnerRef.current = expectedUid;
        const expectedPhoneEpoch = ++phoneVerificationEpochRef.current;
        setConfirmationResult(null);
        setNativeVerificationId(null);
        setPhoneVerificationPhoneNumber(null);
        setPhoneVerificationAttempt(null);
        const isNative = Capacitor.isNativePlatform();
        const useLocalDevPhoneVerification =
          !isNative && AuthService.shouldUseLocalDevPhoneVerification(phone);

        let result: Awaited<
          ReturnType<typeof AuthService.startPhoneLinkVerification>
        > | null = null;
        try {
          const retainedUser = await confirmRetainedNativePhone(phone, expectedUid, expectedPhoneEpoch);
          requirePhoneVerificationOwner(expectedUid, expectedPhoneEpoch);
          if (retainedUser) {
            applyAuthUser(retainedUser);
            phoneVerificationOwnerRef.current = null;
            return { autoVerified: true, user: retainedUser };
          }
          // UAT phone-test allowlist path (fixed OTP, no SMS) — attempt on BOTH
          // web AND native so test numbers work in the iOS app. The backend gates
          // it to ENVIRONMENT=uat + the configured allowlist, so prod / non-listed
          // numbers come back ineligible and fall through to real Firebase below.
          if (!useLocalDevPhoneVerification) {
            const uatPhoneTest =
              await AccountIdentityService.startUatTestPhoneVerification(
                userRef.current,
                phone,
              );
            requirePhoneVerificationOwner(expectedUid, expectedPhoneEpoch);
            if (isNative && uatPhoneTest?.reason === "phone_test_number_in_use") {
              throw new Error("This test phone number is already linked to another account. Use a different phone number.");
            }
            if (isNative && (
              !uatPhoneTest?.success ||
              (uatPhoneTest.eligible && !uatPhoneTest.verification_id) ||
              (!uatPhoneTest.eligible && uatPhoneTest.reason !== "uat_phone_test_not_configured_or_not_allowlisted")
            )) {
              throw new Error("Phone verification is temporarily unavailable. Please try again.");
            }
            if (uatPhoneTest?.eligible && uatPhoneTest.verification_id) {
              result = {
                autoVerified: false,
                verificationId: uatPhoneTest.verification_id,
              };
            }
          }

          if (!result) {
            const linkedUser = await finalizeLinkedProviderPhone(phone, expectedUid, expectedPhoneEpoch);
            if (linkedUser) {
              applyAuthUser(linkedUser);
              phoneVerificationOwnerRef.current = null;
              return { autoVerified: true, user: linkedUser };
            }
            result = await AuthService.startPhoneLinkVerification(phone, {
              resendCode: options?.resendCode,
              recaptchaVerifier:
                isNative || useLocalDevPhoneVerification
                  ? undefined
                  : await prepareRecaptchaVerifier("recaptcha-container"),
            });
          }
        } catch (error) {
          if (!isNative) {
            resetRecaptcha();
          }
          throw error;
        }

        if (!result) {
          throw new Error("Phone verification could not be started.");
        }
        requirePhoneVerificationOwner(expectedUid, expectedPhoneEpoch);
        setPhoneVerificationAttempt({ userId: expectedUid, epoch: expectedPhoneEpoch });
        setPhoneVerificationPhoneNumber(phone);

        if (result.confirmationResult) {
          setConfirmationResult(result.confirmationResult);
        }

        if (result.verificationId) {
          setNativeVerificationId(result.verificationId);
          setPhoneVerificationPhoneNumber(phone);
        }

        if (result.autoVerified) {
          if (!isNative) {
            resetRecaptcha();
          }
          const refreshedUser = result.user ?? (isNative
            ? await AuthService.restoreNativeSession({ nativeOnly: true })
            : await refreshUser());
          requirePhoneVerificationOwner(expectedUid, expectedPhoneEpoch);
          if (refreshedUser?.uid !== expectedUid) throw new Error("The verified account changed. Start phone verification again.");
          if (isNative) {
            await AccountIdentityService.finalizeNativePhoneVerification(refreshedUser, phone);
          }
          requirePhoneVerificationOwner(expectedUid, expectedPhoneEpoch);
          applyAuthUser(refreshedUser);
          phoneVerificationOwnerRef.current = null;
          return {
            autoVerified: true,
            user: refreshedUser,
          };
        }

        return { autoVerified: false };
      })();
    },
    [applyAuthUser, refreshUser, requirePhoneVerificationOwner, finalizeLinkedProviderPhone, confirmRetainedNativePhone],
  );

  const startPhoneReplacement = useCallback(
    async (
      phone: string,
      options?: { resendCode?: boolean },
    ): Promise<{ autoVerified: boolean; user?: User | null }> => {
      const expectedUid = userRef.current?.uid;
      if (!expectedUid) throw new Error("Sign in before changing a phone number.");
      phoneVerificationOwnerRef.current = expectedUid;
      const expectedPhoneEpoch = ++phoneVerificationEpochRef.current;
      setConfirmationResult(null);
      setNativeVerificationId(null);
      setPhoneVerificationPhoneNumber(null);
      setPhoneVerificationAttempt(null);
      const isNative = Capacitor.isNativePlatform();

      let result: Awaited<
        ReturnType<typeof AuthService.startPhoneReplacementVerification>
      >;
      try {
        const retainedUser = await confirmRetainedNativePhone(phone, expectedUid, expectedPhoneEpoch);
        requirePhoneVerificationOwner(expectedUid, expectedPhoneEpoch);
        if (retainedUser) {
          applyAuthUser(retainedUser);
          phoneVerificationOwnerRef.current = null;
          return { autoVerified: true, user: retainedUser };
        }
        const linkedUser = await finalizeLinkedProviderPhone(phone, expectedUid, expectedPhoneEpoch);
        if (linkedUser) {
          applyAuthUser(linkedUser);
          phoneVerificationOwnerRef.current = null;
          return { autoVerified: true, user: linkedUser };
        }
        result = await AuthService.startPhoneReplacementVerification(phone, {
          resendCode: options?.resendCode,
          recaptchaVerifier: isNative
            ? undefined
            : await prepareRecaptchaVerifier("recaptcha-container"),
        });
      } catch (error) {
        if (!isNative) {
          resetRecaptcha();
        }
        throw error;
      }

      requirePhoneVerificationOwner(expectedUid, expectedPhoneEpoch);
      setPhoneVerificationAttempt({ userId: expectedUid, epoch: expectedPhoneEpoch });
      setPhoneVerificationPhoneNumber(phone);
      if (result.confirmationResult) {
        setConfirmationResult(result.confirmationResult);
      }

      if (result.verificationId) {
        setNativeVerificationId(result.verificationId);
        setPhoneVerificationPhoneNumber(phone);
      }

      if (result.autoVerified) {
        if (!isNative) {
          resetRecaptcha();
        }
        const refreshedUser = result.user ?? (isNative
          ? await AuthService.restoreNativeSession({ nativeOnly: true })
          : await refreshUser());
        requirePhoneVerificationOwner(expectedUid, expectedPhoneEpoch);
        if (refreshedUser?.uid !== expectedUid) throw new Error("The verified account changed. Start phone verification again.");
        await AccountIdentityService.finalizeNativePhoneVerification(refreshedUser, phone);
        requirePhoneVerificationOwner(expectedUid, expectedPhoneEpoch);
        applyAuthUser(refreshedUser);
        phoneVerificationOwnerRef.current = null;
        return {
          autoVerified: true,
          user: refreshedUser,
        };
      }

      return { autoVerified: false };
    },
    [applyAuthUser, refreshUser, requirePhoneVerificationOwner, finalizeLinkedProviderPhone, confirmRetainedNativePhone],
  );

  const confirmPhoneVerification = useCallback(
    async (otp: string): Promise<User> => {
      return await (async () => {
        const verificationUser = userRef.current;
        const expectedPhoneEpoch = phoneVerificationAttempt?.epoch ?? -1;
        requirePhoneVerificationOwner(phoneVerificationAttempt?.userId, expectedPhoneEpoch);
        if (!verificationUser) throw new Error("Sign in before verifying a phone number.");
        // A uat-test verification id means the start path used the backend
        // allowlist flow — confirm it via the UAT-test path on BOTH native + web
        // (not the real Firebase native link) so iOS test numbers work.
        const useNativeFirebaseConfirm =
          Capacitor.isNativePlatform() &&
          !AuthService.isUatPhoneTestVerificationId(nativeVerificationId);
        const linkedUser = useNativeFirebaseConfirm
          ? await finalizeLinkedProviderPhone(phoneVerificationPhoneNumber, verificationUser.uid, expectedPhoneEpoch)
          : null;
        const verifiedUser = linkedUser ?? (useNativeFirebaseConfirm
          ? await AuthService.confirmPhoneLinkVerification({
              verificationCode: otp,
              confirmationResult,
              verificationId: nativeVerificationId,
            })
          : AuthService.isLocalDevPhoneVerificationId(nativeVerificationId)
            ? await AuthService.confirmLocalDevPhoneVerification({
                verificationCode: otp,
                verificationId: nativeVerificationId,
              })
            : AuthService.isUatPhoneTestVerificationId(nativeVerificationId)
              ? await (async () => {
                  const phoneNumberForVerification = String(
                    phoneVerificationPhoneNumber ?? "",
                  ).trim();
                  if (!phoneNumberForVerification || !nativeVerificationId) {
                    throw new Error(
                      "Phone verification session expired. Please try again.",
                    );
                  }
                  const identity =
                    await AccountIdentityService.confirmUatTestPhoneVerification(
                      verificationUser,
                      {
                        phoneNumber: phoneNumberForVerification,
                        verificationCode: otp,
                        verificationId: nativeVerificationId,
                      },
                    );
                  if (!AccountIdentityService.hasVerifiedPhone(identity)) {
                    throw new Error(
                      "Phone verification completed but the backend could not confirm the phone claim.",
                    );
                  }
                  return verificationUser;
                })()
              : await (async () => {
                  const phoneIdToken = await AuthService.getPhoneClaimIdToken({
                    verificationCode: otp,
                    verificationId: nativeVerificationId,
                  });
                  requirePhoneVerificationOwner(verificationUser.uid, expectedPhoneEpoch);
                  const identity =
                    await AccountIdentityService.claimCurrentUserPhone(
                      verificationUser,
                      phoneIdToken,
                    );
                  if (!AccountIdentityService.hasVerifiedPhone(identity)) {
                    throw new Error(
                      "Phone verification completed but the backend could not confirm the phone claim.",
                    );
                  }
                  return verificationUser;
                })());
        requirePhoneVerificationOwner(verificationUser.uid, expectedPhoneEpoch);
        if (verifiedUser?.uid !== verificationUser.uid) throw new Error("The verified account changed. Start phone verification again.");
        if (useNativeFirebaseConfirm && !linkedUser) {
          await AccountIdentityService.finalizeNativePhoneVerification(
            verifiedUser, phoneVerificationPhoneNumber,
          );
          requirePhoneVerificationOwner(verificationUser.uid, expectedPhoneEpoch);
        }
        if (!Capacitor.isNativePlatform()) {
          resetRecaptcha();
        }
        setConfirmationResult(null);
        setNativeVerificationId(null);
        setPhoneVerificationPhoneNumber(null);

        const refreshedUser = verifiedUser ?? (await refreshUser());
        applyAuthUser(refreshedUser);
        phoneVerificationOwnerRef.current = null;
        if (!refreshedUser) {
          throw new Error(
            "Phone verification completed but the session could not be refreshed.",
          );
        }
        return refreshedUser;
      })();
    },
    [
      applyAuthUser,
      confirmationResult,
      nativeVerificationId,
      phoneVerificationPhoneNumber,
      phoneVerificationAttempt,
      refreshUser,
      requirePhoneVerificationOwner,
      finalizeLinkedProviderPhone,
    ],
  );

  const confirmPhoneReplacement = useCallback(
    async (otp: string): Promise<User> => {
      const expectedUid = phoneVerificationAttempt?.userId;
      const expectedPhoneEpoch = phoneVerificationAttempt?.epoch ?? -1;
      requirePhoneVerificationOwner(expectedUid, expectedPhoneEpoch);
      const linkedUser = await finalizeLinkedProviderPhone(phoneVerificationPhoneNumber, expectedUid, expectedPhoneEpoch);
      const verifiedUser = linkedUser ??
        await AuthService.confirmPhoneReplacementVerification({
          verificationCode: otp,
          confirmationResult,
          verificationId: nativeVerificationId,
        });
      requirePhoneVerificationOwner(expectedUid, expectedPhoneEpoch);
      if (verifiedUser?.uid !== expectedUid) throw new Error("The verified account changed. Start phone verification again.");
      // Web replacement updates the primary provider too. Both platforms must
      // explicitly persist the new phone before reporting completion.
      if (!linkedUser) {
        await AccountIdentityService.finalizeNativePhoneVerification(
          verifiedUser, phoneVerificationPhoneNumber,
        );
        requirePhoneVerificationOwner(expectedUid, expectedPhoneEpoch);
      }
      if (!Capacitor.isNativePlatform()) {
        resetRecaptcha();
      }
      setConfirmationResult(null);
      setNativeVerificationId(null);
      setPhoneVerificationPhoneNumber(null);

      const refreshedUser = verifiedUser ?? (await refreshUser());
      applyAuthUser(refreshedUser);
      phoneVerificationOwnerRef.current = null;
      if (!refreshedUser) {
        throw new Error(
          "Phone verification completed but the session could not be refreshed.",
        );
      }
      return refreshedUser;
    },
    [
      applyAuthUser, confirmationResult, nativeVerificationId,
      phoneVerificationAttempt, phoneVerificationPhoneNumber,
      refreshUser, requirePhoneVerificationOwner, finalizeLinkedProviderPhone,
    ],
  );

  const beginPostAuthSettlement = useCallback(
    (nextUser: User) => {
      // This entrypoint is reached only after a new interactive credential has
      // succeeded, so it may intentionally establish even the same UID again.
      terminalInvalidationLatchRef.current = null;
      nativeRestoreEpochRef.current.invalidate();
      nativeRestoreSettledRef.current = true;
      postAuthSettlementEpochRef.current += 1;
      const settlementId = postAuthSettlementEpochRef.current;
      activePostAuthSettlementRef.current = settlementId;
      applyAuthUser(nextUser);
      setLoading(true);
      return settlementId;
    },
    [applyAuthUser],
  );

  const completePostAuthSettlement = useCallback((settlementId: number) => {
    if (activePostAuthSettlementRef.current !== settlementId) return;
    activePostAuthSettlementRef.current = null;
    setLoading(false);
  }, []);

  const setNativeUser = useCallback(
    (nextUser: User | null) => {
      console.log("🍎 [AuthContext] Manually setting Native User");
      if (nextUser) {
        terminalInvalidationLatchRef.current = null;
      }
      // AuthStep has a confirmed native Apple result. Invalidate any launch or
      // resume restore that started before the Apple sheet completed.
      nativeRestoreEpochRef.current.invalidate();
      nativeRestoreSettledRef.current = true;
      applyAuthUser(nextUser);
      setLoading(false);
    },
    [applyAuthUser],
  );

  // Memoised so the 130+ useAuth() consumers re-render on an auth fact, not
  // on every render of this provider. Every method above is a stable
  // useCallback, so the dependency list is the state plus those callbacks.
  const value = useMemo<AuthContextType>(
    () => ({
      user,
      loading,
      sessionVerificationRequired,
      phoneNumber,
      phoneNumberStatus,
      resolveVerifiedPhoneNumber,
      // Derived
      // Unified Auth State: Authenticated = Identity Verified.
      isAuthenticated: !!user,
      userId,
      // Methods
      startPhoneVerification,
      confirmPhoneVerification,
      startPhoneReplacement,
      confirmPhoneReplacement,
      signOut,
      checkAuth,
      refreshUser,
      retrySessionVerification,
      beginPostAuthSettlement,
      completePostAuthSettlement,
      setNativeUser,
    }),
    [
      user,
      loading,
      sessionVerificationRequired,
      phoneNumber,
      phoneNumberStatus,
      resolveVerifiedPhoneNumber,
      userId,
      startPhoneVerification,
      confirmPhoneVerification,
      startPhoneReplacement,
      confirmPhoneReplacement,
      signOut,
      checkAuth,
      refreshUser,
      retrySessionVerification,
      beginPostAuthSettlement,
      completePostAuthSettlement,
      setNativeUser,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ============================================================================
// Hook
// ============================================================================

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
