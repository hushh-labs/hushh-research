"use client";

import { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import type { User } from "firebase/auth";

import { useAuth } from "@/hooks/use-auth";
import { AuthService } from "@/lib/services/auth-service";
import { ApiService } from "@/lib/services/api-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { VaultService } from "@/lib/services/vault-service";
import { resolveLocalReviewerCredentials } from "@/lib/testing/local-reviewer-auth";
import { useNativeTestConfig } from "@/lib/testing/native-test";
import { resolveSlowRequestTimeoutMs } from "@/lib/utils/request-timeouts";
import { useVault } from "@/lib/vault/vault-context";

/** Six characters of a uid: enough to tell two identities apart in a log line, never a secret. */
function uidPrefix(uid: string | null | undefined): string {
  return String(uid ?? "").slice(0, 6);
}

function updateBootstrapStatus(
  stage: string,
  options?: { userId?: string | null; errorClass?: string | null; detail?: string | null }
) {
  if (typeof window === "undefined") {
    return;
  }
  const bridge = window.__HUSHH_NATIVE_TEST__;
  if (!bridge?.enabled) {
    return;
  }
  const stageRank: Record<string, number> = {
    waiting_auth: 10,
    authenticating: 20,
    authenticated: 30,
    waiting_vault_user: 35,
    loading_vault_state: 40,
    unlocking_vault: 50,
    vault_unlocked: 60,
    auth_error: 70,
    uid_mismatch: 70,
    vault_error: 70,
  };
  const currentStage = bridge.bootstrapState || "";
  const currentRank = stageRank[currentStage] ?? 0;
  const nextRank = stageRank[stage] ?? 0;
  const failureStages = new Set(["auth_error", "uid_mismatch", "vault_error"]);
  const isRecoveringFromFailure =
    failureStages.has(currentStage) && !failureStages.has(stage);
  if (nextRank < currentRank && !isRecoveringFromFailure) {
    return;
  }
  bridge.bootstrapState = stage;
  bridge.bootstrapUserId = options?.userId ?? bridge.bootstrapUserId ?? "";
  bridge.bootstrapError = "";
  bridge.bootstrapErrorClass = options?.errorClass ?? "";
  // Where the identity that decided this stage came from, plus a uid prefix,
  // so a device run explains a mismatch without a console attached.
  bridge.bootstrapDetail = options?.detail ?? "";
}

function nativeTestErrorClass(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/401|403|auth|sign in/.test(message)) return "authentication";
  if (/404|not found/.test(message)) return "not_found";
  if (/timeout|timed out/.test(message)) return "timeout";
  if (/network|connection|fetch/.test(message)) return "network";
  if (/vault|decrypt|crypto/.test(message)) return "vault";
  if (/rate limit/.test(message)) return "rate_limit";
  return "other";
}

let nativeTestReviewerBootstrapInflight: Promise<void> | null = null;
let nativeTestReviewerBootstrapCooldownUntil = 0;
// A provider boundary can remount while the native bridge finishes initializing.
// This stays process-memory-only and exists solely for the native test handoff;
// it is never written to storage or used outside native test mode.
let nativeTestBootstrapUser: User | null = null;
// Match the vault service's bounded slow-request policy. Local review runs
// intentionally use a UAT-backed Cloud SQL proxy, whose first request can
// exceed the production budget while connections warm; a shorter wrapper here
// used to mark that healthy request as a vault failure before the service's
// own retry policy could finish.
const NATIVE_TEST_VAULT_STEP_TIMEOUT_MS = resolveSlowRequestTimeoutMs(20_000);
const NATIVE_TEST_VAULT_MAX_ATTEMPTS = 5;
const NATIVE_TEST_VAULT_RETRY_DELAY_MS = 250;

