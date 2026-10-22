import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: { uid: "A", getIdToken: vi.fn().mockResolvedValue("id-token") },
  vaultOwnerToken: "vault-A" as string | null,
  calendarRefresh: vi.fn(), gmailRefresh: vi.fn(), statusRefresh: vi.fn(), list: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultOwnerToken: state.vaultOwnerToken }) }));
vi.mock("@/lib/calendar/use-calendar-connection-status", () => ({ useCalendarConnectionStatus: () => ({ connected: true }) }));
vi.mock("@/lib/calendar/use-calendar-upcoming-events", () => ({ useCalendarUpcomingEvents: () => ({ events: [], refresh: state.calendarRefresh }) }));
vi.mock("@/lib/profile/gmail-connector-store", () => ({ useGmailConnectorStatus: () => ({ status: { connected: true }, refreshStatus: state.statusRefresh }) }));
vi.mock("@/lib/gmail/use-gmail-nudges", () => ({ useGmailNudges: () => ({ nudges: [], refresh: state.gmailRefresh }) }));
vi.mock("@/lib/services/gmail-information-requests-service", () => ({ GmailInformationRequestsService: { list: state.list } }));
import { useFeedBriefing } from "@/lib/feed/use-feed-briefing";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { resetIdleSchedulerForTests } from "@/lib/perf/idle-scheduler";

describe("Feed briefing invalidation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Keep event invalidation separate from the wall-clock-aligned two-minute fallback.
    vi.setSystemTime(new Date("2026-10-14T01:16:00.000Z"));
    state.vaultOwnerToken = "vault-A";
    state.list.mockResolvedValue({ workflows: [], total_count: 0 });
    state.statusRefresh.mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    resetIdleSchedulerForTests();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("coalesces remote activity but does not refresh provider reads for read-only or document consent changes", async () => {
    const view = renderHook(() => useFeedBriefing());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => {
      dispatchFeedStateChanged("read");
      window.dispatchEvent(new CustomEvent("consent-state-changed", { detail: { source: "sse_document_feed" } }));
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(state.calendarRefresh).not.toHaveBeenCalled();
    expect(state.gmailRefresh).not.toHaveBeenCalled();
    await act(async () => {
      dispatchFeedStateChanged("arrived");
      dispatchFeedStateChanged("arrived");
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(state.calendarRefresh).toHaveBeenCalledTimes(1);
    expect(state.gmailRefresh).toHaveBeenCalledTimes(1);
    expect(state.list).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("refreshes at the aligned fallback boundary without an activity event", async () => {
    vi.setSystemTime(new Date("2026-10-14T01:17:59.700Z"));
    const view = renderHook(() => useFeedBriefing());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(state.list).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    // The boundary wake still waits for its frame and the refresh debounce.
    expect(state.calendarRefresh).not.toHaveBeenCalled();
    expect(state.gmailRefresh).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(state.calendarRefresh).toHaveBeenCalledTimes(1);
    expect(state.gmailRefresh).toHaveBeenCalledTimes(1);
    expect(state.list).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("refreshes on return and suppresses queued and late private reads after vault locking", async () => {
    let finish!: (value: unknown) => void;
    state.list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { result, rerender, unmount } = renderHook(() => useFeedBriefing());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    act(() => { dispatchFeedStateChanged("arrived"); advanceVaultSessionEpoch(); state.vaultOwnerToken = null; });
    rerender();
    await act(async () => {
      finish({ workflows: [{ status: "detected", workflow_id: "old-private-workflow" }], total_count: 1 });
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(result.current.pendingKyc).toBeNull();
    expect(state.calendarRefresh).not.toHaveBeenCalled();
    expect(state.gmailRefresh).not.toHaveBeenCalled();
    unmount();
  });

  it("does not read when disabled and does not refresh excluded provider lanes", async () => {
    const view = renderHook(({ enabled }) => useFeedBriefing({ enabled, includeCalendar: false, includeNudges: false }), { initialProps: { enabled: false } });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(state.list).not.toHaveBeenCalled();
    view.rerender({ enabled: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(state.list).toHaveBeenCalledTimes(1);
    await act(async () => { dispatchFeedStateChanged("arrived"); await vi.advanceTimersByTimeAsync(1_000); });
    expect(state.calendarRefresh).not.toHaveBeenCalled();
    expect(state.gmailRefresh).not.toHaveBeenCalled();
    expect(state.list).toHaveBeenCalledTimes(2);
  });

  it("reports KYC unavailable separately from an empty queue and recovers on retry", async () => {
    state.list.mockRejectedValueOnce(new Error("synthetic private provider failure"));
    const { result } = renderHook(() => useFeedBriefing({ includeCalendar: false, includeNudges: false }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.kycError).toBe(true);
    expect(result.current.kycLoading).toBe(false);
    state.list.mockResolvedValue({ workflows: [{ workflow_id: "fixture-kyc", status: "detected" }], total_count: 2 });
    await act(async () => { await result.current.retryKyc(); await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.kycError).toBe(false);
    expect(result.current.pendingKyc).toMatchObject({ workflowId: "fixture-kyc", count: 2 });
  });

});
