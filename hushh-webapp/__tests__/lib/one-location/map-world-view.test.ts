import { describe, expect, it } from "vitest";

import {
  MAX_NEUTRAL_WORLD_ZOOM,
  MIN_NEUTRAL_WORLD_ZOOM,
  neutralWorldCamera,
  neutralWorldZoom,
  worldPixelsAtZoom,
} from "@/lib/one-location/map-world-view";

/**
 * Where Google actually paints the world, for a given camera and container.
 *
 * This is Web Mercator, not an approximation of it, and it is the same maths
 * the Maps JS API's own `Projection` uses. It was validated against the live
 * API in Chromium before this file was written: for the camera Your Map used
 * to ship (`{ lat: 20, lng: 0 }` at zoom 2) in a 1920x1080 container, Google
 * reported 86.1px of grey above the world and 0px below it. The
 * `reproduces the reported 1920x1080 defect` case below asserts that this
 * helper returns the same number, so every other case in this file is measured
 * with a model that is known to match the renderer.
 */
function paintedWorld(
  camera: { center: { lat: number }; zoom: number },
  box: { width: number; height: number },
) {
  const worldPx = worldPixelsAtZoom(camera.zoom);
  const mercatorY = (lat: number) =>
    worldPx *
    (0.5 -
      Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI));
  const centerY = mercatorY(camera.center.lat);
  // The projection's own poles: Mercator is truncated at +/-85.05112878.
  const topY = box.height / 2 + (mercatorY(85.05112878) - centerY);
  const bottomY = box.height / 2 + (mercatorY(-85.05112878) - centerY);
  return {
    worldPx,
    greyAbovePx: Math.max(0, topY),
    greyBelowPx: Math.max(0, box.height - bottomY),
    worldsAcross: box.width / worldPx,
  };
}

/** The camera that shipped, and produced the report. */
const LEGACY_CAMERA = { center: { lat: 20, lng: 0 }, zoom: 2 };

/**
 * Every container Your Map has to fill. `/one/location/map` is full-bleed
 * (`h-[100dvh]`, map `absolute inset-0`), so the container IS the viewport.
 */
const VIEWPORTS = [
  { name: "iPhone SE", width: 375, height: 667 },
  { name: "iPhone 15", width: 393, height: 852 },
  { name: "iPhone 15 Pro Max", width: 430, height: 932 },
  { name: "iPhone 15 Pro Max landscape", width: 932, height: 430 },
  { name: "small phone", width: 320, height: 568 },
  { name: "iPad portrait", width: 834, height: 1112 },
  { name: "iPad landscape", width: 1112, height: 834 },
  { name: "laptop", width: 1440, height: 900 },
  { name: "desktop (the report)", width: 1920, height: 1080 },
  { name: "wide desktop", width: 2560, height: 1440 },
  { name: "tall narrow", width: 400, height: 1400 },
] as const;

describe("neutral world camera", () => {
  it("reproduces the reported 1920x1080 defect with the camera that shipped", () => {
    // 86.1px measured in Chromium against the live Maps JS projection.
    const painted = paintedWorld(LEGACY_CAMERA, { width: 1920, height: 1080 });
    expect(painted.greyAbovePx).toBeCloseTo(86.1, 1);
    expect(painted.greyBelowPx).toBe(0);
    // ...and the same camera repeated the world 1.88 times across the width,
    // which is why the desktop screenshot shows Greenland twice.
    expect(painted.worldsAcross).toBeCloseTo(1.88, 2);
  });

  it.each(VIEWPORTS)(
    "fills $name ($width x $height) with no out-of-world band",
    ({ width, height }) => {
      const painted = paintedWorld(neutralWorldCamera({ width, height }), {
        width,
        height,
      });
      expect(painted.greyAbovePx).toBe(0);
      expect(painted.greyBelowPx).toBe(0);
    },
  );

  it.each(VIEWPORTS)(
    "never repeats the world across $name ($width x $height)",
    ({ width, height }) => {
      const painted = paintedWorld(neutralWorldCamera({ width, height }), {
        width,
        height,
      });
      expect(painted.worldsAcross).toBeLessThanOrEqual(1);
    },
  );

  it("centres on the projection origin, because no place is being shown", () => {
    // Latitude 20 is ~5.7% of the world's height above the vertical middle, so
    // it pushed the entire vertical shortfall to the top edge. Any non-zero
    // latitude reintroduces that asymmetry.
    expect(neutralWorldCamera({ width: 1920, height: 1080 }).center).toEqual({
      lat: 0,
      lng: 0,
    });
  });

  it("picks the smallest whole zoom that covers the longer edge", () => {
    expect(neutralWorldZoom({ width: 1920, height: 1080 })).toBe(3);
    expect(neutralWorldZoom({ width: 1440, height: 900 })).toBe(3);
    expect(neutralWorldZoom({ width: 393, height: 852 })).toBe(2);
    // Exactly on a boundary: a 1024px edge is covered by zoom 2, not 3.
    expect(neutralWorldZoom({ width: 1024, height: 800 })).toBe(2);
    expect(neutralWorldZoom({ width: 1025, height: 800 })).toBe(3);
  });

  it("never zooms out past the previous behaviour", () => {
    expect(neutralWorldZoom({ width: 100, height: 100 })).toBe(
      MIN_NEUTRAL_WORLD_ZOOM,
    );
  });

  it("answers for a container that has not been laid out yet", () => {
    // The create effect reads the box straight off the element. jsdom, a
    // hidden route transition, and a native frame that has not been measured
    // all report zero -- none of them may produce NaN or -Infinity zoom.
    for (const box of [
      { width: 0, height: 0 },
      { width: Number.NaN, height: 100 },
      { width: 100, height: Number.POSITIVE_INFINITY },
    ]) {
      const camera = neutralWorldCamera(box);
      expect(Number.isFinite(camera.zoom)).toBe(true);
      expect(camera.zoom).toBeGreaterThanOrEqual(MIN_NEUTRAL_WORLD_ZOOM);
      expect(camera.zoom).toBeLessThanOrEqual(MAX_NEUTRAL_WORLD_ZOOM);
    }
  });

  it("caps an absurd container instead of following it", () => {
    expect(neutralWorldZoom({ width: 10_000_000, height: 10 })).toBe(
      MAX_NEUTRAL_WORLD_ZOOM,
    );
  });
});
