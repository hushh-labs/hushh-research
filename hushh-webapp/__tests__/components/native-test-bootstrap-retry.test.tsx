import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  state: {
    loading: false,
    sessionVerificationRequired: false,
    user: { uid: "reviewer-owner" } as { uid: string } | null,
    userId: "acct_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as string | null,
    accountPrincipal: {
      firebaseUid: "reviewer-owner",
      ownerId: "acct_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      accountGeneration: 1,
    } as { firebaseUid: string; ownerId: string; accountGeneration: number } | null,
    setNativeUser: vi.fn(),
  },
}));

const services = vi.hoisted(() => ({
  bootstrapState: vi.fn(),
  getVaultState: vi.fn(),
  unlockWithMethod: vi.fn(async () => "decrypted-vault-key"),
  getOrIssueVaultOwnerToken: vi.fn(async () => ({
    token: "vault-owner-token",
    expiresAt: Date.now() + 60_000,
  })),
  unlockVault: vi.fn(),
  restoreNativeSession: vi.fn(),
}));
const vault = vi.hoisted(() => ({ unlocked: false, unlock: services.unlockVault }));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth.state }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ isVaultUnlocked: vault.unlocked, unlockVault: vault.unlock }),
}));
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: {
    getCurrentUser: () => auth.state.user,
    restoreNativeSession: services.restoreNativeSession,
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
import { publishPendingAuthSessionIdentity, publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";

function bridgeState() {
  return window.__HUSHH_NATIVE_TEST__?.bootstrapState;
}

describe("NativeTestBootstrap transient vault reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.state.loading = false;
    auth.state.user = { uid: "reviewer-owner" };
    auth.state.sessionVerificationRequired = false;
    auth.state.userId = "acct_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    auth.state.accountPrincipal = { firebaseUid: "reviewer-owner", ownerId: auth.state.userId, accountGeneration: 1 };
    publishValidatedAuthSessionPrincipal(auth.state.accountPrincipal);
    vault.unlocked = false;
    vault.unlock = services.unlockVault;
    services.unlockVault.mockReturnValue(true);
    services.bootstrapState.mockReset().mockResolvedValue({ hasVault: true });
    services.getVaultState.mockReset().mockResolvedValue({ wrappers: [] });
    services.restoreNativeSession.mockReset().mockResolvedValue(null);
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
    const view = render(<NativeTestBootstrap />);

    await waitFor(() => expect(services.unlockVault).toHaveBeenCalledOnce());
    vault.unlocked = true;
    view.rerender(<NativeTestBootstrap />);

    await waitFor(() => {
      const bridge = (window as Window & {
        __HUSHH_NATIVE_TEST__?: Record<string, unknown>;
      }).__HUSHH_NATIVE_TEST__;
      expect(bridge?.bootstrapState).toBe("vault_unlocked");
    });

    expect(services.bootstrapState).toHaveBeenCalledTimes(2);
    expect(services.getVaultState).toHaveBeenCalledTimes(2);
    expect(services.getVaultState).toHaveBeenCalledWith(auth.state.userId);
    expect(services.unlockVault).toHaveBeenCalledWith(
      "decrypted-vault-key",
      "vault-owner-token",
      expect.any(Number),
    );
  });

  it("waits for admitted application ownership before reading the vault", async () => {
    auth.state.sessionVerificationRequired = true;
    publishValidatedAuthSessionPrincipal(null);
    const view = render(<NativeTestBootstrap />);
    expect(services.bootstrapState).not.toHaveBeenCalled();
    expect(bridgeState()).not.toBe("vault_unlocked");

    auth.state.sessionVerificationRequired = false;
    publishValidatedAuthSessionPrincipal(auth.state.accountPrincipal);
    view.rerender(<NativeTestBootstrap />);
    await waitFor(() => expect(services.unlockVault).toHaveBeenCalledOnce());
    expect(services.bootstrapState).toHaveBeenCalledWith(auth.state.userId);
    expect(services.getOrIssueVaultOwnerToken).toHaveBeenCalledWith(auth.state.userId);
  });

  it("retires a held read after callback replacement and waits for the rendered unlock", async () => {
    let release!: (state: { wrappers: never[] }) => void;
    services.getVaultState.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    services.unlockVault.mockReturnValue(false);
    const view = render(<NativeTestBootstrap />);
    await waitFor(() => expect(services.getVaultState).toHaveBeenCalledOnce());

    auth.state.loading = true;
    auth.state.sessionVerificationRequired = true;
    publishPendingAuthSessionIdentity("reviewer-owner", true);
    view.rerender(<NativeTestBootstrap />);
    const currentUnlock = vi.fn(() => true);
    auth.state.loading = false;
    auth.state.sessionVerificationRequired = false;
    publishValidatedAuthSessionPrincipal(auth.state.accountPrincipal);
    vault.unlock = currentUnlock;
    view.rerender(<NativeTestBootstrap />);
    release({ wrappers: [] });
    await waitFor(() => expect(currentUnlock).toHaveBeenCalledOnce());
    expect(services.unlockVault).not.toHaveBeenCalled();
    expect(bridgeState()).not.toBe("vault_unlocked");

    vault.unlocked = true;
    view.rerender(<NativeTestBootstrap />);
    await waitFor(() => expect(bridgeState()).toBe("vault_unlocked"));
  });

  it("never reports an unlock rejected by the current vault owner guard", async () => {
    services.unlockVault.mockReturnValue(false);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(<NativeTestBootstrap />);
      await waitFor(() => expect(bridgeState()).toBe("vault_error"));
      expect(services.unlockVault).toHaveBeenCalledTimes(2);
      expect(window.__HUSHH_NATIVE_TEST__?.replayVaultUnlock).toBeUndefined();
      expect(logged).toHaveBeenCalledWith("[NativeTestBootstrap] Vault bootstrap failed: vault");
    } finally {
      logged.mockRestore();
    }
  });

  it("does not republish a held native restoration after its auth episode retires", async () => {
    auth.state.user = null;
    auth.state.loading = true;
    publishPendingAuthSessionIdentity("reviewer-owner", true);
    let release!: (user: { uid: string }) => void;
    services.restoreNativeSession.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const view = render(<NativeTestBootstrap />);
    await waitFor(() => expect(services.restoreNativeSession).toHaveBeenCalledOnce());

    auth.state.user = { uid: "reviewer-owner" };
    auth.state.loading = false;
    publishValidatedAuthSessionPrincipal(auth.state.accountPrincipal);
    view.rerender(<NativeTestBootstrap />);
    await act(async () => { release({ uid: "reviewer-owner" }); });
    expect(auth.state.setNativeUser).not.toHaveBeenCalled();
  });
});
