/**
 * Vault Context - Memory-Only Vault Key & Token Storage
 * =====================================================
 *
 * SECURITY MODEL (BYOK - Bring Your Own Key):
 * - Browser Vault Key and VAULT_OWNER token: memory-only, never persisted.
 * - iOS publishes the separately governed, user-presence-protected Messages
 *   custody entry. That exception is not browser session persistence.
 *
 * CRITICAL: Neither vault key NOR token are stored in sessionStorage/localStorage.
 * Memory-only storage limits persistence exposure; it is not an XSS boundary.
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
import { isLocalCrmBuildEnabled } from "@/lib/connected-systems/crm-product-availability";
import { PreVaultSensitiveDraftService } from "@/lib/services/pre-vault-sensitive-draft-service";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { HushhConsent } from "@/lib/capacitor";
import { trackGrowthFunnelStepCompleted } from "@/lib/observability/growth";
import { AuthService } from "@/lib/services/auth-service";
import { ConsentExportRefreshOrchestrator } from "@/lib/services/consent-export-refresh-orchestrator";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { PkmUpgradeOrchestrator } from "@/lib/services/pkm-upgrade-orchestrator";
import { UnlockWarmOrchestrator } from "@/lib/services/unlock-warm-orchestrator";
import { VaultService } from "@/lib/services/vault-service";
import { apiErrorCode } from "@/lib/services/api-client";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { dispatchAuthSessionVerificationRequired, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import {
  AUTH_SESSION_INVALIDATED_EVENT,
  authSessionInvalidationCodeFromFirebaseError,
  authSessionInvalidationCodeFromBackendPayload,
  dispatchAuthSessionInvalidated,
  isAuthSessionInvalidationCode,
  type AuthSessionInvalidationDetail,
} from "@/lib/auth/session-invalidation";

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

  /** Local unlock survives temporary loss/renewal of server authority. */
  ownerTokenStatus: "locked" | "valid" | "renewing" | "unavailable";
  retryOwnerTokenRenewal: () => Promise<void>;

  /** Set the vault key and VAULT_OWNER token after successful authentication */
  unlockVault: (key: string, token: string, expiresAt: number) => boolean;

  /** Clear the key/token on explicit lock or a terminal identity boundary. */
  lockVault: () => void;

  /** Get the vault key for encryption operations */
  getVaultKey: () => string | null;

  /** Get the VAULT_OWNER token for agent requests */
  getVaultOwnerToken: () => string | null;
}

const OWNER_TOKEN_RENEWAL_LEAD_MS = 5 * 60_000;
const OWNER_TOKEN_RETRY_MS = 30_000;
const OWNER_TOKEN_RENEWAL_BUDGET_MS = 10_000;

async function boundedRenewal<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Owner token renewal timed out")), OWNER_TOKEN_RENEWAL_BUDGET_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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

function isGmailRoute(routePath: string): boolean {
  return (
    routePath.startsWith("/one/gmail") ||
    routePath.startsWith("/one/setup/gmail") ||
    routePath.startsWith("/one/email")
  );
}

