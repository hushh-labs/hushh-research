import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/services/app-background-task-service", () => ({
  AppBackgroundTaskService: {
    getTask: vi.fn(() => null),
    startTask: vi.fn(),
    updateTask: vi.fn(),
    failTask: vi.fn(),
    cancelTask: vi.fn(),
    completeTask: vi.fn(),
  },
}));

vi.mock("@/lib/services/gmail-receipts-service", () => ({
  GmailReceiptsService: {
    getStatus: vi.fn(),
    reconcile: vi.fn(),
    disconnect: vi.fn(),
    syncNow: vi.fn(),
    getSyncRun: vi.fn(),
  },
}));

import {
  clearConnectorStatus,
  getConnectorView,
  primeConnectorStatus,
  useGmailConnectorStatus,
} from "@/lib/profile/gmail-connector-store";

describe("gmail-connector-store", () => {
  beforeEach(() => {
    clearConnectorStatus("user-snapshot");
    clearConnectorStatus("user-hook");
    if (typeof window !== "undefined") {
      window.sessionStorage.clear();
    }
  });

  it("returns a stable snapshot object until the entry actually changes", () => {
    const emptyFirst = getConnectorView("user-snapshot");
    const emptySecond = getConnectorView("user-snapshot");
    expect(emptyFirst).toBe(emptySecond);

    primeConnectorStatus({
      userId: "user-snapshot",
      status: {
        configured: true,
        connected: true,
        status: "connected",
        google_email: "akshat@hushh.ai",
        scope_csv: "gmail.readonly",
        auto_sync_enabled: true,
        revoked: false,
        connection_state: "connected",
        sync_state: "idle",
        bootstrap_state: "completed",
        watch_status: "active",
        needs_reauth: false,
      },
      source: "status",
    });

    const populatedFirst = getConnectorView("user-snapshot");
    const populatedSecond = getConnectorView("user-snapshot");
    expect(populatedFirst).toBe(populatedSecond);
    expect(populatedFirst).not.toBe(emptyFirst);
    expect(populatedFirst.status?.google_email).toBe("akshat@hushh.ai");
  });

  it("renders the hook without triggering an external-store snapshot loop", () => {
    primeConnectorStatus({
      userId: "user-hook",
      status: {
        configured: true,
        connected: true,
        status: "connected",
        google_email: "user-hook@hushh.ai",
        scope_csv: "gmail.readonly",
        auto_sync_enabled: true,
        revoked: false,
        connection_state: "connected",
        sync_state: "idle",
        bootstrap_state: "completed",
        watch_status: "active",
        needs_reauth: false,
      },
      source: "status",
    });

    const { result, rerender } = renderHook(
      ({ userId }) =>
        useGmailConnectorStatus({
          userId,
          enabled: false,
        }),
      {
        initialProps: {
          userId: "user-hook",
        },
      }
    );

    expect(result.current.status?.google_email).toBe("user-hook@hushh.ai");
    rerender({ userId: "user-hook" });
    expect(result.current.status?.google_email).toBe("user-hook@hushh.ai");
  });
});
