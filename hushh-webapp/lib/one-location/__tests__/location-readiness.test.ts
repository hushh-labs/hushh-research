import { describe, expect, it } from "vitest";

import type { HushhLocationPermissionState } from "@/lib/capacitor";
import {
  canAttemptLocation,
  canPromptForLocation,
  isLocationPermissionDeniedError,
  locationBlockReason,
  locationReadiness,
  locationStatusLabel,
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
    // Reporting that as "Location blocked" is what made a healthy phone look
    // broken the moment the page loaded.
    expect(
      locationStatusLabel({
        readiness: "askable",
        previewOn: false,
        paused: false,
        accuracyLimited: false,
      }),
    ).toBe("Location off");
  });

  it("says blocked when it is, and pause outranks everything", () => {
    expect(
      locationStatusLabel({
        readiness: "blocked",
        previewOn: false,
        paused: false,
        accuracyLimited: false,
      }),
    ).toBe("Location blocked");
    expect(
      locationStatusLabel({
        readiness: "blocked",
        previewOn: true,
        paused: true,
        accuracyLimited: true,
      }),
    ).toBe("Location paused");
  });

  it("reports limited accuracy only while the preview is actually on", () => {
    expect(
      locationStatusLabel({
        readiness: "ready",
        previewOn: true,
        paused: false,
        accuracyLimited: true,
      }),
    ).toBe("Location limited");
    expect(
      locationStatusLabel({
        readiness: "ready",
        previewOn: true,
        paused: false,
        accuracyLimited: false,
      }),
    ).toBe("Location on");
  });
});
