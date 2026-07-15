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
 * - We render children immediately if vault is unlocked (no intermediate states).
 * - Module-level flag tracks unlock across route changes within same session.
 */

import { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { VaultService } from "@/lib/services/vault-service";
import { VaultUnlockDialog } from "./vault-unlock-dialog";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { useStepProgress } from "@/lib/progress/step-progress-context";
import { isSessionUnlockedOnce } from "@/lib/vault/vault-session-latch";
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

  const { user, loading: authLoading, signOut } = useAuth();
  const userId = user?.uid ?? null;
  const { beginTask, completeTaskStep, endTask } = useStepProgress();
  const [hasVault, setHasVault] = useState<boolean | null>(null);
  const [nativeAuthGraceElapsed, setNativeAuthGraceElapsed] = useState(
    !isNativePlatform,
  );
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
    const timer = window.setTimeout(() => setNativeAuthGraceElapsed(true), 2_000);
    return () => window.clearTimeout(timer);
  }, [authLoading, isNativePlatform, nativeAuthGraceElapsed, userId]);

  useEffect(() => {
    if (!userId) {
      setHasVault(null);
      return;
    }
    if (isVaultUnlocked) {
      setHasVault(true);
      return;
    }
    // Hydrate first paint from the shared VaultService cache (memory ->
    // session -> bootstrap) so re-mounts do not flash a loader.
    const cached = VaultService.peekVaultPresence(userId);
    setHasVault(cached);
  }, [isVaultUnlocked, userId]);

  // Redirect unauthenticated users (side-effect outside render)
  useEffect(() => {
    if (authLoading) return;
    if (userId) return;
    if (holdRouteForNativeTest) return;
    if (isNativePlatform && !nativeAuthGraceElapsed) return;

    if (typeof window !== "undefined") {
      const currentPath =
        window.location.pathname + window.location.search + window.location.hash;
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
    if (!nativeTestBootstrapManaged || isVaultUnlocked || nativeReplayAttemptedRef.current) {
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

    async function checkVaultPresence() {
      if (authLoading || !userId || isVaultUnlocked) return;
      // Already resolved from the shared cache during the hydrate effect.
      if (VaultService.peekVaultPresence(userId) !== null) return;

      vaultStepDoneRef.current = false;
      setHasVault(null);
      try {
        const exists = await VaultService.checkVault(userId);
        if (!cancelled) {
          setHasVault(exists);
        }
      } catch (error) {
        console.warn("[VaultLockGuard] Failed to check vault existence:", error);
        if (!cancelled) {
          // Fail closed on transient check failures to preserve existing secure behavior.
          setHasVault(true);
        }
      }
    }

    void checkVaultPresence();

    return () => {
      cancelled = true;
    };
  }, [authLoading, userId, isVaultUnlocked]);

  useEffect(() => {
    if (isVaultUnlocked || authLoading || !userId || hasVault === null || vaultStepDoneRef.current) {
      return;
    }
    completeTaskStep(PROGRESS_SCOPE);
    vaultStepDoneRef.current = true;
    endTask(PROGRESS_SCOPE);
  }, [authLoading, completeTaskStep, endTask, hasVault, isVaultUnlocked, userId]);

  // ============================================================================
  // FAST PATH: If vault is unlocked (in memory) OR was unlocked earlier in this
  // session, render children immediately. The latch prevents the dialog from
  // flashing during route transitions where React state briefly resets.
  // ============================================================================
  const bootstrapState =
    typeof window !== "undefined"
      ? window.__HUSHH_NATIVE_TEST__?.bootstrapState ?? ""
      : "";
  if (nativeTestBootstrapManaged && bootstrapState === "uid_mismatch") {
    return (
      <div
        role="alert"
        className="flex min-h-[50vh] items-center justify-center px-6 text-center text-sm text-muted-foreground"
      >
        Reviewer session unavailable. Verify the UAT reviewer account configuration.
      </div>
    );
  }

  if (isVaultUnlocked || isSessionUnlockedOnce(userId)) {
    return <>{children}</>;
  }

  // ============================================================================
  // SLOW PATH: Vault not unlocked, need to check auth and show appropriate UI
  // ============================================================================
  
  // Auth still loading - show loader
  if (authLoading) {
    return <HushhLoader label="Checking session..." />;
  }

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

  // User exists but vault is locked. This is a focused credential gate, not a
  // route overlay: it uses the unlock dialog's opaque hard-gate canvas so
  // persistent app chrome, the Agent Bar, and the route underneath never
  // compete with credential entry.
  return (
    <VaultUnlockDialog
      user={user}
      open
      dismissible={false}
      surfaceVariant="hard_gate"
      enableGeneratedDefault={!skipGeneratedDefaultUnlock}
      title="Unlock Vault"
      description="Unlock your Vault to continue."
      onSuccess={() => undefined}
      // Escape hatch for the HARD gate only: a user who forgot their vault
      // password has no other way out (the focused credential surface covers
      // persistent chrome). signOut() fully clears the session and redirects
      // to the welcome screen. Not passed by the dismissible top-bar unlock
      // (there the user can just close the sheet).
      onSignOut={() => signOut()}
    />
  );
}
