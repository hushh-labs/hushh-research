"use client";

import { useEffect, useRef } from "react";

import { useAuth } from "@/hooks/use-auth";
import { AuthService } from "@/lib/services/auth-service";
import { ApiService } from "@/lib/services/api-service";
import { VaultService } from "@/lib/services/vault-service";
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
    unlocking_vault: 50,
    vault_unlocked: 60,
    auth_error: 70,
    uid_mismatch: 70,
    vault_error: 70,
  };
  const currentRank = stageRank[bridge.bootstrapState || ""] ?? 0;
  const nextRank = stageRank[stage] ?? 0;
  if (nextRank < currentRank) {
    return;
  }
  bridge.bootstrapState = stage;
  bridge.bootstrapUserId = options?.userId ?? bridge.bootstrapUserId ?? "";
  bridge.bootstrapError = options?.error ?? "";
}

export function NativeTestBootstrap() {
  const config = useNativeTestConfig();
  const { loading: authLoading, user, setNativeUser } = useAuth();
  const { isVaultUnlocked, unlockVault } = useVault();
  const authAttemptedRef = useRef(false);
  const unlockedForUidRef = useRef<string | null>(null);

  useEffect(() => {
    if (!config.enabled || !config.autoReviewerLogin) {
      return;
    }

    if (authLoading) {
      updateBootstrapStatus("waiting_auth", {
        userId: user?.uid ?? null,
      });
      return;
    }

    if (user) {
      updateBootstrapStatus("authenticated", {
        userId: user.uid,
      });
      return;
    }

    if (authAttemptedRef.current) {
      return;
    }

    authAttemptedRef.current = true;
    updateBootstrapStatus("authenticating");

    void (async () => {
      try {
        const { token } = await ApiService.createAppReviewModeSession("reviewer");
        const authResult = await AuthService.signInWithCustomToken(token);
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
        console.error("[NativeTestBootstrap] Auth bootstrap failed:", error);
      }
    })();
  }, [
    authLoading,
    config.autoReviewerLogin,
    config.enabled,
    config.expectedUserId,
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
      updateBootstrapStatus("vault_unlocked", {
        userId: user.uid,
      });
      return;
    }

    if (unlockedForUidRef.current === user.uid) {
      return;
    }

    unlockedForUidRef.current = user.uid;
    updateBootstrapStatus("loading_vault_state", {
      userId: user.uid,
    });

    void (async () => {
      try {
        const vaultState = await VaultService.getVaultState(user.uid);
        updateBootstrapStatus("unlocking_vault", {
          userId: user.uid,
        });
        const decryptedKey = await VaultService.unlockWithMethod({
          state: vaultState,
          method: "passphrase",
          secretMaterial: config.vaultPassphrase!,
        });

        if (!decryptedKey) {
          throw new Error("Vault unlock returned no decrypted key");
        }

        const { token, expiresAt } = await VaultService.getOrIssueVaultOwnerToken(
          user.uid
        );
        unlockVault(decryptedKey, token, expiresAt);
        updateBootstrapStatus("vault_unlocked", {
          userId: user.uid,
        });
      } catch (error) {
        unlockedForUidRef.current = null;
        const message =
          error instanceof Error ? error.message : "Native test vault bootstrap failed";
        updateBootstrapStatus("vault_error", {
          userId: user.uid,
          error: message,
        });
        console.error("[NativeTestBootstrap] Vault bootstrap failed:", error);
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
