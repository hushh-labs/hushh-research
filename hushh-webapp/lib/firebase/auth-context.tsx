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
  useState,
  ReactNode,
  useCallback,
  useRef,
} from "react";
import { useRouter } from "next/navigation";
import { User, ConfirmationResult, onAuthStateChanged } from "firebase/auth";
import { auth, prepareRecaptchaVerifier, resetRecaptcha } from "./config";
import { NativeAuthRestoreEpoch } from "./native-auth-restore-epoch";
import { Capacitor } from "@capacitor/core";
import { AuthService } from "@/lib/services/auth-service";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
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
  removeSessionItem,
} from "@/lib/utils/session-storage";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import { ApiService } from "@/lib/services/api-service";
import { setObservabilityUserId } from "@/lib/observability/identity";
import { isLocalCrmBuildEnabled } from "@/lib/connected-systems/crm-product-availability";
import {
  completeNativeSessionPrivacyValidation,
  getNativeSessionPrivacyState,
} from "@/lib/capacitor/session-privacy";
import {
  AUTH_SESSION_INVALIDATED_EVENT,
  authSessionInvalidationFromSiblingTabStorageEvent,
  authSessionInvalidationCodeFromBackendPayload,
  authSessionInvalidationCodeFromFirebaseError,
  buildLoginRouteWithAuthSessionNotice,
  dispatchAuthSessionInvalidated,
  isAccountDeletionInProgressBackendPayload,
  isAuthSessionInvalidationCode,
  type AuthSessionInvalidationDetail,
  type AuthSessionInvalidationCode,
} from "@/lib/auth/session-invalidation";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

// Pre-compute platform check to avoid dynamic imports in callbacks
const IS_NATIVE = typeof window !== "undefined" && Capacitor.isNativePlatform();
const ACTIVE_SESSION_VALIDATION_DEBOUNCE_MS = 1_500;
const WEB_AUTH_OBSERVER_WATCHDOG_MS = 10_000;
const ACCOUNT_SESSION_VALIDATION_BUDGET_MS = 8_000;
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
      code: "account_not_found" | "session_invalid";
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
    const code = authSessionInvalidationCodeFromBackendPayload(payload);
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

