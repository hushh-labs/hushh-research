import { describe, expect, it } from "vitest";

import { resolveOnboardingMapPoint } from "@/lib/one-location/onboarding-map-point";
import type { PlainLocationPoint } from "@/lib/one-location/types";

function point(
  latitude: number,
  longitude: number,
): PlainLocationPoint {
  return {
    latitude,
    longitude,
    accuracyM: 12,
    capturedAt: "2026-08-17T00:00:00.000Z",
    sourcePlatform: "web",
  };
}

describe("resolveOnboardingMapPoint", () => {
  it("survives the save-place modal closing", () => {
    // THE REGRESSION. The modal's draft is nulled by both of its exits, two
    // screens before the finale renders. Reading the finale's camera from that
    // draft is why "You're on the map." never showed anyone a map.
    expect(
      resolveOnboardingMapPoint({
        draft: null,
        confirmed: point(25.4358, 81.8463),
        workspace: null,
      }),
    ).toEqual({ lat: 25.4358, lng: 81.8463 });
  });

  it("follows the point being edited right now", () => {
    // Dragging the pin edits the draft. While that is on screen it is the
    // freshest statement of where the person says they are.
    expect(
      resolveOnboardingMapPoint({
        draft: point(19.076, 72.8777),
        confirmed: point(25.4358, 81.8463),
        workspace: point(28.6139, 77.209),
      }),
    ).toEqual({ lat: 19.076, lng: 72.8777 });
  });

  it("falls back to what the workspace already knows", () => {
    // Reached the finale without the save-place step ever running: a returning
    // account, or a workspace run where Location was already granted.
    expect(
      resolveOnboardingMapPoint({
        draft: null,
        confirmed: null,
        workspace: point(28.6139, 77.209),
      }),
    ).toEqual({ lat: 28.6139, lng: 77.209 });
  });

  it("returns nothing when this account has never produced a fix", () => {
    // The one case the stylised map is actually for.
    expect(resolveOnboardingMapPoint({})).toBeNull();
    expect(
      resolveOnboardingMapPoint({
        draft: null,
        confirmed: null,
        workspace: null,
      }),
    ).toBeNull();
  });

  it("steps over a coordinate it cannot draw and keeps looking", () => {
    // A broken fresher source must not blank the screen when a usable older
    // one is sitting right behind it.
    expect(
      resolveOnboardingMapPoint({
        draft: point(Number.NaN, 81.8463),
        confirmed: point(25.4358, 81.8463),
      }),
    ).toEqual({ lat: 25.4358, lng: 81.8463 });

    expect(
      resolveOnboardingMapPoint({
        draft: point(91, 0.5),
        confirmed: point(25.4358, 81.8463),
      }),
    ).toEqual({ lat: 25.4358, lng: 81.8463 });

    expect(
      resolveOnboardingMapPoint({
        draft: point(10, 181),
        confirmed: point(25.4358, 81.8463),
      }),
    ).toEqual({ lat: 25.4358, lng: 81.8463 });
  });

  it("refuses Null Island", () => {
    // 0,0 is the shape a dropped or default-initialised fix takes. Ending
    // onboarding by flying the camera into the Gulf of Guinea is worse than the
    // stylised map, which at least never claims to be anywhere.
    expect(
      resolveOnboardingMapPoint({ confirmed: point(0, 0) }),
    ).toBeNull();
    expect(
      resolveOnboardingMapPoint({
        draft: point(0, 0),
        confirmed: point(25.4358, 81.8463),
      }),
    ).toEqual({ lat: 25.4358, lng: 81.8463 });
  });

  it("keeps a real coordinate that merely sits on one axis", () => {
    // The equator and the prime meridian are places. Only the pair 0,0 is the
    // sentinel, so neither axis alone may be rejected.
    expect(resolveOnboardingMapPoint({ confirmed: point(0, 81.8463) })).toEqual({
      lat: 0,
      lng: 81.8463,
    });
    expect(resolveOnboardingMapPoint({ confirmed: point(51.4779, 0) })).toEqual({
      lat: 51.4779,
      lng: 0,
    });
  });
});
