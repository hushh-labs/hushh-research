import type { GoogleMap } from "@capacitor/google-maps";

export interface WebSelfAvatarOverlay {
  element: HTMLDivElement;
  setPoint(point: { latitude: number; longitude: number }): void;
  destroy(): void;
}

/**
 * Capacitor does not expose its web Map. A temporary transparent SDK marker
 * gives us its documented AdvancedMarkerElement.map reference. Remove that
 * probe BEFORE callers install/cluster private pins. No SDK private fields,
 * global constructor patches, identity URLs, or second map instance are used.
 */
export async function createWebSelfAvatarOverlay(
  map: GoogleMap,
  host: HTMLElement,
  initialCenter: { lat: number; lng: number },
): Promise<WebSelfAvatarOverlay> {
  const title = `one-avatar-host-${crypto.randomUUID()}`;
  const id = await map.addMarker({
    coordinate: initialCenter,
    title,
    iconUrl:
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/%3E",
    iconSize: { width: 1, height: 1 },
  });
  let renderer: google.maps.Map;
  try {
    renderer = await new Promise<google.maps.Map>((resolve, reject) => {
      const find = () => {
        const marker = Array.from(
          host.querySelectorAll("gmp-advanced-marker"),
        ).find(
          (node) =>
            (node as google.maps.marker.AdvancedMarkerElement).title === title,
        ) as google.maps.marker.AdvancedMarkerElement | undefined;
        if (!marker?.map) return false;
        observer.disconnect();
        clearTimeout(timer);
        resolve(marker.map as google.maps.Map);
        return true;
      };
      const observer = new MutationObserver(find);
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error("Web map overlay host unavailable"));
      }, 1500);
      observer.observe(host, { childList: true, subtree: true });
      find();
    });
  } finally {
    await map.removeMarker(id);
  }

  const element = document.createElement("div");
  element.style.position = "absolute";
  element.style.left = "0";
  element.style.top = "0";
  element.style.display = "none";
  let point: google.maps.LatLng | null = null;
  let disposed = false;
  const overlay = new google.maps.OverlayView();
  overlay.onAdd = () => {
    overlay.getPanes()?.overlayMouseTarget.appendChild(element);
    google.maps.OverlayView.preventMapHitsFrom(element);
  };
  overlay.draw = () => {
    if (disposed || !point) return;
    const pixel = overlay.getProjection()?.fromLatLngToDivPixel(point);
    if (!pixel) return;
    element.style.transform = `translate3d(${pixel.x}px, ${pixel.y}px, 0)`;
    element.style.display = "block";
  };
  overlay.onRemove = () => element.remove();
  overlay.setMap(renderer);
  return {
    element,
    setPoint(next) {
      if (disposed) return;
      point = new google.maps.LatLng(next.latitude, next.longitude);
      overlay.draw();
    },
    destroy() {
      disposed = true;
      element.style.display = "none";
      overlay.setMap(null);
      element.remove();
    },
  };
}
