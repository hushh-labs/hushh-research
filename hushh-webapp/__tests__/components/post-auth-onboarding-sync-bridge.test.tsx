// @vitest-environment jsdom
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  authState,
  finalizeForVaultMock,
  pathnameState,
  postUnlockRunMock,
  vaultState,
} = vi.hoisted(() => ({
  authState: {
    current: {
      user: { uid: "user-a" } as { uid: string } | null,
      loading: false,
    },
  },
  finalizeForVaultMock: vi.fn(),
  pathnameState: { current: "/one" },
  postUnlockRunMock: vi.fn(),
  vaultState: {
    current: {
      isVaultUnlocked: true,
      vaultKey: "vault-key-a" as string | null,
      vaultOwnerToken: "vault-token-a" as string | null,
    },
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameState.current,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ ...authState.current, userId: authState.current.user?.uid ?? null }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => vaultState.current,
}));

vi.mock("@/lib/services/pre-vault-sensitive-draft-service", () => ({
  PreVaultSensitiveDraftService: {
    finalizeForVault: (...args: unknown[]) => finalizeForVaultMock(...args),
  },
}));

vi.mock("@/lib/services/post-unlock-sync-service", () => ({
  PostUnlockSyncService: {
    run: (...args: unknown[]) => postUnlockRunMock(...args),
  },
}));

import { PostAuthOnboardingSyncBridge } from "@/components/onboarding/PostAuthOnboardingSyncBridge";

