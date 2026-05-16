import { act, renderHook, waitFor } from "@testing-library/react";
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
import { GmailReceiptsService } from "@/lib/services/gmail-receipts-service";

describe("gmail-connector-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearConnectorStatus("user-snapshot");
    clearConnectorStatus("user-hook");
    clearConnectorStatus("user-backfill");
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

  it("falls back to a plain status fetch when reconcile times out", async () => {
    vi.mocked(GmailReceiptsService.reconcile).mockRejectedValueOnce(
      new Error("Gmail is taking too long to respond right now. Please try again in a moment.")
    );
    vi.mocked(GmailReceiptsService.getStatus).mockResolvedValue({
      configured: true,
      connected: true,
      status: "connected",
      google_email: "fallback@hushh.ai",
      scope_csv: "gmail.readonly",
      auto_sync_enabled: true,
      revoked: false,
      connection_state: "connected",
      sync_state: "idle",
      bootstrap_state: "completed",
      watch_status: "active",
      needs_reauth: false,
    } as Awaited<ReturnType<typeof GmailReceiptsService.getStatus>>);

    const { result } = renderHook(() =>
      useGmailConnectorStatus({
        userId: "user-hook",
        enabled: true,
        idTokenProvider: async () => "id-token",
      })
    );

    await waitFor(() => {
      expect(GmailReceiptsService.getStatus).toHaveBeenCalled();
    });

    vi.mocked(GmailReceiptsService.getStatus).mockClear();

    await act(async () => {
      await result.current.refreshStatus({ force: true });
    });

    await waitFor(() => {
      expect(GmailReceiptsService.reconcile).toHaveBeenCalled();
      expect(GmailReceiptsService.getStatus).toHaveBeenCalled();
      expect(result.current.status?.google_email).toBe("fallback@hushh.ai");
    });
  });

  it("keeps a timed-out active run in a stale running state instead of collapsing to idle", async () => {
    let nowMs = 0;
    const setTimeoutSpy = vi
      .spyOn(window, "setTimeout")
      .mockImplementation(
        ((handler: TimerHandler, _timeout?: number, ...args: unknown[]) => {
          if (typeof handler === "function") {
            queueMicrotask(() => handler(...args));
          }
          return 0 as unknown as number;
        }) as typeof window.setTimeout
      );
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    try {
      nowMs = 0;
      const activeRun = {
        run_id: "run_timeout",
        user_id: "user-timeout",
        trigger_source: "connect",
        sync_mode: "bootstrap",
        status: "running",
        listed_count: 2,
        filtered_count: 1,
        synced_count: 1,
        extracted_count: 1,
        duplicates_dropped: 0,
        extraction_success_rate: 1,
      } as const;

      vi.mocked(GmailReceiptsService.getSyncRun).mockImplementation(async () => {
        nowMs = 2 * 60 * 1000 + 1;
        return {
          run: activeRun,
        };
      });
      vi.mocked(GmailReceiptsService.reconcile).mockResolvedValue({
        configured: true,
        connected: true,
        status: "connected",
        google_email: "timeout@hushh.ai",
        scope_csv: "gmail.readonly",
        auto_sync_enabled: true,
        revoked: false,
        connection_state: "connected",
        sync_state: "bootstrap_running",
        bootstrap_state: "running",
        watch_status: "active",
        needs_reauth: false,
        last_sync_status: "running",
        latest_run: activeRun,
      } as Awaited<ReturnType<typeof GmailReceiptsService.reconcile>>);

      primeConnectorStatus({
        userId: "user-timeout",
        status: {
          configured: true,
          connected: true,
          status: "connected",
          google_email: "timeout@hushh.ai",
          scope_csv: "gmail.readonly",
          auto_sync_enabled: true,
          revoked: false,
          connection_state: "connected",
          sync_state: "bootstrap_running",
          bootstrap_state: "running",
          watch_status: "active",
          needs_reauth: false,
          last_sync_status: "running",
          latest_run: activeRun,
        },
        source: "status",
        idTokenProvider: async () => "id-token",
      });

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(GmailReceiptsService.getSyncRun).toHaveBeenCalledWith({
        idToken: "id-token",
        userId: "user-timeout",
        runId: "run_timeout",
      });

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(GmailReceiptsService.reconcile).toHaveBeenCalledTimes(1);

      const view = getConnectorView("user-timeout");
      expect(view.presentation.state).toBe("syncing");
      expect(view.syncingRun).toBe(true);
      expect(view.isStale).toBe(true);
      clearConnectorStatus("user-timeout");
    } finally {
      setTimeoutSpy.mockRestore();
      dateNowSpy.mockRestore();
    }
  });

  it("starts polling active runs discovered from a plain status fetch and hands off to backfill", async () => {
    const setTimeoutSpy = vi
      .spyOn(window, "setTimeout")
      .mockImplementation(
        ((handler: TimerHandler, _timeout?: number, ...args: unknown[]) => {
          if (typeof handler === "function") {
            queueMicrotask(() => handler(...args));
          }
          return 0 as unknown as number;
        }) as typeof window.setTimeout
      );

    try {
      vi.mocked(GmailReceiptsService.getStatus).mockResolvedValue({
        configured: true,
        connected: true,
        status: "connected",
        google_email: "handoff@hushh.ai",
        scope_csv: "gmail.readonly",
        auto_sync_enabled: true,
        revoked: false,
        connection_state: "connected",
        sync_state: "bootstrap_running",
        bootstrap_state: "running",
        watch_status: "active",
        needs_reauth: false,
        latest_run: {
          run_id: "run_bootstrap",
          user_id: "user-hook",
          trigger_source: "connect",
          sync_mode: "bootstrap",
          status: "running",
          listed_count: 2,
          filtered_count: 1,
          synced_count: 1,
          extracted_count: 1,
          duplicates_dropped: 0,
          extraction_success_rate: 1,
        },
      } as Awaited<ReturnType<typeof GmailReceiptsService.getStatus>>);
      vi.mocked(GmailReceiptsService.getSyncRun).mockImplementation(async ({ runId }) => {
        if (runId === "run_bootstrap") {
          return {
            run: {
              run_id: "run_bootstrap",
              user_id: "user-hook",
              trigger_source: "connect",
              sync_mode: "bootstrap",
              status: "completed",
              listed_count: 2,
              filtered_count: 1,
              synced_count: 1,
              extracted_count: 1,
              duplicates_dropped: 0,
              extraction_success_rate: 1,
            },
          };
        }
        return {
          run: {
            run_id: "run_backfill",
            user_id: "user-hook",
            trigger_source: "backfill",
            sync_mode: "backfill",
            status: "completed",
            listed_count: 3,
            filtered_count: 2,
            synced_count: 2,
            extracted_count: 2,
            duplicates_dropped: 0,
            extraction_success_rate: 1,
          },
        };
      });
      vi.mocked(GmailReceiptsService.reconcile)
        .mockResolvedValueOnce({
          configured: true,
          connected: true,
          status: "connected",
          google_email: "handoff@hushh.ai",
          scope_csv: "gmail.readonly",
          auto_sync_enabled: true,
          revoked: false,
          connection_state: "connected",
          sync_state: "backfill_running",
          bootstrap_state: "completed",
          watch_status: "active",
          needs_reauth: false,
          last_sync_status: "running",
          latest_run: {
            run_id: "run_backfill",
            user_id: "user-hook",
            trigger_source: "backfill",
            sync_mode: "backfill",
            status: "running",
            listed_count: 3,
            filtered_count: 2,
            synced_count: 2,
            extracted_count: 2,
            duplicates_dropped: 0,
            extraction_success_rate: 1,
          },
        } as Awaited<ReturnType<typeof GmailReceiptsService.reconcile>>)
        .mockResolvedValueOnce({
          configured: true,
          connected: true,
          status: "connected",
          google_email: "handoff@hushh.ai",
          scope_csv: "gmail.readonly",
          auto_sync_enabled: true,
          revoked: false,
          connection_state: "connected",
          sync_state: "idle",
          bootstrap_state: "completed",
          watch_status: "active",
          needs_reauth: false,
          last_sync_status: "completed",
          latest_run: {
            run_id: "run_backfill",
            user_id: "user-hook",
            trigger_source: "backfill",
            sync_mode: "backfill",
            status: "completed",
            listed_count: 3,
            filtered_count: 2,
            synced_count: 2,
            extracted_count: 2,
            duplicates_dropped: 0,
            extraction_success_rate: 1,
          },
        } as Awaited<ReturnType<typeof GmailReceiptsService.reconcile>>);

      renderHook(() =>
        useGmailConnectorStatus({
          userId: "user-hook",
          enabled: true,
          idTokenProvider: async () => "id-token",
        })
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(GmailReceiptsService.getSyncRun).toHaveBeenCalledWith({
        idToken: "id-token",
        userId: "user-hook",
        runId: "run_bootstrap",
      });
      expect(GmailReceiptsService.getSyncRun).toHaveBeenCalledWith({
        idToken: "id-token",
        userId: "user-hook",
        runId: "run_backfill",
      });
      clearConnectorStatus("user-hook");
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("treats background backfill as passive instead of blocking the UI", () => {
    primeConnectorStatus({
      userId: "user-backfill",
      status: {
        configured: true,
        connected: true,
        status: "connected",
        google_email: "backfill@hushh.ai",
        scope_csv: "gmail.readonly",
        auto_sync_enabled: true,
        revoked: false,
        connection_state: "connected",
        sync_state: "backfill_running",
        bootstrap_state: "completed",
        watch_status: "active",
        needs_reauth: false,
        latest_run: {
          run_id: "run_backfill",
          user_id: "user-backfill",
          trigger_source: "backfill",
          sync_mode: "backfill",
          status: "running",
          listed_count: 12,
          filtered_count: 6,
          synced_count: 6,
          extracted_count: 5,
          duplicates_dropped: 0,
          extraction_success_rate: 0.83,
        },
      },
      source: "status",
    });

    const view = getConnectorView("user-backfill");
    expect(view.activeTaskKind).toBe("gmail_backfill");
    expect(view.syncingRun).toBe(false);
  });
});
