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

import { Capacitor } from "@capacitor/core";
import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  ReactNode,
} from "react";
import { useAuth } from "@/lib/firebase/auth-context";
import { clearAgentPkmContext } from "@/lib/agent/agent-pkm-memory";
import {
  clearAgentChatHistoryCache,
  warmAgentChatHistoryCache,
} from "@/lib/agent/agent-chat-history-cache";
import { clearGeminiRuntimeConnectionCache } from "@/lib/connections/gemini-runtime-configuration";
import { PreVaultSensitiveDraftService } from "@/lib/services/pre-vault-sensitive-draft-service";
import { KycIdentityProfileDraftService } from "@/lib/services/kyc-identity-profile-pkm-service";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { HushhConsent } from "@/lib/capacitor";
import { trackGrowthFunnelStepCompleted } from "@/lib/observability/growth";
import { AuthService } from "@/lib/services/auth-service";
import { ConsentExportRefreshOrchestrator } from "@/lib/services/consent-export-refresh-orchestrator";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { PkmUpgradeOrchestrator } from "@/lib/services/pkm-upgrade-orchestrator";
import { UnlockWarmOrchestrator } from "@/lib/services/unlock-warm-orchestrator";
import { VaultService } from "@/lib/services/vault-service";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";

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
  const [storedVaultKey, setVaultKey] = useState<string | null>(null);

  // VAULT_OWNER consent token (also memory-only for security)
  const [storedVaultOwnerToken, setVaultOwnerToken] = useState<string | null>(null);
  const [storedTokenExpiresAt, setTokenExpiresAt] = useState<number | null>(null);
  const [vaultUserId, setVaultUserId] = useState<string | null>(null);
  const currentUserId = user?.uid ?? null;
  const vaultIdentityMatches = Boolean(
    currentUserId && vaultUserId === currentUserId,
  );
  // Never expose credentials across an auth identity transition, including the
  // render before the cleanup effect below has run.
  const vaultKey = vaultIdentityMatches ? storedVaultKey : null;
  const vaultOwnerToken = vaultIdentityMatches ? storedVaultOwnerToken : null;
  const tokenExpiresAt = vaultIdentityMatches ? storedTokenExpiresAt : null;
  const lastUpgradeKickoffKeyRef = useRef<string | null>(null);
  // Mirror of tokenExpiresAt so the app-resume listener can read the latest
  // expiry without re-subscribing every time the token changes.
  const tokenExpiresAtRef = useRef<number | null>(null);
  useEffect(() => {
    tokenExpiresAtRef.current = tokenExpiresAt;
  }, [tokenExpiresAt]);


  const lockVault = useCallback(() => {
    console.log("🔒 Vault locked (key + token cleared from memory)");
    const lockedUserId = vaultUserId;
    if (lockedUserId && storedVaultOwnerToken) {
      void PkmUpgradeOrchestrator.pauseForLocalAuthResume({
        userId: lockedUserId,
        vaultOwnerToken: storedVaultOwnerToken,
      }).catch((error) => {
        console.warn("[VaultProvider] Failed to pause PKM upgrade for local auth resume:", error);
      });
    }
    if (lockedUserId) {
      // The Agent's decrypted working set is strictly session-memory-only.
      // Clear it synchronously with the vault credentials, rather than waiting
      // for an Agent workspace to remain mounted and notice the lock.
      clearAgentPkmContext(lockedUserId);
      clearAgentChatHistoryCache(lockedUserId);
      clearGeminiRuntimeConnectionCache(lockedUserId);
      PreVaultSensitiveDraftService.clearForUser(lockedUserId);
      KycIdentityProfileDraftService.clear(lockedUserId);
      CacheService.getInstance().invalidate(
        CACHE_KEYS.PKM_DECRYPTED_BLOB(lockedUserId),
      );
      ConsentExportRefreshOrchestrator.pauseForLocalAuthResume({ userId: lockedUserId });
    }
    setVaultKey(null);
    setVaultOwnerToken(null);
    setTokenExpiresAt(null);
    setVaultUserId(null);
    lastUpgradeKickoffKeyRef.current = null;

    if (Capacitor.getPlatform() === "ios") {
      void HushhConsent.clearIMessageSession().catch((error) => {
        console.warn("[VaultProvider] Failed to clear shared iMessage session:", error);
      });
    }

    if (lockedUserId) {
      CacheSyncService.onVaultStateChanged(lockedUserId);
      void import("@/lib/kai/kai-financial-resource")
        .then(({ KaiFinancialResourceService }) => {
          KaiFinancialResourceService.invalidate(lockedUserId, { includeDevice: false });
        })
        .catch(() => undefined);
      void import("@/lib/pkm/pkm-domain-resource")
        .then(({ PkmDomainResourceService }) => {
          PkmDomainResourceService.invalidateDomain(lockedUserId, "financial");
        })
        .catch(() => undefined);
    }
    VaultService.invalidateVaultStateCache();
  }, [storedVaultOwnerToken, vaultUserId]);

  // Auto-lock on sign-out or account switch. The public context is already
  // fail-closed during the render where the UID changes; this effect erases the
  // stale material and identity-bound route latch from memory.
  useEffect(() => {
    if (
      vaultUserId &&
      currentUserId !== vaultUserId &&
      (storedVaultKey || storedVaultOwnerToken)
    ) {
      console.log("🔒 [VaultProvider] Auth identity changed - clearing vault memory...");
      lockVault();
    }
  }, [
    currentUserId,
    lockVault,
    storedVaultKey,
    storedVaultOwnerToken,
    vaultUserId,
  ]);

  // InteractionRuntime owns native/browser lifecycle collection. VaultProvider
  // remains the security authority and only reacts to its active transition.
  // This avoids competing Capacitor listeners while preserving the memory-only
  // expiry rule on iOS, Android, and web.
  useEffect(() => {
    const relockIfTokenExpired = () => {
      const expiresAt = tokenExpiresAtRef.current;
      // Only act when a token exists AND is actually past expiry. A missing
      // token means the vault is already locked (guard handles it).
      if (expiresAt !== null && Date.now() >= expiresAt) {
        console.warn(
          "🔒 [VaultProvider] VAULT_OWNER token expired while backgrounded — locking to prompt re-unlock.",
        );
        lockVault();
      }
    };

    relockIfTokenExpired();
    return appInteractionCoordinator.subscribeLifecycle(() => {
      if (appInteractionCoordinator.getLifecycleSnapshot().state === "active") {
        relockIfTokenExpired();
      }
    });
  }, [lockVault]);

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
    const handleVaultRekeyed = (event: Event) => {
      const customEvent = event as CustomEvent<{
        userId?: string;
        reason?: string;
      }>;
      if (customEvent.detail?.userId && customEvent.detail.userId !== user?.uid) {
        return;
      }
      if (user?.uid) {
        PersonalKnowledgeModelService.invalidateSessionStateAfterVaultRekey(user.uid);
      }
      console.log(
        `[VaultProvider] Vault rekeyed; invalidating PKM session state: ${customEvent.detail?.reason ?? "vault_rekeyed"}`
      );
      lockVault();
    };

    window.addEventListener("vault-rekeyed", handleVaultRekeyed);
    return () => window.removeEventListener("vault-rekeyed", handleVaultRekeyed);
  }, [lockVault, user?.uid]);

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

  useEffect(() => {
    if (!user?.uid || !vaultKey) {
      return;
    }

    void import("@/lib/kai/kai-financial-resource")
      .then(({ KaiFinancialResourceService }) =>
        KaiFinancialResourceService.hydrateFromSecureCache({
          userId: user.uid,
          vaultKey,
        })
      )
      .catch(() => null);

    void import("@/lib/pkm/pkm-domain-resource")
      .then(({ PkmDomainResourceService }) =>
        PkmDomainResourceService.hydrateFromSecureCache({
          userId: user.uid,
          domain: "financial",
          vaultKey,
        })
      )
      .catch(() => null);
  }, [user?.uid, vaultKey]);

  useEffect(() => {
    if (!user?.uid || !vaultKey || !vaultOwnerToken) {
      return;
    }

    const kickoffKey = `${user.uid}:${vaultOwnerToken}`;
    if (lastUpgradeKickoffKeyRef.current === kickoffKey) {
      return;
    }
    lastUpgradeKickoffKeyRef.current = kickoffKey;

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let idleHandle: number | null = null;

    const kickoffUpgrade = () => {
      if (cancelled) return;
      void PkmUpgradeOrchestrator.ensureRunning({
        userId: user.uid,
        vaultKey,
        vaultOwnerToken,
        initiatedBy: "app_entry",
      }).catch((error) => {
        console.warn("[VaultProvider] PKM upgrade orchestration failed during app entry:", error);
      });
    };

    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      const requestIdle = window.requestIdleCallback as (
        callback: IdleRequestCallback,
        options?: IdleRequestOptions
      ) => number;
      const cancelIdle = window.cancelIdleCallback as (handle: number) => void;
      idleHandle = requestIdle(() => {
        kickoffUpgrade();
      }, { timeout: 6000 });
      return () => {
        cancelled = true;
        if (idleHandle !== null) {
          cancelIdle(idleHandle);
        }
      };
    }

    timeoutId = globalThis.setTimeout(() => {
      kickoffUpgrade();
    }, 3000);

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
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
        // Agent history must not wait on Firebase token resolution. The Agent
        // workspace joins this protected, memory-only single-flight cache, so
        // starting it here lets the post-unlock work continue while optional
        // Firebase-authenticated consent warming resolves below.
        void warmAgentChatHistoryCache({
          userId,
          vaultOwnerToken: token,
        }).catch((error) => {
          console.warn("[VaultContext] Agent chat history warm-up failed:", error);
        });
        void import("@/lib/services/connected-systems-resource-service")
          .then(({ ConnectedSystemsResourceService }) =>
            ConnectedSystemsResourceService.warmBindingStatuses({
              userId,
              vaultOwnerToken: token,
            })
          )
          .catch(() => undefined);
        // The consent center warm step needs a Firebase ID token (its proxy is
        // Firebase-authenticated). Fetch it best-effort; the orchestrator
        // skips consent-center warming gracefully if it is unavailable.
        const firebaseIdToken = await AuthService.getIdToken(false).catch(
          () => null
        );
        await UnlockWarmOrchestrator.run({
          userId,
          vaultKey: key,
          vaultOwnerToken: token,
          routePath,
          firebaseIdToken: firebaseIdToken ?? undefined,
        });
      } catch (error) {
        console.warn("[VaultContext] Unlock warm orchestration failed:", error);
      }
    },
    []
  );

  const unlockVault = useCallback(
    (key: string, token: string, expiresAt: number) => {
      const unlockingUserId = user?.uid?.trim() ?? "";
      if (!unlockingUserId) {
        setVaultKey(null);
        setVaultOwnerToken(null);
        setTokenExpiresAt(null);
        setVaultUserId(null);
        console.warn("[VaultProvider] Refused vault unlock without an authenticated user.");
        return;
      }
      console.log(
        "🔓 Vault unlocked (key + token in memory only - XSS protected)"
      );
      setVaultKey(key);
      setVaultOwnerToken(token);
      setTokenExpiresAt(expiresAt);
      setVaultUserId(unlockingUserId);

      if (user?.uid && Capacitor.getPlatform() === "ios") {
        void (async () => {
          const firebaseIDToken = await AuthService.getIdToken(true).catch(
            (error) => {
              console.warn(
                "[VaultProvider] Failed to refresh Firebase token for iMessage session:",
                error
              );
              return null;
            }
          );

          await HushhConsent.publishIMessageSession({
            userId: user.uid,
            vaultOwnerToken: token,
            vaultKey: key,
            expiresAt,
            firebaseIDToken: firebaseIDToken ?? undefined,
            displayName: user.displayName,
            email: user.email,
            avatarURL: user.photoURL,
          });
        })().catch((error) => {
          console.warn(
            "[VaultProvider] Failed to publish shared iMessage session:",
            error
          );
        });
      }

      const routePath =
        typeof window !== "undefined" ? window.location.pathname : "";
      if (!routePath.startsWith("/ria")) {
        trackGrowthFunnelStepCompleted({
          journey: "investor",
          step: "vault_ready",
          dedupeKey: "growth:investor:vault_ready",
          dedupeWindowMs: 5_000,
        });
      }

      if (user?.uid && !routePath.startsWith("/one/setup")) {
        const warmRoutePath = routePath || undefined;
        const scheduleWarm = () => {
          void prefetchDashboardData(user.uid, token, key, warmRoutePath);
        };

        // Warm the current route's caches immediately after unlock so the first
        // paint of the revealed page (e.g. /one, /consents) hits a warm cache
        // instead of a cold loader. Deferring to requestIdleCallback(1500) left
        // the first post-unlock render cold. We still yield off the unlock
        // synchronous path via a 0ms timeout so we don't block the state update
        // that reveals the page, but we no longer wait for idle time.
        globalThis.setTimeout(scheduleWarm, 0);
      }
    },
    [user, prefetchDashboardData]
  );

  const getVaultKey = useCallback(() => {
    return vaultKey;
  }, [vaultKey]);

  const getVaultOwnerToken = useCallback(() => {
    // Check expiry
    if (tokenExpiresAt && Date.now() >= tokenExpiresAt) {
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
