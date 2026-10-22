import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticatePasskeyPrf: vi.fn(),
  authenticateWithPrf: vi.fn(),
  unlockVaultWithPassphrase: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
  },
}));

vi.mock("@/lib/capacitor", () => ({
  HushhKeychain: {},
  HushhVault: { authenticatePasskeyPrf: mocks.authenticatePasskeyPrf },
}));

vi.mock("@/lib/vault/prf-auth", () => ({
  checkBrowserSupport: vi.fn(),
  checkPrfSupport: vi.fn(),
  registerWithPrf: vi.fn(),
  authenticateWithPrf: mocks.authenticateWithPrf,
}));

vi.mock("@/lib/vault/passkey-rp", () => ({
  resolvePasskeyRpId: vi.fn(() => "one.hushh.ai"),
}));

vi.mock("@/lib/vault/passphrase-key", () => ({
  createVaultWithPassphrase: vi.fn(),
  unlockVaultWithPassphrase: mocks.unlockVaultWithPassphrase,
}));

import { VaultBootstrapService } from "@/lib/services/vault-bootstrap-service";

describe("VaultBootstrapService generated web unlock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateWithPrf.mockResolvedValue({
      vaultKeyHex: "derived-vault-key",
      credentialId: "credential-1",
    });
    mocks.unlockVaultWithPassphrase.mockResolvedValue("unlocked-vault-key");
  });

  it("authenticates with the RP recorded on the selected wrapper", async () => {
    await expect(
      VaultBootstrapService.unlockGeneratedDefaultVault({
        userId: "user-1",
        encryptedVaultKey: "encrypted",
        salt: "salt",
        iv: "iv",
        keyMode: "generated_default_web_prf",
        passkeyCredentialId: "credential-1",
        passkeyPrfSalt: "prf-salt",
        passkeyRpId: "one.hushh.ai",
      }),
    ).resolves.toBe("unlocked-vault-key");

    expect(mocks.authenticateWithPrf).toHaveBeenCalledWith(
      "user-1",
      "prf-salt",
      "credential-1",
      "one.hushh.ai",
    );
  });

  it("keeps a native credential's recorded RP even when the build default changes", async () => {
    mocks.authenticatePasskeyPrf.mockResolvedValue({ vaultKeyHex: "derived-vault-key" });
    await expect(VaultBootstrapService.unlockGeneratedDefaultVault({
      userId: "user-1", encryptedVaultKey: "encrypted", salt: "salt", iv: "iv",
      keyMode: "generated_default_native_passkey_prf", passkeyPrfSalt: "prf-salt",
      passkeyCredentialId: "credential-1", passkeyRpId: "uat.one.hushh.ai",
    })).resolves.toBe("unlocked-vault-key");
    expect(mocks.authenticatePasskeyPrf).toHaveBeenCalledWith(expect.objectContaining({
      rpId: "uat.one.hushh.ai", credentialId: "credential-1", prfSalt: "prf-salt",
    }));
  });
});
