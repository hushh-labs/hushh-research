import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch } }));

import { GoogleCalendarError, GoogleCalendarService } from "@/lib/services/google-calendar-service";

describe("connected Calendar transport authority", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } }));
  });

  it.each(["review", "confirm"])("sends matching Firebase/vault authority and the current-lifetime guard for %s", async kind => {
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
    await GoogleCalendarService.today({ firebaseIdToken: "firebase-owner", isEffectCurrent: current, date: "2030-01-02", timeZone: "America/New_York" });

    const [url, options] = apiFetch.mock.calls[0];
    expect(url).toBe("/api/one/calendar/schedule/today");
    expect(options.headers.Authorization).toBe("Bearer firebase-owner");
    expect(options.headers).not.toHaveProperty("X-Hushh-Consent");
    expect(JSON.parse(options.body)).toEqual({ date: "2030-01-02", time_zone: "America/New_York" });
    expect(options.isEffectCurrent).toBe(current);
    expect(options.cache).toBe("no-store");
  });

  it("retains maximal free ranges and their full count separately from the requested meeting duration", async () => {
    const response = {
      windows: [{ start_at: "2030-01-02T09:00:00Z", end_at: "2030-01-02T09:45:00Z", duration_minutes: 45 }],
      full_count: 5, requested_duration_minutes: 15, date: "2030-01-02", time_zone: "UTC",
      time_min: "2030-01-02T09:00:00Z", time_max: "2030-01-02T17:00:00Z", calendars: [{ id: "primary", name: "Personal" }],
    };
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify(response)));
    const current = vi.fn(() => true);
    const result = await GoogleCalendarService.availability({ firebaseIdToken: "firebase-owner", isEffectCurrent: current, date: "2030-01-02", timeZone: "UTC", startTime: "09:00", endTime: "17:00", durationMinutes: 15 });

    expect(result).toEqual(response);
    const [url, options] = apiFetch.mock.calls[0];
    expect(url).toBe("/api/one/calendar/schedule/availability");
    expect(options.headers.Authorization).toBe("Bearer firebase-owner");
    expect(options.headers).not.toHaveProperty("X-Hushh-Consent");
    expect(JSON.parse(options.body)).toEqual({ date: "2030-01-02", time_zone: "UTC", start_time: "09:00", end_time: "17:00", duration_minutes: 15 });
    expect(options.isEffectCurrent).toBe(current);
    expect(options.cache).toBe("no-store");
  });

  it.each([
    { full_count: 0 },
    { requested_duration_minutes: 30 },
    { windows: [{ start_at: "2030-01-02T09:00:00Z", end_at: "2030-01-02T09:30:00Z", duration_minutes: 45 }] },
  ])("rejects misleading free-window responses %j", async correction => {
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      windows: [{ start_at: "2030-01-02T09:00:00Z", end_at: "2030-01-02T09:45:00Z", duration_minutes: 45 }],
      full_count: 1, requested_duration_minutes: 15, date: "2030-01-02", time_zone: "UTC",
      time_min: "2030-01-02T09:00:00Z", time_max: "2030-01-02T17:00:00Z", calendars: [{ id: "primary" }], ...correction,
    })));

    await expect(GoogleCalendarService.availability({ firebaseIdToken: "firebase-owner", date: "2030-01-02", timeZone: "UTC", startTime: "09:00", endTime: "17:00", durationMinutes: 15 })).rejects.toMatchObject({
      reasonCode: "calendar_invalid_response", status: 502,
    });
  });
});
