import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForGoogleOAuthPopup } from "@/lib/google/google-oauth-popup-wait";

describe("owner-bound Google popup wait", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  function setup() {
    const popup = { closed: false, close: vi.fn() } as unknown as Window;
    const failed = vi.fn();
    const attempt = {
      version: 1 as const,
      attemptId: "synthetic-attempt",
      service: "drive" as const,
      startedAt: Date.now(),
    };
    const wait = waitForGoogleOAuthPopup(popup, attempt, () => true, failed);
    const data = {
      schemaVersion: 1,
      type: "google_oauth_settlement",
      attemptId: attempt.attemptId,
      service: "drive",
      outcome: "succeeded",
    };
    const message = (
      overrides = {},
      source: Window | null = popup,
      origin = window.location.origin,
    ) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { ...data, ...overrides },
          source,
          origin,
        }),
      );
    return { popup, wait, failed, message, data };
  }
  it("requires exact source, origin, service and attempt; resolves once", async () => {
    const { popup, wait, failed, message } = setup();
    message({}, null);
    message({}, popup, "https://example.invalid");
    message({ service: "calendar" });
    message({ attemptId: "other-attempt" });
    expect(popup.close).not.toHaveBeenCalled();
    message();
    message();
    await expect(wait.promise).resolves.toBeUndefined();
    expect(popup.close).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
  });
  it("revokes pending initiation when closure is observed, without inferring success", async () => {
    const { popup, wait, failed } = setup();
    Object.assign(popup, { closed: true });
    vi.advanceTimersByTime(500);
    expect(failed).toHaveBeenCalledOnce();
    await expect(wait.promise).rejects.toThrow("not confirmed");
    wait.cancel();
    expect(failed).toHaveBeenCalledOnce();
  });
  it("times out and removes listeners even if window close throws", async () => {
    const { popup, wait, message, failed } = setup();
    vi.mocked(popup.close).mockImplementation(() => {
      throw new Error("detached");
    });
    vi.advanceTimersByTime(5 * 60_000);
    await expect(wait.promise).rejects.toThrow("not confirmed");
    message();
    expect(failed).toHaveBeenCalledOnce();
    expect(popup.close).toHaveBeenCalledOnce();
  });
  it("uses matching transient storage settlement, not provider error text", async () => {
    const { wait, data } = setup();
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "one_google_oauth_popup_settlement_v1",
        newValue: JSON.stringify({
          ...data,
          outcome: "failed",
          message: "PRIVATE PROVIDER BODY",
        }),
      }),
    );
    await expect(wait.promise).rejects.toThrow("could not be confirmed");
  });
});
