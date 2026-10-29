import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch } }));

import { GoogleCalendarError, GoogleCalendarService } from "@/lib/services/google-calendar-service";

describe("connected Calendar transport authority", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } }));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("passes an exact Board review and selected-account confirmation without replaying either mutation", async () => {
    const input = {
      vaultOwnerToken: "vault-owner", userId: "owner", accountId: "second",
      checkedAccountIds: ["default", "second", "third"], selectedDate: "2030-10-21",
      title: "Bug Bash", startAt: "2030-10-21T12:00:00Z", endAt: "2030-10-21T13:00:00Z",
      timeZone: "UTC", attendees: ["guest@example.com"], description: "", meetingType: "external_link" as const,
      meetingLink: "https://discord.com/channels/123456/987654", location: "",
    };
    apiFetch.mockResolvedValueOnce(Response.json({ proposal_id: "gcal_board", plan: { account_id: "second" } }));
    await GoogleCalendarService.reviewBoardBooking(input);
    const [reviewUrl, reviewOptions] = apiFetch.mock.calls[0];
    expect(reviewUrl).toBe("/api/one/calendar/proposals");
    expect(reviewOptions.headers.Authorization).toBe("Bearer vault-owner");
    expect(JSON.parse(reviewOptions.body)).toEqual(expect.objectContaining({
      user_id: "owner", action: "create", booking_source: "board", account_id: "second",
      checked_account_ids: ["default", "second", "third"], selected_date: "2030-10-21",
      meeting_type: "external_link", meeting_link: "https://discord.com/channels/123456/987654",
      attendees: ["guest@example.com"], send_updates: true,
    }));
    apiFetch.mockResolvedValueOnce(Response.json({ action: "create", event: { id: "created" } }));
    await GoogleCalendarService.executeProposal({ vaultOwnerToken: "vault-owner", userId: "owner", proposalId: "gcal_board", accountId: "second" });
    expect(apiFetch.mock.calls[1][0]).toBe("/api/one/calendar/proposals/execute");
    expect(JSON.parse(apiFetch.mock.calls[1][1].body)).toEqual({ user_id: "owner", proposal_id: "gcal_board", account_id: "second" });
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it.each(["review", "confirm"])("sends matching Firebase/vault authority and the current-lifetime guard for %s", async kind => {
    if (kind === "confirm") apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ calendar: "declined", email: "sent", calendar_error: null, email_error: null }), { status: 200 }));
    const current = vi.fn(() => true);
    const credentials = { firebaseIdToken: "firebase-owner", vaultOwnerToken: "vault-owner", isEffectCurrent: current };
    if (kind === "review") await GoogleCalendarService.reviewAttendance({
      ...credentials, eventId: "live-event", offerTimes: true, message: "Edited organizer message",
      date: "2026-10-14", timeZone: "Asia/Kolkata", startTime: "09:00", endTime: "17:00", durationMinutes: 30,
    });
    else await GoogleCalendarService.confirmAttendance({ ...credentials, reviewId: "review-id", reviewToken: "review-token" });

    expect(apiFetch).toHaveBeenCalledOnce();
    const [url, options] = apiFetch.mock.calls[0];
    expect(url).toBe(`/api/one/calendar/attendance/${kind}`);
    expect(options.headers).toMatchObject({ Authorization: "Bearer firebase-owner", "X-Hushh-Consent": "Bearer vault-owner" });
    expect(options.isEffectCurrent).toBe(current);
    expect(options.cache).toBe("no-store");
    expect(JSON.parse(options.body)).not.toHaveProperty("user_id");
  });

  it("uses Firebase without vault authority for a Calendar-only RSVP", async () => {
    const current = vi.fn(() => true);
    await GoogleCalendarService.reviewRsvp({
      firebaseIdToken: "firebase-owner", eventId: "live-event", calendarId: "primary",
      accountId: "second", expectedAccountEmail: "owner@example.test", responseStatus: "accepted",
      timeZone: "UTC", isEffectCurrent: current,
    });
    const [url, options] = apiFetch.mock.calls[0];
    expect(url).toBe("/api/one/calendar/attendance/rsvp/review");
    expect(options.headers.Authorization).toBe("Bearer firebase-owner");
    expect(options.headers).not.toHaveProperty("X-Hushh-Consent");
    expect(JSON.parse(options.body)).toEqual({
      event_id: "live-event", calendar_id: "primary", account_id: "second",
      expected_account_email: "owner@example.test", response_status: "accepted", time_zone: "UTC",
    });
    expect(options.isEffectCurrent).toBe(current);
    expect(options.cache).toBe("no-store");
  });

  it("confirms a Calendar-only RSVP without vault authority", async () => {
    apiFetch.mockResolvedValueOnce(Response.json({ calendar: "accepted", email: "not_sent", calendar_error: null, email_error: null }));
    await GoogleCalendarService.confirmRsvp({ firebaseIdToken: "firebase-owner", accountId: "second", reviewId: "review-id", reviewToken: "sealed-review" });
    const [url, options] = apiFetch.mock.calls[0];
    expect(url).toBe("/api/one/calendar/attendance/rsvp/confirm");
    expect(options.headers.Authorization).toBe("Bearer firebase-owner");
    expect(options.headers).not.toHaveProperty("X-Hushh-Consent");
    expect(JSON.parse(options.body)).toEqual({ account_id: "second", review_id: "review-id", review_token: "sealed-review" });
  });

  it("keeps confirmed selections on availability only and preserves failure catalog", async () => {
    const options = [{ id: "work", name: "Work", availability_default_included: true, availability_included: true }];
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ detail: { message: "Unreadable work calendar", reason_code: "calendar_unreadable", calendar_options: options } }), { status: 409 }));
    await expect(GoogleCalendarService.availability({ firebaseIdToken: "firebase-owner", date: "2030-01-17", timeZone: "UTC", startTime: "09:00", endTime: "17:00", durationMinutes: 30, calendarOverrides: { holiday: false, work: true } })).rejects.toMatchObject({ reasonCode: "calendar_unreadable", calendarOptions: options });
    expect(JSON.parse(apiFetch.mock.calls[0][1].body).calendar_overrides).toEqual({ holiday: false, work: true });
  });

  it("lets recipients check only the public capability without an owner Authorization header", async () => {
    await GoogleCalendarService.publicReschedulingOptions("recipient-capability");

    const [url, options] = apiFetch.mock.calls[0];
    expect(url).toBe("/api/one/calendar/rescheduling/options");
    expect(options.headers).not.toHaveProperty("Authorization");
    expect(options.headers).not.toHaveProperty("X-Hushh-Consent");
    expect(JSON.parse(options.body)).toEqual({ token: "recipient-capability" });
    expect(options.cache).toBe("no-store");
  });

  it("preserves Mail permission recovery separately from Calendar provider errors", async () => {
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ detail: {
      message: "Allow Mail sending", reason_code: "GMAIL_SEND_PERMISSION_REQUIRED",
    } }), { status: 409 }));

    try {
      await GoogleCalendarService.reviewAttendance({ firebaseIdToken: "firebase-owner", vaultOwnerToken: "vault-owner", eventId: "event", offerTimes: true,
        message: "Edited", date: "2026-10-14", timeZone: "UTC", startTime: "09:00", endTime: "17:00", durationMinutes: 30 });
      expect.fail("Mail permission failure was described as success");
    } catch (error) {
      expect(error).toBeInstanceOf(GoogleCalendarError);
      expect(error).toMatchObject({ reasonCode: "GMAIL_SEND_PERMISSION_REQUIRED", status: 409, message: "Allow Mail sending" });
    }
  });

  it("sends the selected day and zone without accepting a body account override", async () => {
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ events: [], calendars: [{ id: "primary", name: "Personal" }], unreadable_calendars: [], date: "2030-01-02", time_zone: "America/New_York" })));
    const current = vi.fn(() => true);
    const signal = new AbortController().signal;
    await GoogleCalendarService.today({ firebaseIdToken: "firebase-owner", signal, isEffectCurrent: current, date: "2030-01-02", timeZone: "America/New_York" });

    const [url, options] = apiFetch.mock.calls[0];
    expect(url).toBe("/api/one/calendar/schedule/today");
    expect(options.headers.Authorization).toBe("Bearer firebase-owner");
    expect(options.headers).not.toHaveProperty("X-Hushh-Consent");
    expect(JSON.parse(options.body)).toEqual({ date: "2030-01-02", time_zone: "America/New_York" });
    expect(options.isEffectCurrent).toBe(current);
    expect(options.signal).toBe(signal);
    expect(options.cache).toBe("no-store");
  });

  it("retains maximal free ranges and their full count separately from the requested meeting duration", async () => {
    const response = {
      windows: [{ start_at: "2030-01-02T09:00:00Z", end_at: "2030-01-02T09:45:00Z", duration_minutes: 45 }],
      full_count: 5, requested_duration_minutes: 15, date: "2030-01-02", time_zone: "UTC",
      time_min: "2030-01-02T00:00:00Z", time_max: "2030-01-03T00:00:00Z", calendars: [{ id: "primary", name: "Personal" }],
    };
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify(response)));
    const current = vi.fn(() => true);
    const signal = new AbortController().signal;
    const result = await GoogleCalendarService.availability({ firebaseIdToken: "firebase-owner", signal, isEffectCurrent: current, date: "2030-01-02", timeZone: "UTC", startTime: "09:00", endTime: "17:00", durationMinutes: 15 });

    expect(result).toEqual(response);
    const [url, options] = apiFetch.mock.calls[0];
    expect(url).toBe("/api/one/calendar/schedule/availability");
    expect(options.headers.Authorization).toBe("Bearer firebase-owner");
    expect(options.headers).not.toHaveProperty("X-Hushh-Consent");
    expect(JSON.parse(options.body)).toEqual({ date: "2030-01-02", time_zone: "UTC", start_time: "00:00", end_time: "24:00", duration_minutes: 15 });
    expect(options.isEffectCurrent).toBe(current);
    expect(options.signal).toBe(signal);
    expect(options.cache).toBe("no-store");
  });

  it.each([
    ["America/New_York", "2026-03-08", "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z"],
    ["America/Los_Angeles", "2026-11-01", "2026-11-01T07:00:00Z", "2026-11-02T08:00:00Z"],
    ["Europe/London", "2026-10-25", "2026-10-24T23:00:00Z", "2026-10-26T00:00:00Z"],
    ["Asia/Kolkata", "2026-10-15", "2026-10-14T18:30:00Z", "2026-10-15T18:30:00Z"],
    ["Asia/Kathmandu", "2026-10-15", "2026-10-14T18:15:00Z", "2026-10-15T18:15:00Z"],
    ["America/Santiago", "2026-09-06", "2026-09-06T04:00:00Z", "2026-09-07T03:00:00Z"],
    ["America/Havana", "2026-11-01", "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z"],
  ])("accepts complete civil-day bounds in %s on %s", async (timeZone, date, start, end) => {
    const response = { windows: [], full_count: 0, requested_duration_minutes: 15, date, time_zone: timeZone, time_min: start, time_max: end, calendars: [{ id: "personal" }] };
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify(response)));
    await expect(GoogleCalendarService.availability({ firebaseIdToken: "firebase-owner", date, timeZone, startTime: "00:00", endTime: "24:00", durationMinutes: 15 })).resolves.toEqual(response);
  });

  it.each([
    { time_min: "2030-01-02T09:00:00Z", time_max: "2030-01-02T17:00:00Z" },
    { time_min: "2030-01-02T14:00:00Z" },
    { time_max: "2030-01-03T01:00:00Z" },
    { windows: [{ start_at: "2030-01-01T23:30:00Z", end_at: "2030-01-02T00:15:00Z", duration_minutes: 45 }] },
    { windows: [{ start_at: "2030-01-02T23:30:00Z", end_at: "2030-01-03T00:15:00Z", duration_minutes: 45 }] },
    { full_count: 0 },
    { requested_duration_minutes: 30 },
    { windows: [{ start_at: "2030-01-02T09:00:00Z", end_at: "2030-01-02T09:30:00Z", duration_minutes: 45 }] },
  ])("rejects misleading free-window responses %j", async correction => {
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      windows: [{ start_at: "2030-01-02T09:00:00Z", end_at: "2030-01-02T09:45:00Z", duration_minutes: 45 }],
      full_count: 1, requested_duration_minutes: 15, date: "2030-01-02", time_zone: "UTC",
      time_min: "2030-01-02T00:00:00Z", time_max: "2030-01-03T00:00:00Z", calendars: [{ id: "primary" }], ...correction,
    })));

    await expect(GoogleCalendarService.availability({ firebaseIdToken: "firebase-owner", date: "2030-01-02", timeZone: "UTC", startTime: "09:00", endTime: "17:00", durationMinutes: 15 })).rejects.toMatchObject({
      reasonCode: "calendar_invalid_response", status: 502,
    });
  });

  it("recovers transient Schedule reads with two bounded delays and preserves Firebase authority", async () => {
    vi.useFakeTimers();
    const signal = new AbortController().signal;
    const response = { events: [], calendars: [{ id: "primary" }], unreadable_calendars: [], date: "2030-01-02", time_zone: "UTC" };
    apiFetch.mockRejectedValueOnce(new TypeError("Network unavailable"));
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ detail: "Google temporarily unavailable" }), { status: 503 }));
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify(response)));
    const result = GoogleCalendarService.today({ firebaseIdToken: "firebase-owner", signal, date: "2030-01-02", timeZone: "UTC" }).then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(0);
    expect(apiFetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(749);
    expect(apiFetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ value: response });
    expect(apiFetch).toHaveBeenCalledTimes(3);
    for (const [url, options] of apiFetch.mock.calls) {
      expect(url).toBe("/api/one/calendar/schedule/today");
      expect(options.signal).toBe(signal);
      expect(options.headers.Authorization).toBe("Bearer firebase-owner");
      expect(options.headers).not.toHaveProperty("X-Hushh-Consent");
      expect(JSON.parse(options.body)).toEqual({ date: "2030-01-02", time_zone: "UTC" });
    }
  });

  it("stops after three unavailable Schedule responses and preserves the final error", async () => {
    vi.useFakeTimers();
    apiFetch.mockImplementation(async () => new Response(JSON.stringify({ detail: "Calendar still unavailable" }), { status: 503 }));
    const result = GoogleCalendarService.today({ firebaseIdToken: "firebase-owner", date: "2030-01-02", timeZone: "UTC" }).then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({ error: { status: 503, message: "Calendar still unavailable" } });
    expect(apiFetch).toHaveBeenCalledTimes(3);
  });

  it("aborts a pending retry delay without issuing another provider read", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ detail: "Temporary provider failure" }), { status: 502 }));
    const result = GoogleCalendarService.today({ firebaseIdToken: "firebase-owner", signal: controller.signal, date: "2030-01-02", timeZone: "UTC" }).then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(0);
    expect(apiFetch).toHaveBeenCalledOnce();
    controller.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({ error: { name: "AbortError" } });
    expect(apiFetch).toHaveBeenCalledOnce();
  });

  it.each([
    { status: 401, reason: "calendar_reauthorization_required" },
    { status: 403, reason: "calendar_list_permission_required" },
  ])("does not retry authentication or permission failure $status", async ({ status, reason }) => {
    vi.useFakeTimers();
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ detail: { message: "Additional access is required", reason_code: reason } }), { status }));
    const result = GoogleCalendarService.today({ firebaseIdToken: "firebase-owner", date: "2030-01-02", timeZone: "UTC" }).then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({ error: { status, reasonCode: reason } });
    expect(apiFetch).toHaveBeenCalledOnce();
  });

  it.each(["review", "confirm"])("never replays an uncertain %s mutation after a transient failure", async kind => {
    vi.useFakeTimers();
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ detail: "Mutation result could not be confirmed" }), { status: 503 }));
    const credentials = { firebaseIdToken: "firebase-owner", vaultOwnerToken: "vault-owner" };
    const operation = kind === "review"
      ? GoogleCalendarService.reviewAttendance({ ...credentials, eventId: "event", offerTimes: false, message: "", date: "2030-01-02", timeZone: "UTC", startTime: "09:00", endTime: "17:00", durationMinutes: 30 })
      : GoogleCalendarService.confirmAttendance({ ...credentials, reviewId: "review-id", reviewToken: "review-token" });
    const result = operation.then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({ error: { status: 503 } });
    expect(apiFetch).toHaveBeenCalledOnce();
  });


  it.each([503, 429])("retries temporary availability failure %s twice within the fixed budget", async status => {
    vi.useFakeTimers();
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ detail: "Temporary provider failure" }), { status }));
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ detail: "Temporary provider failure" }), { status }));
    const response = { windows: [], full_count: 0, requested_duration_minutes: 15, date: "2030-01-02", time_zone: "UTC",
      time_min: "2030-01-02T00:00:00Z", time_max: "2030-01-03T00:00:00Z", calendars: [{ id: "primary" }] };
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify(response)));
    const result = GoogleCalendarService.availability({ firebaseIdToken: "firebase-owner", date: "2030-01-02", timeZone: "UTC", startTime: "09:00", endTime: "17:00", durationMinutes: 15 }).then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(0);
    expect(apiFetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(750);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toEqual({ value: response });
    expect(apiFetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    { status: 502, reason: "calendar_invalid_response" },
    { status: 409, reason: "calendar_unreadable" },
  ])("never retries permanent availability failure $reason", async ({ status, reason }) => {
    vi.useFakeTimers();
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ detail: { message: "Calendar data could not be checked", reason_code: reason } }), { status }));
    const result = GoogleCalendarService.availability({ firebaseIdToken: "firebase-owner", date: "2030-01-02", timeZone: "UTC", startTime: "09:00", endTime: "17:00", durationMinutes: 15 }).then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({ error: { status, reasonCode: reason } });
    expect(apiFetch).toHaveBeenCalledOnce();
  });

  it("does not issue availability transport requests while offline", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await expect(GoogleCalendarService.availability({ firebaseIdToken: "firebase-owner", date: "2030-01-02", timeZone: "UTC", startTime: "09:00", endTime: "17:00", durationMinutes: 15 })).rejects.toMatchObject({ reasonCode: "calendar_offline" });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("stops availability retries when offline rather than waiting indefinitely for reconnect", async () => {
    vi.useFakeTimers();
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ detail: "Temporary provider failure" }), { status: 503 }));
    const result = GoogleCalendarService.availability({ firebaseIdToken: "firebase-owner", date: "2030-01-02", timeZone: "UTC", startTime: "09:00", endTime: "17:00", durationMinutes: 15 }).then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(0);
    expect(apiFetch).toHaveBeenCalledOnce();
    online.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({ error: { reasonCode: "calendar_offline" } });
    expect(apiFetch).toHaveBeenCalledOnce();
  });

  it("keeps Today's existing transient retry behavior outside the Free time failure policy", async () => {
    vi.useFakeTimers();
    apiFetch.mockImplementation(async () => new Response(JSON.stringify({ detail: { message: "Temporary daily-event failure", reason_code: "calendar_invalid_response" } }), { status: 503 }));
    const result = GoogleCalendarService.today({ firebaseIdToken: "firebase-owner", date: "2030-01-02", timeZone: "UTC" }).then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({ error: { status: 503, reasonCode: "calendar_invalid_response" } });
    expect(apiFetch).toHaveBeenCalledTimes(3);
  });

});

