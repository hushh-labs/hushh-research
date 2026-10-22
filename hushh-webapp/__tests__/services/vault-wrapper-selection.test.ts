import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveRpId } = vi.hoisted(() => ({ mockResolveRpId: vi.fn() }));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
}));
vi.mock("@/lib/capacitor", () => ({ HushhVault: {}, HushhAuth: {}, HushhConsent: {} }));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: {} }));
vi.mock("@/lib/firebase/config", () => ({ auth: { currentUser: null } }));
vi.mock("@/lib/cache/cache-sync-service", () => ({ CacheSyncService: {} }));
vi.mock("@/lib/services/pre-vault-user-state-service", () => ({ PreVaultUserStateService: {} }));
vi.mock("@/lib/vault/passphrase-key", () => ({}));
vi.mock("@/lib/services/api-client", () => ({ apiJson: vi.fn() }));
vi.mock("@/lib/vault/passkey-rp", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/vault/passkey-rp")>(),
  resolvePasskeyRpId: (...args: unknown[]) => mockResolveRpId(...args),
}));

import { VaultService } from "@/lib/services/vault-service";

describe("VaultService passkey wrapper selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveRpId.mockReturnValue(null);
  });

  it("selects a canonical RP wrapper on a hosted subdomain", () => {
    mockResolveRpId.mockReturnValue("uat.one.hushh.ai");
    const state = {
      vaultKeyHash: "hash",
      primaryMethod: "generated_default_web_prf" as const,
      primaryWrapperId: "canonical",
      recoveryEncryptedVaultKey: "recovery",
      recoverySalt: "recovery-salt",
      recoveryIv: "recovery-iv",
      wrappers: [
        {
          method: "generated_default_web_prf" as const,
          wrapperId: "canonical",
          encryptedVaultKey: "encrypted",
          salt: "salt",
          iv: "iv",
          passkeyRpId: "one.hushh.ai",
        },
      ],
    };

    expect(
      VaultService.getWrapperByMethod(state, "generated_default_web_prf"),
    ).toMatchObject({
      wrapperId: "canonical",
      passkeyRpId: "one.hushh.ai",
    });
  });

  it.each(["one.hushh.ai"])(
    "reuses the stored production RP %s after the spelling migration",
    (storedRp) => {
      mockResolveRpId.mockReturnValue("one.hussh.ai");
      const wrapper = { method: "generated_default_web_prf" as const,
        wrapperId: "legacy", encryptedVaultKey: "encrypted", salt: "salt", iv: "iv",
        passkeyRpId: storedRp, passkeyCredentialId: "credential", passkeyPrfSalt: "prf-salt" };
      const state = { vaultKeyHash: "hash", primaryMethod: wrapper.method,
        primaryWrapperId: wrapper.wrapperId, recoveryEncryptedVaultKey: "recovery",
        recoverySalt: "salt", recoveryIv: "iv", wrappers: [wrapper] };
      expect(VaultService.getWrapperByMethod(state, wrapper.method)).toBe(wrapper);
      for (const host of ["dev.one.hussh.ai", "uat.one.hussh.ai", "evil.one.hussh.ai"]) {
        mockResolveRpId.mockReturnValue(host);
        expect(VaultService.getWrapperByMethod(state, wrapper.method)).toBeNull();
      }
    },
  );

  it("preserves null metadata fallback without choosing it over an incompatible explicit RP", () => {
    mockResolveRpId.mockReturnValue("one.hussh.ai");
    const wrapper = { method: "generated_default_web_prf" as const,
      wrapperId: "missing-rp", encryptedVaultKey: "encrypted", salt: "salt", iv: "iv" };
    const state = { vaultKeyHash: "hash", primaryMethod: wrapper.method,
      primaryWrapperId: wrapper.wrapperId, recoveryEncryptedVaultKey: "recovery",
      recoverySalt: "salt", recoveryIv: "iv", wrappers: [wrapper] };
    expect(VaultService.getWrapperByMethod(state, wrapper.method)).toBe(wrapper);
    const foreign = { ...wrapper, wrapperId: "foreign", passkeyRpId: "uat.one.hushh.ai" };
    expect(VaultService.getWrapperByMethod({ ...state, wrappers: [foreign, wrapper] }, wrapper.method)).toBeNull();
    const compatible = { ...wrapper, wrapperId: "compatible", passkeyRpId: "one.hushh.ai" };
    expect(VaultService.getWrapperByMethod({ ...state, wrappers: [foreign, wrapper, compatible] }, wrapper.method)).toBe(compatible);
  });
});