describe("PostAuthOnboardingSyncBridge", () => {
  afterEach(() => { delete window.__HUSHH_NATIVE_TEST__; vi.useRealTimers(); });
  beforeEach(() => {
    vi.clearAllMocks();
    authState.current = { user: { uid: "user-a" }, loading: false };
    vaultState.current = {
      isVaultUnlocked: true,
      vaultKey: "vault-key-a",
      vaultOwnerToken: "vault-token-a",
    };
    pathnameState.current = "/one";
    finalizeForVaultMock.mockResolvedValue(undefined);
    postUnlockRunMock.mockResolvedValue(undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("stays inert until complete auth and vault authority exist", async () => {
    authState.current = { user: { uid: "user-a" }, loading: true };
    const view = render(<PostAuthOnboardingSyncBridge />);

    await Promise.resolve();
    expect(finalizeForVaultMock).not.toHaveBeenCalled();

    authState.current = { user: { uid: "user-a" }, loading: false };
    vaultState.current = {
      isVaultUnlocked: false,
      vaultKey: null,
      vaultOwnerToken: null,
    };
    view.rerender(<PostAuthOnboardingSyncBridge />);
    await Promise.resolve();

    expect(finalizeForVaultMock).not.toHaveBeenCalled();
    expect(postUnlockRunMock).not.toHaveBeenCalled();
  });

  it.each(["read_only", "preparation_only", "bounded_mutation"] as const)("does not finalize or sync background drafts during %s review", async reviewerMutationPolicy => {
    vi.useFakeTimers();
    window.__HUSHH_NATIVE_TEST__ = { enabled: true, autoReviewerLogin: true, reviewerMutationPolicy };
    const view = render(<PostAuthOnboardingSyncBridge />);
    pathnameState.current = "/one/pkm";
    view.rerender(<PostAuthOnboardingSyncBridge />);
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(finalizeForVaultMock).not.toHaveBeenCalled();
    expect(postUnlockRunMock).not.toHaveBeenCalled();
  });

  it("cancels a queued retry when reviewer policy becomes restricted", async () => {
    vi.useFakeTimers();
    finalizeForVaultMock.mockRejectedValueOnce(new Error("PKM_WRITE_FAILED"));
    render(<PostAuthOnboardingSyncBridge />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(finalizeForVaultMock).toHaveBeenCalledOnce();
    window.__HUSHH_NATIVE_TEST__ = { enabled: true, autoReviewerLogin: true, reviewerMutationPolicy: "read_only" };
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(finalizeForVaultMock).toHaveBeenCalledOnce();
    expect(postUnlockRunMock).not.toHaveBeenCalled();
  });

  it("withdraws the finalizer's effect fence and skips sync after restriction during an await", async () => {
    let finish!: () => void;
    finalizeForVaultMock.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    render(<PostAuthOnboardingSyncBridge />);
    await waitFor(() => expect(finish).toBeDefined());
    const { beforeEffect } = finalizeForVaultMock.mock.calls[0]![0];
    await expect(beforeEffect()).resolves.toBeUndefined();
    window.__HUSHH_NATIVE_TEST__ = { enabled: true, autoReviewerLogin: true, reviewerMutationPolicy: "read_only" };
    await expect(beforeEffect()).rejects.toThrow("Background onboarding sync cancelled");
    await act(async () => finish());
    expect(postUnlockRunMock).not.toHaveBeenCalled();
  });

  it("waits until setup navigation finishes, then finalizes before ordinary sync", async () => {
    const order: string[] = [];
    pathnameState.current = "/one/setup/location";
    finalizeForVaultMock.mockImplementation(async () => {
      order.push("finalize");
    });
    postUnlockRunMock.mockImplementation(async () => {
      order.push("post-unlock");
    });
    const view = render(<PostAuthOnboardingSyncBridge />);

    await Promise.resolve();
    expect(finalizeForVaultMock).not.toHaveBeenCalled();

    pathnameState.current = "/one";
    view.rerender(<PostAuthOnboardingSyncBridge />);

    await waitFor(() => expect(postUnlockRunMock).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["finalize", "post-unlock"]);

    view.rerender(<PostAuthOnboardingSyncBridge />);
    await Promise.resolve();
    expect(finalizeForVaultMock).toHaveBeenCalledTimes(1);
  });

  it("queues a new account session instead of dropping it behind an active flush", async () => {
    let releaseUserA: (() => void) | undefined;
    finalizeForVaultMock.mockImplementation((params: { userId: string }) =>
      params.userId === "user-a"
        ? new Promise<void>((resolve) => {
            releaseUserA = resolve;
          })
        : Promise.resolve(),
    );
    const view = render(<PostAuthOnboardingSyncBridge />);
    await waitFor(() => expect(finalizeForVaultMock).toHaveBeenCalledTimes(1));

    authState.current = { user: { uid: "user-b" }, loading: false };
    vaultState.current = {
      isVaultUnlocked: true,
      vaultKey: "vault-key-b",
      vaultOwnerToken: "vault-token-b",
    };
    view.rerender(<PostAuthOnboardingSyncBridge />);
    expect(finalizeForVaultMock).toHaveBeenCalledTimes(1);

    releaseUserA?.();

    await waitFor(() => expect(finalizeForVaultMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(postUnlockRunMock).toHaveBeenCalledTimes(1));
    expect(
      finalizeForVaultMock.mock.calls.map(([params]) => params.userId),
    ).toEqual(["user-a", "user-b"]);
    expect(
      postUnlockRunMock.mock.calls.map(([params]) => params.userId),
    ).toEqual(["user-b"]);
  });

  it("does not run ordinary sync after finalization fails and retries new authority", async () => {
    finalizeForVaultMock.mockRejectedValueOnce(new Error("PKM_WRITE_FAILED"));
    const view = render(<PostAuthOnboardingSyncBridge />);

    await waitFor(() => expect(finalizeForVaultMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(postUnlockRunMock).not.toHaveBeenCalled();

    vaultState.current = {
      isVaultUnlocked: true,
      vaultKey: "vault-key-a-rotated",
      vaultOwnerToken: "vault-token-a-rotated",
    };
    view.rerender(<PostAuthOnboardingSyncBridge />);

    await waitFor(() => expect(postUnlockRunMock).toHaveBeenCalledTimes(1));
    expect(finalizeForVaultMock).toHaveBeenCalledTimes(2);
  });

  it("retries a transient finalization failure in the same vault session", async () => {
    finalizeForVaultMock.mockRejectedValueOnce(new Error("PKM_WRITE_FAILED"));
    render(<PostAuthOnboardingSyncBridge />);

    await waitFor(() => expect(finalizeForVaultMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(postUnlockRunMock).toHaveBeenCalledTimes(1));

    expect(finalizeForVaultMock.mock.calls[0]?.[0]).toEqual(
      finalizeForVaultMock.mock.calls[1]?.[0],
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("retrying"),
      expect.any(Error),
    );
  });
});
