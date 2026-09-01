import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseAuth, mockUseStaleResource, mockUseVault } = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockUseStaleResource: vi.fn(),
  mockUseVault: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: mockUseAuth }));
vi.mock("@/lib/cache/use-stale-resource", () => ({
  useStaleResource: mockUseStaleResource,
}));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: mockUseVault }));

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
});
