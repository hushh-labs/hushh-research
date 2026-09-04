import { describe, expect, it } from "vitest";

import {
  estimateMapNameLabelWidthPx,
  firstNameFromLabel,
  layoutMapNameLabels,
  projectToMapBox,
  MAP_NAME_LABEL_GAP_PX,
  MAP_NAME_LABEL_HEIGHT_PX,
  MAP_NAME_LABEL_MIN_ANCHOR_DISTANCE_PX,
  MAP_NAME_LABEL_PIN_OFFSET_PX,
  type MapNameLabelCamera,
  type MapNameLabelCandidate,
  type PlacedMapNameLabel,
} from "@/lib/one-location/map-name-labels";

/** A north-up camera over one degree of the world in each direction. */
function camera(overrides: Partial<MapNameLabelCamera> = {}): MapNameLabelCamera {
  return {
    north: 1,
    south: -1,
    east: 1,
    west: -1,
    zoom: 12,
    bearing: 0,
    tilt: 0,
    ...overrides,
  };
}

const VIEWPORT = { width: 400, height: 400 };

function person(
  key: string,
  latitude: number,
  longitude: number,
  text = key,
): MapNameLabelCandidate {
  return { key, text, kind: "person", point: { latitude, longitude } };
}

function boxOf(label: PlacedMapNameLabel) {
  const halfWidth = estimateMapNameLabelWidthPx(label.text) / 2;
  const bottom = label.y - MAP_NAME_LABEL_PIN_OFFSET_PX;
  return {
    left: label.x - halfWidth,
    right: label.x + halfWidth,
    top: bottom - MAP_NAME_LABEL_HEIGHT_PX,
    bottom,
  };
}

describe("firstNameFromLabel", () => {
  it("keeps only the name a person is called", () => {
    expect(firstNameFromLabel("Ankit Kumar Singh")).toBe("Ankit");
    expect(firstNameFromLabel("Neelesh")).toBe("Neelesh");
    expect(firstNameFromLabel("  Maya   Chen  ")).toBe("Maya");
  });

  it("survives the shapes a display name actually arrives in", () => {
    // A trailing comma from a "Surname, Given" entry must not reach the pill.
    expect(firstNameFromLabel("Rivera, Sam")).toBe("Rivera");
    // A login used as a display name is not a name; the local part is the
    // only human-sized piece of it.
    expect(firstNameFromLabel("ankit@example.com")).toBe("ankit");
    expect(firstNameFromLabel("‘Zoe’ Clarke")).toBe("Zoe");
  });

  it("returns nothing rather than a stray initial when there is no name", () => {
    // The caller picks its own fallback. Splitting "A trusted person" here
    // would put the single letter "A" over somebody's pin.
    expect(firstNameFromLabel("")).toBe("");
    expect(firstNameFromLabel("   ")).toBe("");
  });
});

describe("projectToMapBox", () => {
  it("puts the camera's centre in the middle of the map box", () => {
    const centre = projectToMapBox(
      { latitude: 0, longitude: 0 },
      camera(),
      VIEWPORT,
    );
    expect(centre?.x).toBeCloseTo(200, 6);
    expect(centre?.y).toBeCloseTo(200, 6);
  });

  it("grows y downward, because screens do", () => {
    const north = projectToMapBox(
      { latitude: 0.5, longitude: 0 },
      camera(),
      VIEWPORT,
    );
    expect(north?.y).toBeLessThan(200);
  });

  it("reads a camera straddling the antimeridian as the 20 degrees on screen", () => {
    // west=170, east=-170. A plain `east - west` is -340 here, which would put
    // every pin in the Pacific somewhere off the left edge.
    const straddling = camera({ west: 170, east: -170 });
    expect(
      projectToMapBox({ latitude: 0, longitude: 175 }, straddling, VIEWPORT)?.x,
    ).toBeCloseTo(100, 5);
    expect(
      projectToMapBox({ latitude: 0, longitude: -175 }, straddling, VIEWPORT)?.x,
    ).toBeCloseTo(300, 5);
  });

  it("treats a whole-world camera as 360 degrees, not zero", () => {
    const world = camera({ west: -180, east: 180, north: 60, south: -60 });
    expect(
      projectToMapBox({ latitude: 0, longitude: 0 }, world, VIEWPORT)?.x,
    ).toBeCloseTo(200, 5);
  });

  it("refuses a map box with no size", () => {
    expect(
      projectToMapBox({ latitude: 0, longitude: 0 }, camera(), {
        width: 0,
        height: 0,
      }),
    ).toBeNull();
  });
});

