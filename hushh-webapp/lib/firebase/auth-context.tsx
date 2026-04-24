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
import { Capacitor } from "@capacitor/core";
import { AuthService } from "@/lib/services/auth-service";
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

// Pre-compute platform check to avoid dynamic imports in callbacks
const IS_NATIVE = typeof window !== "undefined" && Capacitor.isNativePlatform();
const AUTH_SESSION_INVALIDATED_EVENT = "auth-session-invalidated";

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
  signOut: (options?: { redirectTo?: string }) => Promise<void>;
  checkAuth: () => Promise<void>; // Manually trigger auth check (e.g. after native login)
  setNativeUser: (user: User | null) => void; // Helper to manually set user state
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
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);

  // Hussh state
  const [userId, setUserId] = useState<string | null>(null);

  const router = useRouter();
  const userRef = useRef<User | null>(null);
  const authRecoveryInFlightRef = useRef(false);

  const applyAuthUser = useCallback((nextUser: User | null) => {
    userRef.current = nextUser;
    setUser(nextUser);
    setUserId(nextUser?.uid ?? null);
    setPhoneNumber(nextUser?.phoneNumber ?? null);
  }, []);

  const refreshUser = useCallback(async (): Promise<User | null> => {
    if (Capacitor.isNativePlatform()) {
      const nativeUser = await AuthService.restoreNativeSession();
      applyAuthUser(nativeUser);
      setLoading(false);
      return nativeUser;
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
    // 1. Native Session Restoration
    if (Capacitor.isNativePlatform()) {
      try {
        const nativeUser = await AuthService.restoreNativeSession();

        if (nativeUser) {
          console.log(
            "🍎 [AuthProvider] Native session restored:",
            nativeUser.uid
          );
          applyAuthUser(nativeUser);
        } else {
          console.log("🍎 [AuthProvider] No native session found");
          applyAuthUser(null);
        }
      } catch (e) {
        console.warn("🍎 [AuthProvider] Native restore error:", e);
        applyAuthUser(null);
        // User will need to log in again
      } finally {
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

    const init = async () => {
      // App State Listener (Background clear)
      if (typeof window !== "undefined" && IS_NATIVE) {
        try {
          const { App } = await import("@capacitor/app");

          await App.addListener("appStateChange", ({ isActive }) => {
            if (!isActive) {
              console.log(
                "🔒 [AuthProvider] App backgrounded - clearing sensitive data"
              );
              // DEFENSIVE CLEANUP: Remove any legacy vault_key from storage
              // Vault key should be managed by VaultContext (memory-only)
              removeLocalItem("vault_key");
              removeSessionItem("vault_key");

              // Reactive state will handle UI updates (e.g. VaultLockGuard will see locked vault)
              // No need to force reload, which causes loops on some Android devices
              return;
            }

            if (!userRef.current) {
              console.log("🍎 [AuthProvider] App active with no in-memory user - rechecking native auth");
              void checkAuth();
            }
          });
        } catch (error) {
          console.warn("⚠️ [AuthProvider] Failed to install native app-state listener", error);
        }
      }

      await checkAuth();
    };

    init();

    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      if (!mounted) return;

      // Safety: Don't overwrite a valid User with null if on Native
      // The Firebase JS SDK often fires 'null' on startup or network change in Capacitor apps
      // Use ref to check current user without adding `user` to dependencies
      if (IS_NATIVE) {
        if (!firebaseUser && userRef.current) {
          console.log(
            "🍎 [AuthContext] Ignoring Firebase Null State (Native Mode)"
          );
          return;
        }
      }

      applyAuthUser(firebaseUser);
      // Only stop loading if we actually got a user or valid null (web)
      setLoading(false);
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [applyAuthUser, checkAuth]); // Do not depend on `user`; that would re-run auth init on every user state update.

  // Sign out
  const signOut = useCallback(async (options?: { redirectTo?: string }): Promise<void> => {
    const currentUid = user?.uid ?? null;
    const redirectTo = options?.redirectTo || ROUTES.HOME;
    try {
      // Delete FCM token before signing out (requires auth)
      if (currentUid) {
        try {
          const idToken = await user?.getIdToken();
          const { deleteFCMToken } = await import("@/lib/notifications/fcm-service");
          await deleteFCMToken(currentUid, idToken);
        } catch (fcmErr) {
          console.warn("FCM token cleanup on signOut failed (non-critical):", fcmErr);
        }
      }

      const { AuthService } = await import("@/lib/services/auth-service");
      await AuthService.signOut(); // Handles Native + Firebase
    } catch (e) {
      console.error("Sign out error", e);
    } finally {
      CacheSyncService.onAuthSignedOut(currentUid);
      if (currentUid) {
        await UserLocalStateService.clearForUser(currentUid);
      }

      userRef.current = null;
      applyAuthUser(null);
      setConfirmationResult(null);
      setNativeVerificationId(null);

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

      router.push(redirectTo);
    }
  }, [applyAuthUser, router, user]);

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
            const [nativeUser, refreshedToken] = await Promise.all([
              AuthService.restoreNativeSession(),
              AuthService.getIdToken(true),
            ]);

            if (nativeUser && refreshedToken) {
              console.info("🍎 [AuthProvider] Recovered native session after auth invalidation");
              applyAuthUser(nativeUser);
              setLoading(false);
              return;
            }
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
        const isNative = Capacitor.isNativePlatform();

        let result: Awaited<ReturnType<typeof AuthService.startPhoneLinkVerification>>;
        try {
          result = await AuthService.startPhoneLinkVerification(phone, {
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
        const verifiedUser = await AuthService.confirmPhoneLinkVerification({
          verificationCode: otp,
          confirmationResult,
          verificationId: nativeVerificationId,
        });
        if (!Capacitor.isNativePlatform()) {
          resetRecaptcha();
        }
        setConfirmationResult(null);
        setNativeVerificationId(null);

        const refreshedUser = verifiedUser ?? (await refreshUser());
        applyAuthUser(refreshedUser);
        if (!refreshedUser) {
          throw new Error("Phone verification completed but the session could not be refreshed.");
        }
        return refreshedUser;
      })();
    },
    [applyAuthUser, confirmationResult, nativeVerificationId, refreshUser]
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
    setNativeUser: (user: User | null) => {
      console.log("🍎 [AuthContext] Manually setting Native User:", user?.uid);
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
