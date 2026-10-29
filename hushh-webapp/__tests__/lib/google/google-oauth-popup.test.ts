import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearGoogleOAuthAttempt,
  consumeStoredGoogleOAuthPopupSettlement,
  openGoogleOAuthPopup,
  persistGoogleOAuthSameWindowAttempt,
  readGoogleOAuthPopupAttempt,
  isGoogleOAuthPopupSettlement,
  settleGoogleOAuthPopup,
  hasCalendarMeetingFileGrant,
} from "@/lib/google/google-oauth-popup";

describe("openGoogleOAuthPopup", () => {
  afterEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("settles the retained window after Google discards the popup opener and session", () => {
    const attempt = {
      version: 1 as const, attemptId: "synthetic-calendar-coop-attempt",
      service: "calendar" as const, startedAt: Date.now(), ownerId: "synthetic-owner",
    };
    const popup = {
      sessionStorage: window.sessionStorage,
      document: { title: "" }, focus: vi.fn(), close: vi.fn(),
    } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    vi.spyOn(window, "close").mockImplementation(() => undefined);
    expect(openGoogleOAuthPopup(attempt)).toBe(popup);
    window.sessionStorage.clear();
    expect(readGoogleOAuthPopupAttempt()).toEqual(attempt);
    settleGoogleOAuthPopup(attempt, "succeeded");
    expect(consumeStoredGoogleOAuthPopupSettlement(attempt.attemptId)?.outcome).toBe("succeeded");
    expect(readGoogleOAuthPopupAttempt()).toBeNull();
  });

  it("does not clear a newer popup attempt when an earlier callback settles", () => {
    const prior = {
      version: 1 as const, attemptId: "synthetic-prior-attempt", service: "calendar" as const,
      startedAt: Date.now(), ownerId: "synthetic-owner",
    };
    const newer = { ...prior, attemptId: "synthetic-newer-attempt" };
    window.localStorage.setItem("one_google_oauth_popup_attempt_fallback_v1", JSON.stringify(newer));
    clearGoogleOAuthAttempt(prior.attemptId);
    expect(readGoogleOAuthPopupAttempt()).toEqual(newer);
    window.sessionStorage.setItem("one_google_oauth_popup_attempt_v1", "malformed");
    clearGoogleOAuthAttempt(newer.attemptId);
    expect(window.localStorage.getItem("one_google_oauth_popup_attempt_fallback_v1")).toBeNull();
  });
  it("recognizes a fresh Calendar attempt without credentials in metadata", () => {
    const attempt = {
      version: 1,
      attemptId: "synthetic-calendar-attempt",
      service: "calendar",
      startedAt: Date.now(),
      ownerId: "synthetic-owner",
    };
    window.sessionStorage.setItem(
      "one_google_oauth_popup_attempt_v1",
      JSON.stringify(attempt),
    );
    expect(readGoogleOAuthPopupAttempt()).toEqual(attempt);
    window.sessionStorage.removeItem("one_google_oauth_popup_attempt_v1");
  });

  it("accepts optional meeting scopes on first connection without inventing a selected account", () => {
    const attempt = { version: 1, attemptId: "synthetic-first-meeting-attempt",
      service: "calendar", startedAt: Date.now(), ownerId: "synthetic-owner",
      meetingFiles: true };
    window.sessionStorage.setItem("one_google_oauth_popup_attempt_v1", JSON.stringify(attempt));
    expect(readGoogleOAuthPopupAttempt()).toEqual(attempt);
    window.sessionStorage.setItem("one_google_oauth_popup_attempt_v1", JSON.stringify({
      ...attempt, targetAccountId: "default",
    }));
    expect(readGoogleOAuthPopupAttempt()).toBeNull();
  });

  it("persists and identifies the same-window Calendar fallback", () => {
    const attempt = {
      version: 1 as const, attemptId: "synthetic-same-window-attempt",
      service: "calendar" as const, startedAt: Date.now(),
      ownerId: "synthetic-owner",
    };
    expect(persistGoogleOAuthSameWindowAttempt(attempt)).toBe(true);
    expect(readGoogleOAuthPopupAttempt()).toEqual({ ...attempt, returnMode: "same_window" });
    clearGoogleOAuthAttempt();
    expect(readGoogleOAuthPopupAttempt()).toBeNull();
  });

  it("accepts Calendar settlements and rejects retired Drive settlements", () => {
    const settlement = {
      schemaVersion: 1,
      type: "google_oauth_settlement",
      attemptId: "synthetic-calendar-attempt",
      service: "calendar",
      outcome: "succeeded",
    };
    expect(isGoogleOAuthPopupSettlement(settlement)).toBe(true);
    expect(
      isGoogleOAuthPopupSettlement({ ...settlement, service: "drive" }),
    ).toBe(false);
  });
  it("persists and consumes one callback-owned terminal marker", () => {
    const attempt = {
      version: 1 as const,
      attemptId: "synthetic-calendar-attempt",
      service: "calendar" as const,
      startedAt: Date.now(),
    };
    vi.spyOn(window, "close").mockImplementation(() => undefined);

    settleGoogleOAuthPopup(attempt, "succeeded");

    expect(consumeStoredGoogleOAuthPopupSettlement(attempt.attemptId)).toMatchObject({
      attemptId: attempt.attemptId,
      outcome: "succeeded",
    });
    expect(consumeStoredGoogleOAuthPopupSettlement(attempt.attemptId)).toBeNull();
  });
  it("falls back when a popup cannot persist its settlement attempt", () => {
    const close = vi.fn();
    const popup = {
      close,
      sessionStorage: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
      },
    } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);

    const result = openGoogleOAuthPopup({
      version: 1,
      attemptId: "calendar-popup-attempt",
      service: "calendar",
      startedAt: Date.now(),
    });

    expect(result).toBeNull();
    expect(close).toHaveBeenCalledOnce();
  });

  it("requires both exact meeting scopes, selected subject and a fresh grant after OAuth", () => {
    const base = { configured: true, connected: true, status: "connected" as const, scope_csv: "",
      accounts: [{ account_id: "calendar-2", google_email: "selected@example.test", connected: true,
        status: "connected" as const, access_level: "read" as const, calendar_list_access: true,
        provider_subject_sha256: "a".repeat(64), grant_generation: "old",
        scope_csv: "https://www.googleapis.com/auth/meetings.space.readonly https://www.googleapis.com/auth/drive.meet.readonly" }] };
    expect(hasCalendarMeetingFileGrant(base, "calendar-2", "a".repeat(64))).toBe(true);
    expect(hasCalendarMeetingFileGrant(base, "default", "a".repeat(64))).toBe(false);
    expect(hasCalendarMeetingFileGrant(base, "calendar-2", "b".repeat(64))).toBe(false);
    expect(hasCalendarMeetingFileGrant(base, "calendar-2", "a".repeat(64), "old")).toBe(false);
    expect(hasCalendarMeetingFileGrant({ ...base, accounts: [{ ...base.accounts[0], grant_generation: "new" }] }, "calendar-2", "a".repeat(64), "old")).toBe(true);
    expect(hasCalendarMeetingFileGrant({ ...base, accounts: [{ ...base.accounts[0], scope_csv: "https://www.googleapis.com/auth/drive.meet.readonly" }] }, "calendar-2", "a".repeat(64))).toBe(false);
  });
});