describe("layoutMapNameLabels", () => {
  it("draws nothing over a rotated or tilted map", () => {
    // The projection is flat. Under a bearing every name would sit over
    // somebody else's pin, and a wrong name is worse than no name.
    const labels = [person("maya", 0, 0)];
    expect(
      layoutMapNameLabels({
        labels,
        camera: camera({ bearing: 42 }),
        viewport: VIEWPORT,
      }),
    ).toEqual([]);
    expect(
      layoutMapNameLabels({
        labels,
        camera: camera({ tilt: 30 }),
        viewport: VIEWPORT,
      }),
    ).toEqual([]);
  });

  it("names every pin that has room of its own", () => {
    const placed = layoutMapNameLabels({
      labels: [person("maya", 0.5, -0.5), person("jordan", -0.5, 0.5)],
      camera: camera(),
      viewport: VIEWPORT,
    });
    expect(placed.map((label) => label.key)).toEqual(["maya", "jordan"]);
  });

  it("keeps you when your pill and somebody else's cannot both fit", () => {
    const placed = layoutMapNameLabels({
      labels: [
        person("maya", 0, 0.001),
        {
          key: "self",
          text: "My location",
          kind: "self",
          point: { latitude: 0, longitude: 0 },
        },
      ],
      camera: camera(),
      viewport: VIEWPORT,
    });
    // Input order put the other person first; priority, not order, decides.
    expect(placed.map((label) => label.key)).toEqual(["self"]);
  });

  it("drops a pin hidden under the top controls or the people tray", () => {
    const placed = layoutMapNameLabels({
      labels: [person("under-header", 0.9, 0), person("under-tray", -0.9, 0)],
      camera: camera(),
      viewport: { ...VIEWPORT, insetTop: 120, insetBottom: 120 },
    });
    expect(placed).toEqual([]);
  });

  it("drops a pill an edge would clip rather than drawing half of it", () => {
    const placed = layoutMapNameLabels({
      labels: [person("edge", 0, 0.999, "Maya")],
      camera: camera(),
      viewport: VIEWPORT,
    });
    expect(placed).toEqual([]);
  });

  it("keeps clear of the desktop check-in panel down the right edge", () => {
    // The panel is real UI over the map, not map. A name behind it is the same
    // as a name behind the header, and gets the same answer.
    const labels = [person("right-edge", 0, 0.7, "Maya")];
    expect(
      layoutMapNameLabels({ labels, camera: camera(), viewport: VIEWPORT }),
    ).toHaveLength(1);
    expect(
      layoutMapNameLabels({
        labels,
        camera: camera(),
        viewport: { ...VIEWPORT, insetRight: 160 },
      }),
    ).toEqual([]);
  });

  it("stays legible when the whole world is on screen", () => {
    // Fifty shares spread across a world view is the zoomed-out case: without
    // a rule, every name lands within a few hundred pixels of the others.
    const crowd = Array.from({ length: 50 }, (_, index) =>
      person(
        `p${index}`,
        ((index % 7) - 3) * 4,
        (Math.floor(index / 7) - 3) * 6,
        `Person${index}`,
      ),
    );
    const placed = layoutMapNameLabels({
      labels: crowd,
      camera: camera({ north: 60, south: -60, east: 60, west: -60 }),
      viewport: { width: 390, height: 844, insetTop: 96, insetBottom: 88 },
    });

    expect(placed.length).toBeGreaterThan(0);
    expect(placed.length).toBeLessThan(crowd.length);

    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i]!;
        const b = placed[j]!;
        const boxA = boxOf(a);
        const boxB = boxOf(b);
        const separated =
          boxA.right + MAP_NAME_LABEL_GAP_PX <= boxB.left ||
          boxB.right + MAP_NAME_LABEL_GAP_PX <= boxA.left ||
          boxA.bottom + MAP_NAME_LABEL_GAP_PX <= boxB.top ||
          boxB.bottom + MAP_NAME_LABEL_GAP_PX <= boxA.top;
        expect(separated).toBe(true);
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(
          MAP_NAME_LABEL_MIN_ANCHOR_DISTANCE_PX,
        );
      }
    }
  });

  it("spreads names further apart while the renderer is clustering", () => {
    // A clustered pin is not drawn at its own coordinate, so a name placed
    // there would label a bubble that stands for four people.
    const pair = [person("maya", 0, 0, "Maya"), person("jordan", -0.28, 0, "Jordan")];
    const options = { labels: pair, camera: camera(), viewport: VIEWPORT };
    expect(layoutMapNameLabels(options)).toHaveLength(2);
    expect(
      layoutMapNameLabels({ ...options, minAnchorDistancePx: 96 }),
    ).toHaveLength(1);
  });

  it("ignores a marker with nothing to say", () => {
    expect(
      layoutMapNameLabels({
        labels: [person("blank", 0, 0, "   ")],
        camera: camera(),
        viewport: VIEWPORT,
      }),
    ).toEqual([]);
  });
});
