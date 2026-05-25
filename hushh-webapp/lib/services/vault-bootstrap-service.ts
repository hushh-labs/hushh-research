"use client";

import { Capacitor } from "@capacitor/core";

import { HushhKeychain, HushhVault } from "@/lib/capacitor";
import {
  checkBrowserSupport,
  checkPrfSupport,
  registerWithPrf,
  authenticateWithPrf,
} from "@/lib/vault/prf-auth";
import { resolvePasskeyRpId } from "@/lib/vault/passkey-rp";
import {
  createVaultWithPassphrase,
  unlockVaultWithPassphrase,
} from "@/lib/vault/passphrase-key";

export type GeneratedVaultKeyMode =
  | "generated_default_native_biometric"
  | "generated_default_web_prf"
  | "generated_default_native_passkey_prf";

export type GeneratedVaultSupport =
  | {
      supported: true;
      mode: GeneratedVaultKeyMode;
    }
  | {
      supported: false;
      reason: string;
    };

export type GeneratedVaultProvisionResult = {
  mode: GeneratedVaultKeyMode;
  authMethod: GeneratedVaultKeyMode;
  encryptedVaultKey: string;
  salt: string;
  iv: string;
  recoveryEncryptedVaultKey: string;
  recoverySalt: string;
  recoveryIv: string;
  recoveryKey: string;
  passkeyCredentialId?: string;
  passkeyPrfSalt?: string;
  passkeyRpId?: string;
  passkeyProvider?: string;
  passkeyDeviceLabel?: string;
};

export type GeneratedVaultMethodMaterial = {
  mode: GeneratedVaultKeyMode;
  authMethod: GeneratedVaultKeyMode;
  wrappingSecret: string;
  passkeyCredentialId?: string;
  passkeyPrfSalt?: string;
  passkeyRpId?: string;
  passkeyProvider?: string;
  passkeyDeviceLabel?: string;
};

export type GeneratedVaultUnlockInput = {
  userId: string;
  encryptedVaultKey: string;
  salt: string;
  iv: string;
  keyMode?: string | null;
  authMethod?: string | null;
  passkeyCredentialId?: string | null;
  passkeyPrfSalt?: string | null;
};

const DEFAULT_VAULT_SECRET_PREFIX = "vault_default_secret";
const BIOMETRIC_PROMPT_SET = "Authenticate to enable secure default vault";
const BIOMETRIC_PROMPT_GET = "Authenticate to unlock your secure vault";

function keychainSecretKey(userId: string): string {
  return `${DEFAULT_VAULT_SECRET_PREFIX}:${userId}`;
}

function normalizeKeyMode(input: {
  keyMode?: string | null;
  authMethod?: string | null;
}): GeneratedVaultKeyMode | null {
  const value = input.keyMode ?? input.authMethod ?? null;
  if (value === "generated_default_native_biometric") {
    return value;
  }
  if (value === "generated_default_web_prf") {
    return value;
  }
  if (value === "generated_default_native_passkey_prf") {
    return value;
  }
  return null;
}

function randomSecretHex(bytes = 32): string {
  const random = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(random)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function canUseNativeBiometricVault(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const result = await HushhKeychain.isBiometricAvailable();
    return result.available;
  } catch (error) {
    console.warn(
      "[VaultBootstrapService] Native biometric availability check failed:",
      error,
    );
    return false;
  }
}

function resolveRpId(): string {
  return resolvePasskeyRpId({
    isNative: Capacitor.isNativePlatform(),
    hostname: typeof window !== "undefined" ? window.location.hostname : null,
  });
}

