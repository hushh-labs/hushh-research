import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  setBiometric: vi.fn(), getBiometric: vi.fn(), deleteBiometric: vi.fn(),
  set: vi.fn(), get: vi.fn(), isBiometricAvailable: vi.fn(),
  isPasskeyAvailable: vi.fn(), registerPasskeyPrf: vi.fn(),
  decrypt: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => "ios" } }));
vi.mock("@/lib/capacitor", () => ({ HushhKeychain: native, HushhVault: native }));
vi.mock("@/lib/vault/prf-auth", () => ({
  checkBrowserSupport: vi.fn(), checkPrfSupport: vi.fn(),
  registerWithPrf: vi.fn(), authenticateWithPrf: vi.fn(), cancelPendingPrfAuthentication: vi.fn(),
}));
vi.mock("@/lib/vault/passkey-rp", () => ({ resolvePasskeyRpId: () => "one.hushh.ai" }));
vi.mock("@/lib/vault/passphrase-key", () => ({ createVaultWithPassphrase: vi.fn(), unlockVaultWithPassphrase: native.decrypt }));
import { VaultBootstrapService as Bootstrap } from "@/lib/services/vault-bootstrap-service";

describe("native biometric enrollment", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    native.isBiometricAvailable.mockResolvedValue({ available: true, type: "faceId" });
    native.isPasskeyAvailable.mockResolvedValue({ available: true });
    native.get.mockResolvedValue({ value: null });
    native.getBiometric.mockImplementation(async () => ({ value: native.setBiometric.mock.lastCall?.[0].value }));
    native.decrypt.mockResolvedValue("verified-key");
  });

  it("prefers actual Face ID capability but honors an explicit passkey selection", async () => {
    expect(await Bootstrap.canUseGeneratedDefaultVault()).toEqual({ supported: true, mode: "generated_default_native_biometric", biometricLabel: "Face ID" });
    native.registerPasskeyPrf.mockResolvedValue({ vaultKeyHex: "prf-secret", credentialId: "credential", prfSalt: "salt" });
    const material = await Bootstrap.provisionGeneratedMethodMaterial({ userId: "owner", displayName: "One", targetMethod: "generated_default_native_passkey_prf" });
    expect(material.mode).toBe("generated_default_native_passkey_prf");
    expect(native.setBiometric).not.toHaveBeenCalled();
  });

  it("uses independent protected references and verifies recovery before preferring", async () => {
    const first = await Bootstrap.provisionGeneratedMethodMaterial({ userId: "owner", displayName: "One", targetMethod: "generated_default_native_biometric" });
    const second = await Bootstrap.provisionGeneratedMethodMaterial({ userId: "owner", displayName: "One", targetMethod: "generated_default_native_biometric" });
    expect(first.wrapperId).not.toBe(second.wrapperId);
    expect(first.wrapperId).toMatch(/^device-/);
    expect(native.setBiometric.mock.calls[0][0].key).toBe(`vault_default_secret:owner:${first.wrapperId}`);
    expect(native.getBiometric).toHaveBeenCalledTimes(2);
    expect(native.set).not.toHaveBeenCalled();
    expect(native.deleteBiometric).not.toHaveBeenCalled();
  });

  it("only removes the newly staged item when enrollment is cancelled", async () => {
    native.getBiometric.mockRejectedValue(Object.assign(new Error("Cancelled"), { code: "USER_CANCELLED" }));
    await expect(Bootstrap.provisionGeneratedMethodMaterial({ userId: "owner", displayName: "One", targetMethod: "generated_default_native_biometric" })).rejects.toThrow("Cancelled");
    expect(native.deleteBiometric).toHaveBeenCalledWith({ key: native.setBiometric.mock.calls[0][0].key });
    expect(native.deleteBiometric.mock.calls[0][0].key).not.toBe("vault_default_secret:owner");
    expect(native.set).not.toHaveBeenCalled();
  });

  it("rejects enrollment when a biometric check does not recover the saved secret", async () => {
    native.getBiometric.mockResolvedValue({ value: "wrong-secret" });
    await expect(Bootstrap.provisionGeneratedMethodMaterial({ userId: "owner", displayName: "One" })).rejects.toThrow("could not be verified");
    expect(native.set).not.toHaveBeenCalled();
  });

  it("preserves legacy default Keychain lookup and uses exact device references for new wrappers", async () => {
    native.getBiometric.mockResolvedValue({ value: "secret" });
    const input = { userId: "owner", keyMode: "generated_default_native_biometric", encryptedVaultKey: "ciphertext", salt: "salt", iv: "iv" };
    await Bootstrap.unlockGeneratedDefaultVault(input);
    expect(native.getBiometric).toHaveBeenLastCalledWith(expect.objectContaining({ key: "vault_default_secret:owner" }));
    await Bootstrap.unlockGeneratedDefaultVault({ ...input, wrapperId: "device-two" });
    expect(native.getBiometric).toHaveBeenLastCalledWith(expect.objectContaining({ key: "vault_default_secret:owner:device-two" }));
    expect(native.decrypt).toHaveBeenCalledWith("secret", "ciphertext", "salt", "iv");
  });
});
