import { afterEach, describe, expect, it, vi } from "vitest";

describe("clearSessionStorage", () => {
  afterEach(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.resetModules();
  });

  it("removes only native-prefixed session keys on clear", async () => {
    (window as unknown as { Capacitor?: { isNativePlatform: () => boolean } }).Capacitor = {
      isNativePlatform: () => true,
    };
    window.localStorage.setItem("_session_native-route", "clear-me");
    window.localStorage.setItem("native-route", "keep-raw-fallback");
    window.localStorage.setItem("profile-cache", "keep-local");

    const { clearSessionStorage } = await import("@/lib/utils/session-storage");

    clearSessionStorage();

    expect(window.localStorage.getItem("_session_native-route")).toBeNull();
    expect(window.localStorage.getItem("native-route")).toBe("keep-raw-fallback");
    expect(window.localStorage.getItem("profile-cache")).toBe("keep-local");
  });
});
