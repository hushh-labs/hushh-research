import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ isNativePlatform: vi.fn(() => true) }));
const vault = vi.hoisted(() => ({
  getVaultState: vi.fn(),
  hashVaultKey: vi.fn(),
  upsertVaultWrapper: vi.fn(),
  getWrapperByMethod: vi.fn(),
  assertVaultKeyMatchesState: vi.fn(),
  setPrimaryVaultMethod: vi.fn(),
}));
const bootstrap = vi.hoisted(() => ({
  provisionGeneratedMethodMaterial: vi.fn(),
  clearGeneratedDefaultMaterial: vi.fn(),
  preferDeviceBiometricWrapper: vi.fn(),
}));
const crypto = vi.hoisted(() => ({
  rewrapVaultKeyWithPassphrase: vi.fn(),
  unlockVaultWithPassphrase: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({ Capacitor: native }));
vi.mock("@/lib/services/vault-service", () => ({ VaultService: vault }));
vi.mock("@/lib/services/vault-bootstrap-service", () => ({
  VaultBootstrapService: bootstrap,
}));
vi.mock("@/lib/vault/rewrap-vault-key", () => ({
  rewrapVaultKeyWithPassphrase: crypto.rewrapVaultKeyWithPassphrase,
}));
vi.mock("@/lib/vault/passphrase-key", () => ({
  unlockVaultWithPassphrase: crypto.unlockVaultWithPassphrase,
}));
vi.mock("@/lib/observability/client", () => ({ trackEvent: vi.fn() }));

import { VaultMethodService } from "@/lib/services/vault-method-service";

// Deterministic test-only key; never a credential from a real Vault.
const vaultKey = "ab".repeat(32);

function state(wrappers: Array<Record<string, unknown>>) {
  return {
    vaultKeyHash: "vault-hash",
    primaryMethod: "passphrase",
    primaryWrapperId: "default",
    recoveryEncryptedVaultKey: "recovery-ciphertext",
    recoverySalt: "recovery-salt",
    recoveryIv: "recovery-iv",
    wrappers,
  };
}

const existingPassphrase = {
  method: "passphrase",
  wrapperId: "default",
  encryptedVaultKey: "passphrase-ciphertext",
  salt: "passphrase-salt",
  iv: "passphrase-iv",
};

function wrapperFor(
  source: { wrappers: Array<Record<string, unknown>> },
  method: string,
  options?: { wrapperId?: string },
) {
  return source.wrappers.find(
    (candidate) =>
      candidate.method === method &&
      (!options?.wrapperId || (candidate.wrapperId ?? "default") === options.wrapperId),
  ) ?? null;
}

describe("VaultMethodService generated enrollment verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    native.isNativePlatform.mockReturnValue(true);
    vault.hashVaultKey.mockResolvedValue("vault-hash");
    vault.getWrapperByMethod.mockImplementation(wrapperFor);
    vault.assertVaultKeyMatchesState.mockResolvedValue(undefined);
    vault.upsertVaultWrapper.mockResolvedValue(undefined);
    vault.setPrimaryVaultMethod.mockResolvedValue(undefined);
    bootstrap.preferDeviceBiometricWrapper.mockResolvedValue(undefined);
    bootstrap.provisionGeneratedMethodMaterial.mockResolvedValue({
      mode: "generated_default_native_biometric",
      authMethod: "generated_default_native_biometric",
      wrappingSecret: "new-device-secret",
      wrapperId: "device-new",
    });
    crypto.rewrapVaultKeyWithPassphrase.mockResolvedValue({
      encryptedVaultKey: "new-ciphertext",
      salt: "new-salt",
      iv: "new-iv",
    });
    crypto.unlockVaultWithPassphrase.mockResolvedValue(vaultKey);
  });

  it("verifies the exact persisted wrapper before making it primary", async () => {
    const original = state([existingPassphrase]);
    const persisted = state([
      existingPassphrase,
      {
        method: "generated_default_native_biometric",
        wrapperId: "device-new",
        encryptedVaultKey: "new-ciphertext",
        salt: "new-salt",
        iv: "new-iv",
      },
    ]);
    vault.getVaultState.mockResolvedValueOnce(original).mockResolvedValueOnce(persisted);

    await expect(
      VaultMethodService.switchMethod({
        userId: "owner",
        currentVaultKey: vaultKey,
        displayName: "One",
        targetMethod: "generated_default_native_biometric",
      }),
    ).resolves.toEqual({ method: "generated_default_native_biometric" });

    expect(bootstrap.provisionGeneratedMethodMaterial).toHaveBeenCalledWith(
      expect.objectContaining({
        targetMethod: "generated_default_native_biometric",
      }),
    );
    expect(vault.upsertVaultWrapper).toHaveBeenCalledWith(
      expect.objectContaining({
        wrapper: expect.objectContaining({
          method: "generated_default_native_biometric",
          wrapperId: "device-new",
        }),
      }),
    );
    expect(crypto.unlockVaultWithPassphrase).toHaveBeenCalledWith(
      "new-device-secret",
      "new-ciphertext",
      "new-salt",
      "new-iv",
    );
    expect(vault.assertVaultKeyMatchesState).toHaveBeenCalledWith(persisted, vaultKey);
    expect(vault.setPrimaryVaultMethod).toHaveBeenCalledWith(
      "owner",
      "generated_default_native_biometric",
      "device-new",
    );
    expect(vault.assertVaultKeyMatchesState.mock.invocationCallOrder[0]).toBeLessThan(
      vault.setPrimaryVaultMethod.mock.invocationCallOrder[0],
    );
    expect(original.wrappers).toEqual([existingPassphrase]);
  });

  it("does not change the primary selection when readback lacks the new wrapper", async () => {
    const original = state([existingPassphrase]);
    vault.getVaultState.mockResolvedValueOnce(original).mockResolvedValueOnce(state([existingPassphrase]));

    await expect(
      VaultMethodService.switchMethod({
        userId: "owner",
        currentVaultKey: vaultKey,
        displayName: "One",
        targetMethod: "generated_default_native_biometric",
      }),
    ).rejects.toThrow(/could not be verified/i);

    expect(vault.setPrimaryVaultMethod).not.toHaveBeenCalled();
    expect(crypto.unlockVaultWithPassphrase).not.toHaveBeenCalled();
    expect(original.wrappers).toEqual([existingPassphrase]);
  });

  it("does not change the primary selection when the device pointer cannot persist", async () => {
    const original = state([existingPassphrase]);
    const persisted = state([
      existingPassphrase,
      {
        method: "generated_default_native_biometric",
        wrapperId: "device-new",
        encryptedVaultKey: "new-ciphertext",
        salt: "new-salt",
        iv: "new-iv",
      },
    ]);
    vault.getVaultState.mockResolvedValueOnce(original).mockResolvedValueOnce(persisted);
    bootstrap.preferDeviceBiometricWrapper.mockRejectedValueOnce(
      new Error("Unable to persist device reference"),
    );

    await expect(
      VaultMethodService.switchMethod({
        userId: "owner",
        currentVaultKey: vaultKey,
        displayName: "One",
        targetMethod: "generated_default_native_biometric",
      }),
    ).rejects.toThrow(/persist device reference/i);

    expect(vault.setPrimaryVaultMethod).not.toHaveBeenCalled();
    expect(original.wrappers).toEqual([existingPassphrase]);
  });

  it("does not report cancellation after the primary write has committed", async () => {
    const controller = new AbortController();
    const original = state([existingPassphrase]);
    const persisted = state([
      existingPassphrase,
      {
        method: "generated_default_native_biometric",
        wrapperId: "device-new",
        encryptedVaultKey: "new-ciphertext",
        salt: "new-salt",
        iv: "new-iv",
      },
    ]);
    vault.getVaultState.mockResolvedValueOnce(original).mockResolvedValueOnce(persisted);
    vault.setPrimaryVaultMethod.mockImplementation(async () => {
      controller.abort();
    });

    await expect(
      VaultMethodService.switchMethod({
        userId: "owner",
        currentVaultKey: vaultKey,
        displayName: "One",
        targetMethod: "generated_default_native_biometric",
        signal: controller.signal,
      }),
    ).resolves.toEqual({ method: "generated_default_native_biometric" });
  });
});