function verifiedBackendPhoneNumber(
  identity:
    | {
        phone_number?: string | null;
        phone_verified?: boolean;
      }
    | null
    | undefined,
): string | null {
  if (identity?.phone_verified !== true) return null;
  const phone = String(identity.phone_number ?? "").trim();
  return phone || null;
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
  const [confirmationResult, setConfirmationResult] =
    useState<ConfirmationResult | null>(null);
  const [nativeVerificationId, setNativeVerificationId] = useState<
    string | null
  >(null);
  const [phoneVerificationPhoneNumber, setPhoneVerificationPhoneNumber] =
    useState<string | null>(null);
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);

  // Hussh state
  const [userId, setUserId] = useState<string | null>(null);

  const router = useRouter();
  const userRef = useRef<User | null>(null);
  const phoneNumberRef = useRef<string | null>(null);
  const verifiedPhoneResolutionRef = useRef<{
    userId: string;
    promise: Promise<string | null>;
  } | null>(null);
  const authRecoveryInFlightRef = useRef(false);
  const terminalInvalidationLatchRef = useRef<{
    invalidatedUserId: string | null;
    observedAnonymous: boolean;
  } | null>(null);
  const activeSessionValidationPromiseRef = useRef<Promise<void> | null>(null);
  // A web auth observer can validate a new identity while a foreground check
  // for the previously published identity is still settling. Only the current
  // observer may release this gate; otherwise the old Vault can flash before
  // the new identity has been validated and published.
  const webAuthObserverPendingRef = useRef(false);
  const lastActiveSessionValidationAtRef = useRef(0);
  const signOutPromiseRef = useRef<Promise<void> | null>(null);
  // Makes a completed UID-scoped terminal sign-out idempotent. A deleting UI
  // can finish its slower local cleanup after the central invalidation handler
  // has already navigated; its fallback must not replace the reason-bearing
  // login route or show the notice twice.
  const completedScopedSignOutUserIdRef = useRef<string | null>(null);
  const postAuthSettlementEpochRef = useRef(0);
  const activePostAuthSettlementRef = useRef<number | null>(null);
  // Firebase JS commonly emits `null` before the native keychain/provider has
  // finished restoring. Until this flips, native restoration owns the loading
  // state and the JS listener must not publish a false signed-out transition.
  const nativeRestoreSettledRef = useRef(!IS_NATIVE);
  const nativeRestoreEpochRef = useRef(new NativeAuthRestoreEpoch());

  const applyAuthUser = useCallback((nextUser: User | null) => {
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

    const nextPhoneNumber = nextUser?.phoneNumber ?? null;
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
  }, []);

  const resolveVerifiedPhoneNumber = useCallback(async (): Promise<
    string | null
  > => {
    const currentUser = userRef.current;
    if (!currentUser?.uid) return null;

    const existingPhone = String(
      phoneNumberRef.current ?? currentUser.phoneNumber ?? "",
    ).trim();
    if (existingPhone) return existingPhone;

    const cachedIdentity = AccountIdentityService.peekCachedIdentity(
      currentUser.uid,
    );
    const cachedPhone = cachedIdentity?.isStale
      ? null
      : verifiedBackendPhoneNumber(cachedIdentity?.data);
    if (cachedPhone) {
      phoneNumberRef.current = cachedPhone;
      setPhoneNumber(cachedPhone);
      return cachedPhone;
    }

    const inFlight = verifiedPhoneResolutionRef.current;
    if (inFlight?.userId === currentUser.uid) {
      return inFlight.promise;
    }

    const promise = (async () => {
      // A non-forced read can legally return a fresh but phone-incomplete
      // shadow. Contact normalization needs an authoritative region, so this
      // missing-phone path must consult Firebase even when that cache is fresh.
      const identity = await AccountIdentityService.refreshCurrentUserIdentity(
        currentUser,
        { force: true },
      );
      if (userRef.current?.uid !== currentUser.uid) return null;

      const backendPhone = verifiedBackendPhoneNumber(identity);
      if (backendPhone) {
        phoneNumberRef.current = backendPhone;
        setPhoneNumber(backendPhone);
      }
      return backendPhone;
    })();
    verifiedPhoneResolutionRef.current = {
      userId: currentUser.uid,
      promise,
    };
    try {
      return await promise;
    } finally {
      if (verifiedPhoneResolutionRef.current?.promise === promise) {
        verifiedPhoneResolutionRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    if (!user || phoneNumber) {
      return;
    }

    const hydrateBackendPhone = () => {
      void resolveVerifiedPhoneNumber().catch(() => undefined);
    };

    if (!isGmailStartupRoute()) {
      hydrateBackendPhone();
      return;
    }

    const cancelIdle = runWhenBrowserIsIdle(() => {
      void hydrateBackendPhone();
    });

    return () => {
      cancelIdle();
    };
  }, [phoneNumber, resolveVerifiedPhoneNumber, user]);

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
          }
        } catch {
          // A transport/backend outage is not evidence of deletion. Fall back
          // to Firebase's own forced validation below.
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
    // later foreground-validation or sign-out loading gate.
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

        try {
          // The sign-out mail must be asked for while the credential is still
          // valid — a moment later `AuthService.signOut()` invalidates it and the
          // route would reject the token. Not awaited: sign-out is a security
          // action and must never wait on, or be failed by, a mail. Deliberately
          // skipped for account deletion, where mailing "you signed out" to an
          // account that no longer exists would be wrong.
          if (currentUser && !options?.skipFcmCleanup) {
            const signOutToken = await currentUser
              ?.getIdToken()
              .catch(() => undefined);
            if (signOutToken) {
              void ApiService.notifyAuthMail("signed_out", {
                idToken: signOutToken,
              });
            }
          }

          // Delete FCM token before signing out (requires auth). Skipped for the
          // account-deletion flow: the backend already removes the account and its
          // push tokens, so this would only add a redundant network round-trip to
          // the wait before redirect.
          if (currentUser && !options?.skipFcmCleanup) {
            try {
              const idToken = await currentUser.getIdToken();
              const { deleteFCMToken } =
                await import("@/lib/notifications/fcm-service");
              await deleteFCMToken(currentUser.uid, idToken);
            } catch (fcmErr) {
              console.warn(
                "FCM token cleanup on signOut failed (non-critical):",
                fcmErr,
              );
            }
          }

          // Clear the server-owned httpOnly session independently from the
          // native/JS Firebase credentials. Logout must not leave a valid web
          // session cookie behind merely because one auth transport failed.
          // Mail/FCM cleanup above can yield long enough for another tab to sign
          // into a different account. Re-check immediately before touching the
          // global Firebase identity or the shared web session cookie.
          ownsExpectedSession = stillOwnsExpectedSession();
          if (!ownsExpectedSession) return;

          const cleanupTasks: Promise<unknown>[] = [AuthService.signOut()];
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

          if (IS_NATIVE && typeof window !== "undefined") {
            // Logout is a terminal security boundary. A document replacement
            // prevents App Router history, delayed transition callbacks, or a
            // stale WebView tree from re-entering the authenticated route.
            terminalNavigationCommitted = true;
            window.location.replace(redirectTo);
          } else {
            router.replace(redirectTo);
            setLoading(false);
          }
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
        }
      }
    },
    [applyAuthUser, router],
  );

  /**
   * Revalidate an already-published identity whenever the app becomes active.
   * The validation is single-flight and briefly restores the auth loading gate
   * so a cached Vault dialog cannot flash while Firebase is deciding whether
   * the account still exists.
   */
  const validateActiveSession = useCallback(
    (options?: { force?: boolean }): Promise<void> => {
      const force = options?.force === true;
      const predecessor = activeSessionValidationPromiseRef.current;

      // Ordinary focus/pageshow events remain single-flight. A shielded native
      // resume is different: if its lifecycle boundary occurred after the
      // current validation began, it must enqueue a new backend check instead of
      // accepting that older result for the new privacy generation.
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
        // Set the React gate before waiting for an older validation. The native
        // overlay protects the first frame; this prevents the WebView tree from
        // becoming visible between serialized checks.
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

        const now = Date.now();
        if (
          !force &&
          now - lastActiveSessionValidationAtRef.current <
            ACTIVE_SESSION_VALIDATION_DEBOUNCE_MS
        ) {
          return;
        }
        lastActiveSessionValidationAtRef.current = now;
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
              path: "app_foreground",
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

    const settleNativePrivacyProtectedSession = async () => {
      const privacyState = await withinAccountSessionValidationBudget(
        getNativeSessionPrivacyState(),
        Date.now() + NATIVE_SESSION_PRIVACY_READ_BUDGET_MS,
      ).catch(() => ({ shielded: false, generation: 0 }));
      try {
        if (userRef.current) {
          await validateActiveSession({ force: privacyState.shielded });
        } else {
          await checkAuth();
        }
      } finally {
        if (
          mounted &&
          privacyState.shielded &&
          !terminalInvalidationLatchRef.current &&
          !signOutPromiseRef.current
        ) {
          await completeNativeSessionPrivacyValidation(
            privacyState.generation,
          ).catch(() => undefined);
        }
      }
    };

    const removeLifecycleListener =
      appInteractionCoordinator.subscribeLifecycle(() => {
        const lifecycle = appInteractionCoordinator.getLifecycleSnapshot();
        if (lifecycle.state === "background") {
          if (IS_NATIVE) {
            // Mirror the native cover with the React auth gate. The OS-level
            // shield protects the very first resume frame; this gate protects
            // all subsequent WebView renders until validation settles.
            setLoading(true);
            // Defensive cleanup for an obsolete storage key only. VaultProvider
            // owns the actual in-memory vault and does not lock on background.
            removeLocalItem("vault_key");
            removeSessionItem("vault_key");
          }
          return;
        }

        if (IS_NATIVE) {
          void settleNativePrivacyProtectedSession();
        } else if (userRef.current) {
          void validateActiveSession();
        }
      });

    const validateWhenVisible = () => {
      if (document.visibilityState !== "visible" || !userRef.current) return;
      void validateActiveSession();
    };
    window.addEventListener("focus", validateWhenVisible);
    window.addEventListener("pageshow", validateWhenVisible);

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
          if (!mounted || revision !== webAuthRevision) {
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
          if (!mounted || revision !== webAuthRevision) return;
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
      webAuthRevision += 1;
      webAuthObserverPendingRef.current = false;
      markInitialWebAuthObserverReceived();
      removeLifecycleListener();
      window.removeEventListener("focus", validateWhenVisible);
      window.removeEventListener("pageshow", validateWhenVisible);
      unsubscribe();
    };
  }, [applyAuthUser, checkAuth, validateAccountSession, validateActiveSession]);

  const startPhoneVerification = useCallback(
    async (
      phone: string,
      options?: { resendCode?: boolean },
    ): Promise<{ autoVerified: boolean; user?: User | null }> => {
      return await (async () => {
        setConfirmationResult(null);
        setNativeVerificationId(null);
        setPhoneVerificationPhoneNumber(null);
        const isNative = Capacitor.isNativePlatform();
        const useLocalDevPhoneVerification =
          !isNative && AuthService.shouldUseLocalDevPhoneVerification(phone);

        let result: Awaited<
          ReturnType<typeof AuthService.startPhoneLinkVerification>
        > | null = null;
        try {
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
            if (uatPhoneTest?.eligible && uatPhoneTest.verification_id) {
              result = {
                autoVerified: false,
                verificationId: uatPhoneTest.verification_id,
              };
            }
          }

          if (!result) {
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
          const refreshedUser = result.user ?? (await refreshUser());
          applyAuthUser(refreshedUser);
          return {
            autoVerified: true,
            user: refreshedUser,
          };
        }

        return { autoVerified: false };
      })();
    },
    [applyAuthUser, refreshUser],
  );

  const startPhoneReplacement = useCallback(
    async (
      phone: string,
      options?: { resendCode?: boolean },
    ): Promise<{ autoVerified: boolean; user?: User | null }> => {
      setConfirmationResult(null);
      setNativeVerificationId(null);
      setPhoneVerificationPhoneNumber(null);
      const isNative = Capacitor.isNativePlatform();

      let result: Awaited<
        ReturnType<typeof AuthService.startPhoneReplacementVerification>
      >;
      try {
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
        const refreshedUser = result.user ?? (await refreshUser());
        applyAuthUser(refreshedUser);
        return {
          autoVerified: true,
          user: refreshedUser,
        };
      }

      return { autoVerified: false };
    },
    [applyAuthUser, refreshUser],
  );

  const confirmPhoneVerification = useCallback(
    async (otp: string): Promise<User> => {
      return await (async () => {
        // A uat-test verification id means the start path used the backend
        // allowlist flow — confirm it via the UAT-test path on BOTH native + web
        // (not the real Firebase native link) so iOS test numbers work.
        const useNativeFirebaseConfirm =
          Capacitor.isNativePlatform() &&
          !AuthService.isUatPhoneTestVerificationId(nativeVerificationId);
        const verifiedUser = useNativeFirebaseConfirm
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
                      userRef.current,
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
                  return userRef.current;
                })()
              : await (async () => {
                  const phoneIdToken = await AuthService.getPhoneClaimIdToken({
                    verificationCode: otp,
                    verificationId: nativeVerificationId,
                  });
                  const identity =
                    await AccountIdentityService.claimCurrentUserPhone(
                      userRef.current,
                      phoneIdToken,
                    );
                  if (!AccountIdentityService.hasVerifiedPhone(identity)) {
                    throw new Error(
                      "Phone verification completed but the backend could not confirm the phone claim.",
                    );
                  }
                  return userRef.current;
                })();
        if (!Capacitor.isNativePlatform()) {
          resetRecaptcha();
        }
        setConfirmationResult(null);
        setNativeVerificationId(null);
        setPhoneVerificationPhoneNumber(null);

        const refreshedUser = verifiedUser ?? (await refreshUser());
        applyAuthUser(refreshedUser);
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
      refreshUser,
    ],
  );

  const confirmPhoneReplacement = useCallback(
    async (otp: string): Promise<User> => {
      const verifiedUser =
        await AuthService.confirmPhoneReplacementVerification({
          verificationCode: otp,
          confirmationResult,
          verificationId: nativeVerificationId,
        });
      if (!Capacitor.isNativePlatform()) {
        resetRecaptcha();
      }
      setConfirmationResult(null);
      setNativeVerificationId(null);
      setPhoneVerificationPhoneNumber(null);

      const refreshedUser = verifiedUser ?? (await refreshUser());
      applyAuthUser(refreshedUser);
      if (!refreshedUser) {
        throw new Error(
          "Phone verification completed but the session could not be refreshed.",
        );
      }
      return refreshedUser;
    },
    [applyAuthUser, confirmationResult, nativeVerificationId, refreshUser],
  );

  const value: AuthContextType = {
    user,
    loading,
    sessionVerificationRequired,
    phoneNumber,
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
    retrySessionVerification: async () => {
      if (IS_NATIVE && !userRef.current) {
        setLoading(true);
        await checkAuth();
        return;
      }
      await validateActiveSession({ force: true });
    },
    beginPostAuthSettlement: (nextUser: User) => {
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
    completePostAuthSettlement: (settlementId: number) => {
      if (activePostAuthSettlementRef.current !== settlementId) return;
      activePostAuthSettlementRef.current = null;
      setLoading(false);
    },
    setNativeUser: (user: User | null) => {
      console.log("🍎 [AuthContext] Manually setting Native User");
      if (user) {
        terminalInvalidationLatchRef.current = null;
      }
      // AuthStep has a confirmed native Apple result. Invalidate any launch or
      // resume restore that started before the Apple sheet completed.
      nativeRestoreEpochRef.current.invalidate();
      nativeRestoreSettledRef.current = true;
      applyAuthUser(user);
      setLoading(false);
    },
  };

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
