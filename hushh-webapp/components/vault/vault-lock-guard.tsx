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
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { VaultService } from "@/lib/services/vault-service";
import { VaultUnlockDialog } from "./vault-unlock-dialog";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { useStepProgress } from "@/lib/progress/step-progress-context";
import {
  isSessionUnlockedOnce,
  markSessionUnlocked,
} from "@/lib/vault/vault-session-latch";
import {
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

const vaultPresenceCache = new Map<string, boolean>();

// ============================================================================
// Component
// ============================================================================

export function VaultLockGuard({ children }: VaultLockGuardProps) {
  const { isVaultUnlocked, unlockVault } = useVault();
  const router = useRouter();
  const nativeTestConfig = useNativeTestConfig();
  const nativeTestBootstrapManaged =
    isNativeTestVaultBootstrapManaged(nativeTestConfig);
  const skipGeneratedDefaultUnlock =
    preferPassphraseUnlockForAutomation(nativeTestConfig);

  // Latch: once unlocked, remember for the rest of this JS session
  if (isVaultUnlocked && !isSessionUnlockedOnce()) {
    markSessionUnlocked();
  }
  const { user, loading: authLoading } = useAuth();
  const userId = user?.uid ?? null;
  const { beginTask, completeTaskStep, endTask } = useStepProgress();
  const [hasVault, setHasVault] = useState<boolean | null>(null);
  const authStepDoneRef = useRef(false);
  const vaultStepDoneRef = useRef(false);
  const nativeReplayAttemptedRef = useRef(false);
  const PROGRESS_SCOPE = "vault-lock-guard";

  useEffect(() => {
    if (!userId) {
      setHasVault(null);
      return;
    }
    if (isVaultUnlocked) {
      setHasVault(true);
      return;
    }
    if (vaultPresenceCache.has(userId)) {
      setHasVault(vaultPresenceCache.get(userId) ?? null);
      return;
    }
    setHasVault(null);
  }, [isVaultUnlocked, userId]);

  // Redirect unauthenticated users (side-effect outside render)
  useEffect(() => {
    if (authLoading) return;
    if (userId) return;

    if (typeof window !== "undefined") {
      const currentPath = window.location.pathname;
      router.replace(`/login?redirect=${encodeURIComponent(currentPath)}`);
    }
  }, [authLoading, router, userId]);

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
      if (vaultPresenceCache.has(userId)) return;

      vaultStepDoneRef.current = false;
      setHasVault(null);
      try {
        const exists = await VaultService.checkVault(userId);
        if (!cancelled) {
          vaultPresenceCache.set(userId, exists);
          setHasVault(exists);
        }
      } catch (error) {
        console.warn("[VaultLockGuard] Failed to check vault existence:", error);
        if (!cancelled) {
          // Fail closed on transient check failures to preserve existing secure behavior.
          vaultPresenceCache.set(userId, true);
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
  if (isVaultUnlocked || isSessionUnlockedOnce()) {
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
    const bootstrapState =
      typeof window !== "undefined"
        ? window.__HUSHH_NATIVE_TEST__?.bootstrapState ?? ""
        : "";
    if (bootstrapState === "vault_error" || bootstrapState === "auth_error") {
      // Fall through to passphrase-only unlock dialog below.
    } else {
      return <HushhLoader label="Unlocking vault..." />;
    }
  }

  // User exists but vault is locked - show unlock dialog
  return (
    <VaultUnlockDialog
      user={user}
      open
      dismissible={false}
      enableGeneratedDefault={!skipGeneratedDefaultUnlock}
      title="Unlock Vault"
      description="Unlock your Vault to continue."
      onSuccess={() => {
        markSessionUnlocked();
      }}
    />
  );
}
