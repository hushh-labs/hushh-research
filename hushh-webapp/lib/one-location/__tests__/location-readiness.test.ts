import { describe, expect, it } from "vitest";

import type { HushhLocationPermissionState } from "@/lib/capacitor";
import {
  canAttemptLocation,
  canPromptForLocation,
  fixAgeLabel,
  isLocationPermissionDeniedError,
  isUsableFixAge,
  locationBlockReason,
  locationReadiness,
  locationStatusLabel,
  shouldSurfaceLocationError,
} from "@/lib/one-location/location-readiness";

function permission(
  over: Partial<HushhLocationPermissionState>,
): HushhLocationPermissionState {
  return {
    state: "prompt",
    precise: null,
    background: "foreground-only",
    locationServicesEnabled: null,
    ...over,
  } as HushhLocationPermissionState;
}

describe("what may be attempted", () => {
  it("attempts when the platform cannot report its own permission", () => {
    // Safari has no `geolocation` entry in the Permissions API, so every iPhone
    // arrives here knowing nothing. Nothing is a reason to ask the device, and
    // treating it as a refusal is what pinned the toggle off on phones whose
    // location worked.
    expect(canAttemptLocation(permission({ state: "prompt" }))).toBe(true);
    expect(canAttemptLocation(null)).toBe(true);
  });

  it("attempts even when a stale read claims denied", () => {
    // The browser prompt only appears from getCurrentPosition(). Refusing on a
    // read-back denial guarantees it never appears, which leaves the user stuck
    // behind "Allow location permission before sharing" with no way out.
    expect(canAttemptLocation(permission({ state: "denied" }))).toBe(true);
    expect(locationBlockReason(permission({ state: "denied" }))).toBeNull();
  });

  it("does not attempt what asking cannot fix", () => {
    expect(locationBlockReason(permission({ locationServicesEnabled: false }))).toBe(
      "services-off",
    );
    expect(locationBlockReason(permission({ state: "restricted" }))).toBe("restricted");
    expect(locationBlockReason(permission({ state: "unavailable" }))).toBe("unsupported");
  });

  it("calls an OS-level switch off rather than unsupported, even when both look true", () => {
    // iOS reports state=unavailable AND locationServicesEnabled=false when the
    // system toggle is off. That is a fixable setting, not a dead device, and
    // the message the user gets has to say so.
    expect(
      locationBlockReason(
        permission({ state: "unavailable", locationServicesEnabled: false }),
      ),
    ).toBe("services-off");
  });

  it("only promises a prompt when one can actually appear", () => {
    expect(canPromptForLocation(permission({ state: "prompt" }))).toBe(true);
    expect(canPromptForLocation(permission({ state: "denied" }))).toBe(false);
    expect(canPromptForLocation(permission({ state: "restricted" }))).toBe(false);
  });
});

describe("recognising a real denial", () => {
  it("recognises each platform's way of saying no", () => {
    const web = new Error("Location permission is blocked for this site.");
    web.name = "LocationPermissionDeniedError";
    expect(isLocationPermissionDeniedError(web)).toBe(true);
    // iOS and Android plugins both reject with this exact string.
    expect(
      isLocationPermissionDeniedError(new Error("Location permission was not granted.")),
    ).toBe(true);
    expect(isLocationPermissionDeniedError({ code: 1 })).toBe(true);
  });

  it("does not mistake a slow fix for a refusal", () => {
    // Sending someone to Settings because their GPS was slow is worse than
    // useless: the setting they are told to change is already correct.
    expect(
      isLocationPermissionDeniedError(new Error("Precise location unavailable before timeout.")),
    ).toBe(false);
    expect(
      isLocationPermissionDeniedError(
        new Error("Could not get your location. Turn on Location for your device/browser."),
      ),
    ).toBe(false);
    expect(isLocationPermissionDeniedError(null)).toBe(false);
    expect(isLocationPermissionDeniedError({ code: 3 })).toBe(false);
  });
});

describe("what the UI may claim", () => {
  it("treats a fix in hand as the authority over any permission value", () => {
    // The whole point: a device that just produced a coordinate is working,
    // whatever the permission API says — including saying nothing at all.
    expect(
      locationReadiness({
        permission: permission({ state: "denied" }),
        hasFix: true,
      }),
    ).toBe("ready");
  });

  it("is askable while nothing is known", () => {
    expect(
      locationReadiness({ permission: permission({ state: "prompt" }), hasFix: false }),
    ).toBe("askable");
  });

  it("is blocked only after a denial was actually observed", () => {
    const stale = permission({ state: "denied" });
    expect(locationReadiness({ permission: stale, hasFix: false })).toBe("askable");
    expect(
      locationReadiness({ permission: stale, hasFix: false, observedDenial: true }),
    ).toBe("blocked");
  });

  it("is blocked when the OS switch is off, without needing an attempt", () => {
    expect(
      locationReadiness({
        permission: permission({ locationServicesEnabled: false }),
        hasFix: false,
      }),
    ).toBe("blocked");
  });
});

