/**
 * Name pills that float above the pins on Your Map.
 *
 * A coloured pin answers "somebody is here". It does not answer "who", and on a
 * map with more than one person that is the only question being asked. The pill
 * layer is HTML drawn ON TOP of the map surface, never data handed to the
 * renderer: the private-share boundary in `location-immersive-map.tsx` says the
 * Google renderer receives coordinates and a generic title, never a recipient's
 * name, and putting names in the WebView is what lets the map say who is who
 * without moving that line.
 *
 * Everything here is pure geometry so it can be reasoned about (and tested)
 * without a map instance: project a coordinate into the map box, drop what is
 * not comfortably on screen, and refuse to draw two pills on top of each other.
 * That last rule is what keeps a zoomed-out world view legible instead of a
 * pile of overlapping names.
 */

export type MapNameLabelKind = "person" | "self" | "place";

export interface MapNameLabelPoint {
  latitude: number;
  longitude: number;
}

export interface MapNameLabelCandidate {
  key: string;
  /** Already shortened for display -- a first name, not a full name. */
  text: string;
  kind: MapNameLabelKind;
  point: MapNameLabelPoint;
  /** Their last position is older than live, so the pill greys out with the pin. */
  stale?: boolean;
  /** The pin's own colour, so the pill's dot cannot drift from the pin it names. */
  tintCss?: string;
}

/**
 * What the renderer is currently showing. Both platforms report this through
 * `onCameraIdle`/`onBoundsChanged`; on web those fire continuously through a
 * gesture, on iOS and Android only once the camera settles.
 */
export interface MapNameLabelCamera {
  north: number;
  south: number;
  east: number;
  west: number;
  zoom: number;
  bearing: number;
  tilt: number;
}

/** The map box in CSS pixels, minus the chrome floating over it. */
export interface MapNameLabelViewport {
  width: number;
  height: number;
  /** Room taken by the top controls; a pill hidden under them helps nobody. */
  insetTop?: number;
  /** Room taken by the people tray at the bottom edge. */
  insetBottom?: number;
  insetLeft?: number;
  /** Room taken by the desktop check-in panel down the right-hand side. */
  insetRight?: number;
}

export interface PlacedMapNameLabel extends MapNameLabelCandidate {
  /** Pixels from the map box's left edge, at the pin's own longitude. */
  x: number;
  /** Pixels from the map box's top edge, at the pin's own latitude. */
  y: number;
}

/**
 * How far above the coordinate the pill's bottom edge sits.
 *
 * A Google pin is drawn ~40px tall with its TIP on the coordinate, and the
 * pill's tail reaches ~5px below its own bottom edge. 48 leaves the tail
 * pointing at the pin's head with a few pixels of daylight, rather than
 * merging into it.
 */
export const MAP_NAME_LABEL_PIN_OFFSET_PX = 48;
/** The pill's own height, including its border. Mirrors the rendered pill. */
export const MAP_NAME_LABEL_HEIGHT_PX = 26;
/** Breathing room between two pills before they count as touching. */
export const MAP_NAME_LABEL_GAP_PX = 8;
export const MAP_NAME_LABEL_MAX_WIDTH_PX = 156;
export const MAP_NAME_LABEL_MIN_WIDTH_PX = 52;
/**
 * Two pins closer together than this share one story, and two pills that close
 * cannot say which name belongs to which pin even when the boxes miss each
 * other. Raised while the renderer is clustering, because a clustered pin is
 * not drawn where its coordinate is.
 */
export const MAP_NAME_LABEL_MIN_ANCHOR_DISTANCE_PX = 44;
export const MAP_NAME_LABEL_CLUSTERED_ANCHOR_DISTANCE_PX = 96;

/** Semibold 12px, measured against the rendered pill rather than guessed. */
const GLYPH_WIDTH_PX = 6.9;
/** Dot + gap + horizontal padding + both borders. */
const PILL_CHROME_WIDTH_PX = 34;

/** Web Mercator stops at the poles; past this the projection has no y. */
const MAX_MERCATOR_LATITUDE = 85.05112878;

