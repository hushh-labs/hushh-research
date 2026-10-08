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

  it("loads the next owner's connection and ignores the previous owner's delayed response", async () => {
    let finish!: (
      value: Awaited<ReturnType<typeof GoogleCalendarService.status>>,
    ) => void;
    mockedStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mockedStatus.mockResolvedValueOnce({
      configured: true,
      connected: false,
      status: "disconnected",
      scope_csv: "",
    });
    const { result, rerender } = renderHook(
      ({ owner }) =>
        useCalendarConnectionStatus({
          userId: owner,
          idTokenProvider: async () => `token-${owner}`,
        }),
      { initialProps: { owner: "owner-a" } },
    );
    await waitFor(() => expect(mockedStatus).toHaveBeenCalledTimes(1));
    rerender({ owner: "owner-b" });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(mockedStatus).toHaveBeenLastCalledWith("token-owner-b", "owner-b");
    await act(async () => {
      finish({
        configured: true,
        connected: true,
        status: "connected",
        scope_csv: "calendar.events.readonly",
      });
    });
    expect(result.current.connected).toBe(false);
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
});
