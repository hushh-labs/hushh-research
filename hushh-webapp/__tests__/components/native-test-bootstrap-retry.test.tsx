import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  state: {
    loading: false,
    user: { uid: "reviewer-owner" } as { uid: string } | null,
    setNativeUser: vi.fn(),
  },
}));

const services = vi.hoisted(() => ({
  bootstrapState: vi
    .fn()
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValue({ hasVault: true }),
  getVaultState: vi
    .fn()
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValue({ wrappers: [] }),
  unlockWithMethod: vi.fn(async () => "decrypted-vault-key"),
  getOrIssueVaultOwnerToken: vi.fn(async () => ({
    token: "vault-owner-token",
    expiresAt: Date.now() + 60_000,
  })),
  unlockVault: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth.state }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ isVaultUnlocked: false, unlockVault: services.unlockVault }),
}));
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: {
    getCurrentUser: () => auth.state.user,
    restoreNativeSession: vi.fn(async () => null),
  },
}));
vi.mock("@/lib/services/api-service", () => ({ ApiService: {} }));
vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    bootstrapState: services.bootstrapState,
    isSetupResolved: () => true,
  },
}));
vi.mock("@/lib/services/vault-service", () => ({
  VaultService: {
    getVaultState: services.getVaultState,
    unlockWithMethod: services.unlockWithMethod,
    getOrIssueVaultOwnerToken: services.getOrIssueVaultOwnerToken,
  },
}));
vi.mock("@/lib/testing/local-reviewer-auth", () => ({
  resolveLocalReviewerCredentials: () => null,
}));
vi.mock("@/lib/testing/native-test", () => ({
  useNativeTestConfig: () => ({
    enabled: true,
    autoReviewerLogin: true,
    vaultPassphrase: "test-passphrase",
    expectedUserId: "reviewer-owner",
  }),
}));

import { NativeTestBootstrap } from "@/components/app-ui/native-test-bootstrap";

describe("NativeTestBootstrap transient vault reads", () => {
  beforeEach(() => {
    (window as Window & { __HUSHH_NATIVE_TEST__?: Record<string, unknown> })
      .__HUSHH_NATIVE_TEST__ = { enabled: true };
  });

  afterEach(() => {
    cleanup();
    delete (window as Window & { __HUSHH_NATIVE_TEST__?: unknown })
      .__HUSHH_NATIVE_TEST__;
  });

  it("retries transient setup and vault reads before reporting failure", async () => {
    render(<NativeTestBootstrap />);

    await waitFor(() => {
      const bridge = (window as Window & {
        __HUSHH_NATIVE_TEST__?: Record<string, unknown>;
      }).__HUSHH_NATIVE_TEST__;
      expect(bridge?.bootstrapState).toBe("vault_unlocked");
    });

    expect(services.bootstrapState).toHaveBeenCalledTimes(2);
    expect(services.getVaultState).toHaveBeenCalledTimes(2);
    expect(services.unlockVault).toHaveBeenCalledWith(
      "decrypted-vault-key",
      "vault-owner-token",
      expect.any(Number),
    );
  });
});
