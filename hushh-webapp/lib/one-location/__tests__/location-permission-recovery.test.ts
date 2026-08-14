// The instructions someone sees when their browser is blocking location and no
// website is allowed to ask again.
//
// The property that matters most is not which browser we detect — it is that
// we NEVER hand someone a dead end. Every branch must name who is blocking and
// say where the switch is, because "allow location permission" alone is what
// stranded people who did not already know browsers keep that switch behind an
// address-bar icon.

import { describe, expect, it } from "vitest";

import {
  detectLocationRecoveryTarget,
  locationRecoveryGuide,
  resolveLocationRecoveryGuide,
  shouldShowLocationRecovery,
  type LocationRecoveryTarget,
} from "@/lib/one-location/location-permission-recovery";

const UA = {
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  chromeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  chromeIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/151.0.0.0 Mobile/15E148 Safari/604.1",
  firefox:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:126.0) Gecko/20100101 Firefox/126.0",
};

describe("which instructions apply", () => {
  it("recognises desktop Chrome — the browser in the reported failure", () => {
    expect(detectLocationRecoveryTarget({ userAgent: UA.chromeMac })).toBe(
      "chromium-desktop",
    );
    expect(detectLocationRecoveryTarget({ userAgent: UA.chromeWindows })).toBe(
      "chromium-desktop",
    );
  });

  it("treats Edge as Chrome", () => {
    // It announces both. They share the address-bar control this advice points
    // at, so splitting them would only create a branch that can rot.
    expect(detectLocationRecoveryTarget({ userAgent: UA.edge })).toBe(
      "chromium-desktop",
    );
  });

  it("separates Chrome on Android from Chrome on a computer", () => {
    expect(detectLocationRecoveryTarget({ userAgent: UA.chromeAndroid })).toBe(
      "chromium-android",
    );
  });

  it("sends every iPhone browser to Safari's settings", () => {
    // Chrome and Firefox on iOS are Safari's engine and share Safari's
    // per-site permission. Naming Chrome there would send someone hunting for
    // a setting that does not exist on that device.
    expect(detectLocationRecoveryTarget({ userAgent: UA.safariIphone })).toBe(
      "safari-ios",
    );
    expect(detectLocationRecoveryTarget({ userAgent: UA.chromeIphone })).toBe(
      "safari-ios",
    );
  });

  it("recognises Safari and Firefox on a computer", () => {
    expect(detectLocationRecoveryTarget({ userAgent: UA.safariMac })).toBe(
      "safari-desktop",
    );
    expect(detectLocationRecoveryTarget({ userAgent: UA.firefox })).toBe(
      "firefox",
    );
  });

  it("puts the native app ahead of its user agent", () => {
    // The Capacitor WebView reports Safari/Chrome. Sniffing the agent alone
    // would send an app user into browser settings they do not have.
    expect(
      detectLocationRecoveryTarget({
        userAgent: UA.safariIphone,
        isNativeApp: true,
        nativePlatform: "ios",
      }),
    ).toBe("ios-app");
    expect(
      detectLocationRecoveryTarget({
        userAgent: UA.chromeAndroid,
        isNativeApp: true,
        nativePlatform: "android",
      }),
    ).toBe("android-app");
  });

  it("falls back to advice that is true everywhere", () => {
    expect(detectLocationRecoveryTarget({ userAgent: "" })).toBe("browser");
    expect(detectLocationRecoveryTarget({})).toBe("browser");
    expect(detectLocationRecoveryTarget({ userAgent: "Lynx/2.9" })).toBe(
      "browser",
    );
  });
});

const ALL_TARGETS: LocationRecoveryTarget[] = [
  "chromium-desktop",
  "chromium-android",
  "safari-desktop",
  "safari-ios",
  "firefox",
  "ios-app",
  "android-app",
  "browser",
];

describe("every guide is actionable", () => {
  it.each(ALL_TARGETS)("%s names who is blocking and what to do", (target) => {
    const guide = locationRecoveryGuide(target);

    // Naming the blocker is what turns "the app is broken" into a ten-second
    // fix, so it is asserted rather than left to review.
    expect(guide.title).toMatch(/blocking/i);
    expect(guide.steps.length).toBeGreaterThanOrEqual(2);
    expect(guide.steps.length).toBeLessThanOrEqual(4);
    for (const step of guide.steps) {
      expect(step.trim().length).toBeGreaterThan(0);
      // A step that only repeats the old dead-end copy helps nobody.
      expect(step).not.toMatch(/^allow location permission\.?$/i);
    }
  });

  it("never offers a Settings button on the web", () => {
    // `openLocationSettings()` resolves `{ opened: false }` in a browser. A
    // button that does nothing spends trust it cannot earn back.
    for (const target of [
      "chromium-desktop",
      "chromium-android",
      "safari-desktop",
      "safari-ios",
      "firefox",
      "browser",
    ] as LocationRecoveryTarget[]) {
      expect(locationRecoveryGuide(target).canOpenSettings).toBe(false);
    }
  });

  it("offers a Settings button only where one genuinely opens", () => {
    expect(locationRecoveryGuide("ios-app").canOpenSettings).toBe(true);
    expect(locationRecoveryGuide("android-app").canOpenSettings).toBe(true);
  });

  it("tells desktop Chrome users about the icon beside the address", () => {
    // The precise control in the reported case: the panel behind that icon
    // carries a Location switch. Without this sentence there is nothing on
    // screen connecting the failure to the fix.
    const guide = resolveLocationRecoveryGuide({ userAgent: UA.chromeMac });
    expect(guide.steps[0]).toMatch(/left of the web address/i);
    expect(guide.steps.join(" ")).toMatch(/location/i);
  });

  it("promises the page will heal itself rather than demanding a reload", () => {
    // The recovery listener re-checks on focus, so asking for a manual reload
    // would be one instruction more than the person actually needs.
    for (const target of [
      "chromium-desktop",
      "chromium-android",
      "ios-app",
      "android-app",
      "browser",
    ] as LocationRecoveryTarget[]) {
      expect(locationRecoveryGuide(target).steps.join(" ")).toMatch(
        /turns on by itself/i,
      );
    }
  });
});

describe("when to show it at all", () => {
  it("shows only after an attempt actually failed with a denial", () => {
    expect(
      shouldShowLocationRecovery({ observedDenial: true, hasFix: false }),
    ).toBe(true);
  });

  it("stays hidden when nothing has been attempted", () => {
    // A permission API reporting "denied" is a hint, not proof: Safari cannot
    // report it, and Android re-prompts. Sending someone to settings on a hint
    // teaches them to ignore the message.
    expect(
      shouldShowLocationRecovery({ observedDenial: false, hasFix: false }),
    ).toBe(false);
  });

  it("stays hidden once a position is in hand", () => {
    // A device that just produced a coordinate is working, whatever any
    // earlier denial said.
    expect(
      shouldShowLocationRecovery({ observedDenial: true, hasFix: true }),
    ).toBe(false);
  });
});
