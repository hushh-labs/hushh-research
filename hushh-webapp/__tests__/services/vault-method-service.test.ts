import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/services/vault-service", () => ({
  VaultService: {
    getVaultState: vi.fn(),
    hashVaultKey: vi.fn(),
    upsertVaultWrapper: vi.fn(),
    setPrimaryVaultMethod: vi.fn(),
    canUseGeneratedDefaultVault: vi.fn(),
  },
}));

vi.mock("@/lib/services/vault-bootstrap-service", () => ({
  VaultBootstrapService: {
    provisionGeneratedMethodMaterial: vi.fn(),
    clearGeneratedDefaultMaterial: vi.fn(),
  },
}));

vi.mock("@/lib/vault/rewrap-vault-key", () => ({
  rewrapVaultKeyWithPassphrase: vi.fn(),
}));

import { VaultService, type VaultState } from "@/lib/services/vault-service";
import { rewrapVaultKeyWithPassphrase } from "@/lib/vault/rewrap-vault-key";
import { VaultMethodService } from "@/lib/services/vault-method-service";

describe("VaultMethodService.changePassphrase", () => {
  const getVaultStateMock = vi.mocked(VaultService.getVaultState);
  const hashVaultKeyMock = vi.mocked(VaultService.hashVaultKey);
  const upsertWrapperMock = vi.mocked(VaultService.upsertVaultWrapper);
  const setPrimaryMock = vi.mocked(VaultService.setPrimaryVaultMethod);
  const rewrapMock = vi.mocked(rewrapVaultKeyWithPassphrase);

  beforeEach(() => {
    vi.clearAllMocks();
    const mockVaultState: VaultState = {
      vaultKeyHash: "vault-hash",
      primaryMethod: "generated_default_native_passkey_prf",
      primaryWrapperId: "cred-1",
      recoveryEncryptedVaultKey: "r1",
      recoverySalt: "r2",
      recoveryIv: "r3",
      wrappers: [
        {
          method: "generated_default_native_passkey_prf",
          wrapperId: "cred-1",
          encryptedVaultKey: "e1",
          salt: "s1",
          iv: "i1",
        },
        {
          method: "passphrase",
          wrapperId: "default",
          encryptedVaultKey: "e2",
          salt: "s2",
          iv: "i2",
        },
      ],
    };
    getVaultStateMock.mockResolvedValue(mockVaultState);
    hashVaultKeyMock.mockResolvedValue("vault-hash");
    rewrapMock.mockResolvedValue({
      encryptedVaultKey: "wrapped-key",
      salt: "wrapped-salt",
      iv: "wrapped-iv",
    });
  });

  it("updates passphrase wrapper without changing primary method by default", async () => {
    const result = await VaultMethodService.changePassphrase({
      userId: "uid-1",
      currentVaultKey:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      newPassphrase: "new-passphrase-123",
    });

    expect(upsertWrapperMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "uid-1",
        wrapper: expect.objectContaining({
          method: "passphrase",
          wrapperId: "default",
        }),
      })
    );
    expect(setPrimaryMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      primaryMethod: "generated_default_native_passkey_prf",
      passphraseUpdated: true,
    });
  });

  it("can set passphrase as primary when keepPrimaryMethod is false", async () => {
    const result = await VaultMethodService.changePassphrase({
      userId: "uid-1",
      currentVaultKey:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      newPassphrase: "new-passphrase-123",
      keepPrimaryMethod: false,
    });

    expect(setPrimaryMock).toHaveBeenCalledWith("uid-1", "passphrase", "default");
    expect(result).toEqual({
      primaryMethod: "passphrase",
      passphraseUpdated: true,
    });
  });

  it("maps RP mismatch errors to actionable message", async () => {
    upsertWrapperMock.mockRejectedValueOnce(
      new Error("wrapper rp id is not allowed for this environment")
    );

    await expect(
      VaultMethodService.changePassphrase({
        userId: "uid-1",
        currentVaultKey:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        newPassphrase: "new-passphrase-123",
      })
    ).rejects.toThrow(/older domain/i);
  });
});
