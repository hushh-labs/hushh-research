import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCalendarUpcomingEvents } from "@/lib/calendar/use-calendar-upcoming-events";
import { GoogleCalendarError, GoogleCalendarService } from "@/lib/services/google-calendar-service";

vi.mock("@/lib/services/google-calendar-service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/services/google-calendar-service")>(),
  GoogleCalendarService: {
    listEvents: vi.fn(),
  },
}));

const mockedListEvents = vi.mocked(GoogleCalendarService.listEvents);

// Mirrors consent-protocol/tests/test_gmail_calendar_tools.py's own
// redaction fixture -- same sensitive fields, same expectation that none of
// them survive.
const RAW_EVENT = {
  id: "e1",
  etag: '"abc"',
  title: "1:1 with Jamie",
  description: "Discuss the Q3 roadmap and comp review.",
  location: "123 Private Rd, Springfield",
  start: { dateTime: "2026-01-01T10:00:00Z" },
  end: { dateTime: "2026-01-01T10:30:00Z" },
  status: "confirmed",
  attendees: [{ email: "jamie@example.com", response_status: "accepted" }],
  html_link: "https://calendar.google.com/event?eid=abc",
  updated: "2025-12-01T00:00:00Z",
};

describe("useCalendarUpcomingEvents", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not fetch when disconnected", () => {
    renderHook(() =>
      useCalendarUpcomingEvents({
        userId: "user-1",
        vaultOwnerToken: "vault-token",
        isConnected: false,
      }),
    );
    expect(mockedListEvents).not.toHaveBeenCalled();
  });

  it("redacts description, location, attendees, and html_link before returning events", async () => {
    mockedListEvents.mockResolvedValueOnce({
      events: [RAW_EVENT],
      time_zone: "America/Los_Angeles",
    });

    const { result } = renderHook(() =>
      useCalendarUpcomingEvents({
        userId: "user-1",
        vaultOwnerToken: "vault-token",
        isConnected: true,
      }),
    );

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.events).toEqual([
      {
        id: "e1",
        title: "1:1 with Jamie",
        start: { dateTime: "2026-01-01T10:00:00Z" },
        end: { dateTime: "2026-01-01T10:30:00Z" },
        status: "confirmed",
      },
    ]);

    const serialized = JSON.stringify(result.current.events);
    for (const forbidden of [
      "description",
      "Q3 roadmap",
      "location",
      "Springfield",
      "attendees",
      "jamie@example.com",
      "html_link",
      "etag",
      "updated",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("keeps only a validated Google Meet URL in the memory-only event shape", async () => {
    mockedListEvents.mockResolvedValueOnce({
      events: [
        {
          ...RAW_EVENT,
          conference_url: "https://meet.google.com/abc-defg-hij",
        },
        {
          ...RAW_EVENT,
          id: "e2",
          conference_url: "https://attacker.example/meeting",
        },
      ],
    });

    const { result } = renderHook(() =>
      useCalendarUpcomingEvents({
        userId: "user-1",
        vaultOwnerToken: "vault-token",
        isConnected: true,
      }),
    );

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.events[0]?.conferenceUrl).toBe(
      "https://meet.google.com/abc-defg-hij",
    );
    expect(result.current.events[1]?.conferenceUrl).toBeUndefined();
  });

  it("requests roughly a 48h look-ahead window by default", async () => {
    mockedListEvents.mockResolvedValueOnce({ events: [] });

    renderHook(() =>
      useCalendarUpcomingEvents({
        userId: "user-1",
        vaultOwnerToken: "vault-token",
        isConnected: true,
      }),
    );

    await waitFor(() => expect(mockedListEvents).toHaveBeenCalledTimes(1));
    const call = mockedListEvents.mock.calls[0][0];
    const spanMs = new Date(call.endAt).getTime() - new Date(call.startAt).getTime();
    expect(spanMs).toBeCloseTo(48 * 60 * 60 * 1000, -3);
  });

  it("sets an error and still marks loaded when the fetch rejects", async () => {
    mockedListEvents.mockRejectedValueOnce(new Error("network down"));

    const { result } = renderHook(() =>
      useCalendarUpcomingEvents({
        userId: "user-1",
        vaultOwnerToken: "vault-token",
        isConnected: true,
      }),
    );

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.events).toHaveLength(0);
    expect(result.current.error).toBeTruthy();
  });

  it("returns an empty list once disconnected, even if events were previously fetched", async () => {
    mockedListEvents.mockResolvedValueOnce({ events: [RAW_EVENT] });

    const { result, rerender } = renderHook(
      (props: { isConnected: boolean }) =>
        useCalendarUpcomingEvents({
          userId: "user-1",
          vaultOwnerToken: "vault-token",
          isConnected: props.isConnected,
        }),
      { initialProps: { isConnected: true } },
    );

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.events).toHaveLength(1);

    rerender({ isConnected: false });
    expect(result.current.events).toHaveLength(0);
  });

  it("discards an old owner's delayed response after switching accounts", async () => {
    type ListResponse = Awaited<ReturnType<typeof GoogleCalendarService.listEvents>>;
    let resolveOld!: (value: ListResponse) => void;
    let resolveNew!: (value: ListResponse) => void;
    mockedListEvents
      .mockImplementationOnce(() => new Promise<ListResponse>((resolve) => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise<ListResponse>((resolve) => { resolveNew = resolve; }));

    const { result, rerender } = renderHook(
      (props: { userId: string; vaultOwnerToken: string }) =>
        useCalendarUpcomingEvents({ ...props, isConnected: true }),
      { initialProps: { userId: "owner-a", vaultOwnerToken: "token-a" } },
    );
    await waitFor(() => expect(mockedListEvents).toHaveBeenCalledTimes(1));

    rerender({ userId: "owner-b", vaultOwnerToken: "token-b" });
    expect(result.current.events).toEqual([]);
    await waitFor(() => expect(mockedListEvents).toHaveBeenCalledTimes(2));

    await act(async () => resolveOld({ events: [RAW_EVENT] }));
    expect(result.current.events).toEqual([]);
    expect(result.current.loaded).toBe(false);

    await act(async () => resolveNew({
      events: [{ ...RAW_EVENT, id: "e2", title: "New owner's event" }],
    }));
    expect(result.current.events.map((event) => event.title)).toEqual(["New owner's event"]);
  });
  it("reloads when the requested time window changes and ignores the old window", async () => {
    let resolveOld!: (value: { events: typeof RAW_EVENT[] }) => void;
    mockedListEvents.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    mockedListEvents.mockResolvedValueOnce({ events: [{ ...RAW_EVENT, title: "Current window" }] });
    const { result, rerender } = renderHook(({ windowHours }) => useCalendarUpcomingEvents({ userId: "owner", vaultOwnerToken: "token", isConnected: true, windowHours }), { initialProps: { windowHours: 24 } });
    await waitFor(() => expect(mockedListEvents).toHaveBeenCalledTimes(1));
    rerender({ windowHours: 168 });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => resolveOld({ events: [RAW_EVENT] }));
    expect(result.current.events.map((event) => event.title)).toEqual(["Current window"]);
    const query = mockedListEvents.mock.calls[1][0];
    expect(Date.parse(query.endAt) - Date.parse(query.startAt)).toBe(168 * 60 * 60 * 1000);
  });

  it("exposes typed reconnect recovery and clears the old private events", async () => {
    mockedListEvents.mockResolvedValueOnce({ events: [RAW_EVENT] });
    const { result } = renderHook(() => useCalendarUpcomingEvents({ userId: "owner", vaultOwnerToken: "token", isConnected: true }));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    mockedListEvents.mockRejectedValueOnce(new GoogleCalendarError("Reconnect Calendar to read events.", "calendar_reauthorization_required", 401));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.recovery).toBe("reconnect"));
    expect(result.current.events).toEqual([]);
    expect(result.current.error).toBe("Reconnect Calendar to read events.");
  });

});
