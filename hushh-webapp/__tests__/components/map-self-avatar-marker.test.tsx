/**
 * The owner's own marker on Your Map, drawn as their avatar.
 *
 * These cases cover what the immersive-map suite cannot cheaply reach: the
 * marker's own edge conditions. The integration behaviour -- that the renderer
 * stops drawing a pin under it, that the "My location" pill goes away, that a
 * tap still flies the camera in -- is asserted in
 * `__tests__/components/location-immersive-map.test.tsx`, where the real
 * renderer harness lives.
 *
 * JSDOM performs no layout, so nothing here proves a pixel. What it proves is
 * the projection decision: WHERE the marker is told to sit, and when it refuses
 * to draw at all.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MapSelfAvatarMarker,
  SELF_AVATAR_MARKER_SIZE_PX,
} from "@/components/one-location/map-self-avatar-marker";
import type { MapNameLabelCamera } from "@/lib/one-location/map-name-labels";

/** A north-up, untilted camera over Prayagraj. The only camera shape that projects. */
const CAMERA: MapNameLabelCamera = {
  north: 25.47,
  south: 25.42,
  east: 81.87,
  west: 81.8,
  zoom: 12,
  bearing: 0,
  tilt: 0,
};

const VIEWPORT = {
  width: 390,
  height: 844,
  insetTop: 80,
  insetBottom: 96,
  insetLeft: 8,
  insetRight: 8,
};

/** Dead centre of that camera. */
const CENTRE_POINT = { latitude: 25.445, longitude: 81.835 };