function mercatorY(latitude: number): number {
  const clamped = Math.min(
    MAX_MERCATOR_LATITUDE,
    Math.max(-MAX_MERCATOR_LATITUDE, latitude),
  );
  return Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360));
}

/**
 * Degrees travelled going EAST from `from` to `to`, always in [0, 360).
 *
 * Longitude is a circle, so a plain subtraction is wrong exactly where it
 * matters most: a map straddling the antimeridian reports west=170, east=-170,
 * and `east - west` is -340 rather than the 20 degrees actually on screen.
 */
function eastwardDegrees(from: number, to: number): number {
  const delta = (to - from) % 360;
  return delta < 0 ? delta + 360 : delta;
}

/**
 * Where a coordinate lands inside the map box, in CSS pixels.
 *
 * Flat Mercator: correct for a north-up, untilted camera, which is the only
 * camera this layer ever draws for (see `layoutMapNameLabels`). Returns null
 * when the camera cannot describe a projection at all.
 */
export function projectToMapBox(
  point: MapNameLabelPoint,
  camera: MapNameLabelCamera,
  viewport: MapNameLabelViewport,
): { x: number; y: number } | null {
  if (!(viewport.width > 0) || !(viewport.height > 0)) return null;
  if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) {
    return null;
  }

  const top = mercatorY(camera.north);
  const bottom = mercatorY(camera.south);
  const latitudeSpan = top - bottom;
  if (!(latitudeSpan > 0)) return null;

  // A camera showing the whole world reports west === east; that is 360
  // degrees of longitude, not zero.
  const longitudeSpan = eastwardDegrees(camera.west, camera.east) || 360;

  const x =
    (eastwardDegrees(camera.west, point.longitude) / longitudeSpan) *
    viewport.width;
  const y = ((top - mercatorY(point.latitude)) / latitudeSpan) * viewport.height;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/**
 * The pill's width before it is rendered, so collisions can be resolved in one
 * pass instead of by measuring the DOM. An estimate is enough: it decides
 * whether two names may share the screen, never what either one says.
 */
export function estimateMapNameLabelWidthPx(text: string): number {
  const glyphs = text.trim().length;
  return Math.min(
    MAP_NAME_LABEL_MAX_WIDTH_PX,
    Math.max(
      MAP_NAME_LABEL_MIN_WIDTH_PX,
      PILL_CHROME_WIDTH_PX + glyphs * GLYPH_WIDTH_PX,
    ),
  );
}

/**
 * The one word a person is called.
 *
 * "Ankit Kumar Singh" is a form-field answer; on a pill above a pin it is three
 * words of somebody else's screen. Handles the shapes a display name actually
 * arrives in -- extra whitespace, a trailing comma, an address used as a name
 * -- and returns "" when there is no name in there at all, so the caller can
 * choose its own fallback rather than print a stray initial.
 */
