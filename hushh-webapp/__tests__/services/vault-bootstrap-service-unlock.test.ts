import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
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
  HushhVault: {},
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
});
