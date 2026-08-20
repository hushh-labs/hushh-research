/**
 * The camera Your Map opens with when it has no coordinate to open on.
 *
 * ## The band this exists to remove
 *
 * Google draws a Mercator world that is `256 * 2^zoom` CSS pixels tall, and
 * nothing above or below it. Anything the camera shows outside that range is
 * Google's own out-of-world backdrop -- near-white in the light map, which on
 * a phone reads as an unexplained blank strip between the top of the screen
 * and where "the map" appears to start.
 *
 * The map container was never the problem: `location-immersive-map.tsx`
 * renders `h-[100dvh]` with the renderer at `absolute inset-0`. The problem was
 * arithmetic in a fixed camera. The pre-consent view was hardcoded to
 * `center { lat: 20, lng: 0 }, zoom: 2`, and a zoom-2 world is 1024 px tall
 * with latitude 20 sitting 453.9 px down it. A viewport taller than
 * `453.9 * 2 ≈ 908` px therefore CANNOT be covered: at 1080 px the camera is
 * asked to show 86 px that do not exist, and paints backdrop there.
 *
 * That is a per-device failure, not a per-build one. 844 px (iPhone 15) is
 * fine, 932 px (iPhone 15 Pro Max) leaks ~12 px, a laptop window leaks ~86 px.
 * A single hardcoded zoom cannot be right for all of them, so this module
 * derives one from the box the renderer was actually given.
 *
 * A sibling of the WEB `setPadding` trap already documented in
 * `location-immersive-map.tsx`: that one dropped z2 to z1 and produced bands at
 * BOTH edges. Stopping the padding call fixed the drop; it could not fix a
 * starting zoom that was already too low for the box.
 *
 * Pure and dependency-free so the arithmetic is unit-testable without a
 * renderer, a browser, or a Maps key.
 */

/** Google's Mercator tile edge, in CSS pixels, at zoom 0. */
export const MAP_WORLD_TILE_SIZE_PX = 256;

/**
 * The latitude the neutral world view prefers to sit on.
 *
 * Kept at the previous hardcoded value: it favours the populated northern
 * latitudes over an equator-centred view that spends its lower half on empty
 * ocean. It is a preference, not a guarantee -- `neutralWorldCamera` moves off
 * it when the box cannot be covered from there.
 */
export const MAP_NEUTRAL_WORLD_LATITUDE = 20;

/** Longitude of the neutral world view. Unchanged; longitude wraps, so it never bands. */
export const MAP_NEUTRAL_WORLD_LONGITUDE = 0;

/**
 * Never open closer than the whole-world view, even in a tiny box.
 *
 * Below zoom 2 the world is smaller than a phone screen in BOTH axes and the
 * renderer tiles it sideways, which is its own kind of wrong.
 */
export const MAP_NEUTRAL_WORLD_MIN_ZOOM = 2;

/**
 * And never open closer than a continent.
 *
 * Only reachable by a box taller than 4096 px. The cap keeps a mis-measured or
 * absurd container from opening the neutral view zoomed into one city, which
 * would imply a location the app has not been given.
 */
export const MAP_NEUTRAL_WORLD_MAX_ZOOM = 5;

export interface MapBoxSize {
  width: number;
  height: number;
}

export interface MapWorldCamera {
  center: { lat: number; lng: number };
  zoom: number;
}

/** Normalized 0..1 Mercator position of a latitude, 0 at the north edge. */
function mercatorFraction(latitude: number): number {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const radians = (clamped * Math.PI) / 180;
  return (
    0.5 - Math.log(Math.tan(Math.PI / 4 + radians / 2)) / (2 * Math.PI)
  );
}

/** The inverse: the latitude at a normalized 0..1 Mercator position. */
function latitudeAtFraction(fraction: number): number {
  const clamped = Math.max(0, Math.min(1, fraction));
  const n = Math.PI * (1 - 2 * clamped);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

/**
 * The smallest zoom whose world covers `box` on both axes.
 *
 * Width matters as well as height even though the renderer repeats the world
 * horizontally: a repeating world on a wide window shows the same continent
 * twice, which reads as a rendering fault rather than a map.
 */
export function worldFillingZoom(box: MapBoxSize): number {
  const longestEdge = Math.max(
    Number.isFinite(box.width) ? box.width : 0,
    Number.isFinite(box.height) ? box.height : 0,
  );
  if (!(longestEdge > 0)) return MAP_NEUTRAL_WORLD_MIN_ZOOM;
  const required = Math.ceil(Math.log2(longestEdge / MAP_WORLD_TILE_SIZE_PX));
  return Math.max(
    MAP_NEUTRAL_WORLD_MIN_ZOOM,
    Math.min(MAP_NEUTRAL_WORLD_MAX_ZOOM, required),
  );
}

/**
 * A neutral world camera that fills `box` with map and nothing else.
 *
 * Two steps, in this order:
 *
 *  1. Pick the zoom whose world is at least as large as the box.
 *  2. Slide the centre latitude until the visible window sits fully inside
 *     that world. The preferred latitude is kept whenever it already does.
 *
 * Step 2 is what step 1 alone cannot do: a world 1024 px tall covers a 932 px
 * box, but only if the centre is between 466 px and 558 px down it. Latitude
 * 20 is at 453.9 px, so it still leaks 12 px off the top until it is moved.
 *
 * A zero or unmeasured box returns the preferred latitude at the minimum zoom
 * -- the same view as before this module existed, which is the correct thing to
 * fall back to when there is no geometry to reason about.
 */
export function neutralWorldCamera(box: MapBoxSize): MapWorldCamera {
  const zoom = worldFillingZoom(box);
  const worldPx = MAP_WORLD_TILE_SIZE_PX * 2 ** zoom;
  const height = Number.isFinite(box.height) ? Math.max(0, box.height) : 0;

  const preferredY = mercatorFraction(MAP_NEUTRAL_WORLD_LATITUDE) * worldPx;
  // A box taller than the world cannot be filled from any centre. Only
  // reachable past MAP_NEUTRAL_WORLD_MAX_ZOOM (a box over 4096 px tall), where
  // centring the world is the least-wrong answer.
  if (height >= worldPx) {
    return {
      center: { lat: 0, lng: MAP_NEUTRAL_WORLD_LONGITUDE },
      zoom,
    };
  }

  const half = height / 2;
  const clampedY = Math.max(half, Math.min(worldPx - half, preferredY));
  return {
    center: {
      lat:
        clampedY === preferredY
          ? MAP_NEUTRAL_WORLD_LATITUDE
          : latitudeAtFraction(clampedY / worldPx),
      lng: MAP_NEUTRAL_WORLD_LONGITUDE,
    },
    zoom,
  };
}

/**
 * How many pixels of Google's out-of-world backdrop a camera would expose.
 *
 * The test oracle: `neutralWorldCamera` is correct exactly when this returns 0.
 * Kept beside the code it checks so the two cannot drift.
 */
export function outOfWorldBandPx(
  camera: MapWorldCamera,
  box: MapBoxSize,
): number {
  const worldPx = MAP_WORLD_TILE_SIZE_PX * 2 ** camera.zoom;
  const centerY = mercatorFraction(camera.center.lat) * worldPx;
  const half = Math.max(0, box.height) / 2;
  const above = Math.max(0, half - centerY);
  const below = Math.max(0, centerY + half - worldPx);
  return above + below;
}
