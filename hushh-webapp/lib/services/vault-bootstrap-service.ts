"use client";

import { Capacitor } from "@capacitor/core";

import { HushhKeychain, HushhVault } from "@/lib/capacitor";
import {
  checkBrowserSupport,
  checkPrfSupport,
  registerWithPrf,
  authenticateWithPrf,
  cancelPendingPrfAuthentication,
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
      biometricLabel?: string;
    }
  | {
      supported: false;
      reason: string;
    };

export type GeneratedVaultProvisionResult = {
  mode: GeneratedVaultKeyMode;
  wrapperId?: string;
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
  wrapperId?: string;
  passkeyCredentialId?: string;
  passkeyPrfSalt?: string;
  passkeyRpId?: string;
  passkeyProvider?: string;
  passkeyDeviceLabel?: string;
};

export type GeneratedVaultUnlockInput = {
  userId: string;
  wrapperId?: string | null;
  requestId?: string;
  signal?: AbortSignal;
  encryptedVaultKey: string;
  salt: string;
  iv: string;
  keyMode?: string | null;
  authMethod?: string | null;
  passkeyCredentialId?: string | null;
  passkeyPrfSalt?: string | null;
  passkeyRpId?: string | null;
};

const DEFAULT_VAULT_SECRET_PREFIX = "vault_default_secret";
const BIOMETRIC_PROMPT_SET = "Set up quick unlock for One";
const BIOMETRIC_PROMPT_GET = "Unlock One";

function keychainSecretKey(userId: string, wrapperId?: string | null): string {
  const legacyKey = `${DEFAULT_VAULT_SECRET_PREFIX}:${userId}`;
  return !wrapperId || wrapperId === "default" ? legacyKey : `${legacyKey}:${wrapperId}`;
}