export function firstNameFromLabel(label: string): string {
  const collapsed = label.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";

  const [first = ""] = collapsed.split(" ");
  // "ankit@example.com" is a login, not a name, and its first token is the
  // whole address. The local part is the only human-sized piece of it.
  const withoutAddress = first.includes("@")
    ? (first.split("@")[0] ?? first)
    : first;
  const trimmed = withoutAddress.replace(
    /^[.,;:!?'"“”‘’()[\]{}<>|/\\-]+|[.,;:!?'"“”‘’()[\]{}<>|/\\-]+$/g,
    "",
  );
  return trimmed || withoutAddress;
}

interface LabelBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function pillBox(
  anchor: { x: number; y: number },
  text: string,
  pinOffsetPx: number,
  labelHeightPx: number,
): LabelBox {
  const halfWidth = estimateMapNameLabelWidthPx(text) / 2;
  const bottom = anchor.y - pinOffsetPx;
  return {
    left: anchor.x - halfWidth,
    right: anchor.x + halfWidth,
    top: bottom - labelHeightPx,
    bottom,
  };
}

function overlaps(a: LabelBox, b: LabelBox, gapPx: number): boolean {
  return (
    a.left - gapPx < b.right &&
    a.right + gapPx > b.left &&
    a.top - gapPx < b.bottom &&
    a.bottom + gapPx > b.top
  );
}

/** self first, then the check-in place, then people in the order given. */
const KIND_PRIORITY: Record<MapNameLabelKind, number> = {
  self: 0,
  place: 1,
  person: 2,
};

export interface MapNameLabelLayoutOptions {
  labels: MapNameLabelCandidate[];
  camera: MapNameLabelCamera;
  viewport: MapNameLabelViewport;
  /** Raise while the renderer is clustering. */
  minAnchorDistancePx?: number;
  pinOffsetPx?: number;
  labelHeightPx?: number;
  gapPx?: number;
}

/**
 * Decide which names may be drawn, and where.
 *
 * The rules, in the order they are applied:
 *  1. A rotated or tilted camera gets no pills at all. The projection above is
 *     flat, so a bearing would slide every name off its own pin -- a wrong
 *     name over a pin is worse than no name.
 *  2. Whoever matters most is placed first: you, then the place you are
 *     checking in to, then everyone else. Priority decides who KEEPS their
 *     pill when two of them cannot both have one.
 *  3. A pin under the top controls, the people tray or the desktop check-in
 *     panel is not on screen in any sense that matters, and neither is one
 *     whose pill an edge would cut in half. Both are dropped rather than
 *     half-drawn.
 *  4. Nothing may overlap anything already placed -- not the boxes, and not
 *     the pins themselves. This is the rule that makes a zoomed-out map read
 *     as a handful of legible names instead of a stack of pills.
 */
export function layoutMapNameLabels(
  options: MapNameLabelLayoutOptions,
): PlacedMapNameLabel[] {
  const {
    labels,
    camera,
    viewport,
    minAnchorDistancePx = MAP_NAME_LABEL_MIN_ANCHOR_DISTANCE_PX,
    pinOffsetPx = MAP_NAME_LABEL_PIN_OFFSET_PX,
    labelHeightPx = MAP_NAME_LABEL_HEIGHT_PX,
    gapPx = MAP_NAME_LABEL_GAP_PX,
  } = options;

  if (labels.length === 0) return [];

  const bearing = ((camera.bearing % 360) + 360) % 360;
  const rotated = bearing > 0.5 && bearing < 359.5;
  if (rotated || Math.abs(camera.tilt) > 0.5) return [];

  const insetTop = Math.max(0, viewport.insetTop ?? 0);
  const insetBottom = Math.max(0, viewport.insetBottom ?? 0);
  const insetLeft = Math.max(0, viewport.insetLeft ?? 0);
  const insetRight = Math.max(0, viewport.insetRight ?? 0);
  const rightEdge = viewport.width - insetRight;

  const ordered = labels
    .map((label, index) => ({ label, index }))
    .sort(
      (a, b) =>
        KIND_PRIORITY[a.label.kind] - KIND_PRIORITY[b.label.kind] ||
        a.index - b.index,
    );

  const placed: PlacedMapNameLabel[] = [];
  const boxes: LabelBox[] = [];

  for (const { label } of ordered) {
    if (!label.text.trim()) continue;
    const anchor = projectToMapBox(label.point, camera, viewport);
    if (!anchor) continue;

    // The pin itself has to be somewhere a person can actually look.
    if (anchor.x < insetLeft || anchor.x > rightEdge) continue;
    if (anchor.y < insetTop || anchor.y > viewport.height - insetBottom) {
      continue;
    }

    const box = pillBox(anchor, label.text, pinOffsetPx, labelHeightPx);
    if (box.left < insetLeft || box.right > rightEdge) continue;
    if (box.top < insetTop) continue;

    const crowded = placed.some(
      (other) =>
        Math.hypot(other.x - anchor.x, other.y - anchor.y) <
        minAnchorDistancePx,
    );
    if (crowded) continue;
    if (boxes.some((other) => overlaps(other, box, gapPx))) continue;

    boxes.push(box);
    placed.push({ ...label, x: anchor.x, y: anchor.y });
  }

  return placed;
}
