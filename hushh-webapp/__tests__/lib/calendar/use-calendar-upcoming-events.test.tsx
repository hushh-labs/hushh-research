import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCalendarUpcomingEvents } from "@/lib/calendar/use-calendar-upcoming-events";
import { GoogleCalendarService } from "@/lib/services/google-calendar-service";

vi.mock("@/lib/services/google-calendar-service", () => ({
  GoogleCalendarService: {
    listEvents: vi.fn(),
    resolveReminder: vi.fn(),
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
  it("fences a pending owner read across account switch", async () => {
    let complete!: (value: { events: (typeof RAW_EVENT)[] }) => void;
    mockedListEvents.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    mockedListEvents.mockResolvedValueOnce({ events: [] });
    const { result, rerender } = renderHook(
      ({ owner }) =>
        useCalendarUpcomingEvents({
          userId: owner,
          vaultOwnerToken: `${owner}-vault`,
          isConnected: true,
        }),
      { initialProps: { owner: "old" } },
    );
    rerender({ owner: "new" });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => complete({ events: [RAW_EVENT] }));
    expect(result.current.events).toEqual([]);
  });

  it("resolves the exact reminder independently of a failed ordinary listing", async () => {
    mockedListEvents.mockRejectedValueOnce(new Error("offline"));
    vi.mocked(GoogleCalendarService.resolveReminder).mockResolvedValueOnce({
      ...RAW_EVENT,
      end: { dateTime: "2099-01-01T00:00:00Z" },
    });
    const { result } = renderHook(() =>
      useCalendarUpcomingEvents({
        userId: "owner",
        vaultOwnerToken: "vault",
        isConnected: true,
        reminderId: "11111111-2222-3333-4444-555555555555",
      }),
    );
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.events[0]).toMatchObject({
      id: "e1",
      reminderSelected: true,
    });
    expect(result.current.error).toBeTruthy();
  });
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

  it("checks a tapped reminder against the live backend even when connection status has not loaded", async () => {
    vi.mocked(GoogleCalendarService.resolveReminder).mockRejectedValueOnce(
      new Error("Calendar was disconnected"),
    );
    const { result } = renderHook(() =>
      useCalendarUpcomingEvents({
        userId: "owner",
        vaultOwnerToken: "vault",
        isConnected: false,
        reminderId: "11111111-2222-3333-4444-555555555555",
      }),
    );
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(mockedListEvents).not.toHaveBeenCalled();
    expect(GoogleCalendarService.resolveReminder).toHaveBeenCalledWith(
      "vault",
      "11111111-2222-3333-4444-555555555555",
    );
    expect(result.current.error).toBeTruthy();
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
    const spanMs =
      new Date(call.endAt).getTime() - new Date(call.startAt).getTime();
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
});
