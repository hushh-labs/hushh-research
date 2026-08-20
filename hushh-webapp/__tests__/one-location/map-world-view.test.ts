/**
 * The arithmetic behind the blank strip above Your Map.
 *
 * The defect was reported as a layout bug — "the map starts below a large
 * white region" — and it is not one. `location-immersive-map.tsx` renders
 * `h-[100dvh]` with the renderer at `absolute inset-0`, so the container fills
 * the screen exactly. What did not fill it was the picture inside: Google draws
 * a Mercator world `256 * 2^zoom` px tall and its own backdrop everywhere else,
 * and the pre-consent camera was hardcoded to `{ lat: 20, lng: 0 }, zoom: 2`.
 *
 * That camera can cover at most `2 * 453.9 ≈ 908` px of height. Which devices
 * it fails on is therefore a property of the device, not of the build — which
 * is why it survived review on a 844 px simulator and showed up on a taller
 * window. These cases pin the fix at the sizes it has to hold for.
 */

import { describe, expect, it } from "vitest";

import {
  MAP_NEUTRAL_WORLD_LATITUDE,
  MAP_NEUTRAL_WORLD_MAX_ZOOM,
  MAP_NEUTRAL_WORLD_MIN_ZOOM,
  MAP_WORLD_TILE_SIZE_PX,
  neutralWorldCamera,
  outOfWorldBandPx,
  worldFillingZoom,
} from "@/lib/one-location/map-world-view";

/** The camera this replaced, kept here so the regression stays visible. */
const PREVIOUS_FIXED_CAMERA = { center: { lat: 20, lng: 0 }, zoom: 2 };

const DEVICE_BOXES = [
  { name: "iPhone SE", width: 375, height: 667 },
  { name: "iPhone 13 mini", width: 375, height: 812 },
  { name: "iPhone 15", width: 390, height: 844 },
  { name: "iPhone 15 Pro Max", width: 430, height: 932 },
  { name: "iPhone 15 Pro Max, landscape", width: 932, height: 430 },
  { name: "iPad portrait", width: 768, height: 1024 },
  { name: "the reported browser window", width: 552, height: 1080 },
  { name: "a desktop window", width: 1440, height: 900 },
  { name: "a tall narrow window", width: 360, height: 1600 },
] as const;

describe("neutral world camera", () => {
  it("shows no out-of-world backdrop on any supported box", () => {
    for (const box of DEVICE_BOXES) {
      const camera = neutralWorldCamera(box);
      expect(
        outOfWorldBandPx(camera, box),
        `${box.name} (${box.width}x${box.height})`,
      ).toBe(0);
    }
  });

  it("reproduces the reported band under the camera it replaced", () => {
    // Not a hypothetical. 552x1080 is the window the screenshot was taken in,
    // and 86 px is the strip measured in it.
    const reported = { width: 552, height: 1080 };
    expect(outOfWorldBandPx(PREVIOUS_FIXED_CAMERA, reported)).toBeCloseTo(86, 0);

    // The two device sizes that also leaked, and the one that did not -- which
    // is exactly why this was easy to miss.
    expect(
      outOfWorldBandPx(PREVIOUS_FIXED_CAMERA, { width: 430, height: 932 }),
    ).toBeGreaterThan(0);
    expect(
      outOfWorldBandPx(PREVIOUS_FIXED_CAMERA, { width: 390, height: 844 }),
    ).toBe(0);
  });

  it("keeps the preferred latitude whenever the box can be covered from it", () => {
    // Moving the camera is a cost -- latitude 20 is where the populated half of
    // the world sits. It should only move when the arithmetic forces it.
    for (const box of [
      { width: 375, height: 667 },
      { width: 390, height: 844 },
      { width: 932, height: 430 },
    ]) {
      expect(neutralWorldCamera(box).center.lat).toBe(
        MAP_NEUTRAL_WORLD_LATITUDE,
      );
    }
  });

  it("slides the latitude, not the zoom, when 12 px of world are missing", () => {
    // iPhone 15 Pro Max. A zoom-2 world (1024 px) is tall enough for 932 px;
    // it is latitude 20 that sits 12 px too high in it. Raising the zoom
    // instead would answer a 12 px band by throwing away the world view.
    const camera = neutralWorldCamera({ width: 430, height: 932 });
    expect(camera.zoom).toBe(2);
    expect(camera.center.lat).toBeLessThan(MAP_NEUTRAL_WORLD_LATITUDE);
    expect(camera.center.lat).toBeGreaterThan(0);
    expect(outOfWorldBandPx(camera, { width: 430, height: 932 })).toBe(0);
  });

  it("raises the zoom only when no latitude can cover the box", () => {
    // 1080 px of height needs more than a 1024 px world at any centre.
    const camera = neutralWorldCamera({ width: 552, height: 1080 });
    expect(camera.zoom).toBe(3);
    expect(outOfWorldBandPx(camera, { width: 552, height: 1080 })).toBe(0);
  });

  it("never opens closer than the world view, or closer than a continent", () => {
    expect(worldFillingZoom({ width: 1, height: 1 })).toBe(
      MAP_NEUTRAL_WORLD_MIN_ZOOM,
    );
    expect(worldFillingZoom({ width: 100_000, height: 100_000 })).toBe(
      MAP_NEUTRAL_WORLD_MAX_ZOOM,
    );
  });

  it("counts width as well as height", () => {
    // The renderer repeats the world sideways rather than showing backdrop, so
    // a too-low zoom on a wide window paints the same continent twice. That
    // reads as a rendering fault, not as a map.
    const wide = { width: 2400, height: 400 };
    const camera = neutralWorldCamera(wide);
    expect(MAP_WORLD_TILE_SIZE_PX * 2 ** camera.zoom).toBeGreaterThanOrEqual(
      wide.width,
    );
  });

  it("falls back to the previous view when there is no box to measure", () => {
    // jsdom reports every rect as zero, and so does a container that has not
    // laid out yet. Neither is a reason to invent geometry.
    for (const box of [
      { width: 0, height: 0 },
      { width: Number.NaN, height: Number.NaN },
    ]) {
      const camera = neutralWorldCamera(box);
      expect(camera.zoom).toBe(MAP_NEUTRAL_WORLD_MIN_ZOOM);
      expect(camera.center.lat).toBe(MAP_NEUTRAL_WORLD_LATITUDE);
    }
  });

  it("holds across every height between a phone and a large desktop", () => {
    // The failure was a boundary nobody had computed, so the guard is the
    // sweep rather than a handful of named devices.
    for (let height = 320; height <= 2000; height += 1) {
      const box = { width: 390, height };
      expect(outOfWorldBandPx(neutralWorldCamera(box), box), `${height}px`).toBe(
        0,
      );
    }
  });
});
