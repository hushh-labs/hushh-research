"use client";

import { Capacitor } from "@capacitor/core";

import type { GeneratedVaultKeyMode } from "@/lib/services/vault-bootstrap-service";
import { VaultBootstrapService } from "@/lib/services/vault-bootstrap-service";
import { VaultService, type VaultMethod } from "@/lib/services/vault-service";
import { rewrapVaultKeyWithPassphrase } from "@/lib/vault/rewrap-vault-key";
import { trackEvent } from "@/lib/observability/client";

export type { VaultMethod } from "@/lib/services/vault-service";

export type VaultCapabilityMatrix = {
  passphrase: boolean;
  generatedNativeBiometric: boolean;
  generatedWebPrf: boolean;
  recommendedMethod: VaultMethod;
  reason?: string;
};

function ensureVaultKeyHex(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(
      "Vault key in memory is invalid. Unlock vault again and retry.",
    );
  }
  return normalized;
}

function normalizeVaultMethodError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();

  if (
    lowered.includes("vault_passkey_rp_mismatch") ||
    lowered.includes("rp id is not allowed")
  ) {
    return new Error(
      "This passkey was enrolled under an older domain. Use passphrase once, then enroll passkey again for kai.hushh.ai.",
    );
  }

  if (lowered.includes("client_upgrade_required")) {
    return new Error(
      "Client upgrade required. Please update the app and retry.",
    );
  }

  if (lowered.includes("passphrase wrapper missing")) {
    return new Error(
      "Passphrase wrapper is missing for this vault. Use passphrase/recovery flow once to repair wrapper enrollment.",
    );
  }

  return error instanceof Error ? error : new Error(message);
}

function dispatchVaultRekeyed(userId: string, reason: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent("vault-rekeyed", {
      detail: {
        userId,
        reason,
      },
    })
  );
}

export class VaultMethodService {
  static async getCurrentMethod(userId: string): Promise<VaultMethod> {
    const state = await VaultService.getVaultState(userId);
    return state.primaryMethod;
  }

  static async getCapabilityMatrix(): Promise<VaultCapabilityMatrix> {
    const support = await VaultService.canUseGeneratedDefaultVault();

    if (support.supported) {
      if (support.mode === "generated_default_native_biometric") {
        return {
          passphrase: true,
          generatedNativeBiometric: true,
          generatedWebPrf: false,
          recommendedMethod: "generated_default_native_biometric",
        };
      }

      if (support.mode === "generated_default_native_passkey_prf") {
        return {
          passphrase: true,
          generatedNativeBiometric: true,
          generatedWebPrf: false,
          recommendedMethod: "generated_default_native_passkey_prf",
        };
      }

      return {
        passphrase: true,
        generatedNativeBiometric: false,
        generatedWebPrf: true,
        recommendedMethod: "generated_default_web_prf",
      };
    }

    return {
      passphrase: true,
      generatedNativeBiometric: false,
      generatedWebPrf: false,
      recommendedMethod: "passphrase",
      reason: support.reason,
    };
  }

  static async switchMethod(params: {
    userId: string;
    currentVaultKey: string;
    displayName: string;
    targetMethod: VaultMethod;
    passphrase?: string;
  }): Promise<{ method: VaultMethod }> {
    try {
      const canonicalVaultKey = ensureVaultKeyHex(params.currentVaultKey);
      const state = await VaultService.getVaultState(params.userId);
      const vaultKeyHash = await VaultService.hashVaultKey(canonicalVaultKey);

      if (state.vaultKeyHash && state.vaultKeyHash !== vaultKeyHash) {
        throw new Error("Vault key mismatch detected. Unlock vault again.");
      }

      if (params.targetMethod === "passphrase") {
        const passphrase = params.passphrase?.trim();
        if (!passphrase || passphrase.length < 8) {
          throw new Error("Passphrase must be at least 8 characters.");
        }

        const wrapped = await rewrapVaultKeyWithPassphrase({
          vaultKeyHex: canonicalVaultKey,
          wrappingSecret: passphrase,
        });

        await VaultService.upsertVaultWrapper({
          userId: params.userId,
          vaultKeyHash,
          wrapper: {
            method: "passphrase",
            encryptedVaultKey: wrapped.encryptedVaultKey,
            salt: wrapped.salt,
            iv: wrapped.iv,
          },
        });

        await VaultService.setPrimaryVaultMethod(params.userId, "passphrase");
        dispatchVaultRekeyed(params.userId, "vault_method_switched_to_passphrase");
        trackEvent("profile_method_switch_result", {
          result: "success",
        });
        return { method: "passphrase" };
      }

      const material =
        await VaultBootstrapService.provisionGeneratedMethodMaterial({
          userId: params.userId,
          displayName: params.displayName,
        });

      if (material.mode !== params.targetMethod) {
        throw new Error("Requested method is not supported on this device.");
      }

      try {
        const wrapped = await rewrapVaultKeyWithPassphrase({
          vaultKeyHex: canonicalVaultKey,
          wrappingSecret: material.wrappingSecret,
        });

        await VaultService.upsertVaultWrapper({
          userId: params.userId,
          vaultKeyHash,
          wrapper: {
            method: material.mode,
            wrapperId:
              material.passkeyCredentialId ??
              (material.mode === "generated_default_native_biometric"
                ? "default"
                : "default"),
            encryptedVaultKey: wrapped.encryptedVaultKey,
            salt: wrapped.salt,
            iv: wrapped.iv,
            passkeyCredentialId: material.passkeyCredentialId,
            passkeyPrfSalt: material.passkeyPrfSalt,
            passkeyRpId: material.passkeyRpId,
            passkeyProvider: material.passkeyProvider,
            passkeyDeviceLabel: material.passkeyDeviceLabel,
            passkeyLastUsedAt: Date.now(),
          },
        });

        await VaultService.setPrimaryVaultMethod(
          params.userId,
          material.mode,
          material.passkeyCredentialId ?? "default",
        );
        dispatchVaultRekeyed(params.userId, "vault_method_switched_to_generated");
        trackEvent("profile_method_switch_result", {
          result: "success",
        });
        return { method: material.mode };
      } catch (error) {
        if (
          material.mode === "generated_default_native_biometric" &&
          Capacitor.isNativePlatform()
        ) {
          await VaultBootstrapService.clearGeneratedDefaultMaterial(
            params.userId,
            material.mode as GeneratedVaultKeyMode,
          );
        }
        throw error;
      }
    } catch (error) {
      trackEvent("profile_method_switch_result", {
        result: "error",
      });
      throw normalizeVaultMethodError(error);
    }
  }

