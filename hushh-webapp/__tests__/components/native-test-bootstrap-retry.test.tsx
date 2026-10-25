import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";

const auth = vi.hoisted(() => ({
  native: true,
  state: {
    loading: false,
    sessionVerificationRequired: false,
    userId: "reviewer-owner" as string | null,
    accountPrincipal: null as { firebaseUid: string; ownerId: string; accountGeneration: number } | null,
    user: { uid: "reviewer-owner" } as { uid: string } | null,
    setNativeUser: vi.fn(),
  },
}));

const services = vi.hoisted(() => ({
  unlocked: false,
  bootstrapState: vi.fn(),
  getVaultState: vi.fn(),
  unlockWithMethod: vi.fn(async () => "decrypted-vault-key"),
  getOrIssueVaultOwnerToken: vi.fn(async () => ({
    token: "vault-owner-token",
    expiresAt: Date.now() + 60_000,
  })),
  unlockVault: vi.fn(() => true),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => auth.native },
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth.state }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ isVaultUnlocked: services.unlocked, unlockVault: services.unlockVault }),
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
    auth.native = true;
    auth.state.loading = false;
    auth.state.sessionVerificationRequired = false;
    auth.state.userId = "reviewer-owner";
    auth.state.accountPrincipal = { firebaseUid: "reviewer-owner", ownerId: "reviewer-owner", accountGeneration: 0 };
    publishValidatedAuthSessionPrincipal(auth.state.accountPrincipal);
    services.unlocked = false;
    services.bootstrapState.mockReset().mockResolvedValue({ hasVault: true });
    services.getVaultState.mockReset().mockResolvedValue({ wrappers: [] });
    services.unlockVault.mockReset().mockReturnValue(true);
    (window as Window & { __HUSHH_NATIVE_TEST__?: Record<string, unknown> })
      .__HUSHH_NATIVE_TEST__ = { enabled: true };
  });

  afterEach(() => {
    cleanup();
    publishValidatedAuthSessionPrincipal(null);
    delete (window as Window & { __HUSHH_NATIVE_TEST__?: unknown })
      .__HUSHH_NATIVE_TEST__;
  });

  it("retries transient setup and vault reads before reporting failure", async () => {
    services.bootstrapState.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    services.getVaultState.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { rerender } = render(<NativeTestBootstrap />);
    await waitFor(() => expect(services.unlockVault).toHaveBeenCalledOnce());
    expect(window.__HUSHH_NATIVE_TEST__?.bootstrapState).not.toBe("vault_unlocked");
    services.unlocked = true;
    rerender(<NativeTestBootstrap />);

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

  it.each([false, true])("waits for a verified owner and refuses a rejected vault admission (native=%s)", async (native) => {
    auth.native = native;
    auth.state.loading = true;
    auth.state.userId = null;
    auth.state.accountPrincipal = null;
    publishValidatedAuthSessionPrincipal(null);
    services.unlockVault.mockReturnValue(false);
    const { rerender } = render(<NativeTestBootstrap />);
    expect(services.bootstrapState).not.toHaveBeenCalled();
    expect(window.__HUSHH_NATIVE_TEST__?.bootstrapState).toBe("waiting_auth");

    auth.state.loading = false;
    rerender(<NativeTestBootstrap />);
    expect(services.bootstrapState).not.toHaveBeenCalled();
    auth.state.accountPrincipal = { firebaseUid: "reviewer-owner", ownerId: "acct_0123456789abcdef0123456789abcdef", accountGeneration: 1 };
    auth.state.userId = auth.state.accountPrincipal.ownerId;
    publishValidatedAuthSessionPrincipal(auth.state.accountPrincipal);
    rerender(<NativeTestBootstrap />);
    await waitFor(() => expect(window.__HUSHH_NATIVE_TEST__?.bootstrapState).toBe("vault_error"));
    expect(services.bootstrapState).toHaveBeenCalledWith(auth.state.userId);
    expect(services.getVaultState).toHaveBeenCalledWith(auth.state.userId);
    expect(services.unlockVault).toHaveBeenCalledOnce();
    expect(window.__HUSHH_NATIVE_TEST__?.replayVaultUnlock).toBeUndefined();
  });
});
