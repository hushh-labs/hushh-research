import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockSubscribeToOneLocationStateChanges,
  mockUseAuth,
  mockUseStaleResource,
  mockUseVault,
} = vi.hoisted(() => ({
  mockSubscribeToOneLocationStateChanges: vi.fn(),
  mockUseAuth: vi.fn(),
  mockUseStaleResource: vi.fn(),
  mockUseVault: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: mockUseAuth }));
vi.mock("@/lib/cache/use-stale-resource", () => ({
  useStaleResource: mockUseStaleResource,
}));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: mockUseVault }));
vi.mock("@/lib/one-location/one-location-state-events", () => ({
  subscribeToOneLocationStateChanges: mockSubscribeToOneLocationStateChanges,
}));

import { useUnseenLocationShareCount } from "@/lib/one-location/use-unseen-location-share-count";

const NOW = Date.parse("2026-09-01T08:00:00.000Z");

describe("useUnseenLocationShareCount request deadlines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockUseAuth.mockReturnValue({ user: { uid: "owner" } });
    mockUseVault.mockReturnValue({
      isVaultUnlocked: true,
      getVaultOwnerToken: () => "vault-token",
    });
    mockSubscribeToOneLocationStateChanges.mockReturnValue(vi.fn());
    mockUseStaleResource.mockImplementation(
      ({ refreshKey }: { refreshKey: string }) => {
        const tick = Number(refreshKey.split(":").at(-1));
        return {
          data:
            tick === 0
              ? {
                  receivedGrantIds: [],
                  pendingIncomingRequests: 1,
                  nextPendingRequestExpiryAtMs: NOW + 1_000,
                }
              : {
                  receivedGrantIds: [],
                  pendingIncomingRequests: 0,
                  nextPendingRequestExpiryAtMs: null,
                },
        };
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-evaluates the badge as soon as the nearest request expires", () => {
    const { result } = renderHook(() => useUnseenLocationShareCount());
    expect(result.current).toBe(1);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current).toBe(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(0);
    expect(mockUseStaleResource.mock.calls.at(-1)?.[0]?.refreshKey).toBe(
      "owner:unlocked:1",
    );
  });

  it("refreshes on focus and matching cross-tab Location mutations", () => {
    const { unmount } = renderHook(() => useUnseenLocationShareCount());
    const listener = mockSubscribeToOneLocationStateChanges.mock.calls[0]?.[0];

    act(() => window.dispatchEvent(new Event("focus")));
    expect(mockUseStaleResource.mock.calls.at(-1)?.[0]?.refreshKey).toBe(
      "owner:unlocked:1",
    );

    act(() =>
      listener?.({
        userId: "other",
        domains: ["workspace"],
        changedAt: NOW,
      }),
    );
    expect(mockUseStaleResource.mock.calls.at(-1)?.[0]?.refreshKey).toBe(
      "owner:unlocked:1",
    );

    act(() =>
      listener?.({
        userId: "owner",
        domains: ["workspace"],
        changedAt: NOW + 1,
      }),
    );
    expect(mockUseStaleResource.mock.calls.at(-1)?.[0]?.refreshKey).toBe(
      "owner:unlocked:2",
    );

    unmount();
    expect(
      mockSubscribeToOneLocationStateChanges.mock.results[0]?.value,
    ).toHaveBeenCalledOnce();
  });
});
