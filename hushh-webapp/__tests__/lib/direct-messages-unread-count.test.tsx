import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  unreadCount: vi.fn(),
  registerPeriodicTask: vi.fn(),
  unregister: vi.fn(),
  subscribeLifecycle: vi.fn(),
  unsubscribeLifecycle: vi.fn(),
  lifecycleState: "active" as "active" | "background",
}));
vi.mock("@/lib/services/direct-messages-service", () => ({ DirectMessagesService: { unreadCount: mocks.unreadCount } }));
vi.mock("@/lib/perf/idle-scheduler", () => ({ registerPeriodicTask: mocks.registerPeriodicTask, markPeriodicTaskRan: vi.fn() }));
vi.mock("@/lib/interaction/interaction-intent-coordinator", () => ({ appInteractionCoordinator: { subscribeLifecycle: mocks.subscribeLifecycle, getLifecycleSnapshot: () => ({ state: mocks.lifecycleState }) } }));

import { dispatchDirectMessagesUpdated } from "@/lib/direct-messages/direct-message-events";
import { useDirectMessagesUnreadCount } from "@/lib/direct-messages/use-direct-messages-unread-count";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const owner = (uid: string) => ({ uid, getIdToken: vi.fn(async () => `${uid}-token`) });

describe("Messages action count", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.lifecycleState = "active";
    vi.stubGlobal("BroadcastChannel", undefined);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    mocks.registerPeriodicTask.mockReturnValue(mocks.unregister);
    mocks.subscribeLifecycle.mockReturnValue(mocks.unsubscribeLifecycle);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });

  it("recounts every arrival/read, including 100+ messages and repeated read cycles", async () => {
    const user = owner("owner");
    mocks.unreadCount.mockResolvedValue(0);
    const { result } = renderHook(() => useDirectMessagesUnreadCount(user));
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe(0));
    expect(mocks.unreadCount).toHaveBeenCalledWith({ idToken: "owner-token" });

    for (const count of [1, 2, 100, 137, 1, 0, 1, 0]) {
      mocks.unreadCount.mockResolvedValue(count);
      act(() => {
        if (count <= 1) dispatchDirectMessagesUpdated({ userId: user.uid, conversationId: "conversation", messageId: null, source: "read" });
        else dispatchFeedStateChanged("arrived");
      });
      await waitFor(() => expect(result.current).toBe(count));
    }
  });

  it("ignores an older response and follows up once when read events arrive during a request", async () => {
    const user = owner("owner");
    const oldRequest = deferred<number>();
    const afterRead = deferred<number>();
    mocks.unreadCount.mockResolvedValueOnce(1).mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(afterRead.promise);
    const { result } = renderHook(() => useDirectMessagesUnreadCount(user));
    await waitFor(() => expect(result.current).toBe(1));
    act(() => dispatchFeedStateChanged("arrived"));
    await waitFor(() => expect(mocks.unreadCount).toHaveBeenCalledTimes(2));
    act(() => {
      dispatchFeedStateChanged("read");
      dispatchFeedStateChanged("read");
    });
    await act(async () => { oldRequest.resolve(137); });
    await waitFor(() => expect(mocks.unreadCount).toHaveBeenCalledTimes(3));
    expect(result.current).toBe(1);
    await act(async () => { afterRead.resolve(0); });
    expect(result.current).toBe(0);
  });

  it("fences late requests across A to B to A, even when the same A user object returns", async () => {
    const a = owner("a");
    const b = owner("b");
    const oldA = deferred<number>();
    const pendingB = deferred<number>();
    const newA = deferred<number>();
    mocks.unreadCount.mockReturnValueOnce(oldA.promise).mockReturnValueOnce(pendingB.promise).mockReturnValueOnce(newA.promise);
    const { result, rerender } = renderHook(({ user }) => useDirectMessagesUnreadCount(user), { initialProps: { user: a } });
    await waitFor(() => expect(mocks.unreadCount).toHaveBeenCalledTimes(1));
    rerender({ user: b });
    expect(result.current).toBeNull();
    await waitFor(() => expect(mocks.unreadCount).toHaveBeenCalledTimes(2));
    rerender({ user: a });
    await waitFor(() => expect(mocks.unreadCount).toHaveBeenCalledTimes(3));
    await act(async () => { oldA.resolve(137); pendingB.resolve(25); });
    expect(result.current).toBeNull();
    await act(async () => { newA.resolve(2); });
    expect(result.current).toBe(2);
  });

  it("does not report failures as zero and recovers on focus, online and the shared clock", async () => {
    const user = owner("owner");
    mocks.unreadCount.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(2).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(0);
    const { result } = renderHook(() => useDirectMessagesUnreadCount(user));
    await waitFor(() => expect(mocks.unreadCount).toHaveBeenCalledTimes(1));
    expect(result.current).toBeNull();
    act(() => window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(result.current).toBe(2));
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(mocks.unreadCount).toHaveBeenCalledTimes(3));
    expect(result.current).toBe(2);
    const task = mocks.registerPeriodicTask.mock.calls[0][0];
    expect(task.intervalMs).toBe(45_000);
    await act(async () => { await task.run(); });
    expect(result.current).toBe(0);
  });

  it("pauses in a native background before document visibility catches up and recounts on resume", async () => {
    const user = owner("owner");
    mocks.unreadCount.mockResolvedValueOnce(2).mockResolvedValueOnce(5);
    const { result } = renderHook(() => useDirectMessagesUnreadCount(user));
    await waitFor(() => expect(result.current).toBe(2));
    mocks.lifecycleState = "background";
    act(() => dispatchFeedStateChanged("arrived"));
    expect(mocks.unreadCount).toHaveBeenCalledTimes(1);
    mocks.lifecycleState = "active";
    await act(async () => { await mocks.subscribeLifecycle.mock.calls[0][0](); });
    await waitFor(() => expect(result.current).toBe(5));
  });

  it("pauses hidden reads, ignores another owner and cleans up on unmount", async () => {
    const user = owner("owner");
    mocks.unreadCount.mockResolvedValue(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const { result, unmount } = renderHook(() => useDirectMessagesUnreadCount(user));
    act(() => dispatchFeedStateChanged("arrived"));
    expect(mocks.unreadCount).not.toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(result.current).toBe(2));
    act(() => dispatchDirectMessagesUpdated({ userId: "someone-else", conversationId: null, messageId: null, source: "fcm" }));
    expect(mocks.unreadCount).toHaveBeenCalledTimes(1);
    unmount();
    expect(mocks.unregister).toHaveBeenCalledOnce();
    expect(mocks.unsubscribeLifecycle).toHaveBeenCalledOnce();
    act(() => { dispatchFeedStateChanged("arrived"); window.dispatchEvent(new Event("online")); });
    expect(mocks.unreadCount).toHaveBeenCalledTimes(1);
  });
});
