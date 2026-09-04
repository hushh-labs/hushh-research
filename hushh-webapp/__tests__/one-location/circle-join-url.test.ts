// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCircleJoinUrl,
  CIRCLE_JOIN_CODE_PARAM,
  formatCircleCodeForDisplay,
  resolveCircleJoinOrigin,
} from "@/lib/one-location/circle-join-url";

/** Repoint the jsdom origin the way each runtime would report it. */
function setWindowOrigin(origin: string | undefined): void {
  if (origin === undefined) {
    // @ts-expect-error -- exercising the server/no-window branch.
    delete globalThis.window;
    return;
  }
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { origin },
  });
}

describe("buildCircleJoinUrl", () => {
  it("builds a clickable join link carrying the code query param", () => {
    expect(
      buildCircleJoinUrl("https://uat.one.hushh.ai", "96RE-HUNF-KMVX"),
    ).toBe("https://uat.one.hushh.ai/circle/join?code=96RE-HUNF-KMVX");
  });

  it("strips a trailing slash from the origin", () => {
    expect(buildCircleJoinUrl("https://uat.one.hushh.ai/", "ABCD")).toBe(
      "https://uat.one.hushh.ai/circle/join?code=ABCD",
    );
  });

  it("URL-encodes the code", () => {
    expect(buildCircleJoinUrl("https://x.test", "A B&C")).toBe(
      "https://x.test/circle/join?code=A%20B%26C",
    );
  });

  it("omits the query when no code is given", () => {
    expect(buildCircleJoinUrl("https://x.test", "")).toBe(
      "https://x.test/circle/join",
    );
  });

  it("exposes the canonical code param name", () => {
    expect(CIRCLE_JOIN_CODE_PARAM).toBe("code");
  });
});

describe("resolveCircleJoinOrigin", () => {
  const realLocation = window.location;

  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: realLocation,
    });
  });

  it("keeps the live origin on the web so a UAT invite stays on UAT", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://one.hushh.ai");
    setWindowOrigin("https://uat.one.hushh.ai");

    expect(resolveCircleJoinOrigin()).toBe("https://uat.one.hushh.ai");
  });

  it("falls back to the built-in origin on iOS, where the app runs on App://", () => {
    // capacitor.config.ts pins ios.scheme = "App". Sharing this origin sent
    // recipients `App://localhost/circle/join?code=...`, which opens nothing.
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://uat.one.hushh.ai");
    setWindowOrigin("App://localhost");

    expect(resolveCircleJoinOrigin()).toBe("https://uat.one.hushh.ai");
  });

  it("falls back on Android too, where the origin is https but loopback", () => {
    // androidScheme: "https" makes this pass an http(s) check while still
    // resolving to the recipient's own device.
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://uat.one.hushh.ai");
    setWindowOrigin("https://localhost");

    expect(resolveCircleJoinOrigin()).toBe("https://uat.one.hushh.ai");
  });

  it("does not hand out a loopback link from local web dev either", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://uat.one.hushh.ai");
    setWindowOrigin("http://127.0.0.1:3000");

    expect(resolveCircleJoinOrigin()).toBe("https://uat.one.hushh.ai");
  });

  it("returns null rather than a broken link when nothing is shareable", () => {
    // Callers then send the code on its own, which is still joinable.
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    setWindowOrigin("App://localhost");

    expect(resolveCircleJoinOrigin()).toBeNull();
  });

  it("trims a trailing slash off the configured origin", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://one.hushh.ai/");
    setWindowOrigin("App://localhost");

    expect(resolveCircleJoinOrigin()).toBe("https://one.hushh.ai");
  });

  it("produces a link a recipient can actually open from an iOS share", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://uat.one.hushh.ai");
    setWindowOrigin("App://localhost");

    const origin = resolveCircleJoinOrigin();
    expect(origin).not.toBeNull();
    expect(buildCircleJoinUrl(origin!, "SWDX-ENDP-B954")).toBe(
      "https://uat.one.hushh.ai/circle/join?code=SWDX-ENDP-B954",
    );
  });
});

describe("formatCircleCodeForDisplay", () => {
  it("groups a code the way the sender sees it on their own screen", () => {
    expect(formatCircleCodeForDisplay("96REHUNFKMVX")).toBe("96RE-HUNF-KMVX");
  });

  it("normalises whatever survived the trip through a message", () => {
    // Links get lowercased, wrapped, and re-spaced by messaging apps; the code
    // on the landing page must still match the one being read aloud.
    expect(formatCircleCodeForDisplay(" 96re hunf-kmvx ")).toBe(
      "96RE-HUNF-KMVX",
    );
  });

  it("does not leave a trailing separator on an exact multiple of four", () => {
    expect(formatCircleCodeForDisplay("ABCD")).toBe("ABCD");
    expect(formatCircleCodeForDisplay("")).toBe("");
  });
});
