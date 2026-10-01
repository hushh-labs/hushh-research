import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasDrivePopupMarker,
  isDrivePopupSettlement,
  navigateDriveOAuthPopup,
  notifyDrivePopup,
  readDrivePopupAttempt,
  waitForOAuthPopup,
  waitForDrivePopup,
} from "@/lib/profile/drive-oauth-popup";

describe("Drive popup boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    if (typeof window.localStorage?.setItem !== "function") {
      const store = new Map<string, string>();
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: {
          get length() {
            return store.size;
          },
          clear: () => store.clear(),
          getItem: (key: string) => store.get(key) ?? null,
          key: (index: number) => Array.from(store.keys())[index] ?? null,
          removeItem: (key: string) => {
            store.delete(key);
          },
          setItem: (key: string, value: string) => {
            store.set(key, value);
          },
        },
      });
    }
    try {
      sessionStorage?.clear?.();
    } catch {
      // The test only models Drive's localStorage persistence boundary.
    }
    try {
      window.localStorage?.clear?.();
    } catch {
      // The local fallback above keeps this deterministic in Node test hosts.
    }
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
  it("keeps an opaque attempt in same-origin storage when desktop COOP clears popup session storage", () => {
    const target = popup();
    const currentAttempt = attempt();
    navigateDriveOAuthPopup(
      target,
      currentAttempt,
      "https://accounts.google.com/o/oauth2/v2/auth?state=signed-state",
    );
    expect(target.location.replace).toHaveBeenCalledOnce();
    // Google COOP can create a new popup browsing-context group, losing this
    // storage while the opener's same-origin localStorage remains intact.
    sessionStorage.clear();
    expect(hasDrivePopupMarker()).toBe(true);
    expect(readDrivePopupAttempt()).toEqual(currentAttempt);
    expect(window.localStorage.getItem("one_drive_popup_attempt_v1")).not.toContain(
      "signed-state",
    );
    expect(() =>
      navigateDriveOAuthPopup(target, attempt(), "https://attacker.invalid"),
    ).toThrow();
  });
  it("keeps the redacted settlement available for the opener's storage event", async () => {
    const currentAttempt = attempt();
    navigateDriveOAuthPopup(
      popup(),
      currentAttempt,
      "https://accounts.google.com/o/oauth2/v2/auth?state=signed-state",
    );
    notifyDrivePopup(currentAttempt, "succeeded");
    expect(window.localStorage.getItem("one_drive_popup_attempt_v1")).toBeNull();
    expect(window.localStorage.getItem("one_drive_popup_settlement_v1")).toContain(
      '"outcome":"succeeded"',
    );
    await vi.advanceTimersByTimeAsync(3_000);
    expect(window.localStorage.getItem("one_drive_popup_settlement_v1")).toBeNull();
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
  it("accepts the storage fallback when a desktop browser omits storageArea", async () => {
    const target = popup();
    const controller = new AbortController();
    const done = vi.fn();
    const currentAttempt = attempt();
    const result = waitForDrivePopup(
      target,
      currentAttempt,
      controller.signal,
    ).then(done);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "one_drive_popup_settlement_v1",
        newValue: JSON.stringify({
          ...currentAttempt,
          type: "drive_oauth_settlement",
          outcome: "succeeded",
        }),
      }),
    );
    await result;
    expect(done).toHaveBeenCalledOnce();
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
  it("does not inspect a cross-origin popup's closed property", async () => {
    const target = popup();
    Object.defineProperty(target, "closed", { get: () => { throw new Error("COOP blocked"); } });
    const cancel = new AbortController();
    const result = waitForDrivePopup(target, attempt(), new AbortController().signal, cancel.signal);
    cancel.abort();
    await expect(result).resolves.toBeUndefined();
  });
  it("reports bounded expiry", async () => {
    const target = popup();
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