export function VaultProvider({ children }: VaultProviderProps) {
  // Access Auth Context to listen for logout
  const { user, loading: authLoading, sessionVerificationRequired } = useAuth();
  const authReady = !authLoading && !sessionVerificationRequired;
  const authStateRef = useRef({ user, ready: authReady });
  authStateRef.current = { user, ready: authReady };
  const sessionEpochRef = useRef(0);
  const mountedRef = useRef(true);
  const renewalRef = useRef<{ epoch: number; promise: Promise<void> } | null>(null);
  const [renewalState, setRenewalState] = useState<"idle" | "renewing" | "unavailable">("idle");
  const [, updateTokenClock] = useState(0);
  const [renewalAttempt, setRenewalAttempt] = useState(0);
  const nativeGenerationRef = useRef<Promise<number | null>>(Promise.resolve(null));

  // SECURITY: Vault key stored in React state = memory only
  // Never persisted to browser storage.
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
  const tokenIsValid = Boolean(storedTokenExpiresAt && Date.now() < storedTokenExpiresAt);
  const vaultOwnerToken = vaultIdentityMatches && tokenIsValid ? storedVaultOwnerToken : null;
  const tokenExpiresAt = vaultIdentityMatches ? storedTokenExpiresAt : null;
  const lastUpgradeKickoffKeyRef = useRef<string | null>(null);
  const tokenExpiresAtRef = useRef<number | null>(null);
  // Mirrors of the latest values so async event handlers and cleanup
  // callbacks never read stale closures. lockVault reads from these refs
  // instead of from the useCallback capture.
  const vaultUserIdRef = useRef<string | null>(vaultUserId);
  const storedVaultOwnerTokenRef = useRef<string | null>(storedVaultOwnerToken);
  const storedVaultKeyRef = useRef<string | null>(storedVaultKey);

  const clearNativeSession = useCallback(() => {
    if (Capacitor.getPlatform() !== "ios") return;
    nativeGenerationRef.current = HushhConsent.clearIMessageSession()
      .then((result) => result.sessionGeneration ?? null)
      .catch(() => null);
  }, []);

  useEffect(() => {
    tokenExpiresAtRef.current = tokenExpiresAt;
  }, [tokenExpiresAt]);
  useEffect(() => {
    vaultUserIdRef.current = vaultUserId;
  }, [vaultUserId]);
  useEffect(() => {
    storedVaultOwnerTokenRef.current = storedVaultOwnerToken;
  }, [storedVaultOwnerToken]);
  const lockVault = useCallback(() => {
    // Read from refs so event-listeners registered at mount time always see
    // the latest values — never stale closure captures.
    const lockedUserId = vaultUserIdRef.current;
    const lockedOwnerToken = storedVaultOwnerTokenRef.current;
    sessionEpochRef.current += 1;
    advanceVaultSessionEpoch();
    renewalRef.current = null;
    storedVaultKeyRef.current = null;
    storedVaultOwnerTokenRef.current = null;
    tokenExpiresAtRef.current = null;
    vaultUserIdRef.current = null;
    setRenewalState("idle");
    console.log("🔒 Vault locked (key + token cleared from memory)");
    if (lockedUserId && lockedOwnerToken) {
      void PkmUpgradeOrchestrator.pauseForLocalAuthResume({
        userId: lockedUserId,
        vaultOwnerToken: lockedOwnerToken,
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

    clearNativeSession();

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
  }, [clearNativeSession]);

  useEffect(() => {
    mountedRef.current = true;
    clearNativeSession();
    return () => {
      mountedRef.current = false;
      // Clear decrypted consumers on disposal too. StrictMode's empty initial
      // cleanup does not invalidate the first rendered unlock callback.
      if (storedVaultKeyRef.current) lockVault();
      else {
        advanceVaultSessionEpoch();
        clearNativeSession();
      }
    };
  }, [clearNativeSession, lockVault]);

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

  const publishNativeSession = useCallback(async (
    epoch: number, owner: NonNullable<typeof user>, key: string, token: string, expiresAt: number,
  ) => {
    if (Capacitor.getPlatform() !== "ios") return;
    const sessionGeneration = await nativeGenerationRef.current;
    const firebaseIDToken = await owner.getIdToken(false).catch(() => null);
    if (
      sessionGeneration === null || !mountedRef.current ||
      sessionEpochRef.current !== epoch || authStateRef.current.user?.uid !== owner.uid ||
      storedVaultKeyRef.current !== key || storedVaultOwnerTokenRef.current !== token ||
      Date.now() >= expiresAt
    ) return;
    await HushhConsent.publishIMessageSession({
      userId: owner.uid, vaultOwnerToken: token, vaultKey: key, expiresAt,
      sessionGeneration, firebaseIDToken: firebaseIDToken ?? undefined,
      displayName: owner.displayName, email: owner.email, avatarURL: owner.photoURL,
    }).catch(() => undefined);
  }, []);

  const retryOwnerTokenRenewal = useCallback((): Promise<void> => {
    const owner = authStateRef.current.user;
    const epoch = sessionEpochRef.current;
    const key = storedVaultKeyRef.current;
    const priorToken = storedVaultOwnerTokenRef.current;
    const sessionOwner = snapshotValidatedAuthSessionOwner();
    if (!owner || !key || !priorToken || !authStateRef.current.ready || vaultUserIdRef.current !== owner.uid) {
      return Promise.resolve();
    }
    if (renewalRef.current?.epoch === epoch) return renewalRef.current.promise;
    const stillCurrent = () => mountedRef.current && sessionEpochRef.current === epoch &&
      authStateRef.current.user?.uid === owner.uid && storedVaultKeyRef.current === key;
    setRenewalState("renewing");
    const promise = (async () => {
      try {
        const issued = await boundedRenewal((async () => {
          const firebaseToken = await owner.getIdToken(false);
          if (!stillCurrent() || !authStateRef.current.ready) return null;
          return VaultService.issueVaultOwnerToken(owner.uid, firebaseToken, priorToken);
        })());
        if (!stillCurrent()) return;
        if (!authStateRef.current.ready || issued?.renewalValidated !== true || !issued?.token || !Number.isFinite(issued.expiresAt) || issued.expiresAt <= Date.now()) {
          setRenewalState("unavailable");
          return;
        }
        // A response for the replaced credential must not invalidate its
        // successor. Identical-token reuse keeps revocation responses current.
        if (issued.token !== priorToken) advanceVaultSessionEpoch();
        storedVaultOwnerTokenRef.current = issued.token;
        tokenExpiresAtRef.current = issued.expiresAt;
        setVaultOwnerToken(issued.token);
        setTokenExpiresAt(issued.expiresAt);
        setRenewalState("idle");
        void publishNativeSession(epoch, owner, key, issued.token, issued.expiresAt);
      } catch (error) {
        if (!stillCurrent()) return;
        const backendCode = apiErrorCode(error) ?? (
          error && typeof error === "object" && "code" in error && typeof error.code === "string"
            ? error.code : null
        );
        const code = authSessionInvalidationCodeFromFirebaseError(error) ??
          authSessionInvalidationCodeFromBackendPayload({ code: backendCode });
        if (code) {
          dispatchAuthSessionInvalidated({ code, userId: owner.uid, path: "vault_owner_renewal" });
          lockVault();
        } else if (backendCode === "AUTH_VAULT_OWNER_INVALID") {
          lockVault();
        } else {
          setRenewalState("unavailable");
          if (sessionOwner && (backendCode === "AUTH_ACCOUNT_STATUS_UNAVAILABLE" ||
              backendCode === "AUTH_ACCOUNT_DELETION_IN_PROGRESS")) {
            dispatchAuthSessionVerificationRequired(sessionOwner, backendCode);
          }
        }
      } finally {
        if (renewalRef.current?.epoch === epoch) renewalRef.current = null;
      }
    })();
    renewalRef.current = { epoch, promise };
    return promise;
  }, [lockVault, publishNativeSession]);

  // A local unlock lasts for this document/runtime. Expiry withdraws server
  // authority immediately, then renews without asking for the key again.
  useEffect(() => {
    return appInteractionCoordinator.subscribeLifecycle(() => {
      if (appInteractionCoordinator.getLifecycleSnapshot().state === "active") {
        updateTokenClock((value) => value + 1);
        setRenewalAttempt((value) => value + 1);
      }
    });
  }, []);

  useEffect(() => {
    if (!vaultKey || !storedTokenExpiresAt) return;
    const timer = setTimeout(() => updateTokenClock((value) => value + 1), Math.max(0, storedTokenExpiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [vaultKey, storedTokenExpiresAt]);

  useEffect(() => {
    if (!vaultKey || !authReady || !storedTokenExpiresAt) return;
    const delay = renewalState === "unavailable" ? OWNER_TOKEN_RETRY_MS :
      Math.max(0, storedTokenExpiresAt - Date.now() - OWNER_TOKEN_RENEWAL_LEAD_MS);
    const timer = setTimeout(() => void retryOwnerTokenRenewal(), delay);
    return () => clearTimeout(timer);
  }, [authReady, vaultKey, storedTokenExpiresAt, renewalState, renewalAttempt, retryOwnerTokenRenewal]);

  // Native bridges can collapse expiry and revocation into the same invalid
  // owner code. Expiry withdraws authority, not local key custody; authenticated
  // renewal decides whether that expired lineage was actually revoked.
  useEffect(() => {
    const handleLockRequest = (event: Event) => {
      const customEvent = event as CustomEvent<{ reason: string; path?: string }>;

      if (
        typeof customEvent.detail?.path === "string" &&
        storedVaultKeyRef.current && storedVaultOwnerTokenRef.current &&
        vaultUserIdRef.current === authStateRef.current.user?.uid &&
        tokenExpiresAtRef.current !== null && Date.now() >= tokenExpiresAtRef.current
      ) {
        updateTokenClock((value) => value + 1);
        void retryOwnerTokenRenewal();
        return;
      }

      // Explicit owner-revoke events have no API path and always clear custody,
      // as do validation failures for a still-live current token.
      console.log(
        `🔒 [VaultProvider] Lock requested: ${customEvent.detail?.reason}`
      );
      lockVault();
    };

    window.addEventListener("vault-lock-requested", handleLockRequest);
    return () =>
      window.removeEventListener("vault-lock-requested", handleLockRequest);
  }, [lockVault, retryOwnerTokenRenewal]);

  // Terminal session invalidation is also an immediate memory boundary. The
  // AuthProvider hides protected routes and signs out; VaultProvider erases the
  // matching user's decrypted key/token synchronously with that signal. UID
  // scoping prevents a delayed account-A event from locking account B.
  useEffect(() => {
    const handleTerminalSessionInvalidation = (event: Event) => {
      const detail = (event as CustomEvent<AuthSessionInvalidationDetail>)
        .detail;
      if (
        !isAuthSessionInvalidationCode(detail?.code) ||
        !detail?.userId ||
        detail.userId !== user?.uid
      ) {
        return;
      }
      lockVault();
    };

    window.addEventListener(
      AUTH_SESSION_INVALIDATED_EVENT,
      handleTerminalSessionInvalidation,
    );
    return () =>
      window.removeEventListener(
        AUTH_SESSION_INVALIDATED_EVENT,
        handleTerminalSessionInvalidation,
      );
  }, [lockVault, user?.uid]);

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

    const hydrateFinancialCaches = () => {
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
    };

    const routePath =
      typeof window === "undefined" ? "" : window.location.pathname;
    if (!isGmailRoute(routePath)) {
      hydrateFinancialCaches();
      return;
    }

    // Gmail needs its connection status immediately after unlock. Financial
    // cache hydration is unrelated to that decision, so leave it until the
    // browser has yielded rather than competing for the first backend slots.
    if ("requestIdleCallback" in window) {
      const requestIdle = window.requestIdleCallback as (
        callback: IdleRequestCallback,
        options?: IdleRequestOptions,
      ) => number;
      const cancelIdle = window.cancelIdleCallback as (handle: number) => void;
      const idleHandle = requestIdle(hydrateFinancialCaches, { timeout: 4_000 });
      return () => cancelIdle(idleHandle);
    }

    const timeoutId = globalThis.setTimeout(hydrateFinancialCaches, 1_000);
    return () => globalThis.clearTimeout(timeoutId);
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
    async (userId: string, token: string, key: string, routePath?: string, epoch = sessionEpochRef.current) => {
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
        if (isLocalCrmBuildEnabled()) {
          void import("@/lib/services/connected-systems-resource-service")
            .then(({ ConnectedSystemsResourceService }) =>
              ConnectedSystemsResourceService.warmBindingStatuses({
                userId,
                vaultOwnerToken: token,
              })
            )
            .catch(() => undefined);
        }
        // The consent center warm step needs a Firebase ID token (its proxy is
        // Firebase-authenticated). Fetch it best-effort; the orchestrator
        // skips consent-center warming gracefully if it is unavailable.
        const firebaseIdToken = await AuthService.getIdToken(false).catch(
          () => null
        );
        if (!mountedRef.current || sessionEpochRef.current !== epoch || authStateRef.current.user?.uid !== userId) return;
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

  const unlockEpoch = sessionEpochRef.current;
  const unlockVault = useCallback(
    (key: string, token: string, expiresAt: number) => {
      const unlockingUserId = user?.uid?.trim() ?? "";
      if (!unlockingUserId || !mountedRef.current ||
          unlockEpoch !== sessionEpochRef.current ||
          authStateRef.current.user?.uid !== unlockingUserId || !authStateRef.current.ready ||
          !key || !token || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        return false;
      }
      sessionEpochRef.current += 1;
      advanceVaultSessionEpoch();
      const epoch = sessionEpochRef.current;
      storedVaultKeyRef.current = key;
      storedVaultOwnerTokenRef.current = token;
      tokenExpiresAtRef.current = expiresAt;
      vaultUserIdRef.current = unlockingUserId;
      renewalRef.current = null;
      setRenewalState("idle");
      setVaultKey(key);
      setVaultOwnerToken(token);
      setTokenExpiresAt(expiresAt);
      setVaultUserId(unlockingUserId);

      // Notify listeners (e.g. Siri handoff) that the vault is now unlocked
      // so they can resume any pending actions that were blocked by vault.
      window.dispatchEvent(new CustomEvent("vault-unlocked", {
        detail: { userId: unlockingUserId },
      }));

      if (user) void publishNativeSession(epoch, user, key, token, expiresAt);

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
          if (!mountedRef.current || sessionEpochRef.current !== epoch || authStateRef.current.user?.uid !== user.uid) return;
          void prefetchDashboardData(user.uid, token, key, warmRoutePath, epoch);
        };

        if (isGmailRoute(routePath)) {
          // Gmail's protected route resource fetches connection status as soon
          // as the owner token reaches React state. Keep the dashboard/PKM/RIA/
          // location warmups off that critical path.
          if ("requestIdleCallback" in window) {
            const requestIdle = window.requestIdleCallback as (
              callback: IdleRequestCallback,
              options?: IdleRequestOptions,
            ) => number;
            requestIdle(scheduleWarm, { timeout: 4_000 });
          } else {
            globalThis.setTimeout(scheduleWarm, 1_000);
          }
          return true;
        }

        // Warm the current route's caches immediately after unlock so the first
        // paint of the revealed page (e.g. /one, /consents) hits a warm cache
        // instead of a cold loader. Deferring to requestIdleCallback(1500) left
        // the first post-unlock render cold. We still yield off the unlock
        // synchronous path via a 0ms timeout so we don't block the state update
        // that reveals the page, but we no longer wait for idle time.
        globalThis.setTimeout(scheduleWarm, 0);
      }
      return true;
    },
    [user, unlockEpoch, prefetchDashboardData, publishNativeSession]
  );

  const getVaultKey = useCallback(() => {
    return mountedRef.current && vaultUserIdRef.current === authStateRef.current.user?.uid
      ? storedVaultKeyRef.current : null;
  }, []);

  const getVaultOwnerToken = useCallback(() => {
    // Check expiry
    return mountedRef.current && vaultUserIdRef.current === authStateRef.current.user?.uid &&
      tokenExpiresAtRef.current !== null && Date.now() < tokenExpiresAtRef.current
      ? storedVaultOwnerTokenRef.current : null;
  }, []);

  const value: VaultContextType = {
    vaultKey,
    vaultOwnerToken,
    tokenExpiresAt,
    isVaultUnlocked: !!vaultKey,
    ownerTokenStatus: !vaultKey ? "locked" : vaultOwnerToken ? "valid" :
      renewalState === "renewing" ? "renewing" : "unavailable",
    retryOwnerTokenRenewal,
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