function deviceWrapperReferenceKey(userId: string): string {
  return `vault_biometric_wrapper_ref:${userId}`;
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

export function resolveWebPasskeyDeviceLabel(): string {
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
      // Chrome's GREASE placeholder brand ("Not;A Brand", "Not.A/Brand",
      // "Not-A?Brand", ...) randomizes its punctuation every session so sites
      // can't key off one literal string — matching only "not.a/brand" let
      // every other variant through as if it were a real browser name, which
      // is how a passkey label ended up reading "Not-A?Brand passkey on
      // Windows". `.?` treats each separator slot as optional-any-char so it
      // catches all of them.
      (item) => item.brand && !/chromium|not.?a.?brand/i.test(item.brand),
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
  static async cancelAuthentication(requestId?: string): Promise<void> {
    if (Capacitor.isNativePlatform()) {
      await Promise.allSettled([
        HushhKeychain.cancelBiometricAuthentication({ requestId }),
        HushhVault.cancelPasskeyAuthentication({ requestId }),
      ]);
    } else {
      cancelPendingPrfAuthentication();
    }
  }
  static async getBiometricLabel(): Promise<string> {
    if (!Capacitor.isNativePlatform()) return "Biometrics";
    try {
      const { type } = await HushhKeychain.isBiometricAvailable();
      if (type === "faceId") return "Face ID";
      if (type === "touchId") return "Touch ID";
      return "Biometrics";
    } catch {
      return "Biometrics";
    }
  }

  // This is only an opaque wrapper reference, never an unlocked key. A new
  // device must not try another device's biometric wrapper just because it
  // became the account's primary method. Legacy default wrappers still work.
  static async getDeviceBiometricWrapperId(userId: string): Promise<string> {
    if (!Capacitor.isNativePlatform()) return "default";
    const { value } = await HushhKeychain.get({ key: deviceWrapperReferenceKey(userId) });
    return value || "default";
  }

  static async preferDeviceBiometricWrapper(userId: string, wrapperId: string): Promise<void> {
    await HushhKeychain.set({ key: deviceWrapperReferenceKey(userId), value: wrapperId });
  }

  static async canUseGeneratedDefaultVault(): Promise<GeneratedVaultSupport> {
    // Native Keychain unlock does not depend on WebAuthn RP association or a
    // synced credential provider. Preserve passkeys as an explicit alternative.
    if (await canUseNativeBiometricVault()) {
      return {
        supported: true,
        mode: "generated_default_native_biometric",
        biometricLabel: await this.getBiometricLabel(),
      };
    }

    if (await canUseNativePasskeyVault()) {
      return {
        supported: true,
        mode: "generated_default_native_passkey_prf",
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
          "Passkey/PRF is unavailable on this browser. Use a passphrase to keep your information encrypted.",
      };
    }

    return {
      supported: false,
      reason:
        "Biometric protection is unavailable on this device. Use a passphrase to keep your information encrypted.",
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
      wrapperId: material.wrapperId,
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
    targetMethod?: GeneratedVaultKeyMode;
    signal?: AbortSignal;
    requestId?: string;
  }): Promise<GeneratedVaultMethodMaterial> {
    const available = params.targetMethod === "generated_default_native_biometric"
      ? await canUseNativeBiometricVault()
      : params.targetMethod === "generated_default_native_passkey_prf"
        ? await canUseNativePasskeyVault()
        : params.targetMethod === "generated_default_web_prf"
          ? await canUseWebPrfVault()
          : null;
    const support: GeneratedVaultSupport = params.targetMethod
      ? available
        ? { supported: true, mode: params.targetMethod }
        : { supported: false, reason: "Requested unlock method is unavailable on this device." }
      : await this.canUseGeneratedDefaultVault();
    params.signal?.throwIfAborted();
    if (!support.supported) {
      throw new Error(support.reason);
    }

    if (support.mode === "generated_default_native_biometric") {
      const generatedSecret = randomSecretHex(32);
      const wrapperId = `device-${crypto.randomUUID()}`;
      try {
        await HushhKeychain.setBiometric({
          key: keychainSecretKey(params.userId, wrapperId),
          value: generatedSecret,
          promptMessage: BIOMETRIC_PROMPT_SET,
        });
        params.signal?.throwIfAborted();
        // Saving a protected item alone does not prove that this user/device
        // can recover it. Verify the actual Keychain secret before enrollment.
        const recovered = await HushhKeychain.getBiometric({
          key: keychainSecretKey(params.userId, wrapperId),
          promptMessage: BIOMETRIC_PROMPT_SET,
          requestId: params.requestId,
        });
        params.signal?.throwIfAborted();
        if (recovered.value !== generatedSecret) {
          throw new Error("Quick unlock could not be verified. Your passphrase still works.");
        }
        return { mode: support.mode, authMethod: support.mode, wrappingSecret: generatedSecret, wrapperId };
      } catch (error) {
        await this.clearGeneratedDefaultMaterial(params.userId, support.mode, wrapperId);
        throw error;
      }
    }

    if (support.mode === "generated_default_native_passkey_prf") {
      const rpId = resolveRpId();
      const registered = await HushhVault.registerPasskeyPrf({
        userId: params.userId,
        displayName: params.displayName,
        rpId,
        requestId: params.requestId,
      });
      params.signal?.throwIfAborted();
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
    params.signal?.throwIfAborted();
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
    wrapperId?: string | null,
  ): Promise<void> {
    if (mode !== "generated_default_native_biometric") return;

    try {
      await HushhKeychain.deleteBiometric({
        key: keychainSecretKey(userId, wrapperId),
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
    input.signal?.throwIfAborted();

    if (mode === "generated_default_native_biometric") {
      const secret = await HushhKeychain.getBiometric({
        key: keychainSecretKey(input.userId, input.wrapperId),
        promptMessage: BIOMETRIC_PROMPT_GET,
        requestId: input.requestId,
      });
      input.signal?.throwIfAborted();

      if (!secret.value) {
        throw Object.assign(new Error("Quick unlock needs to be set up again on this device. Use your passphrase."), {
          code: "VAULT_DEVICE_WRAPPER_UNAVAILABLE",
        });
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
        requestId: input.requestId,
      });
      input.signal?.throwIfAborted();
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
      input.passkeyRpId ?? undefined,
    );
    input.signal?.throwIfAborted();

    return unlockVaultWithPassphrase(
      auth.vaultKeyHex,
      input.encryptedVaultKey,
      input.salt,
      input.iv,
    );
  }
}
