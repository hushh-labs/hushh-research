"use client";

import { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";

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
  options?: { userId?: string | null; error?: string | null }
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
    loading_vault_state: 40,
    creating_vault: 50,
    unlocking_vault: 50,
    completing_setup: 55,
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
  bridge.bootstrapError = options?.error ?? "";
}

let nativeTestReviewerBootstrapInflight: Promise<void> | null = null;
let nativeTestReviewerBootstrapCooldownUntil = 0;

export function NativeTestBootstrap() {
  const config = useNativeTestConfig();
  const { loading: authLoading, user, setNativeUser } = useAuth();
  const { isVaultUnlocked, unlockVault } = useVault();
  const [authRetryTick, setAuthRetryTick] = useState(0);
  const authAttemptedRef = useRef(false);
  const authAttemptedAtRef = useRef(0);
  const unlockedForUidRef = useRef<string | null>(null);
  const unlockInFlightForUidRef = useRef<string | null>(null);

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
          throw new Error(
            `Native test bootstrap signed in unexpected uid ${authenticatedUser.uid}`
          );
        }

        setNativeUser(authenticatedUser);
        updateBootstrapStatus("authenticated", {
          userId: authenticatedUser.uid,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Native test auth bootstrap failed";
        updateBootstrapStatus("auth_error", {
          error: message,
        });
        if (/rate limit exceeded/i.test(message)) {
          nativeTestReviewerBootstrapCooldownUntil = Date.now() + 60_000;
        }
        console.error("[NativeTestBootstrap] Auth bootstrap failed:", error);
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

    if (!user) {
      return;
    }

    if (config.expectedUserId && user.uid !== config.expectedUserId) {
      updateBootstrapStatus("uid_mismatch", {
        userId: user.uid,
        error: `Expected ${config.expectedUserId}, got ${user.uid}`,
      });
      return;
    }

    if (isVaultUnlocked) {
      unlockedForUidRef.current = user.uid;
      unlockInFlightForUidRef.current = null;
      updateBootstrapStatus("vault_unlocked", {
        userId: user.uid,
      });
      return;
    }

    if (
      unlockedForUidRef.current === user.uid ||
      unlockInFlightForUidRef.current === user.uid
    ) {
      return;
    }

    unlockInFlightForUidRef.current = user.uid;
    updateBootstrapStatus("loading_vault_state", {
      userId: user.uid,
    });

    void (async () => {
      try {
        const hasVault = await VaultService.checkVault(user.uid);
        let decryptedKey: string | null;

        if (hasVault) {
          const vaultState = await VaultService.getVaultState(user.uid);
          updateBootstrapStatus("unlocking_vault", {
            userId: user.uid,
          });
          decryptedKey = await VaultService.unlockWithMethod({
            state: vaultState,
            method: "passphrase",
            secretMaterial: config.vaultPassphrase!,
          });
        } else {
          updateBootstrapStatus("creating_vault", {
            userId: user.uid,
          });
          const vaultData = await VaultService.createVault(
            config.vaultPassphrase!,
          );
          const vaultKeyHash = await VaultService.hashVaultKey(
            vaultData.vaultKeyHex,
          );
          await VaultService.setupVaultState(user.uid, {
            vaultKeyHash,
            primaryMethod: "passphrase",
            recoveryEncryptedVaultKey: vaultData.recoveryEncryptedVaultKey,
            recoverySalt: vaultData.recoverySalt,
            recoveryIv: vaultData.recoveryIv,
            wrappers: [
              {
                method: "passphrase",
                encryptedVaultKey: vaultData.encryptedVaultKey,
                salt: vaultData.salt,
                iv: vaultData.iv,
              },
            ],
          });
          const persistedState = await VaultService.getVaultState(user.uid);
          await VaultService.assertVaultKeyMatchesState(
            persistedState,
            vaultData.vaultKeyHex,
          );
          decryptedKey = await VaultService.unlockWithMethod({
            state: persistedState,
            method: "passphrase",
            secretMaterial: config.vaultPassphrase!,
          });
          if (!decryptedKey) {
            throw new Error("Persisted vault passphrase verification failed");
          }
        }

        if (!decryptedKey) {
          throw new Error("Vault unlock returned no decrypted key");
        }

        const setupState = await PreVaultUserStateService.bootstrapState(
          user.uid,
        );
        if (!PreVaultUserStateService.isSetupResolved(setupState)) {
          updateBootstrapStatus("completing_setup", {
            userId: user.uid,
          });
          await PreVaultUserStateService.syncKaiSetupState({
            userId: user.uid,
            completed: true,
            skipped: false,
            completedAt: Date.now(),
          });
        }

        const { token, expiresAt } = await VaultService.getOrIssueVaultOwnerToken(
          user.uid
        );
        if (typeof window !== "undefined" && window.__HUSHH_NATIVE_TEST__?.enabled) {
          window.__HUSHH_NATIVE_TEST__.replayVaultUnlock = () => {
            unlockVault(decryptedKey, token, expiresAt);
          };
        }
        unlockVault(decryptedKey, token, expiresAt);
        updateBootstrapStatus("vault_unlocked", {
          userId: user.uid,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Native test vault bootstrap failed";
        updateBootstrapStatus("vault_error", {
          userId: user.uid,
          error: message,
        });
        console.error("[NativeTestBootstrap] Vault bootstrap failed:", error);
      } finally {
        if (unlockInFlightForUidRef.current === user.uid) {
          unlockInFlightForUidRef.current = null;
        }
      }
    })();
  }, [
    config.autoReviewerLogin,
    config.enabled,
    config.expectedUserId,
    config.vaultPassphrase,
    isVaultUnlocked,
    unlockVault,
    user,
  ]);

  return null;
}
