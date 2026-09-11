import { describe, expect, it, vi } from "vitest";

import { openGoogleOAuthPopup } from "@/lib/google/google-oauth-popup";

describe("openGoogleOAuthPopup", () => {
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