  static async changePassphrase(params: {
    userId: string;
    currentVaultKey: string;
    newPassphrase: string;
    keepPrimaryMethod?: boolean;
  }): Promise<{ primaryMethod: VaultMethod; passphraseUpdated: true }> {
    try {
      const canonicalVaultKey = ensureVaultKeyHex(params.currentVaultKey);
      const state = await VaultService.getVaultState(params.userId);
      const vaultKeyHash = await VaultService.hashVaultKey(canonicalVaultKey);

      if (state.vaultKeyHash && state.vaultKeyHash !== vaultKeyHash) {
        throw new Error("Vault key mismatch detected. Unlock vault again.");
      }

      const nextPassphrase = params.newPassphrase.trim();
      if (nextPassphrase.length < 8) {
        throw new Error("Passphrase must be at least 8 characters.");
      }

      const wrapped = await rewrapVaultKeyWithPassphrase({
        vaultKeyHex: canonicalVaultKey,
        wrappingSecret: nextPassphrase,
      });

      await VaultService.upsertVaultWrapper({
        userId: params.userId,
        vaultKeyHash,
        wrapper: {
          method: "passphrase",
          wrapperId: "default",
          encryptedVaultKey: wrapped.encryptedVaultKey,
          salt: wrapped.salt,
          iv: wrapped.iv,
        },
      });

      const keepPrimaryMethod = params.keepPrimaryMethod ?? true;
      if (!keepPrimaryMethod) {
        await VaultService.setPrimaryVaultMethod(
          params.userId,
          "passphrase",
          "default",
        );
        dispatchVaultRekeyed(params.userId, "vault_passphrase_changed");
        return { primaryMethod: "passphrase", passphraseUpdated: true };
      }

      dispatchVaultRekeyed(params.userId, "vault_passphrase_changed");
      return {
        primaryMethod: state.primaryMethod,
        passphraseUpdated: true,
      };
    } catch (error) {
      throw normalizeVaultMethodError(error);
    }
  }

  static async removeMethod(params: {
    userId: string;
    currentVaultKey: string;
    vaultOwnerToken: string;
    method: VaultMethod;
    wrapperId?: string;
    fallbackPrimaryMethod?: VaultMethod;
    fallbackPrimaryWrapperId?: string;
  }): Promise<{ primaryMethod: VaultMethod }> {
    try {
      if (params.method === "passphrase") {
        throw new Error("Passphrase unlock cannot be removed.");
      }

      const canonicalVaultKey = ensureVaultKeyHex(params.currentVaultKey);
      const state = await VaultService.getVaultState(params.userId);
      const vaultKeyHash = await VaultService.hashVaultKey(canonicalVaultKey);

      if (state.vaultKeyHash && state.vaultKeyHash !== vaultKeyHash) {
        throw new Error("Vault key mismatch detected. Unlock vault again.");
      }

      const wrapperId = params.wrapperId ?? "default";
      const targetWrapper = state.wrappers.find(
        (wrapper) =>
          wrapper.method === params.method &&
          (wrapper.wrapperId ?? "default") === wrapperId,
      );
      if (!targetWrapper) {
        throw new Error("This unlock method is no longer enrolled.");
      }

      const fallbackPrimaryMethod =
        params.fallbackPrimaryMethod ?? "passphrase";
      const fallbackPrimaryWrapperId =
        params.fallbackPrimaryWrapperId ?? "default";
      const fallbackWrapper = state.wrappers.find(
        (wrapper) =>
          wrapper.method === fallbackPrimaryMethod &&
          (wrapper.wrapperId ?? "default") === fallbackPrimaryWrapperId,
      );
      if (!fallbackWrapper) {
        throw new Error(
          "Passphrase unlock must be repaired before removing this method.",
        );
      }

      await VaultService.deleteVaultWrapper({
        userId: params.userId,
        vaultKeyHash,
        method: params.method,
        vaultOwnerToken: params.vaultOwnerToken,
        wrapperId,
        fallbackPrimaryMethod,
        fallbackPrimaryWrapperId,
      });

      const removingPrimary =
        state.primaryMethod === params.method &&
        (state.primaryWrapperId ?? "default") === wrapperId;

      return {
        primaryMethod: removingPrimary
          ? fallbackPrimaryMethod
          : state.primaryMethod,
      };
    } catch (error) {
      throw normalizeVaultMethodError(error);
    }
  }
}
