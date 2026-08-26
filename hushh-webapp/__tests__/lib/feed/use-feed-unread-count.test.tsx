import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: null as { uid: string; getIdToken: () => Promise<string> } | null,
  unreadCount: vi.fn(),
  liveRefresh: null as (() => void) | null,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: mocks.user }),
}));

vi.mock("@/lib/services/feed-service", () => ({
  FeedService: { unreadCount: mocks.unreadCount },
}));

vi.mock("@/lib/feed/use-feed-live-refresh", () => ({
  useFeedLiveRefresh: (refresh: () => void) => {
    mocks.liveRefresh = refresh;
  },
}));

import { useFeedUnreadCount } from "@/lib/feed/use-feed-unread-count";

describe("useFeedUnreadCount account isolation", () => {
  beforeEach(() => {
    mocks.user = null;
    mocks.unreadCount.mockReset();
    mocks.liveRefresh = null;
  });

  it("never shows a late count from the previous signed-in account", async () => {
    let resolveA!: (value: number) => void;
    let resolveB!: (value: number) => void;
    mocks.unreadCount.mockImplementation(
      ({ userId }: { userId: string }) =>
        new Promise<number>((resolve) => {
          if (userId === "user-a") resolveA = resolve;
          else resolveB = resolve;
        }),
    );
    mocks.user = {
      uid: "user-a",
      getIdToken: async () => "token-a",
    };
    const { result, rerender } = renderHook(() => useFeedUnreadCount());

    await waitFor(() =>
      expect(mocks.unreadCount).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user-a" }),
      ),
    );

    mocks.user = {
      uid: "user-b",
      getIdToken: async () => "token-b",
    };
    rerender();
    expect(result.current).toBeNull();
    await waitFor(() =>
      expect(mocks.unreadCount).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user-b" }),
      ),
    );

    await act(async () => resolveB(2));
    await waitFor(() => expect(result.current).toBe(2));

    await act(async () => resolveA(9));
    expect(result.current).toBe(2);
  });

  it("rejects an obsolete response across an A-to-B-to-A session cycle", async () => {
    const pendingA: Array<(value: number) => void> = [];
    let resolveB!: (value: number) => void;
    mocks.unreadCount.mockImplementation(
      ({ userId }: { userId: string }) =>
        new Promise<number>((resolve) => {
          if (userId === "user-a") pendingA.push(resolve);
          else resolveB = resolve;
        }),
    );

    mocks.user = { uid: "user-a", getIdToken: async () => "token-a-1" };
    const { result, rerender } = renderHook(() => useFeedUnreadCount());
    await waitFor(() => expect(pendingA).toHaveLength(1));

    mocks.user = { uid: "user-b", getIdToken: async () => "token-b" };
    rerender();
    await waitFor(() => expect(resolveB).toBeTypeOf("function"));

    mocks.user = { uid: "user-a", getIdToken: async () => "token-a-2" };
    rerender();
    await waitFor(() => expect(pendingA).toHaveLength(2));

    await act(async () => pendingA[0](9));
    expect(result.current).toBeNull();

    await act(async () => pendingA[1](3));
    await waitFor(() => expect(result.current).toBe(3));
  });

  it("coalesces simultaneous visibility and focus refresh signals", async () => {
    const pending: Array<(value: number) => void> = [];
    mocks.unreadCount.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          pending.push(resolve);
        }),
    );
    mocks.user = { uid: "user-a", getIdToken: async () => "token-a" };
    const { result } = renderHook(() => useFeedUnreadCount());

    await waitFor(() => expect(mocks.unreadCount).toHaveBeenCalledTimes(1));
    act(() => {
      mocks.liveRefresh?.();
      mocks.liveRefresh?.();
    });
    expect(mocks.unreadCount).toHaveBeenCalledTimes(1);

    await act(async () => pending[0](1));
    await waitFor(() => expect(result.current).toBe(1));

    act(() => {
      mocks.liveRefresh?.();
      mocks.liveRefresh?.();
    });
    await waitFor(() => expect(mocks.unreadCount).toHaveBeenCalledTimes(2));
    expect(mocks.unreadCount).toHaveBeenCalledTimes(2);
    await act(async () => pending[1](2));
    await waitFor(() => expect(result.current).toBe(2));
  });
});