beforeEach(() => {
  // Radix's Avatar preloads through `new window.Image()` and shows the
  // fallback until `load` fires. jsdom never fires it, so without this the
  // photo branch is unreachable and a photo assertion could not fail.
  class ImageStub {
    #listeners = new Map<string, Set<() => void>>();
    #src = "";
    referrerPolicy = "";
    crossOrigin: string | null = null;
    addEventListener(type: string, handler: () => void) {
      const set = this.#listeners.get(type) ?? new Set();
      set.add(handler);
      this.#listeners.set(type, set);
    }
    removeEventListener(type: string, handler: () => void) {
      this.#listeners.get(type)?.delete(handler);
    }
    get src() {
      return this.#src;
    }
    set src(value: string) {
      this.#src = value;
      queueMicrotask(() => {
        for (const handler of this.#listeners.get(value ? "load" : "error") ??
          []) {
          handler();
        }
      });
    }
  }
  vi.stubGlobal("Image", ImageStub);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderMarker(
  overrides: Partial<React.ComponentProps<typeof MapSelfAvatarMarker>> = {},
) {
  return render(
    <MapSelfAvatarMarker
      point={CENTRE_POINT}
      camera={CAMERA}
      viewport={VIEWPORT}
      avatarUrl={null}
      displayName="Ankit Kumar Singh"
      {...overrides}
    />,
  );
}

describe("MapSelfAvatarMarker", () => {
  it("sits centred on the coordinate, not above it like a pin", () => {
    renderMarker();

    const marker = screen.getByTestId("one-location-map-self-avatar");
    // Centre of the camera -> centre of the box. `translate(-50%, -50%)` is
    // what makes this a "you are here" puck rather than a pin whose tip marks
    // the spot; a pin offset would put the owner half a marker north of where
    // they are standing.
    const [, x, y] =
      /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/.exec(
        marker.getAttribute("style") ?? "",
      ) ?? [];
    expect(Number(x)).toBeCloseTo(VIEWPORT.width / 2, 3);
    // Mercator is not linear in latitude, so the camera's centre latitude does
    // not land on exactly half the box. A pin offset would be tens of pixels;
    // this is under one.
    expect(Number(y)).toBeCloseTo(VIEWPORT.height / 2, 0);
    expect(marker.getAttribute("style")).toContain("translate(-50%, -50%)");
  });

  it("meets the 44 px touch target the pin it replaced never had", () => {
    renderMarker();

    const marker = screen.getByTestId("one-location-map-self-avatar");
    expect(marker).toHaveStyle({
      width: `${SELF_AVATAR_MARKER_SIZE_PX}px`,
      height: `${SELF_AVATAR_MARKER_SIZE_PX}px`,
    });
    expect(SELF_AVATAR_MARKER_SIZE_PX).toBeGreaterThanOrEqual(44);
  });

  it("draws nothing before the renderer has reported a camera", () => {
    renderMarker({ camera: null });

    expect(
      screen.queryByTestId("one-location-map-self-avatar"),
    ).not.toBeInTheDocument();
  });

  it("draws nothing rather than clipping at the edge of the map box", () => {
    // Panned away. Clamping the marker to the edge would be worse than hiding
    // it: it would claim the owner is somewhere they are not.
    renderMarker({ point: { latitude: 45, longitude: 9 } });

    expect(
      screen.queryByTestId("one-location-map-self-avatar"),
    ).not.toBeInTheDocument();
  });

  it("shows the photo when there is one", async () => {
    renderMarker({ avatarUrl: "https://avatars.test/ankit.jpg" });

    const photo = await screen.findByTestId(
      "one-location-map-self-avatar-photo",
    );
    expect(photo).toHaveAttribute("src", "https://avatars.test/ankit.jpg");
    // Decorative: the button already carries the accessible name, and a
    // screen reader announcing the same person twice is noise.
    expect(photo).toHaveAttribute("alt", "");
  });

  it("uses the app's existing initials fallback when there is no photo", () => {
    renderMarker({ avatarUrl: null });

    expect(
      screen.getByTestId("one-location-map-self-avatar-fallback"),
    ).toHaveTextContent("AK");
  });

  it("falls back to the profile glyph when there is no name to take initials from", () => {
    renderMarker({ avatarUrl: null, displayName: null });

    const fallback = screen.getByTestId(
      "one-location-map-self-avatar-fallback",
    );
    expect(fallback).toBeInTheDocument();
    expect(fallback).toHaveTextContent("");
    expect(fallback.querySelector("svg")).not.toBeNull();
  });

  it("greys the ring when the position is stale, and never the face", () => {
    const { rerender } = renderMarker({
      avatarUrl: null,
      stale: false,
    });
    const ring = () =>
      screen
        .getByTestId("one-location-map-self-avatar")
        .querySelector("span[aria-hidden]");

    expect(ring()?.className).toContain("--app-accent");

    rerender(
      <MapSelfAvatarMarker
        point={CENTRE_POINT}
        camera={CAMERA}
        viewport={VIEWPORT}
        avatarUrl={null}
        displayName="Ankit Kumar Singh"
        stale
      />,
    );
    expect(ring()?.className).toContain("--muted-foreground");
    expect(screen.getByTestId("one-location-map-self-avatar")).toHaveAttribute(
      "data-stale",
      "true",
    );
  });

  it("fades out and stops taking taps while a native camera is mid-gesture", () => {
    // Same rule the name pills follow: iOS and Android report the camera only
    // once it settles, so holding the old position through a drag would walk
    // the marker away from where the person is.
    renderMarker({ stalePositions: true });

    const marker = screen.getByTestId("one-location-map-self-avatar");
    expect(marker).toHaveClass("opacity-0");
    expect(marker).toHaveClass("pointer-events-none");
  });

  it("says only that this is you", () => {
    const onSelect = vi.fn();
    renderMarker({ onSelect });

    const marker = screen.getByTestId("one-location-map-self-avatar");
    // Not the person's name. This is the surface built around not handing the
    // owner's identity to the map; announcing it here would undo that in the
    // accessibility tree.
    expect(marker).toHaveAccessibleName("Your location");
    expect(marker).not.toHaveAccessibleName(/Ankit/);

    fireEvent.click(marker);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
