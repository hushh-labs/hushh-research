/**
 * The neutral world camera Your Map opens on.
 *
 * Your Map shows a world view twice: before renderer consent (no coordinate has
 * been handed to the renderer yet) and after consent when this device has no
 * position to centre on -- a denied permission, a disabled service, or a fix
 * that never arrived. Both are legitimate "we are not showing you anywhere in
 * particular" states, and both are full-bleed, so the picture behind the copy
 * has to look like a map rather than like a broken screen.
 *
 * It used to be a fixed `{ lat: 20, lng: 0 }` at `zoom: 2`, which cannot do
 * that, because a Web Mercator world is a SQUARE of `256 * 2^zoom` pixels:
 *
 *   zoom 2 -> 1024 x 1024 px
 *
 * Two things follow, and both were visible on uat.one.hushh.ai:
 *
 * 1. A container taller than the world cannot be filled by it. Google paints
 *    its own out-of-world grey above and below whatever is left over. At
 *    1920x1080 the world is 1024px tall inside a 1080px box.
 * 2. Centring at latitude 20 is not the world's vertical middle. Latitude 20
 *    sits ~5.7% of the world's height ABOVE centre, so the whole 56px shortfall
 *    was pushed to one side: measured in Chromium against the real Maps JS
 *    projection, 86.1px of grey at the top and 0px at the bottom. That band is
 *    what was reported as the map being "cut off at the top" -- the container,
 *    the header and the safe area were all correct.
 *
 * A container WIDER than the world has the mirror problem: the world repeats
 * horizontally, so a desktop showed Greenland twice (1920 / 1024 = 1.88 worlds).
 *
 * So the camera is derived from the box it has to fill instead of guessed:
 * centre on the equator, where the Mercator world is symmetric about the
 * viewport centre, and pick the smallest whole zoom whose world covers the
 * larger of the two axes. Then `worldPixels >= width` (no repeat) and
 * `worldPixels >= height` (no grey), at every size, on both renderers.
 */

/** Web Mercator's world is `TILE_SIZE * 2^zoom` pixels square. */
export const WORLD_TILE_SIZE_PX = 256;

/**
 * Never zoom out past the previous behaviour. Any box up to 1024px on its
 * longer side already resolves to 2, so this only guards a degenerate or
 * not-yet-laid-out container.
 */
export const MIN_NEUTRAL_WORLD_ZOOM = 2;

/**
 * A neutral view is a backdrop, not a destination. Past zoom 6 a "world" view
 * is a country, so an absurd container is capped rather than followed.
 */
export const MAX_NEUTRAL_WORLD_ZOOM = 6;

export type NeutralWorldCamera = {
  center: { lat: number; lng: number };
  zoom: number;
};

export type NeutralWorldBox = {
  width: number;
  height: number;
};

/**
 * The zoom whose Mercator world covers `box` on both axes.
 *
 * Whole zooms only. Both renderers accept fractional zoom, but a whole one
 * keeps raster tiles on their native grid and the extra magnification is at
 * most 2x on a backdrop nobody is reading distances off.
 */
export function neutralWorldZoom(box: NeutralWorldBox): number {
  const longestEdge = Math.max(box.width, box.height);
  if (!Number.isFinite(longestEdge) || longestEdge <= 0) {
    // A box with no layout yet. Answer with the historical default rather than
    // -Infinity; the resize pass re-frames it as soon as it has real geometry.
    return MIN_NEUTRAL_WORLD_ZOOM;
  }
  const required = Math.ceil(Math.log2(longestEdge / WORLD_TILE_SIZE_PX));
  return Math.min(
    MAX_NEUTRAL_WORLD_ZOOM,
    Math.max(MIN_NEUTRAL_WORLD_ZOOM, required),
  );
}

/**
 * The full camera: the equator, and a zoom that fills `box`.
 *
 * Longitude 0 rather than a populated meridian for the same reason as latitude
 * 0 -- there is no place being shown, so the only defensible centre is the
 * projection's own origin.
 */
export function neutralWorldCamera(box: NeutralWorldBox): NeutralWorldCamera {
  return {
    center: { lat: 0, lng: 0 },
    zoom: neutralWorldZoom(box),
  };
}

/** The Mercator world's pixel extent at `zoom`. Exported for the contract test. */
export function worldPixelsAtZoom(zoom: number): number {
  return WORLD_TILE_SIZE_PX * 2 ** zoom;
}
