// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  normalizeWebOrigin,
  resolveShareableAppOrigin,
} from "@/lib/share/app-origin";

const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

/**
 * jsdom's `window.location.origin` is read-only, so each case installs its own
 * location object. Restored afterwards -- a leaked origin would silently
 * decide the outcome of whatever test ran next.
 */
function setWindowOrigin(origin: string | undefined): void {
  if (origin === undefined) {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: undefined,
    });
    return;
  }
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { origin },
  });
}

const realLocation = window.location;

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_APP_URL;
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: realLocation,
  });
  if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL;
});

describe("normalizeWebOrigin", () => {
  it("keeps a real https origin and drops a trailing slash", () => {
    expect(normalizeWebOrigin("https://one.hushh.ai/")).toBe(
      "https://one.hushh.ai",
    );
  });

  it("rejects the iOS Capacitor scheme", () => {
    // `ios.scheme` in capacitor.config.ts. Not http(s), so it never reaches
    // the host check.
    expect(normalizeWebOrigin("App://localhost")).toBeNull();
  });

  it("rejects the Android Capacitor origin, which passes the scheme check", () => {
    // This is the one that shipped a dead link: it IS https, and it resolves
    // to the recipient's own device.
    expect(normalizeWebOrigin("https://localhost")).toBeNull();
  });

  it("rejects loopback by address as well as by name", () => {
    expect(normalizeWebOrigin("http://127.0.0.1:3000")).toBeNull();
    expect(normalizeWebOrigin("http://[::1]:3000")).toBeNull();
  });

  it("rejects empty, malformed, and non-string input", () => {
    expect(normalizeWebOrigin("")).toBeNull();
    expect(normalizeWebOrigin("   ")).toBeNull();
    expect(normalizeWebOrigin(null)).toBeNull();
    expect(normalizeWebOrigin(undefined)).toBeNull();
    expect(normalizeWebOrigin("one.hushh.ai")).toBeNull();
    expect(normalizeWebOrigin("https://")).toBeNull();
  });
});

describe("resolveShareableAppOrigin", () => {
  it("prefers the live origin, so a link shared from UAT points at UAT", () => {
    setWindowOrigin("https://uat.one.hushh.ai");
    process.env.NEXT_PUBLIC_APP_URL = "https://one.hushh.ai";
    expect(resolveShareableAppOrigin()).toBe("https://uat.one.hushh.ai");
  });

  it("falls back to the build origin inside the Android shell", () => {
    setWindowOrigin("https://localhost");
    process.env.NEXT_PUBLIC_APP_URL = "https://one.hushh.ai";
    expect(resolveShareableAppOrigin()).toBe("https://one.hushh.ai");
  });

  it("falls back to the build origin inside the iOS shell", () => {
    setWindowOrigin("App://localhost");
    process.env.NEXT_PUBLIC_APP_URL = "https://one.hushh.ai";
    expect(resolveShareableAppOrigin()).toBe("https://one.hushh.ai");
  });

  it("returns null when neither is usable, rather than a broken origin", () => {
    setWindowOrigin("https://localhost");
    expect(resolveShareableAppOrigin()).toBeNull();
  });

  it("returns null on a dev server, where the origin is loopback", () => {
    setWindowOrigin("http://localhost:3000");
    expect(resolveShareableAppOrigin()).toBeNull();
  });

  it("survives a window with no location object", () => {
    setWindowOrigin(undefined);
    process.env.NEXT_PUBLIC_APP_URL = "https://one.hushh.ai";
    expect(resolveShareableAppOrigin()).toBe("https://one.hushh.ai");
  });
});