async function withVaultBootstrapTimeout<T>(
  label: string,
  operation: Promise<T>
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${label} timed out`));
        }, NATIVE_TEST_VAULT_STEP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

function isRetryableNativeTestVaultError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return /network|failed to fetch|connection|timeout|timed out|502|503/.test(message);
}

/**
 * Retry only transient reads during the test-only vault admission handoff.
 *
 * The reviewer bootstrap runs while the Next shell and the local ADK proxy
 * are warming. A single failed read must not strand an otherwise valid
 * session, but authentication, vault-integrity, and setup-state failures must
 * remain terminal. The operation is supplied as a factory so each attempt
 * gets a fresh request and the final failure is still surfaced to the native
 * test bridge.
 */
async function withNativeTestVaultRetry<T>(
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= NATIVE_TEST_VAULT_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await withVaultBootstrapTimeout(label, operation());
    } catch (error) {
      lastError = error;
      if (
        attempt >= NATIVE_TEST_VAULT_MAX_ATTEMPTS ||
        !isRetryableNativeTestVaultError(error)
      ) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, NATIVE_TEST_VAULT_RETRY_DELAY_MS * attempt),
      );
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${label} failed`);
}

export function NativeTestBootstrap() {
  const config = useNativeTestConfig();
  const { loading: authLoading, user, setNativeUser } = useAuth();
  const { isVaultUnlocked, unlockVault } = useVault();
  const [authRetryTick, setAuthRetryTick] = useState(0);
  // Native Firebase can resolve a custom-token sign-in before AuthContext has
  // published its next render. Keep that authenticated user in memory only so
  // the test-only vault bootstrap has a continuous handoff; the app still
  // prefers the canonical context user whenever it is available.
  const [bootstrapUser, setBootstrapUser] = useState<User | null>(null);
  const authAttemptedRef = useRef(false);
  const authAttemptedAtRef = useRef(0);
  const identityMismatchForExpectedUserRef = useRef<string | null>(null);
  const identityMismatchObservedUidRef = useRef<string | null>(null);
  const replacedPersistedUidRef = useRef<string | null>(null);
  const unlockInFlightForUidRef = useRef<string | null>(null);
  const nativeSessionRecoveryInFlightRef = useRef(false);

  useEffect(() => {
    if (!config.enabled || !config.autoReviewerLogin) {
      return undefined;
    }

    if (authLoading) {
      updateBootstrapStatus("waiting_auth", {
        userId: user?.uid ?? null,
      });
      return undefined;
    }

    if (user) {
      // A session the device kept from before the audit (a simulator whose
      // keychain survived an app removal, a phone signed in as its owner) is
      // not the requested fixture. When the audit names an identity and this
      // is not it, replace it once instead of auditing as whoever was there
      // last; a second sighting of the same uid after that is a real
      // mismatch and falls through to the ordinary failure below.
      if (
        config.expectedUserId &&
        user.uid !== config.expectedUserId &&
        replacedPersistedUidRef.current !== user.uid
      ) {
        replacedPersistedUidRef.current = user.uid;
        updateBootstrapStatus("authenticating");
        void AuthService.signOut()
          .catch(() => undefined)
          .finally(() => {
            nativeTestBootstrapUser = null;
            setBootstrapUser(null);
            // In native mode the auth context publishes identity only through
            // its own restore and sign-in paths and ignores Firebase state
            // changes, so the service sign-out alone leaves the persisted
            // user published; withdraw it explicitly.
            setNativeUser(null);
            setAuthRetryTick((value) => value + 1);
          });
        return undefined;
      }
      updateBootstrapStatus("authenticated", {
        userId: user.uid,
      });
      return undefined;
    }

    if (
      config.expectedUserId &&
      identityMismatchForExpectedUserRef.current === config.expectedUserId
    ) {
      updateBootstrapStatus("uid_mismatch", {
        errorClass: "identity",
        detail: `signin_result:${uidPrefix(identityMismatchObservedUidRef.current)}`,
      });
      return undefined;
    }

    const now = Date.now();
    const retryInMs = 5_000 - (now - authAttemptedAtRef.current);
    if (authAttemptedRef.current && retryInMs > 0) {
      const timer = window.setTimeout(() => {
        setAuthRetryTick((value) => value + 1);
      }, Math.max(250, retryInMs));
      return () => window.clearTimeout(timer);
    }

    if (authAttemptedRef.current) {
      authAttemptedRef.current = false;
    }

    if (now < nativeTestReviewerBootstrapCooldownUntil) {
      return undefined;
    }

    authAttemptedRef.current = true;
    authAttemptedAtRef.current = now;
    updateBootstrapStatus("authenticating");

    nativeTestReviewerBootstrapInflight ??= (async () => {
      try {
        // Simulator/emulator app removal does not always clear the native
        // Firebase keychain entry. A reviewer audit must begin from the
        // requested fixture, never reuse whichever native identity was last
        // present on the device.
        if (Capacitor.isNativePlatform()) {
          await AuthService.signOut().catch(() => undefined);
        }
        const useCustomReviewerToken =
          window.__HUSHH_NATIVE_TEST__?.reviewerAuthMode === "custom_token";
        const localReviewerCredentials = Capacitor.isNativePlatform() || useCustomReviewerToken
          ? null
          : resolveLocalReviewerCredentials(
              typeof window !== "undefined" ? window.location.hostname : null
            );
        const authResult = localReviewerCredentials
          ? await AuthService.signInWithEmailAndPassword(
              localReviewerCredentials.email,
              localReviewerCredentials.password
            )
          : await (async () => {
              const { token } = await ApiService.createAppReviewModeSession("reviewer", {
                smokePassphrase: config.vaultPassphrase,
                reviewerUid: config.expectedUserId,
              });
              return AuthService.signInWithCustomToken(token);
            })();
        const authenticatedUser = authResult.user;

        if (!authenticatedUser) {
          throw new Error("Native test bootstrap returned no authenticated user");
        }

        if (
          config.expectedUserId &&
          authenticatedUser.uid !== config.expectedUserId
        ) {
          identityMismatchForExpectedUserRef.current = config.expectedUserId;
          identityMismatchObservedUidRef.current = authenticatedUser.uid;
          nativeTestReviewerBootstrapCooldownUntil = Date.now() + 5 * 60_000;
          updateBootstrapStatus("uid_mismatch", {
            errorClass: "identity",
            detail: `signin_result:${uidPrefix(authenticatedUser.uid)}`,
          });
          await AuthService.signOut();
          nativeTestBootstrapUser = null;
          setBootstrapUser(null);
          console.error("[NativeTestBootstrap] Auth bootstrap failed: identity_mismatch");
          return;
        }

        setNativeUser(authenticatedUser);
        nativeTestBootstrapUser = authenticatedUser;
        setBootstrapUser(authenticatedUser);
        updateBootstrapStatus("authenticated", {
          userId: authenticatedUser.uid,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Native test auth bootstrap failed";
        updateBootstrapStatus("auth_error", {
          errorClass: nativeTestErrorClass(error),
        });
        if (/rate limit exceeded/i.test(message)) {
          nativeTestReviewerBootstrapCooldownUntil = Date.now() + 60_000;
        }
        console.error(
          `[NativeTestBootstrap] Auth bootstrap failed: ${nativeTestErrorClass(error)}`,
        );
      } finally {
        nativeTestReviewerBootstrapInflight = null;
      }
    })();
    return undefined;
  }, [
    authLoading,
    authRetryTick,
    config.autoReviewerLogin,
    config.enabled,
    config.expectedUserId,
    config.vaultPassphrase,
    setNativeUser,
    user,
  ]);

  useEffect(() => {
    if (!config.enabled || !config.autoReviewerLogin || !config.vaultPassphrase) {
      return;
    }

    // The Firebase singleton is the last in-memory fallback across a provider
    // remount during native bridge initialization. It is never serialized and
    // remains scoped to the authenticated Firebase session.
    const vaultUser =
      user ??
      bootstrapUser ??
      nativeTestBootstrapUser ??
      AuthService.getCurrentUser();
    const vaultUserSource = user
      ? "auth_context"
      : bootstrapUser
        ? "bootstrap_state"
        : nativeTestBootstrapUser
          ? "bootstrap_module"
          : "firebase_js_current";
    if (!vaultUser) {
      updateBootstrapStatus("waiting_vault_user");
      if (
        Capacitor.isNativePlatform() &&
        !nativeSessionRecoveryInFlightRef.current
      ) {
        nativeSessionRecoveryInFlightRef.current = true;
        void AuthService.restoreNativeSession()
          .then((restoredUser) => {
            if (!restoredUser) {
              return;
            }
            // Never adopt a restored session that is not the audited identity.
            if (config.expectedUserId && restoredUser.uid !== config.expectedUserId) {
              return;
            }
            nativeTestBootstrapUser = restoredUser;
            setBootstrapUser(restoredUser);
            setNativeUser(restoredUser);
          })
          .finally(() => {
            nativeSessionRecoveryInFlightRef.current = false;
          });
      }
      return;
    }

    if (config.expectedUserId && vaultUser.uid !== config.expectedUserId) {
      // The fallbacks exist for a native sign-in that resolved before the
      // context published it. A fallback naming a different identity than
      // the audit expects is a stale session the auth effect is replacing;
      // judge only the context user.
      if (vaultUserSource !== "auth_context") {
        updateBootstrapStatus("waiting_vault_user", {
          detail: `${vaultUserSource}:${uidPrefix(vaultUser.uid)}`,
        });
        return;
      }
      updateBootstrapStatus("uid_mismatch", {
        errorClass: "identity",
        detail: `${vaultUserSource}:${uidPrefix(vaultUser.uid)}`,
      });
      return;
    }

    if (isVaultUnlocked) {
      unlockInFlightForUidRef.current = null;
      updateBootstrapStatus("vault_unlocked", {
        userId: vaultUser.uid,
      });
      return;
    }

    if (unlockInFlightForUidRef.current === vaultUser.uid) {
      return;
    }

    unlockInFlightForUidRef.current = vaultUser.uid;
    updateBootstrapStatus("loading_vault_state", {
      userId: vaultUser.uid,
    });

    void (async () => {
      try {
        // The authenticated bootstrap snapshot is the single admission read
        // for vault presence, phone, and setup state. Calling the native vault
        // plugin first duplicated the same backend lookup and could leave iOS
        // stuck in `checking vault` while this authoritative snapshot waited.
        const setupState = await withNativeTestVaultRetry(
          "Setup state load",
          () => PreVaultUserStateService.bootstrapState(vaultUser.uid),
        );
        if (!setupState.hasVault) {
          throw new Error(
            "Reviewer fixture has no existing vault; native audit will not create one",
          );
        }

        const vaultState = await withNativeTestVaultRetry(
          "Vault state load",
          () => VaultService.getVaultState(vaultUser.uid),
        );
        updateBootstrapStatus("unlocking_vault", {
          userId: vaultUser.uid,
        });
        const decryptedKey = await withVaultBootstrapTimeout(
          "Vault unlock",
          VaultService.unlockWithMethod({
            state: vaultState,
            method: "passphrase",
            secretMaterial: config.vaultPassphrase!,
          })
        );

        if (!decryptedKey) {
          throw new Error("Vault unlock returned no decrypted key");
        }

        if (!PreVaultUserStateService.isSetupResolved(setupState)) {
          throw new Error(
            "Reviewer fixture setup is unresolved; native audit will not mutate onboarding state",
          );
        }

        const { token, expiresAt } = await withVaultBootstrapTimeout(
          "Vault owner token issue",
          VaultService.getOrIssueVaultOwnerToken(vaultUser.uid)
        );
        if (typeof window !== "undefined" && window.__HUSHH_NATIVE_TEST__?.enabled) {
          window.__HUSHH_NATIVE_TEST__.replayVaultUnlock = () => {
            unlockVault(decryptedKey, token, expiresAt);
          };
        }
        unlockVault(decryptedKey, token, expiresAt);
        updateBootstrapStatus("vault_unlocked", {
          userId: vaultUser.uid,
        });
      } catch (error) {
        updateBootstrapStatus("vault_error", {
          userId: vaultUser.uid,
          errorClass: nativeTestErrorClass(error),
        });
        console.error(
          `[NativeTestBootstrap] Vault bootstrap failed: ${nativeTestErrorClass(error)}`,
        );
      } finally {
        if (unlockInFlightForUidRef.current === vaultUser.uid) {
          unlockInFlightForUidRef.current = null;
        }
      }
    })();
  }, [
    config.autoReviewerLogin,
    bootstrapUser,
    config.enabled,
    config.expectedUserId,
    config.vaultPassphrase,
    isVaultUnlocked,
    setNativeUser,
    unlockVault,
    user,
  ]);

  return null;
}
