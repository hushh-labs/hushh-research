import { describe, expect, it, vi } from "vitest";

import {
  clearGoogleOAuthAttempt,
  openGoogleOAuthPopup,
  persistGoogleOAuthSameWindowAttempt,
  readGoogleOAuthPopupAttempt,
  isGoogleOAuthPopupSettlement,
} from "@/lib/google/google-oauth-popup";

describe("openGoogleOAuthPopup", () => {
  it("recognizes a fresh Calendar attempt without credentials in metadata", () => {
    const attempt = {
      version: 1,
      attemptId: "synthetic-calendar-attempt",
      service: "calendar",
      startedAt: Date.now(),
    };
    window.sessionStorage.setItem(
      "one_google_oauth_popup_attempt_v1",
      JSON.stringify(attempt),
    );
    expect(readGoogleOAuthPopupAttempt()).toEqual(attempt);
    window.sessionStorage.removeItem("one_google_oauth_popup_attempt_v1");
  });

  it("persists and identifies the same-window Calendar fallback", () => {
    const attempt = {
      version: 1 as const, attemptId: "synthetic-same-window-attempt",
      service: "calendar" as const, startedAt: Date.now(),
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
});
