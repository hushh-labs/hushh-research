import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoogleMap } from "@capacitor/google-maps";
import { createWebSelfAvatarOverlay } from "@/lib/one-location/web-self-avatar-overlay";

let sdkOverlay: {
  draw: () => void;
  onAdd: () => void;
  onRemove: () => void;
  setMap: ReturnType<typeof vi.fn>;
};
let pane: HTMLDivElement;
let pixel = { x: 15, y: 25 };
beforeEach(() => {
  pane = document.createElement("div");
  document.body.appendChild(pane);
  class Overlay {
    static preventMapHitsFrom = vi.fn();
    onAdd = () => {};
    onRemove = () => {};
    draw = () => {};
    setMap = vi.fn((map) => (map ? this.onAdd() : this.onRemove()));
    getPanes = () => ({ overlayMouseTarget: pane });
    getProjection = () => ({ fromLatLngToDivPixel: () => pixel });
    constructor() {
      sdkOverlay = this;
    }
  }
  vi.stubGlobal("google", {
    maps: {
      OverlayView: Overlay,
      LatLng: class {
        constructor(
          public lat: number,
          public lng: number,
        ) {}
      },
    },
  });
});
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function fixture(attach = true) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const renderer = {};
  const map = {
    getMapBounds: vi.fn(async () => ({ center: { lat: 25, lng: 81 } })),
    addMarker: vi.fn(async ({ title }) => {
      if (attach) {
        const marker = document.createElement("gmp-advanced-marker");
        Object.assign(marker, { title, map: renderer });
        host.appendChild(marker);
      }
      return "probe-id";
    }),
    removeMarker: vi.fn(async () => {
      host.replaceChildren();
    }),
  };
  return { host, renderer, map };
}

describe("web self avatar overlay", () => {
  it("removes its neutral probe before exposing an SDK-positioned, non-clustered HTML host", async () => {
    const { host, renderer, map } = fixture();
    const overlay = await createWebSelfAvatarOverlay(
      map as unknown as GoogleMap,
      host,
      { lat: 25, lng: 81 },
    );
    expect(map.removeMarker).toHaveBeenCalledWith("probe-id");
    expect(host.children).toHaveLength(0);
    expect(sdkOverlay.setMap).toHaveBeenCalledWith(renderer);
    expect(overlay.element.parentElement).toBe(pane);
    overlay.setPoint({ latitude: 25.445, longitude: 81.835 });
    expect(overlay.element.style.transform).toBe("translate3d(15px, 25px, 0)");
    const photo = document.createElement("img");
    overlay.element.appendChild(photo);
    pixel = { x: -20, y: 90 };
    sdkOverlay.draw();
    expect(overlay.element.style.transform).toBe("translate3d(-20px, 90px, 0)");
    expect(overlay.element.firstChild).toBe(photo);
    expect(map.addMarker).toHaveBeenCalledTimes(1);
    overlay.destroy();
    expect(overlay.element.isConnected).toBe(false);
    expect(sdkOverlay.setMap).toHaveBeenLastCalledWith(null);
    overlay.setPoint({ latitude: 0, longitude: 0 });
    sdkOverlay.draw();
    expect(overlay.element.style.display).toBe("none");
  });

  it("removes the probe and fails closed if an adapter has no public marker map reference", async () => {
    vi.useFakeTimers();
    const { host, map } = fixture(false);
    const result = createWebSelfAvatarOverlay(
      map as unknown as GoogleMap,
      host,
      { lat: 25, lng: 81 },
    );
    const rejection = expect(result).rejects.toThrow(
      "Web map overlay host unavailable",
    );
    await vi.advanceTimersByTimeAsync(1500);
    await rejection;
    expect(map.removeMarker).toHaveBeenCalledWith("probe-id");
  });
});
