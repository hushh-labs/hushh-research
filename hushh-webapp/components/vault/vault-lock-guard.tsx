"use client";

/**
 * VaultLockGuard - Protects routes requiring vault access
 * ========================================================
 *
 * SECURITY: Detects when user is authenticated but vault is locked
 * (e.g., after page refresh - React state resets but Firebase persists)
 *
 * Flow:
 * - Auth ❌ → Redirect to login
 * - Auth ✅ + Vault ❌ → Show unlock dialog
 * - Auth ✅ + Vault ✅ → Render children
 *
 * SECURITY MODEL (BYOK Compliant):
 * - The vault key is stored ONLY in React state (memory).
 * - On page refresh, React state resets, so the vault key is lost.
 * - We ONLY trust `isVaultUnlocked` from VaultContext (which checks memory state).
 * - We render children only when auth is settled and the vault is unlocked.
 * - Route continuity comes from the mounted VaultProvider's in-memory state.
 * - Cached vault presence selects the gate UI; it never authorizes access.
 */

import { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import {
  VaultAuthSessionNotReadyError,
  VaultService,
} from "@/lib/services/vault-service";
import { VaultUnlockDialog } from "./vault-unlock-dialog";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { useStepProgress } from "@/lib/progress/step-progress-context";
import { useSessionChromeSuppression } from "@/lib/auth/use-session-chrome-suppression";
import { SessionVerificationRecovery } from "@/components/auth/session-verification-recovery";
import {
  hasIncompleteNativeUiFlowSession,
  isNativeTestVaultBootstrapManaged,
  preferPassphraseUnlockForAutomation,
  useNativeTestConfig,
} from "@/lib/testing/native-test";

// ============================================================================
// Types
// ============================================================================

interface VaultLockGuardProps {
  children: React.ReactNode;
}

// ============================================================================
// Component
// ============================================================================

export function VaultLockGuard({ children }: VaultLockGuardProps) {
  const { isVaultUnlocked, unlockVault } = useVault();
  const router = useRouter();
  const nativeTestConfig = useNativeTestConfig();
  const nativeTestBootstrapManaged =
    isNativeTestVaultBootstrapManaged(nativeTestConfig);
  const nativeUiFlowResumePending = hasIncompleteNativeUiFlowSession();
  const holdRouteForNativeTest =
    nativeTestBootstrapManaged || nativeUiFlowResumePending;
  const isNativePlatform = Capacitor.isNativePlatform();
  const skipGeneratedDefaultUnlock =
    preferPassphraseUnlockForAutomation(nativeTestConfig);

  const {
    user,
    loading: authLoading,
    retrySessionVerification,
    sessionVerificationRequired,
    signOut,
  } = useAuth();
  const userId = user?.uid ?? null;
  const { beginTask, completeTaskStep, endTask } = useStepProgress();
  const [hasVault, setHasVault] = useState<boolean | null>(null);
  const [vaultCheckFailed, setVaultCheckFailed] = useState(false);
  useSessionChromeSuppression(
    authLoading || sessionVerificationRequired || vaultCheckFailed,
  );
  const [nativeAuthGraceElapsed, setNativeAuthGraceElapsed] =
    useState(!isNativePlatform);
  const [nativeVaultCheckAttempt, setNativeVaultCheckAttempt] = useState(0);
  const authStepDoneRef = useRef(false);
  const vaultStepDoneRef = useRef(false);
  const nativeReplayAttemptedRef = useRef(false);
  const PROGRESS_SCOPE = "vault-lock-guard";

  useEffect(() => {
    if (!isNativePlatform || authLoading || userId) {
      if (!isNativePlatform || userId) {
        setNativeAuthGraceElapsed(true);
      }
      return undefined;
    }
    if (nativeAuthGraceElapsed) {
      return undefined;
    }
    const timer = window.setTimeout(
      () => setNativeAuthGraceElapsed(true),
      2_000,
    );
    return () => window.clearTimeout(timer);
  }, [authLoading, isNativePlatform, nativeAuthGraceElapsed, userId]);

  useEffect(() => {
    setVaultCheckFailed(false);
    if (!userId) {
      setHasVault(null);
      setNativeVaultCheckAttempt(0);
      return;
    }
    if (isVaultUnlocked) {
      setHasVault(true);
      return;
    }
    // Hydrate first paint from the shared VaultService cache (memory ->
    // session -> bootstrap) so re-mounts do not flash a loader.
    const cached = VaultService.peekVaultPresence(userId);
    // Positive presence may safely select the unlock UI. A negative cache is
    // not authority to reveal a protected route; revalidate it below.
    setHasVault(cached === true ? true : null);
    setNativeVaultCheckAttempt(0);
  }, [isVaultUnlocked, userId]);

  // Redirect unauthenticated users (side-effect outside render)
  useEffect(() => {
    if (authLoading) return;
    if (userId) return;
    if (holdRouteForNativeTest) return;
    if (isNativePlatform && !nativeAuthGraceElapsed) return;

    if (typeof window !== "undefined") {
      const currentPath =
        window.location.pathname +
        window.location.search +
        window.location.hash;
      router.replace(`/login?redirect=${encodeURIComponent(currentPath)}`);
    }
  }, [
    authLoading,
    holdRouteForNativeTest,
    isNativePlatform,
    nativeAuthGraceElapsed,
    router,
    userId,
  ]);

  useEffect(() => {
    if (isVaultUnlocked) {
      nativeReplayAttemptedRef.current = false;
      endTask(PROGRESS_SCOPE);
      authStepDoneRef.current = false;
      vaultStepDoneRef.current = false;
      return;
    }
    beginTask(PROGRESS_SCOPE, 2);
    authStepDoneRef.current = false;
    vaultStepDoneRef.current = false;
    return () => {
      endTask(PROGRESS_SCOPE);
    };
  }, [beginTask, endTask, isVaultUnlocked]);

  useEffect(() => {
    if (
      !nativeTestBootstrapManaged ||
      isVaultUnlocked ||
      nativeReplayAttemptedRef.current
    ) {
      return;
    }
    const bridge =
      typeof window !== "undefined" ? window.__HUSHH_NATIVE_TEST__ : null;
    if (
      bridge?.bootstrapState === "vault_unlocked" &&
      typeof bridge.replayVaultUnlock === "function"
    ) {
      nativeReplayAttemptedRef.current = true;
      bridge.replayVaultUnlock();
    }
  }, [isVaultUnlocked, nativeTestBootstrapManaged, unlockVault]);

  useEffect(() => {
    if (isVaultUnlocked || authLoading || authStepDoneRef.current) return;
    completeTaskStep(PROGRESS_SCOPE);
    authStepDoneRef.current = true;
    if (!userId) {
      endTask(PROGRESS_SCOPE);
    }
  }, [authLoading, completeTaskStep, endTask, isVaultUnlocked, userId]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | undefined;

    async function checkVaultPresence() {
      if (
        authLoading ||
        sessionVerificationRequired ||
        !userId ||
        isVaultUnlocked
      ) {
        return;
      }
      const cachedPresence = VaultService.peekVaultPresence(userId);
      // Positive presence is sufficient to show the unlock challenge. A
      // negative value must be revalidated before treating the account as a
      // genuine no-vault onboarding case.
      if (cachedPresence === true) return;

      vaultStepDoneRef.current = false;
      setHasVault(null);
      setVaultCheckFailed(false);
      try {
        const exists =
          cachedPresence === false
            ? await VaultService.refreshVaultPresence(userId)
            : await VaultService.checkVault(userId);
        if (!cancelled) {
          setHasVault(exists);
        }
      } catch (error) {
        if (
          error instanceof VaultAuthSessionNotReadyError &&
          nativeVaultCheckAttempt < 2
        ) {
          retryTimer = window.setTimeout(() => {
            if (!cancelled) {
              setNativeVaultCheckAttempt((attempt) => attempt + 1);
            }
          }, 400);
          return;
        }
        console.warn(
          "[VaultLockGuard] Failed to check vault existence:",
          error,
        );
        if (!cancelled) {
          // A failed read proves neither a deleted account nor an existing
          // Vault. Keep the route hidden without presenting an irrelevant
          // unlock challenge, and give the user a way to recover or leave.
          setVaultCheckFailed(true);
        }
      }
    }

    void checkVaultPresence();

    return () => {
      cancelled = true;
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [
    authLoading,
    isNativePlatform,
    isVaultUnlocked,
    nativeVaultCheckAttempt,
    sessionVerificationRequired,
    userId,
  ]);

  useEffect(() => {
    if (
      isVaultUnlocked ||
      authLoading ||
      !userId ||
      hasVault === null ||
      vaultStepDoneRef.current
    ) {
      return;
    }
    completeTaskStep(PROGRESS_SCOPE);
    vaultStepDoneRef.current = true;
    endTask(PROGRESS_SCOPE);
  }, [
    authLoading,
    completeTaskStep,
    endTask,
    hasVault,
    isVaultUnlocked,
    userId,
  ]);

  // ============================================================================
  // FAST PATH: only the current VaultProvider's in-memory key + owner token
  // state may authorize protected children. A historical "unlocked once"
  // signal cannot prove the key survived a provider remount or Fast Refresh.
  // ============================================================================
  const bootstrapState =
    typeof window !== "undefined"
      ? (window.__HUSHH_NATIVE_TEST__?.bootstrapState ?? "")
      : "";

  if (nativeTestBootstrapManaged && bootstrapState === "uid_mismatch") {
    return (
      <div
        role="alert"
        className="flex min-h-[50vh] items-center justify-center px-6 text-center text-sm text-muted-foreground"
      >
        Reviewer session unavailable. Verify the UAT reviewer account
        configuration.
      </div>
    );
  }

  // Auth validation is the outer security boundary. A cached in-memory vault
  // must never bypass it while a foreground/deletion check is in progress.
  if (authLoading) {
    return <HushhLoader label="Checking session..." />;
  }

  // An ordinary network/backend outage cannot prove that a remotely deleted
  // account is still live. Keep every decrypted/cached Vault surface hidden,
  // but retain the identity so the user can recover without a destructive
  // automatic logout when connectivity returns.
  if (sessionVerificationRequired) {
    return (
      <SessionVerificationRecovery
        onRetry={() => void retrySessionVerification()}
        onSignOut={() => void signOut({ skipFcmCleanup: true })}
      />
    );
  }

  if (isVaultUnlocked) {
    return <>{children}</>;
  }

  // ============================================================================
  // SLOW PATH: Vault not unlocked, need to check auth and show appropriate UI
  // ============================================================================

  // No user - redirect to login
  if (!user) {
    if (
      holdRouteForNativeTest ||
      (isNativePlatform && !nativeAuthGraceElapsed)
    ) {
      return <HushhLoader label="Restoring reviewer session..." />;
    }
    return <HushhLoader label="Redirecting to login..." />;
  }

  if (vaultCheckFailed) {
    return (
      <SessionVerificationRecovery
        onRetry={() => {
          setVaultCheckFailed(false);
          setNativeVaultCheckAttempt((attempt) => attempt + 1);
        }}
        onSignOut={() => void signOut({ skipFcmCleanup: true })}
      />
    );
  }

  if (hasVault === null) {
    return <HushhLoader label="Checking vault..." />;
  }

  if (hasVault === false) {
    return <>{children}</>;
  }

  if (nativeTestBootstrapManaged) {
    // UITest-only: NativeTestBootstrap unlocks via passphrase while we show a loader.
    if (bootstrapState === "vault_error" || bootstrapState === "auth_error") {
      // Fall through to passphrase-only unlock dialog below.
    } else {
      return <HushhLoader label="Unlocking vault..." />;
    }
  }

  // User exists but vault is locked. This is a focused credential gate, not
  // a route overlay: it uses the unlock dialog's opaque hard-gate canvas so
  // persistent app chrome, the Agent Bar, and the route underneath never
  // compete with credential entry.
  return (
    <VaultUnlockDialog
      user={user}
      open
      dismissible={false}
      surfaceVariant="hard_gate"
      enableGeneratedDefault={!skipGeneratedDefaultUnlock}
      title="Unlock One"
      description="Unlock to continue."
      onSuccess={() => undefined}
      // Escape hatch for the HARD gate only: a user who forgot their vault
      // password has no other way out (the focused credential surface
      // covers persistent chrome). signOut() fully clears the session and
      // redirects to the welcome screen. Not passed by the dismissible
      // top-bar unlock (there the user can just close the sheet).
      onSignOut={() => signOut()}
    />
  );
}
