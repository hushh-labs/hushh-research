import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAgentDeploymentFollow } from "@/lib/feed/use-agent-deployment-follow";

const mocks = vi.hoisted(() => ({ status: vi.fn(), stream: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { getPersonalAgentStatus: mocks.status },
}));
vi.mock("@/lib/streaming/pod-lifecycle-client", () => ({
  followPodLifecycle: mocks.stream,
}));
vi.mock("@/lib/feed/feed-events", () => ({
  dispatchFeedStateChanged: vi.fn(),
}));
vi.mock("@/lib/services/app-background-task-service", () => ({
  AppBackgroundTaskService: {
    startTask: vi.fn(),
    updateTask: vi.fn(),
    completeTask: vi.fn(),
    failTask: vi.fn(),
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

it("loads hosting and release status with lifecycle streaming enabled", async () => {
  vi.stubEnv("NEXT_PUBLIC_POD_LIFECYCLE_STREAM", "1");
  mocks.status.mockResolvedValue({
    state: "active",
    hostingMode: "byoc",
    updateOfferable: false,
  });
  mocks.stream.mockResolvedValue(undefined);
  const { result } = renderHook(() =>
    useAgentDeploymentFollow({ userId: "owner" }),
  );
  await waitFor(() => expect(result.current.status?.hostingMode).toBe("byoc"));
  expect(result.current.resolved).toBe(true);
  expect(mocks.stream).toHaveBeenCalledOnce();
});

it("clears the previous owner's status while the next owner's request is pending", async () => {
  vi.stubEnv("NEXT_PUBLIC_POD_LIFECYCLE_STREAM", "0");
  mocks.status.mockResolvedValueOnce({
    state: "active",
    hushhId: "previous",
    hostingMode: "byoc",
  });
  const { result, rerender } = renderHook(
    ({ userId }) => useAgentDeploymentFollow({ userId }),
    {
      initialProps: { userId: "first" },
    },
  );
  await waitFor(() => expect(result.current.hushhId).toBe("previous"));
  mocks.status.mockImplementation(() => new Promise(() => {}));
  rerender({ userId: "second" });
  expect(result.current.status).toBeNull();
  expect(result.current.hushhId).toBeNull();
  expect(result.current.resolved).toBe(false);
  expect(result.current.update.offerable).toBe(false);
});

it("keeps the current version visible while a refresh is pending", async () => {
  vi.stubEnv("NEXT_PUBLIC_POD_LIFECYCLE_STREAM", "0");
  mocks.status.mockResolvedValueOnce({
    state: "active",
    hostingMode: "byoc",
    installedRelease: { version: "2026.09-dev.1" },
  });
  const { result } = renderHook(() =>
    useAgentDeploymentFollow({ userId: "owner" }),
  );
  await waitFor(() =>
    expect(result.current.status?.installedRelease?.version).toBe(
      "2026.09-dev.1",
    ),
  );
  mocks.status.mockImplementation(() => new Promise(() => {}));
  act(() => result.current.refresh());
  expect(result.current.status?.installedRelease?.version).toBe(
    "2026.09-dev.1",
  );
  expect(result.current.resolved).toBe(true);
});
