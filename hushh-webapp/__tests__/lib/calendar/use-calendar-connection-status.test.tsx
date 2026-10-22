import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCalendarConnectionStatus } from "@/lib/calendar/use-calendar-connection-status";
import { GoogleCalendarService } from "@/lib/services/google-calendar-service";

vi.mock("@/lib/services/google-calendar-service", () => ({
  GoogleCalendarService: {
    status: vi.fn(),
  },
}));

const mockedStatus = vi.mocked(GoogleCalendarService.status);

describe("useCalendarConnectionStatus", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not fetch when disabled", () => {
    renderHook(() =>
      useCalendarConnectionStatus({
        userId: "user-1",
        idTokenProvider: async () => "id-token",
        enabled: false,
      }),
    );
    expect(mockedStatus).not.toHaveBeenCalled();
  });

  it("does not fetch without a userId", () => {
    renderHook(() =>
      useCalendarConnectionStatus({
        userId: null,
        idTokenProvider: async () => "id-token",
      }),
    );
    expect(mockedStatus).not.toHaveBeenCalled();
  });

  it("derives connected: true for a healthy connection", async () => {
    mockedStatus.mockResolvedValueOnce({
      configured: true,
      connected: true,
      status: "connected",
      scope_csv: "calendar.events.readonly",
    });

    const { result } = renderHook(() =>
      useCalendarConnectionStatus({
        userId: "user-1",
        idTokenProvider: async () => "id-token",
      }),
    );

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.connected).toBe(true);
    expect(mockedStatus).toHaveBeenCalledWith("id-token", "user-1");
  });

  it("derives connected: false when status is needs_reauth, even though connected is true", async () => {
    mockedStatus.mockResolvedValueOnce({
      configured: true,
      connected: true,
      status: "needs_reauth",
      scope_csv: "calendar.events.readonly",
    });

    const { result } = renderHook(() =>
      useCalendarConnectionStatus({
        userId: "user-1",
        idTokenProvider: async () => "id-token",
      }),
    );

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.connected).toBe(false);
  });

  it("sets an error and still marks loaded when the fetch rejects", async () => {
    mockedStatus.mockRejectedValueOnce(new Error("network down"));

    const { result } = renderHook(() =>
      useCalendarConnectionStatus({
        userId: "user-1",
        idTokenProvider: async () => "id-token",
      }),
    );

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.connected).toBe(false);
    expect(result.current.error).toBeTruthy();
  });

  it("refresh() re-fetches", async () => {
    mockedStatus.mockResolvedValue({
      configured: true,
      connected: true,
      status: "connected",
      scope_csv: "calendar.events.readonly",
    });

    const { result } = renderHook(() =>
      useCalendarConnectionStatus({
        userId: "user-1",
        idTokenProvider: async () => "id-token",
      }),
    );

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(mockedStatus).toHaveBeenCalledTimes(1);

    result.current.refresh();
    await waitFor(() => expect(mockedStatus).toHaveBeenCalledTimes(2));
  });
  it("hides the previous owner immediately and ignores delayed status and token results", async () => {
    const connected = { configured: true, connected: true, status: "connected" as const, scope_csv: "read" };
    let resolveOld!: (value: typeof connected) => void;
    mockedStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    mockedStatus.mockResolvedValueOnce({ ...connected, connected: false, status: "disconnected" });
    const provider = async () => "token";
    const { result, rerender } = renderHook(({ userId }) => useCalendarConnectionStatus({ userId, idTokenProvider: provider }),
      { initialProps: { userId: "old" } });
    await waitFor(() => expect(mockedStatus).toHaveBeenCalledTimes(1));
    rerender({ userId: "new" });
    expect(result.current.status).toBeNull();
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => resolveOld(connected));
    expect(result.current.connected).toBe(false);
    expect(mockedStatus).toHaveBeenLastCalledWith("token", "new");
  });

  it("does not dispatch status after its owner's token resolves late", async () => {
    let token!: (value: string) => void;
    const provider = () => new Promise<string>((resolve) => { token = resolve; });
    const { result, rerender } = renderHook(({ enabled }) => useCalendarConnectionStatus({ userId: "owner", idTokenProvider: provider, enabled }),
      { initialProps: { enabled: true } });
    rerender({ enabled: false });
    await act(async () => token("old-token"));
    expect(mockedStatus).not.toHaveBeenCalled();
    expect(result.current.status).toBeNull();
  });

  it("keeps the newest refresh when earlier requests complete out of order", async () => {
    const connected = { configured: true, connected: true, status: "connected" as const, scope_csv: "read" };
    let resolveOld!: (value: typeof connected) => void;
    mockedStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    mockedStatus.mockResolvedValueOnce({ ...connected, connected: false, status: "disconnected" });
    const { result } = renderHook(() => useCalendarConnectionStatus({ userId: "owner", idTokenProvider: async () => "token" }));
    await waitFor(() => expect(mockedStatus).toHaveBeenCalledTimes(1));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => resolveOld(connected));
    expect(result.current.connected).toBe(false);
  });

});