it("meeting context uses Firebase plus separate vault authority and no-store", async () => {
  const { CalendarInsightsService } = await import("@/lib/services/calendar-insights-service");
  const { ApiService } = await import("@/lib/services/api-service");
  const read = vi.spyOn(ApiService, "apiFetch").mockResolvedValue(Response.json({ sources: [] }));
  await CalendarInsightsService.read("meetings/context", { calendar_id: "primary", event_id: "provider-event", expected_account_email: "owner@example.test" }, "identity", undefined, "owner-capability");
  expect(read).toHaveBeenCalledWith("/api/one/calendar/meetings/context", expect.objectContaining({ cache: "no-store", headers: { Authorization: "Bearer identity", "X-Hushh-Consent": "Bearer owner-capability", "Content-Type": "application/json" } }));
});


it("rejects an unverified attendance outcome without claiming email success", async () => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue(new Response(JSON.stringify({ calendar: "declined" }), { status: 200 }));
  await expect(GoogleCalendarService.confirmAttendance({ firebaseIdToken: "firebase", vaultOwnerToken: "owner", reviewId: "review", reviewToken: "review-token" })).rejects.toMatchObject({ reasonCode: "calendar_invalid_response" });
  expect(apiFetch).toHaveBeenCalledOnce();
});
