import { describe, expect, it, vi } from "vitest";

import {
  openGoogleOAuthPopup,
  readGoogleOAuthPopupAttempt,
  isGoogleOAuthPopupSettlement,
} from "@/lib/google/google-oauth-popup";

describe("openGoogleOAuthPopup", () => {
  it("recognizes a fresh Drive attempt without credentials in metadata", () => {
    const attempt = {
      version: 1,
      attemptId: "synthetic-drive-attempt",
      service: "drive",
      startedAt: Date.now(),
    };
    window.sessionStorage.setItem(
      "one_google_oauth_popup_attempt_v1",
      JSON.stringify(attempt),
    );
    expect(readGoogleOAuthPopupAttempt()).toEqual(attempt);
    window.sessionStorage.removeItem("one_google_oauth_popup_attempt_v1");
  });

  it("accepts Drive settlements and rejects unrecognized services", () => {
    const settlement = {
      schemaVersion: 1,
      type: "google_oauth_settlement",
      attemptId: "synthetic-drive-attempt",
      service: "drive",
      outcome: "succeeded",
    };
    expect(isGoogleOAuthPopupSettlement(settlement)).toBe(true);
    expect(
      isGoogleOAuthPopupSettlement({ ...settlement, service: "other" }),
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
