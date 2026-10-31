/** A neutral fallback, never a person's name or photo URL in SDK arguments. */
const PERSON_MARKER_PLACEHOLDER =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='44' height='44' viewBox='0 0 44 44'%3E%3Ccircle cx='22' cy='22' r='18' fill='gray' stroke='white' stroke-width='3'/%3E%3C/svg%3E";

export function webPersonMarkerPlaceholder(stale: boolean): string {
  return PERSON_MARKER_PLACEHOLDER.replace("fill='gray'", stale ? "fill='gray'" : "fill='dodgerblue'");
}

export interface WebPersonAvatarBatch {
  hosts: ReadonlyMap<string, HTMLElement>;
  destroy(): void;
}

/**
 * Decorate public AdvancedMarkerElements before enabling clustering. The same
 * elements retain their coordinates, tap handlers and cluster membership.
 * React renders photos into local hosts, never into SDK arguments. Opaque
 * titles disambiguate people at exactly the same coordinate.
 */
export async function attachWebPersonAvatarHosts(
  mapElement: HTMLElement,
  titles: ReadonlyMap<string, string>,
  signal?: AbortSignal,
): Promise<WebPersonAvatarBatch> {
  const readMarkers = () => new Map(
    Array.from(mapElement.querySelectorAll<HTMLElement>("gmp-advanced-marker"))
      .map(marker => [marker.title, marker] as const),
  );
  // Google can attach an AdvancedMarker on its next draw, after addMarkers
  // resolves. Watch only this map until all opaque references arrive.
  const markers = await new Promise<Map<string, HTMLElement>>(resolve => {
    if (signal?.aborted || !titles.size) { resolve(new Map()); return; }
    const finish = (found: Map<string, HTMLElement>) => {
      observer.disconnect();
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(found);
    };
    const inspect = () => {
      const found = readMarkers();
      if ([...titles.values()].every(title => found.has(title))) finish(found);
    };
    const observer = new MutationObserver(inspect);
    const timer = setTimeout(() => finish(readMarkers()), 1500);
    const abort = () => finish(new Map());
    signal?.addEventListener("abort", abort, { once: true });
    observer.observe(mapElement, { childList: true, subtree: true });
    inspect();
  });
  const hosts = new Map<string, HTMLElement>();
  const cleanups: (() => void)[] = [];
  for (const [key, title] of titles) {
    const marker = markers.get(title);
    if (!marker) continue;
    const previous = Array.from(marker.childNodes);
    const host = document.createElement("div");
    host.style.width = "44px";
    host.style.height = "44px";
    marker.replaceChildren(host);
    marker.title = "Private location";
    hosts.set(key, host);
    cleanups.push(() => {
      if (host.parentNode === marker) marker.replaceChildren(...previous);
      host.remove();
    });
  }
  return {
    hosts,
    destroy() {
      cleanups.splice(0).forEach((cleanup) => cleanup());
      hosts.clear();
    },
  };
}
