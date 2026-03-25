/**
 * Vault Context - Memory-Only Vault Key & Token Storage
 * =====================================================
 *
 * SECURITY MODEL (BYOK - Bring Your Own Key):
 * - Vault Key: Stored in React state (memory only) - XSS cannot access
 * - VAULT_OWNER Token: Stored in React state (memory only) - XSS cannot access
 *
 * CRITICAL: Neither vault key NOR token are stored in sessionStorage/localStorage.
 * This prevents XSS attacks from stealing credentials.
 *
 * Services that need the token MUST receive it as a parameter from components
 * that have access to useVault() hook. This ensures the token never leaves
 * the React component tree's memory space.
 *
 * PERFORMANCE:
 * - Prefetches common data (PKM, vault status, consents) on vault unlock
 * - Data is cached via CacheService for faster page loads
 */

"use client";

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  ReactNode,
} from "react";
import { useAuth } from "@/lib/firebase/auth-context";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { ConsentExportRefreshOrchestrator } from "@/lib/services/consent-export-refresh-orchestrator";
import { PkmUpgradeOrchestrator } from "@/lib/services/pkm-upgrade-orchestrator";
import { UnlockWarmOrchestrator } from "@/lib/services/unlock-warm-orchestrator";
import { VaultService } from "@/lib/services/vault-service";

// ============================================================================
// Types
// ============================================================================

interface VaultContextType {
  /** The decrypted vault key (hex string) - ONLY IN MEMORY */
  vaultKey: string | null;

  /** VAULT_OWNER consent token - ONLY IN MEMORY */
  vaultOwnerToken: string | null;

  /** Token expiry timestamp (ms) */
  tokenExpiresAt: number | null;

  /** Whether the vault is currently unlocked */
  isVaultUnlocked: boolean;

  /** Set the vault key and VAULT_OWNER token after successful authentication */
  unlockVault: (key: string, token: string, expiresAt: number) => void;

  /** Clear the vault key and token (on logout or timeout) */
  lockVault: () => void;

  /** Get the vault key for encryption operations */
  getVaultKey: () => string | null;

  /** Get the VAULT_OWNER token for agent requests */
  getVaultOwnerToken: () => string | null;
}

// ============================================================================
// Context
// ============================================================================

// Export context for components that need optional access (e.g., ExitDialog)
export const VaultContext = createContext<VaultContextType | null>(null);

// ============================================================================
// Provider
// ============================================================================

interface VaultProviderProps {
  children: ReactNode;
}

