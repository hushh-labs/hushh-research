import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isDrivePopupSettlement,
  navigateDriveOAuthPopup,
  readDrivePopupAttempt,
  waitForOAuthPopup,
  waitForDrivePopup,
} from "@/lib/profile/drive-oauth-popup";

describe("Drive popup boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const attempt = () => ({
    connectorId: "google_drive" as const,
    attemptId: "synthetic-attempt-id",
    expiresAt: Date.now() + 60_000,
  });
  const popup = () =>
    ({
      closed: false,
      close: vi.fn(),
      sessionStorage,
      location: { replace: vi.fn() },
    }) as unknown as Window;
  const settlement = () => ({
    ...attempt(),
    type: "drive_oauth_settlement",
    outcome: "succeeded",
  });
  it("accepts only bounded redacted terminal messages", () => {
    expect(isDrivePopupSettlement(settlement())).toBe(true);
    for (const patch of [
      { connectorId: "mail" },
      { expiresAt: 0 },
      { expiresAt: Date.now() + 660_000 },
      { accessToken: "secret" },
      { outcome: "pending" },
    ])
      expect(isDrivePopupSettlement({ ...settlement(), ...patch })).toBe(false);
  });
  it("only navigates retained popup to fixed Google auth and persists no credentials", () => {
    const target = popup();
    navigateDriveOAuthPopup(
      target,
      attempt(),
      "https://accounts.google.com/o/oauth2/v2/auth?state=signed-state",
    );
    expect(target.location.replace).toHaveBeenCalledOnce();
    expect(readDrivePopupAttempt()).toEqual(attempt());
    expect(sessionStorage.getItem("one_drive_popup_attempt_v1")).not.toContain(
      "signed-state",
    );
    expect(localStorage.length).toBe(0);
    expect(() =>
      navigateDriveOAuthPopup(target, attempt(), "https://attacker.invalid"),
    ).toThrow();
  });
  it("requires exact origin, window, connector and attempt; settles once", async () => {
    const target = popup();
    const controller = new AbortController();
    const done = vi.fn();
    const result = waitForDrivePopup(target, attempt(), controller.signal).then(
      done,
    );
    const send = (
      data: unknown,
      origin = window.location.origin,
      source: Window = target,
    ) =>
      window.dispatchEvent(
        new MessageEvent("message", { data, origin, source }),
      );
    send(settlement(), "https://attacker.invalid");
    send(settlement(), window.location.origin, window);
    send({ ...settlement(), attemptId: "other-valid-attempt" });
    send({ ...settlement(), connectorId: "mail" });
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    send(settlement());
    send(settlement());
    await result;
    expect(done).toHaveBeenCalledOnce();
    expect(target.close).toHaveBeenCalledOnce();
  });
  it.each(["abort", "cancel", "expire"])(
    "reconciles %s without claiming provider success",
    async (kind) => {
      const target = popup();
      const controller = new AbortController();
      const cancel = new AbortController();
      const result = waitForDrivePopup(target, attempt(), controller.signal, cancel.signal);
      if (kind === "abort") controller.abort();
      else if (kind === "cancel") cancel.abort();
      else await vi.advanceTimersByTimeAsync(60_000);
      expect(await result).toBeUndefined();
      expect(target.close).toHaveBeenCalledOnce();
    },
  );
  it("reports bounded expiry without reading popup closure", async () => {
    const target = popup();
    Object.defineProperty(target, "closed", { get: () => { throw new Error("COOP blocked"); } });
    const onFinish = vi.fn();
    const currentAttempt = attempt();
    const result = waitForOAuthPopup({
      popup: target,
      expiresAt: currentAttempt.expiresAt,
      signal: new AbortController().signal,
      matches: () => false,
      storageValue: () => null,
      onFinish,
    });
    await vi.advanceTimersByTimeAsync(60_000);

    await result;
    expect(onFinish).toHaveBeenCalledExactlyOnceWith("expired");
  });
  it("does not inspect a cross-origin popup's closed property", async () => {
    const target = popup();
    Object.defineProperty(target, "closed", { get: () => { throw new Error("COOP blocked"); } });
    const cancel = new AbortController();
    const result = waitForDrivePopup(target, attempt(), new AbortController().signal, cancel.signal);
    cancel.abort();
    await expect(result).resolves.toBeUndefined();
  });
  it("rejects malformed expiry without an unbounded watcher", async () => {
    const target = popup();
    await expect(
      waitForDrivePopup(
        target,
        { ...attempt(), expiresAt: NaN },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(target.close).toHaveBeenCalledOnce();
  });
});
