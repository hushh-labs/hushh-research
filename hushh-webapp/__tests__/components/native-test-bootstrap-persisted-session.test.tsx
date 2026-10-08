/**
 * The native test bootstrap must audit as the identity the run names, never
 * as whichever session the device kept from before. A phone signed in as its
 * owner used to be accepted as "authenticated", the vault stage then
 * reported a uid mismatch, and the card ran as the owner.
 */
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  native: true,
  state: {
    loading: false,
    user: { uid: "owner-on-device" } as { uid: string } | null,
    setNativeUser: vi.fn(),
  },
}));
const reviewerConfig = vi.hoisted(() => ({ mode: undefined as "human_authenticated" | "operator_issued_token" | undefined, vaultPassphrase: null as string | null, expectedUserId: "reviewer-minted" as string | null }));
const vault = vi.hoisted(() => ({ isVaultUnlocked: false, unlockVault: vi.fn() }));
const services = vi.hoisted(() => ({
  signInOperatorReviewer: vi.fn(async () => ({ user: { uid: "reviewer-minted" } })),
  signOut: vi.fn(async () => {
    auth.state.user = null;
  }),
  signInWithCustomToken: vi.fn(async () => ({ user: { uid: "reviewer-minted" } })),
  getCurrentUser: vi.fn(() => null),
  restoreNativeSession: vi.fn(async () => null),
  createAppReviewModeSession: vi.fn(async () => ({ token: "custom-token" })),
}));

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => auth.native } }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth.state }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => vault }));
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: {
    signOut: services.signOut,
    signInWithCustomToken: services.signInWithCustomToken,
    getCurrentUser: services.getCurrentUser,
    restoreNativeSession: services.restoreNativeSession,
  },
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { createAppReviewModeSession: services.createAppReviewModeSession },
}));
vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: { bootstrapState: vi.fn(async () => ({ hasVault: true })) },
}));
vi.mock("@/lib/services/vault-service", () => ({ VaultService: {} }));
vi.mock("@/lib/testing/reviewer-operator-auth", () => ({ signInOperatorReviewer: services.signInOperatorReviewer }));
vi.mock("@/lib/testing/local-reviewer-auth", () => ({ resolveLocalReviewerCredentials: () => null }));
vi.mock("@/lib/testing/native-test", () => ({
  useNativeTestConfig: () => ({
    enabled: true,
    autoReviewerLogin: true,
    reviewerAuthMode: reviewerConfig.mode,
    // The locked-vault rehearsal withholds vaultPassphrase (no auto-unlock)
    // but must still prove the reviewer credential to the backend mint.
    vaultPassphrase: reviewerConfig.vaultPassphrase,
    reviewerSessionPassphrase: "mint-only-credential",
    expectedUserId: reviewerConfig.expectedUserId,
    expectedMarker: null,
    initialRoute: null,
    expectedRoute: null,
  }),
}));

import { NativeTestBootstrap } from "@/components/app-ui/native-test-bootstrap";

type Bridge = { enabled: boolean; bootstrapState?: string; bootstrapUserId?: string; bootstrapErrorClass?: string };

