import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";

vi.mock("@/lib/services/vault-service", () => ({
  VaultService: {
    getVaultState: vi.fn(),
    getOrIssueVaultOwnerToken: vi.fn(),
    hashVaultKey: vi.fn(),
    upsertVaultWrapper: vi.fn(),
    deleteVaultWrapper: vi.fn(),
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
  const ownerTokenMock = vi.mocked(VaultService.getOrIssueVaultOwnerToken);
  const hashVaultKeyMock = vi.mocked(VaultService.hashVaultKey);
  const upsertWrapperMock = vi.mocked(VaultService.upsertVaultWrapper);
  const deleteWrapperMock = vi.mocked(VaultService.deleteVaultWrapper);
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
    ownerTokenMock.mockResolvedValue({ token: "owner-token", expiresAt: 9999999999999, scope: "VAULT_OWNER" });
    hashVaultKeyMock.mockResolvedValue("vault-hash");
    rewrapMock.mockResolvedValue({
      encryptedVaultKey: "wrapped-key",
      salt: "wrapped-salt",
      iv: "wrapped-iv",
    });
  });

  it("updates passphrase wrapper without changing primary method by default", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    let acknowledge!: () => void;
    let acknowledged = false;
    let observed: { acknowledged: boolean; beforeRekey: boolean } | undefined;
    upsertWrapperMock.mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
    const committed = vi.fn(() => {
      observed = { acknowledged, beforeRekey: !dispatchSpy.mock.calls.some(([event]) => event.type === "vault-rekeyed") };
    });

    const pending = VaultMethodService.changePassphrase({
      userId: "uid-1",
      currentVaultKey:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      newPassphrase: "new-passphrase-123",
      onCommitted: committed,
    });
    await waitFor(() => expect(upsertWrapperMock).toHaveBeenCalledTimes(1));
    expect(committed).not.toHaveBeenCalled();
    acknowledged = true;
    acknowledge();
    const result = await pending;
    expect(observed).toEqual({ acknowledged: true, beforeRekey: true });

    expect(upsertWrapperMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "uid-1",
        vaultOwnerToken: "owner-token",
        wrapper: expect.objectContaining({
          method: "passphrase",
          wrapperId: "default",
        }),
      }),
    );
    expect(setPrimaryMock).not.toHaveBeenCalled();
    expect(committed).toHaveBeenCalledExactlyOnceWith({
      primaryMethod: "generated_default_native_passkey_prf", passphraseUpdated: true,
    });
    expect(hashVaultKeyMock).toHaveBeenCalledWith(
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "vault-hash",
    );
    expect(upsertWrapperMock).toHaveBeenCalledWith(expect.objectContaining({ vaultKeyHash: "vault-hash" }));
    expect(result).toEqual({
      primaryMethod: "generated_default_native_passkey_prf",
      passphraseUpdated: true,
    });
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "vault-rekeyed",
        detail: {
          userId: "uid-1",
          reason: "vault_passphrase_changed",
        },
      })
    );
  });

  it("cancels before persistence but does not report an acknowledged write as failed after cancellation", async () => {
    const controller = new AbortController();
    const committed = vi.fn();
    const material = { encryptedVaultKey: "synthetic-ciphertext", salt: "synthetic-salt", iv: "synthetic-iv" };
    rewrapMock.mockImplementationOnce(async () => { controller.abort(); return material; });
    const input = { userId: "uid-1", currentVaultKey: "ab".repeat(32), newPassphrase: "synthetic-passphrase",
      signal: controller.signal, onCommitted: committed };
    await expect(VaultMethodService.changePassphrase(input)).rejects.toThrow();
    expect(upsertWrapperMock).not.toHaveBeenCalled();
    expect(committed).not.toHaveBeenCalled();
    const afterCommit = new AbortController();
    upsertWrapperMock.mockImplementationOnce(async () => { afterCommit.abort(); });
    await expect(VaultMethodService.changePassphrase({ ...input, signal: afterCommit.signal })).resolves.toMatchObject({ passphraseUpdated: true });
    expect(committed).toHaveBeenCalledTimes(1);
  });

  it("can set passphrase as primary when keepPrimaryMethod is false", async () => {
    const result = await VaultMethodService.changePassphrase({
      userId: "uid-1",
      currentVaultKey:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      newPassphrase: "new-passphrase-123",
      keepPrimaryMethod: false,
    });

    expect(setPrimaryMock).toHaveBeenCalledWith(
      "uid-1",
      "passphrase",
      "default",
      "owner-token",
    );
    expect(result).toEqual({
      primaryMethod: "passphrase",
      passphraseUpdated: true,
    });
  });

  it("maps RP mismatch errors to actionable message", async () => {
    upsertWrapperMock.mockRejectedValueOnce(
      new Error("wrapper rp id is not allowed for this environment"),
    );

    await expect(
      VaultMethodService.changePassphrase({
        userId: "uid-1",
        currentVaultKey:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        newPassphrase: "new-passphrase-123",
      }),
    ).rejects.toThrow(/older domain/i);
  });
  it("preserves passphrase primary selection result shape", async () => {
    const result = await VaultMethodService.changePassphrase({
      userId: "uid-1",
      currentVaultKey:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      newPassphrase: "new-passphrase-123",
      keepPrimaryMethod: false,
    });

    expect(result.primaryMethod).toBe("passphrase");
    expect(result.passphraseUpdated).toBe(true);
  });

  it("preserves recovery material when passphrase changes", async () => {
    await VaultMethodService.changePassphrase({
      userId: "uid-1",
      currentVaultKey:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      newPassphrase: "new-passphrase-123",
    });

    expect(upsertWrapperMock).toHaveBeenCalledWith(
      expect.objectContaining({
        wrapper: expect.objectContaining({
          method: "passphrase",
          wrapperId: "default",
        }),
      }),
    );

    const latestVaultState = await getVaultStateMock.mock.results[0]?.value;

    expect(latestVaultState?.recoveryEncryptedVaultKey).toBe("r1");
    expect(latestVaultState?.recoverySalt).toBe("r2");
    expect(latestVaultState?.recoveryIv).toBe("r3");
  });

  describe("removeMethod", () => {
    it("removes a passkey wrapper and falls back to passphrase when primary", async () => {
      const result = await VaultMethodService.removeMethod({
        userId: "uid-1",
        currentVaultKey:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        vaultOwnerToken: "vault-owner-token-1",
        method: "generated_default_native_passkey_prf",
        wrapperId: "cred-1",
      });

      expect(deleteWrapperMock).toHaveBeenCalledWith({
        userId: "uid-1",
        vaultKeyHash: "vault-hash",
        method: "generated_default_native_passkey_prf",
        vaultOwnerToken: "vault-owner-token-1",
        wrapperId: "cred-1",
        fallbackPrimaryMethod: "passphrase",
        fallbackPrimaryWrapperId: "default",
      });
      expect(result).toEqual({ primaryMethod: "passphrase" });
    });

    it("rejects passphrase removal", async () => {
      await expect(
        VaultMethodService.removeMethod({
          userId: "uid-1",
          currentVaultKey:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          vaultOwnerToken: "vault-owner-token-1",
          method: "passphrase",
          wrapperId: "default",
        }),
      ).rejects.toThrow(/cannot be removed/i);

      expect(deleteWrapperMock).not.toHaveBeenCalled();
    });

    it("requires a passphrase fallback before removing quick unlock", async () => {
      getVaultStateMock.mockResolvedValueOnce({
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
        ],
      });

      await expect(
        VaultMethodService.removeMethod({
          userId: "uid-1",
          currentVaultKey:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          vaultOwnerToken: "vault-owner-token-1",
          method: "generated_default_native_passkey_prf",
          wrapperId: "cred-1",
        }),
      ).rejects.toThrow(/passphrase unlock must be repaired/i);

      expect(deleteWrapperMock).not.toHaveBeenCalled();
    });
  });
});