export function VaultProvider({ children }: VaultProviderProps) {
  // Access Auth Context to listen for logout
  const { user } = useAuth();

  // SECURITY: Vault key stored in React state = memory only
  // This is NOT accessible via sessionStorage.getItem() - XSS protection
  const [vaultKey, setVaultKey] = useState<string | null>(null);

  // VAULT_OWNER consent token (also memory-only for security)
  const [vaultOwnerToken, setVaultOwnerToken] = useState<string | null>(null);
  const [tokenExpiresAt, setTokenExpiresAt] = useState<number | null>(null);

  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const lockVault = useCallback(() => {
    console.log("🔒 Vault locked (key + token cleared from memory)");
    if (user?.uid && vaultOwnerToken) {
      void PkmUpgradeOrchestrator.pauseForLocalAuthResume({
        userId: user.uid,
        vaultOwnerToken,
      }).catch((error) => {
        console.warn("[VaultProvider] Failed to pause PKM upgrade for local auth resume:", error);
      });
    }
    if (user?.uid) {
      ConsentExportRefreshOrchestrator.pauseForLocalAuthResume({ userId: user.uid });
    }
    setVaultKey(null);
    setVaultOwnerToken(null);
    setTokenExpiresAt(null);

    if (user?.uid) {
      CacheSyncService.onVaultStateChanged(user.uid);
    }
    VaultService.invalidateVaultStateCache();
  }, [user?.uid, vaultOwnerToken]);

  // Auto-Lock on Sign Out
  // If AuthContext reports no user, we MUST clear the decrypted key from memory immediately.
  useEffect(() => {
    if (!user && vaultKey) {
      console.log("🔒 [VaultProvider] User signed out - Formatting memory...");
      lockVault();
    }
  }, [user, vaultKey, lockVault]);

  // Listen for vault-lock-requested events (e.g., when VAULT_OWNER token is revoked)
  useEffect(() => {
    const handleLockRequest = (event: Event) => {
      const customEvent = event as CustomEvent<{ reason: string }>;
      console.log(
        `🔒 [VaultProvider] Lock requested: ${customEvent.detail?.reason}`
      );
      lockVault();
    };

    window.addEventListener("vault-lock-requested", handleLockRequest);
    return () =>
      window.removeEventListener("vault-lock-requested", handleLockRequest);
  }, [lockVault]);

  useEffect(() => {
    if (!user?.uid || !vaultKey || !vaultOwnerToken) {
      return;
    }

    const handleDomainStored = (event: Event) => {
      const customEvent = event as CustomEvent<{
        userId?: string;
        domain?: string;
      }>;
      if (customEvent.detail?.userId !== user.uid) {
        return;
      }
      void ConsentExportRefreshOrchestrator.ensureRunning({
        userId: user.uid,
        vaultKey,
        vaultOwnerToken,
        initiatedBy: "pkm_domain_store",
      }).catch((error) => {
        console.warn("[VaultProvider] Consent export refresh orchestration failed:", error);
      });
    };

    window.addEventListener("pkm-domain-stored", handleDomainStored);
    return () => {
      window.removeEventListener("pkm-domain-stored", handleDomainStored);
    };
  }, [user?.uid, vaultKey, vaultOwnerToken]);

  /**
   * Prefetch common data after vault unlock to speed up page loads.
   * Runs in background - errors are logged but don't block UI.
   * Declared before unlockVault so it can be called from it (react-hooks/immutability).
   */
  const prefetchDashboardData = useCallback(
    async (userId: string, token: string, key: string, routePath?: string) => {
      try {
        await UnlockWarmOrchestrator.run({
          userId,
          vaultKey: key,
          vaultOwnerToken: token,
          routePath,
        });
      } catch (error) {
        console.warn("[VaultContext] Unlock warm orchestration failed:", error);
      }
    },
    []
  );

  const unlockVault = useCallback(
    (key: string, token: string, expiresAt: number) => {
      console.log(
        "🔓 Vault unlocked (key + token in memory only - XSS protected)"
      );
      setVaultKey(key);
      setVaultOwnerToken(token);
      setTokenExpiresAt(expiresAt);

      if (user?.uid) {
        const routePath =
          typeof window !== "undefined" ? window.location.pathname : undefined;
        prefetchDashboardData(user.uid, token, key, routePath);
      }
    },
    [user, prefetchDashboardData]
  );

  const getVaultKey = useCallback(() => {
    return vaultKey;
  }, [vaultKey]);

  const getVaultOwnerToken = useCallback(() => {
    // Check expiry
    if (tokenExpiresAt && Date.now() > tokenExpiresAt) {
      console.warn("⚠️ VAULT_OWNER token expired");
      return null;
    }
    return vaultOwnerToken;
  }, [vaultOwnerToken, tokenExpiresAt]);

  const value: VaultContextType = {
    vaultKey,
    vaultOwnerToken,
    tokenExpiresAt,
    isVaultUnlocked: !!vaultKey && !!vaultOwnerToken,
    unlockVault,
    lockVault,
    getVaultKey,
    getVaultOwnerToken,
  };

  return (
    <VaultContext.Provider value={value}>{children}</VaultContext.Provider>
  );
}

// ============================================================================
// Hook
// ============================================================================

export function useVault(): VaultContextType {
  const context = useContext(VaultContext);
  if (!context) {
    throw new Error("useVault must be used within a VaultProvider");
  }
  return context;
}

/**
 * HOC for components that need vault access
 * Wraps component to ensure vault is available
 */
export function withVaultRequired<T extends object>(
  Component: React.ComponentType<T>
): React.FC<T> {
  return function VaultRequiredComponent(props: T) {
    const { isVaultUnlocked } = useVault();

    if (!isVaultUnlocked) {
      return (
        <div className="flex items-center justify-center min-h-[200px]">
          <p className="text-muted-foreground">
            🔒 Vault locked. Please unlock to continue.
          </p>
        </div>
      );
    }

    return <Component {...props} />;
  };
}