function resolveWebPasskeyDeviceLabel(): string {
  if (typeof navigator === "undefined") return "Browser passkey";

  const nav = navigator as Navigator & {
    userAgentData?: {
      brands?: Array<{ brand?: string; version?: string }>;
      platform?: string;
    };
  };
  const brands = nav.userAgentData?.brands || [];
  const brand =
    brands.find(
      (item) =>
        item.brand && !/chromium|not.a\/brand|not a brand/i.test(item.brand),
    )?.brand || "";
  const platform = nav.userAgentData?.platform || "";
  const ua = navigator.userAgent || "";

  let browser = brand;
  if (!browser) {
    if (/Edg\//.test(ua)) browser = "Edge";
    else if (/Chrome\//.test(ua)) browser = "Chrome";
    else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) browser = "Safari";
    else if (/Firefox\//.test(ua)) browser = "Firefox";
  }

  let device = platform;
  if (!device) {
    if (/Macintosh|Mac OS X/i.test(ua)) device = "Mac";
    else if (/iPhone/i.test(ua)) device = "iPhone";
    else if (/iPad/i.test(ua)) device = "iPad";
    else if (/Android/i.test(ua)) device = "Android";
    else if (/Windows/i.test(ua)) device = "Windows";
  }

  if (browser && device) return `${browser} passkey on ${device}`;
  if (browser) return `${browser} passkey`;
  if (device) return `Passkey on ${device}`;
  return "Browser passkey";
}

function resolveNativePasskeyDeviceLabel(): string {
  const platform = Capacitor.getPlatform();
  if (platform === "ios") return "iOS passkey";
  if (platform === "android") return "Android passkey";
  return "Device passkey";
}

async function canUseNativePasskeyVault(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const result = await HushhVault.isPasskeyAvailable({ rpId: resolveRpId() });
    return !!result.available;
  } catch (error) {
    console.warn(
      "[VaultBootstrapService] Native passkey availability check failed:",
      error,
    );
    return false;
  }
}

async function canUseWebPrfVault(): Promise<boolean> {
  if (Capacitor.isNativePlatform()) return false;
  if (typeof window === "undefined") return false;

  const browser = checkBrowserSupport();
  if (!browser.supported) {
    return false;
  }
  return checkPrfSupport();
}

export class VaultBootstrapService {
  static async canUseGeneratedDefaultVault(): Promise<GeneratedVaultSupport> {
    if (await canUseNativePasskeyVault()) {
      return {
        supported: true,
        mode: "generated_default_native_passkey_prf",
      };
    }

    if (await canUseNativeBiometricVault()) {
      return {
        supported: true,
        mode: "generated_default_native_biometric",
      };
    }

    if (await canUseWebPrfVault()) {
      return {
        supported: true,
        mode: "generated_default_web_prf",
      };
    }

    if (!Capacitor.isNativePlatform()) {
      return {
        supported: false,
        reason:
          "Passkey/PRF is unavailable on this browser. Use a passphrase to keep data encrypted.",
      };
    }

    return {
      supported: false,
      reason:
        "Biometric protection is unavailable on this device. Use a passphrase to keep data encrypted.",
    };
  }

  static async provisionGeneratedDefaultVault(params: {
    userId: string;
    displayName: string;
  }): Promise<GeneratedVaultProvisionResult> {
    const material = await this.provisionGeneratedMethodMaterial(params);
    const vaultData = await createVaultWithPassphrase(material.wrappingSecret);

    return {
      mode: material.mode,
      authMethod: material.authMethod,
      encryptedVaultKey: vaultData.encryptedVaultKey,
      salt: vaultData.salt,
      iv: vaultData.iv,
      recoveryEncryptedVaultKey: vaultData.recoveryEncryptedVaultKey,
      recoverySalt: vaultData.recoverySalt,
      recoveryIv: vaultData.recoveryIv,
      recoveryKey: vaultData.recoveryKey,
      passkeyCredentialId: material.passkeyCredentialId,
      passkeyPrfSalt: material.passkeyPrfSalt,
      passkeyRpId: material.passkeyRpId,
      passkeyProvider: material.passkeyProvider,
      passkeyDeviceLabel: material.passkeyDeviceLabel,
    };
  }

  static async provisionGeneratedMethodMaterial(params: {
    userId: string;
    displayName: string;
  }): Promise<GeneratedVaultMethodMaterial> {
    const support = await this.canUseGeneratedDefaultVault();
    if (!support.supported) {
      throw new Error(support.reason);
    }

    if (support.mode === "generated_default_native_biometric") {
      const generatedSecret = randomSecretHex(32);
      await HushhKeychain.setBiometric({
        key: keychainSecretKey(params.userId),
        value: generatedSecret,
        promptMessage: BIOMETRIC_PROMPT_SET,
      });

      return {
        mode: support.mode,
        authMethod: support.mode,
        wrappingSecret: generatedSecret,
      };
    }

    if (support.mode === "generated_default_native_passkey_prf") {
      const rpId = resolveRpId();
      const registered = await HushhVault.registerPasskeyPrf({
        userId: params.userId,
        displayName: params.displayName,
        rpId,
      });
      return {
        mode: support.mode,
        authMethod: support.mode,
        wrappingSecret: registered.vaultKeyHex,
        passkeyCredentialId: registered.credentialId,
        passkeyPrfSalt: registered.prfSalt,
        passkeyRpId: rpId,
        passkeyProvider: "native_passkey",
        passkeyDeviceLabel: resolveNativePasskeyDeviceLabel(),
      };
    }

    const prfRegistration = await registerWithPrf(
      params.userId,
      params.displayName,
    );
    const rpId = resolveRpId();

    return {
      mode: support.mode,
      authMethod: support.mode,
      wrappingSecret: prfRegistration.vaultKeyHex,
      passkeyCredentialId: prfRegistration.credentialId,
      passkeyPrfSalt: prfRegistration.prfSalt,
      passkeyRpId: rpId,
      passkeyProvider: "webauthn_prf",
      passkeyDeviceLabel: resolveWebPasskeyDeviceLabel(),
    };
  }

  static async clearGeneratedDefaultMaterial(
    userId: string,
    mode?: GeneratedVaultKeyMode | null,
  ): Promise<void> {
    if (mode !== "generated_default_native_biometric") return;

    try {
      await HushhKeychain.delete({
        key: keychainSecretKey(userId),
      });
    } catch (error) {
      console.warn(
        "[VaultBootstrapService] Failed to clear native biometric secret:",
        error,
      );
    }
  }

  static async unlockGeneratedDefaultVault(
    input: GeneratedVaultUnlockInput,
  ): Promise<string | null> {
    const mode = normalizeKeyMode(input);
    if (!mode) return null;

    if (mode === "generated_default_native_biometric") {
      const secret = await HushhKeychain.getBiometric({
        key: keychainSecretKey(input.userId),
        promptMessage: BIOMETRIC_PROMPT_GET,
      });

      if (!secret.value) {
        throw new Error("Biometric vault secret not available.");
      }

      return unlockVaultWithPassphrase(
        secret.value,
        input.encryptedVaultKey,
        input.salt,
        input.iv,
      );
    }

    if (mode === "generated_default_native_passkey_prf") {
      if (!input.passkeyPrfSalt) {
        throw new Error("Passkey metadata missing for native passkey vault.");
      }
      const auth = await HushhVault.authenticatePasskeyPrf({
        userId: input.userId,
        rpId: resolveRpId(),
        credentialId: input.passkeyCredentialId ?? undefined,
        prfSalt: input.passkeyPrfSalt,
      });
      return unlockVaultWithPassphrase(
        auth.vaultKeyHex,
        input.encryptedVaultKey,
        input.salt,
        input.iv,
      );
    }

    if (!input.passkeyPrfSalt) {
      throw new Error("Passkey metadata missing for generated default vault.");
    }

    const auth = await authenticateWithPrf(
      input.userId,
      input.passkeyPrfSalt,
      input.passkeyCredentialId ?? undefined,
    );

    return unlockVaultWithPassphrase(
      auth.vaultKeyHex,
      input.encryptedVaultKey,
      input.salt,
      input.iv,
    );
  }
}
