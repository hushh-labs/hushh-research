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
import {
  User,
  ConfirmationResult,
  onAuthStateChanged,
} from "firebase/auth";
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

// Pre-compute platform check to avoid dynamic imports in callbacks
const IS_NATIVE = typeof window !== "undefined" && Capacitor.isNativePlatform();
const AUTH_SESSION_INVALIDATED_EVENT = "auth-session-invalidated";

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
    | undefined
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
  phoneNumber: string | null;
  // Derived state
  isAuthenticated: boolean;
  userId: string | null;
  // Methods
  startPhoneVerification: (
    phoneNumber: string,
    options?: { resendCode?: boolean }
  ) => Promise<{ autoVerified: boolean; user?: User | null }>;
  confirmPhoneVerification: (otp: string) => Promise<User>;
  startPhoneReplacement: (
    phoneNumber: string,
    options?: { resendCode?: boolean }
  ) => Promise<{ autoVerified: boolean; user?: User | null }>;
  confirmPhoneReplacement: (otp: string) => Promise<User>;
  signOut: (options?: {
    redirectTo?: string;
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
  const [confirmationResult, setConfirmationResult] =
    useState<ConfirmationResult | null>(null);
  const [nativeVerificationId, setNativeVerificationId] = useState<string | null>(null);
  const [phoneVerificationPhoneNumber, setPhoneVerificationPhoneNumber] =
    useState<string | null>(null);
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);

  // Hussh state
  const [userId, setUserId] = useState<string | null>(null);

  const router = useRouter();
  const userRef = useRef<User | null>(null);
  const authRecoveryInFlightRef = useRef(false);
  const signOutPromiseRef = useRef<Promise<void> | null>(null);
  const postAuthSettlementEpochRef = useRef(0);
  const activePostAuthSettlementRef = useRef<number | null>(null);
  // Firebase JS commonly emits `null` before the native keychain/provider has
  // finished restoring. Until this flips, native restoration owns the loading
  // state and the JS listener must not publish a false signed-out transition.
  const nativeRestoreSettledRef = useRef(!IS_NATIVE);
  const nativeRestoreEpochRef = useRef(new NativeAuthRestoreEpoch());

  const applyAuthUser = useCallback((nextUser: User | null) => {
    userRef.current = nextUser;
    setUser(nextUser);
    setUserId(nextUser?.uid ?? null);
    setPhoneNumber(nextUser?.phoneNumber ?? null);
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

  useEffect(() => {
    if (!user || phoneNumber) {
      return;
    }

    let cancelled = false;

    const hydrateBackendPhone = async () => {
      const identity = await AccountIdentityService.refreshCurrentUserIdentity(user, {
        force: false,
      });
      if (cancelled) return;
      const backendPhone = verifiedBackendPhoneNumber(identity);
      if (backendPhone) {
        setPhoneNumber(backendPhone);
      }
    };

    if (!isGmailStartupRoute()) {
      void hydrateBackendPhone();
      return () => {
        cancelled = true;
      };
    }

    const cancelIdle = runWhenBrowserIsIdle(() => {
      void hydrateBackendPhone();
    });

    return () => {
      cancelled = true;
      cancelIdle();
    };
  }, [phoneNumber, user]);

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
      try {
        const nativeUser = await AuthService.restoreNativeSession();

        if (!nativeRestoreEpochRef.current.isCurrent(restoreEpoch)) {
          return;
        }

        if (nativeUser) {
          console.log("🍎 [AuthProvider] Native session restored");
          applyAuthUser(nativeUser);
        } else {
          console.log("🍎 [AuthProvider] No native session found");
          applyAuthUser(null);
        }
      } catch (_error) {
        if (!nativeRestoreEpochRef.current.isCurrent(restoreEpoch)) {
          return;
        }
        console.warn("🍎 [AuthProvider] Native restore error");
        applyAuthUser(null);
        // User will need to log in again
      } finally {
        if (!nativeRestoreEpochRef.current.isCurrent(restoreEpoch)) {
          return;
        }
        nativeRestoreSettledRef.current = true;
        // ✅ CRITICAL: Always set loading to false after native check
        // This ensures VaultLockGuard can proceed (to login or vault unlock)
        setLoading(false);
      }
      return; // Exit early for native - don't wait for onAuthStateChanged
    }

    // 3. Web Platform: Let onAuthStateChanged handle loading state
    // (It will call setLoading(false) when it fires)
    // But add a safety timeout in case Firebase is slow
    setTimeout(() => {
      setLoading((current) => {
        if (current) {
          console.warn(
            "⚠️ [AuthProvider] Auth check timeout - forcing loading=false"
          );
          return false;
        }
        return current;
      });
    }, 10000); // 10s safety timeout for web
  }, [applyAuthUser]);

  // Keep ref in sync with state
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  // Initialize on Mount - CRITICAL: Do not depend on `user` to avoid render loops
  useEffect(() => {
    let mounted = true;
    let removeLifecycleListener: (() => void) | null = null;

    const init = async () => {
      if (IS_NATIVE) {
        removeLifecycleListener = appInteractionCoordinator.subscribeLifecycle(() => {
          const lifecycle = appInteractionCoordinator.getLifecycleSnapshot();
          if (lifecycle.state === "background") {
            // Defensive cleanup for an obsolete storage key only. VaultProvider
            // owns the actual in-memory vault and does not lock on background.
            removeLocalItem("vault_key");
            removeSessionItem("vault_key");
            return;
          }

          if (!userRef.current) {
            void checkAuth();
          }
        });
      }

      await checkAuth();
    };

    init();

    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      if (!mounted) return;

      // Native identity has one publication authority: checkAuth/refreshUser
      // for restoration and the explicit post-auth settlement for sign-in.
      // The WebView Firebase observer can fire either null or a matching user
      // while the native Apple SDK is still completing, so publishing either
      // value here would reopen the setup/vault race.
      if (IS_NATIVE) {
        if (!firebaseUser && !nativeRestoreSettledRef.current) {
          console.log(
            "🍎 [AuthContext] Ignoring Firebase Null State While Native Restore Is Pending"
          );
        } else {
          console.log(
            "🍎 [AuthContext] Ignoring Firebase JS State (Native Mode)"
          );
        }
        return;
      }

      applyAuthUser(firebaseUser);
      // Only stop loading if we actually got a user or valid null (web)
      setLoading(false);
    });

    return () => {
      mounted = false;
      removeLifecycleListener?.();
      unsubscribe();
    };
  }, [applyAuthUser, checkAuth]); // Do not depend on `user`; that would re-run auth init on every user state update.

  // Sign out
  const signOut = useCallback(async (options?: {
    redirectTo?: string;
    skipFcmCleanup?: boolean;
  }): Promise<void> => {
    if (signOutPromiseRef.current) {
      return signOutPromiseRef.current;
    }

    const operation = (async () => {
      // A restore or post-auth settlement that began before sign-out must
      // never repopulate auth state. Keep the sign-out barrier active through
      // the terminal navigation below.
      nativeRestoreEpochRef.current.invalidate();
      nativeRestoreSettledRef.current = true;
      postAuthSettlementEpochRef.current += 1;
      activePostAuthSettlementRef.current = null;
      const currentUser = userRef.current;
      const currentUid = currentUser?.uid ?? null;
      const redirectTo = options?.redirectTo || ROUTES.HOME;
      setLoading(true);

      try {
        // The sign-out mail must be asked for while the credential is still
        // valid — a moment later `AuthService.signOut()` invalidates it and the
        // route would reject the token. Not awaited: sign-out is a security
        // action and must never wait on, or be failed by, a mail. Deliberately
        // skipped for account deletion, where mailing "you signed out" to an
        // account that no longer exists would be wrong.
        if (currentUid && !options?.skipFcmCleanup) {
          const signOutToken = await currentUser?.getIdToken().catch(() => undefined);
          if (signOutToken) {
            void ApiService.notifyAuthMail("signed_out", { idToken: signOutToken });
          }
        }

        // Delete FCM token before signing out (requires auth). Skipped for the
        // account-deletion flow: the backend already removes the account and its
        // push tokens, so this would only add a redundant network round-trip to
        // the wait before redirect.
        if (currentUid && !options?.skipFcmCleanup) {
          try {
            const idToken = await currentUser?.getIdToken();
            const { deleteFCMToken } = await import("@/lib/notifications/fcm-service");
            await deleteFCMToken(currentUid, idToken);
          } catch (fcmErr) {
            console.warn("FCM token cleanup on signOut failed (non-critical):", fcmErr);
          }
        }

        // Clear the server-owned httpOnly session independently from the
        // native/JS Firebase credentials. Logout must not leave a valid web
        // session cookie behind merely because one auth transport failed.
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
        CacheSyncService.onAuthSignedOut(currentUid);
        if (currentUid) {
          await UserLocalStateService.clearForUser(currentUid);
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

        if (IS_NATIVE && typeof window !== "undefined") {
          // Logout is a terminal security boundary. A document replacement
          // prevents App Router history, delayed transition callbacks, or a
          // stale WebView tree from re-entering the authenticated route.
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
      if (signOutPromiseRef.current === operation && !IS_NATIVE) {
        signOutPromiseRef.current = null;
      }
    }
  }, [applyAuthUser, router]);

  useEffect(() => {
    const handleAuthInvalidated = (event: Event) => {
      const customEvent = event as CustomEvent<{ reason?: string; path?: string }>;
      console.warn(
        "🔒 [AuthProvider] Auth session invalidated:",
        customEvent.detail?.reason || "unknown reason"
      );
      if (authRecoveryInFlightRef.current) {
        return;
      }

      const recoverOrSignOut = async () => {
        authRecoveryInFlightRef.current = true;
        try {
          if (Capacitor.isNativePlatform()) {
            const restoreEpoch = nativeRestoreEpochRef.current.begin();
            nativeRestoreSettledRef.current = false;
            const [nativeUser, refreshedToken] = await Promise.all([
              AuthService.restoreNativeSession(),
              AuthService.getIdToken(true),
            ]);

            if (!nativeRestoreEpochRef.current.isCurrent(restoreEpoch)) {
              return;
            }

            if (
              nativeUser &&
              refreshedToken
            ) {
              console.info("🍎 [AuthProvider] Recovered native session after auth invalidation");
              applyAuthUser(nativeUser);
              setLoading(false);
              return;
            }
            nativeRestoreSettledRef.current = true;
          }

          await signOut({ redirectTo: ROUTES.LOGIN });
        } finally {
          authRecoveryInFlightRef.current = false;
        }
      };

      void recoverOrSignOut();
    };

    window.addEventListener(AUTH_SESSION_INVALIDATED_EVENT, handleAuthInvalidated);
    return () =>
      window.removeEventListener(AUTH_SESSION_INVALIDATED_EVENT, handleAuthInvalidated);
  }, [applyAuthUser, signOut]);

  const startPhoneVerification = useCallback(
    async (
      phone: string,
      options?: { resendCode?: boolean }
    ): Promise<{ autoVerified: boolean; user?: User | null }> => {
      return await (async () => {
        setConfirmationResult(null);
        setNativeVerificationId(null);
        setPhoneVerificationPhoneNumber(null);
        const isNative = Capacitor.isNativePlatform();
        const useLocalDevPhoneVerification =
          !isNative && AuthService.shouldUseLocalDevPhoneVerification(phone);

        let result:
          | Awaited<ReturnType<typeof AuthService.startPhoneLinkVerification>>
          | null = null;
        try {
          // UAT phone-test allowlist path (fixed OTP, no SMS) — attempt on BOTH
          // web AND native so test numbers work in the iOS app. The backend gates
          // it to ENVIRONMENT=uat + the configured allowlist, so prod / non-listed
          // numbers come back ineligible and fall through to real Firebase below.
          if (!useLocalDevPhoneVerification) {
            const uatPhoneTest =
              await AccountIdentityService.startUatTestPhoneVerification(
                userRef.current,
                phone
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
              recaptchaVerifier: isNative || useLocalDevPhoneVerification
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
    [applyAuthUser, refreshUser]
  );

  const startPhoneReplacement = useCallback(
    async (
      phone: string,
      options?: { resendCode?: boolean }
    ): Promise<{ autoVerified: boolean; user?: User | null }> => {
      setConfirmationResult(null);
      setNativeVerificationId(null);
      setPhoneVerificationPhoneNumber(null);
      const isNative = Capacitor.isNativePlatform();

      let result: Awaited<ReturnType<typeof AuthService.startPhoneReplacementVerification>>;
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
    [applyAuthUser, refreshUser]
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
                const phoneNumberForVerification =
                  String(phoneVerificationPhoneNumber ?? "").trim();
                if (!phoneNumberForVerification || !nativeVerificationId) {
                  throw new Error("Phone verification session expired. Please try again.");
                }
                const identity =
                  await AccountIdentityService.confirmUatTestPhoneVerification(
                    userRef.current,
                    {
                      phoneNumber: phoneNumberForVerification,
                      verificationCode: otp,
                      verificationId: nativeVerificationId,
                    }
                  );
                if (!AccountIdentityService.hasVerifiedPhone(identity)) {
                  throw new Error(
                    "Phone verification completed but the backend could not confirm the phone claim."
                  );
                }
                return userRef.current;
              })()
          : await (async () => {
              const phoneIdToken = await AuthService.getPhoneClaimIdToken({
                verificationCode: otp,
                verificationId: nativeVerificationId,
              });
              const identity = await AccountIdentityService.claimCurrentUserPhone(
                userRef.current,
                phoneIdToken
              );
              if (!AccountIdentityService.hasVerifiedPhone(identity)) {
                throw new Error(
                  "Phone verification completed but the backend could not confirm the phone claim."
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
          throw new Error("Phone verification completed but the session could not be refreshed.");
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
    ]
  );

  const confirmPhoneReplacement = useCallback(
    async (otp: string): Promise<User> => {
      const verifiedUser = await AuthService.confirmPhoneReplacementVerification({
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
        throw new Error("Phone verification completed but the session could not be refreshed.");
      }
      return refreshedUser;
    },
    [applyAuthUser, confirmationResult, nativeVerificationId, refreshUser]
  );

  const value: AuthContextType = {
    user,
    loading,
    phoneNumber,
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
    beginPostAuthSettlement: (nextUser: User) => {
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
