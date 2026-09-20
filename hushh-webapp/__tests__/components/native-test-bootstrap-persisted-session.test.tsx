/**
 * The native test bootstrap must audit as the identity the run names, never
 * as whichever session the device kept from before. A phone signed in as its
 * owner used to be accepted as "authenticated", the vault stage then
 * reported a uid mismatch, and the card ran as the owner.
 */
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  state: {
    loading: false,
    user: { uid: "owner-on-device" } as { uid: string } | null,
    setNativeUser: vi.fn(),
  },
}));
const vault = vi.hoisted(() => ({ isVaultUnlocked: false, unlockVault: vi.fn() }));
const services = vi.hoisted(() => ({
  signOut: vi.fn(async () => {
    auth.state.user = null;
  }),
  signInWithCustomToken: vi.fn(async () => ({ user: { uid: "reviewer-minted" } })),
  getCurrentUser: vi.fn(() => null),
  restoreNativeSession: vi.fn(async () => null),
  createAppReviewModeSession: vi.fn(async () => ({ token: "custom-token" })),
}));

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));
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
vi.mock("@/lib/testing/local-reviewer-auth", () => ({ resolveLocalReviewerCredentials: () => null }));
vi.mock("@/lib/testing/native-test", () => ({
  useNativeTestConfig: () => ({
    enabled: true,
    autoReviewerLogin: true,
    vaultPassphrase: null,
    expectedUserId: "reviewer-minted",
    expectedMarker: null,
    initialRoute: null,
    expectedRoute: null,
  }),
}));

import { NativeTestBootstrap } from "@/components/app-ui/native-test-bootstrap";

type Bridge = { enabled: boolean; bootstrapState?: string; bootstrapUserId?: string; bootstrapErrorClass?: string };

describe("NativeTestBootstrap with a session persisted on the device", () => {
  beforeEach(() => {
    (window as Window & { __HUSHH_NATIVE_TEST__?: Bridge }).__HUSHH_NATIVE_TEST__ = { enabled: true };
    auth.state.user = { uid: "owner-on-device" };
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
      expect.objectContaining({ reviewerUid: "reviewer-minted" }),
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
});