describe("NativeTestBootstrap with a session persisted on the device", () => {
  beforeEach(() => {
    auth.native = true;
    (window as Window & { __HUSHH_NATIVE_TEST__?: Bridge }).__HUSHH_NATIVE_TEST__ = { enabled: true };
    auth.state.loading = false;
    auth.state.user = { uid: "owner-on-device" };
    reviewerConfig.mode = undefined;
    reviewerConfig.expectedUserId = "reviewer-minted";
    reviewerConfig.vaultPassphrase = null;
    vault.isVaultUnlocked = false;
    vault.unlockVault.mockClear();
    services.signInOperatorReviewer.mockClear();
    services.signOut.mockClear();
    auth.state.setNativeUser.mockClear();
    services.createAppReviewModeSession.mockClear();
    services.signInWithCustomToken.mockClear();
  });

  afterEach(() => {
    delete (window as Window & { __HUSHH_NATIVE_TEST__?: Bridge }).__HUSHH_NATIVE_TEST__;
  });

  it("replaces a persisted user that is not the audited identity and mints the reviewer", async () => {
    const { rerender } = render(<NativeTestBootstrap />);

    await waitFor(() => expect(services.signOut).toHaveBeenCalledTimes(1));
    // The context ignores Firebase state changes on native, so the bootstrap
    // withdraws the persisted user itself; then the reviewer sign-in begins.
    await waitFor(() => expect(auth.state.setNativeUser).toHaveBeenCalledWith(null));
    await act(async () => {
      rerender(<NativeTestBootstrap />);
    });
    await waitFor(() => expect(services.createAppReviewModeSession).toHaveBeenCalledTimes(1));
    expect(services.createAppReviewModeSession).toHaveBeenCalledWith(
      "reviewer",
      expect.objectContaining({
        reviewerUid: "reviewer-minted",
        smokePassphrase: "mint-only-credential",
      }),
    );
    await waitFor(() => {
      const bridge = (window as Window & { __HUSHH_NATIVE_TEST__?: Bridge }).__HUSHH_NATIVE_TEST__;
      expect(bridge?.bootstrapState).toBe("authenticated");
      expect(bridge?.bootstrapUserId).toBe("reviewer-minted");
    });
  });

  it("keeps a persisted user that already is the audited identity", async () => {
    auth.state.user = { uid: "reviewer-minted" };
    render(<NativeTestBootstrap />);
    await waitFor(() => {
      const bridge = (window as Window & { __HUSHH_NATIVE_TEST__?: Bridge }).__HUSHH_NATIVE_TEST__;
      expect(bridge?.bootstrapState).toBe("authenticated");
    });
    expect(services.signOut).not.toHaveBeenCalled();
    expect(services.createAppReviewModeSession).not.toHaveBeenCalled();
  });

  it.each([
    [null, "waiting_auth"],
    [{ uid: "reviewer-minted" }, "authenticated"],
    [{ uid: "other-owner" }, "uid_mismatch"],
  ] as const)("observes human identity %s without mint, replacement or automatic unlock", async (user, stage) => {
    reviewerConfig.mode = "human_authenticated";
    reviewerConfig.vaultPassphrase = "synthetic-forbidden-automatic-credential";
    auth.state.user = user;
    render(<NativeTestBootstrap />);
    await waitFor(() => expect(window.__HUSHH_NATIVE_TEST__?.bootstrapState).toBe(stage));
    expect(services.signOut).not.toHaveBeenCalled();
    expect(services.createAppReviewModeSession).not.toHaveBeenCalled();
    expect(services.signInWithCustomToken).not.toHaveBeenCalled();
    expect(vault.unlockVault).not.toHaveBeenCalled();
  });

  it("observes ordinary human vault unlock and fails closed when that identity is lost", async () => {
    reviewerConfig.mode = "human_authenticated";
    auth.state.user = { uid: "reviewer-minted" };
    vault.isVaultUnlocked = true;
    const { rerender } = render(<NativeTestBootstrap />);
    await waitFor(() => expect(window.__HUSHH_NATIVE_TEST__?.bootstrapState).toBe("vault_unlocked"));
    auth.state.user = null;
    await act(async () => rerender(<NativeTestBootstrap />));
    await waitFor(() => expect(window.__HUSHH_NATIVE_TEST__?.bootstrapState).toBe("auth_error"));
    expect(window.__HUSHH_NATIVE_TEST__?.bootstrapUserId).toBe("");
    expect(services.createAppReviewModeSession).not.toHaveBeenCalled();
    expect(vault.unlockVault).not.toHaveBeenCalled();
  });


  it("invalidates human vault admission while authentication is being reverified", async () => {
    reviewerConfig.mode = "human_authenticated";
    auth.state.user = { uid: "reviewer-minted" };
    vault.isVaultUnlocked = true;
    const { rerender } = render(<NativeTestBootstrap />);
    await waitFor(() => expect(window.__HUSHH_NATIVE_TEST__?.bootstrapState).toBe("vault_unlocked"));
    auth.state.loading = true;
    await act(async () => rerender(<NativeTestBootstrap />));
    await waitFor(() => expect(window.__HUSHH_NATIVE_TEST__?.bootstrapState).toBe("waiting_auth"));
    expect(window.__HUSHH_NATIVE_TEST__?.bootstrapUserId).toBe("");
    expect(vault.unlockVault).not.toHaveBeenCalled();
  });

  it("withdraws human vault admission when the same owner relocks", async () => {
    reviewerConfig.mode = "human_authenticated";
    auth.state.user = { uid: "reviewer-minted" };
    vault.isVaultUnlocked = true;
    const { rerender } = render(<NativeTestBootstrap />);
    await waitFor(() => expect(window.__HUSHH_NATIVE_TEST__?.bootstrapState).toBe("vault_unlocked"));
    vault.isVaultUnlocked = false;
    await act(async () => rerender(<NativeTestBootstrap />));
    await waitFor(() => expect(window.__HUSHH_NATIVE_TEST__?.bootstrapState).toBe("authenticated"));
    expect(window.__HUSHH_NATIVE_TEST__?.bootstrapUserId).toBe("reviewer-minted");
    expect(services.createAppReviewModeSession).not.toHaveBeenCalled();
    expect(services.signOut).not.toHaveBeenCalled();
    expect(vault.unlockVault).not.toHaveBeenCalled();
  });

  it("cannot admit an unlocked human vault without an expected owner", async () => {
    reviewerConfig.mode = "human_authenticated";
    reviewerConfig.expectedUserId = null;
    auth.state.user = { uid: "reviewer-minted" };
    vault.isVaultUnlocked = true;
    render(<NativeTestBootstrap />);
    await waitFor(() => expect(window.__HUSHH_NATIVE_TEST__?.bootstrapState).toBe("uid_mismatch"));
    expect(window.__HUSHH_NATIVE_TEST__?.bootstrapUserId).toBe("");
    expect(vault.unlockVault).not.toHaveBeenCalled();
  });

  it.each([
    [null, "auth_error", false],
    [{ uid: "other-owner" }, "uid_mismatch", false],
    [null, "auth_error", true],
  ] as const)("retires a verified operator session on canonical identity loss %s (reverification %s)", async (nextUser, stage, reverify) => {
    auth.native = false;
    reviewerConfig.mode = "operator_issued_token";
    auth.state.user = null;
    const { rerender } = render(<NativeTestBootstrap />);
    await waitFor(() => expect(services.signInOperatorReviewer).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(auth.state.setNativeUser).toHaveBeenCalledWith({ uid: "reviewer-minted" }));
    auth.state.user = { uid: "reviewer-minted" };
    vault.isVaultUnlocked = true;
    await act(async () => rerender(<NativeTestBootstrap />));
    await waitFor(() => expect(window.__HUSHH_NATIVE_TEST__?.bootstrapState).toBe("vault_unlocked"));
    if (reverify) {
      auth.state.loading = true;
      await act(async () => rerender(<NativeTestBootstrap />));
      expect(window.__HUSHH_NATIVE_TEST__?.bootstrapState).toBe("waiting_auth");
      expect(window.__HUSHH_NATIVE_TEST__?.bootstrapUserId).toBe("");
      auth.state.loading = false;
    }
    auth.state.user = nextUser;
    await act(async () => rerender(<NativeTestBootstrap />));
    expect(window.__HUSHH_NATIVE_TEST__?.bootstrapState).toBe(stage);
    expect(window.__HUSHH_NATIVE_TEST__?.bootstrapUserId).toBe("");
    auth.state.user = { uid: "reviewer-minted" };
    await act(async () => rerender(<NativeTestBootstrap />));
    expect(window.__HUSHH_NATIVE_TEST__?.bootstrapState).toBe("auth_error");
    expect(services.signInOperatorReviewer).toHaveBeenCalledTimes(1);
    expect(services.createAppReviewModeSession).not.toHaveBeenCalled();
    expect(services.signOut).not.toHaveBeenCalled();
    expect(vault.unlockVault).not.toHaveBeenCalled();
  });

});
