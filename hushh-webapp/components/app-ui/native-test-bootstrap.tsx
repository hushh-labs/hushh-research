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
import { useVault } from "@/lib/vault/vault-context";

function updateBootstrapStatus(
  stage: string,
  options?: { userId?: string | null; errorClass?: string | null }
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
const NATIVE_TEST_VAULT_STEP_TIMEOUT_MS = 20_000;

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
      updateBootstrapStatus("authenticated", {
        userId: user.uid,
      });
      return undefined;
    }

    if (
      config.expectedUserId &&
      identityMismatchForExpectedUserRef.current === config.expectedUserId
    ) {
      updateBootstrapStatus("uid_mismatch", { errorClass: "identity" });
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
        const localReviewerCredentials = Capacitor.isNativePlatform()
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
          nativeTestReviewerBootstrapCooldownUntil = Date.now() + 5 * 60_000;
          updateBootstrapStatus("uid_mismatch", { errorClass: "identity" });
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
      updateBootstrapStatus("uid_mismatch", {
        errorClass: "identity",
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
        const setupState = await withVaultBootstrapTimeout(
          "Setup state load",
          PreVaultUserStateService.bootstrapState(vaultUser.uid),
        );
        if (!setupState.hasVault) {
          throw new Error(
            "Reviewer fixture has no existing vault; native audit will not create one",
          );
        }

        const vaultState = await withVaultBootstrapTimeout(
          "Vault state load",
          VaultService.getVaultState(vaultUser.uid)
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