describe("status label", () => {
  it("never calls a working device blocked just because the preview is off", () => {
    // The header switch is a preview control, so it legitimately starts off.
    // Reporting that as "Location is blocked" is what made a healthy phone
    // look broken the moment the page loaded.
    expect(
      locationStatusLabel({
        readiness: "askable",
        previewOn: false,
        paused: false,
        accuracyLimited: false,
      }),
    ).toBe("Location is off");
  });

  it("says blocked when it is, and pause outranks everything", () => {
    expect(
      locationStatusLabel({
        readiness: "blocked",
        previewOn: false,
        paused: false,
        accuracyLimited: false,
      }),
    ).toBe("Location is blocked");
    expect(
      locationStatusLabel({
        readiness: "blocked",
        previewOn: true,
        paused: true,
        accuracyLimited: true,
      }),
    ).toBe("Location is paused");
  });

  it("reports limited accuracy only while the preview is actually on", () => {
    expect(
      locationStatusLabel({
        readiness: "ready",
        previewOn: true,
        paused: false,
        accuracyLimited: true,
      }),
    ).toBe("Location is limited");
    expect(
      locationStatusLabel({
        readiness: "ready",
        previewOn: true,
        paused: false,
        accuracyLimited: false,
      }),
    ).toBe("Location is on");
  });

  it("names what the switch controls in every state, at every width", () => {
    // The compact form exists because the phone header puts this text under a
    // 28px title that already says Location: the long string measured two title
    // lines at 320/360/375/390. It must agree with the full form on every
    // state, or the same switch would report differently on a phone and a
    // laptop.
    const cases = [
      [{ readiness: "askable", previewOn: false, paused: false, accuracyLimited: false }, "Location is off"],
      [{ readiness: "blocked", previewOn: false, paused: false, accuracyLimited: false }, "Location is blocked"],
      [{ readiness: "blocked", previewOn: true, paused: true, accuracyLimited: true }, "Location is paused"],
      [{ readiness: "ready", previewOn: true, paused: false, accuracyLimited: true }, "Location is limited"],
      [{ readiness: "ready", previewOn: true, paused: false, accuracyLimited: false }, "Location is on"],
    ] as const;

    for (const [params, full] of cases) {
      expect(locationStatusLabel(params)).toBe(full);
      // Every state names the thing being switched. The one-word form this
      // used to also return is gone: it fit beside the switch and told an iOS
      // user nothing, which is how the header ended up reading just "On".
      expect(full.startsWith("Location ")).toBe(true);
    }
  });
});

describe("when a location failure is worth showing", () => {
  // The rule this replaces: toast on every capture failure, including the ones
  // where a perfectly good position was already on screen. That is how "turn
  // on location" ended up in front of people whose location was working.
  it("says nothing about a failed refresh while a usable fix is held", () => {
    expect(
      shouldSurfaceLocationError({
        hasUsableFix: true,
        observedDenial: false,
        blockReason: null,
        blocksUserIntent: true,
      }),
    ).toBe(false);
  });

  it("speaks up for an observed denial even while a fix is held", () => {
    // The owner is cut off from every future fix until they change a setting.
    // Holding a position does not make that less true, and only saying so
    // gets them to the screen that fixes it.
    expect(
      shouldSurfaceLocationError({
        hasUsableFix: true,
        observedDenial: true,
        blockReason: null,
        blocksUserIntent: false,
      }),
    ).toBe(true);
  });

  it("speaks up for a platform block even while a fix is held", () => {
    expect(
      shouldSurfaceLocationError({
        hasUsableFix: true,
        observedDenial: false,
        blockReason: "services-off",
        blocksUserIntent: false,
      }),
    ).toBe(true);
  });

  it("speaks up when the owner pressed something and got nothing", () => {
    expect(
      shouldSurfaceLocationError({
        hasUsableFix: false,
        observedDenial: false,
        blockReason: null,
        blocksUserIntent: true,
      }),
    ).toBe(true);
  });

  it("stays quiet about background work the owner never asked for", () => {
    // A screen warming a position does not get to interrupt somebody about it.
    expect(
      shouldSurfaceLocationError({
        hasUsableFix: false,
        observedDenial: false,
        blockReason: null,
        blocksUserIntent: false,
      }),
    ).toBe(false);
  });
});

describe("how a position's age is judged and described", () => {
  it("accepts a position from within the usable window", () => {
    const capturedAt = new Date(Date.now() - 20 * 60_000).toISOString();
    expect(isUsableFixAge(capturedAt)).toBe(true);
  });

  it("rejects a position older than the usable window", () => {
    const capturedAt = new Date(Date.now() - 90 * 60_000).toISOString();
    expect(isUsableFixAge(capturedAt)).toBe(false);
  });

  it("rejects a future timestamp as a clock change, not a fresh fix", () => {
    const capturedAt = new Date(Date.now() + 10 * 60_000).toISOString();
    expect(isUsableFixAge(capturedAt)).toBe(false);
  });

  it("says nothing about a position recent enough to need no qualifier", () => {
    expect(fixAgeLabel(new Date(Date.now() - 30_000).toISOString())).toBe("");
  });

  it("labels an older position honestly rather than replacing it with an error", () => {
    expect(fixAgeLabel(new Date(Date.now() - 20 * 60_000).toISOString())).toBe(
      " · 20 min ago",
    );
    expect(fixAgeLabel(new Date(Date.now() - 60 * 60_000).toISOString())).toBe(
      " · 1 hr ago",
    );
  });

  it("says nothing when there is no timestamp to describe", () => {
    expect(fixAgeLabel(null)).toBe("");
    expect(fixAgeLabel("not-a-date")).toBe("");
  });
});
