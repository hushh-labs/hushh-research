import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ bootstrap: vi.fn() }));
vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    bootstrapState: mocks.bootstrap,
    hasExplicitIncompleteSetup: (state: { setupCompleted?: boolean }) =>
      state.setupCompleted === false,
  },
}));
import {
  devicePrerequisiteCallback,
  useDeviceAuthorizationReadiness,
} from "@/lib/trusted-device/authorization-readiness";
const ready = {
  userId: "owner",
  hasVault: true,
  setupCompleted: true,
  phoneVerified: true,
};
beforeEach(() => {
  mocks.bootstrap.mockReset();
});
describe("device approval prerequisites", () => {
  it("blocks enrollment when the session needs verification", () => {
    const hook = renderHook(() =>
      useDeviceAuthorizationReadiness("owner", false, true),
    );
    expect(hook.result.current).toBe("unavailable");
    expect(mocks.bootstrap).not.toHaveBeenCalled();
  });
  it("waits for authentication before returning a login prerequisite", () => {
    const hook = renderHook(
      ({ loading }) => useDeviceAuthorizationReadiness(null, loading),
      { initialProps: { loading: true } },
    );
    expect(hook.result.current).toBe("checking");
    hook.rerender({ loading: false });
    expect(hook.result.current).toBe("login_required");
    expect(mocks.bootstrap).not.toHaveBeenCalled();
  });
  it.each([
    [ready, "ready"],
    [{ ...ready, hasVault: false }, "account_setup_required"],
    [{ ...ready, setupCompleted: false }, "account_setup_required"],
    [{ ...ready, phoneVerified: false }, "account_setup_required"],
    [{ ...ready, userId: "different-owner" }, "unavailable"],
    [{ ...ready, hasVault: null }, "unavailable"],
    [{ ...ready, phoneVerified: null }, "unavailable"],
    [{ ...ready, setupCompleted: null }, "ready"],
  ])(
    "checks authoritative setup before approval: %j",
    async (state, expected) => {
      mocks.bootstrap.mockResolvedValue(state);
      const hook = renderHook(() =>
        useDeviceAuthorizationReadiness("owner", false),
      );
      await waitFor(() => expect(hook.result.current).toBe(expected));
    },
  );
  it("does not classify a failed readiness read as missing setup", async () => {
    mocks.bootstrap.mockRejectedValue(new Error("unavailable"));
    const hook = renderHook(() =>
      useDeviceAuthorizationReadiness("owner", false),
    );
    await waitFor(() => expect(hook.result.current).toBe("unavailable"));
  });
  it("discards readiness from an owner who signed out", async () => {
    let resolve!: (value: typeof ready) => void;
    mocks.bootstrap.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const hook = renderHook(
      ({ owner }: { owner: string | null }) =>
        useDeviceAuthorizationReadiness(owner, false),
      { initialProps: { owner: "owner" as string | null } },
    );
    hook.rerender({ owner: null });
    await act(async () => resolve(ready));
    expect(hook.result.current).toBe("login_required");
  });
  it("returns only a state-bound error to the local callback", () => {
    const url = new URL(
      devicePrerequisiteCallback(
        "http://127.0.0.1:55573/callback",
        "opaque_state_123456",
        "login_required",
      )!,
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      state: "opaque_state_123456",
      error: "login_required",
    });
  });
  it.each([
    "https://example.com/callback",
    "http://127.0.0.1/callback",
    "http://127.0.0.1:55573/admin",
    "http://user@localhost:55573/callback",
    "http://localhost:55573/callback?code=x",
    "http://localhost:55573/callback#x",
  ])("rejects unsafe callbacks: %s", (uri) => {
    expect(
      devicePrerequisiteCallback(uri, "opaque_state_123456", "login_required"),
    ).toBeNull();
  });
});
