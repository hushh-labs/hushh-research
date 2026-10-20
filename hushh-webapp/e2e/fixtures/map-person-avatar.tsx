import { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MapPersonAvatarMarker } from "@/components/one-location/map-person-avatar-marker";
import { MapSelfAvatarMarker } from "@/components/one-location/map-self-avatar-marker";
import { attachWebPersonAvatarHosts, type WebPersonAvatarBatch } from "@/lib/one-location/web-person-avatar-markers";
import type { WebSelfAvatarOverlay } from "@/lib/one-location/web-self-avatar-overlay";

const PHOTO = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect width="60" height="60" fill="#57a"/><circle cx="30" cy="23" r="13" fill="#fc9"/><path d="M8 60a22 24 0 0 1 44 0" fill="#234"/></svg>')}`;
const POINT = { latitude: 25.445, longitude: 81.835 };
const VIEWPORT = { width: 390, height: 844, insetTop: 0, insetBottom: 0, insetLeft: 0, insetRight: 0 };

function MapAvatarFixture() {
  const map = useRef<HTMLDivElement>(null);
  const marker = useRef<HTMLElement | null>(null);
  const batch = useRef<WebPersonAvatarBatch | null>(null);
  const [hosts, setHosts] = useState<ReadonlyMap<string, HTMLElement>>(new Map());
  const [selfOverlay, setSelfOverlay] = useState<WebSelfAvatarOverlay | null>(null);
  const [selections, setSelections] = useState(0);
  useLayoutEffect(() => {
    const element = document.createElement("gmp-advanced-marker");
    element.title = "opaque-fixture-reference";
    element.dataset.testid = "sdk-person-marker";
    element.setAttribute("role", "button");
    element.setAttribute("aria-label", "Shared location");
    element.tabIndex = 0;
    Object.assign(element.style, { position: "absolute", left: "60%", top: "45%", transform: "translate(-50%, -100%)" });
    element.addEventListener("click", () => setSelections(value => value + 1));
    element.addEventListener("keydown", event => { if (event.key === "Enter") element.click(); });
    element.appendChild(document.createElement("img"));
    map.current!.appendChild(element);
    marker.current = element;
    const self = document.createElement("div");
    Object.assign(self.style, { position: "absolute", left: "30%", top: "65%" });
    map.current!.appendChild(self);
    setSelfOverlay({ element: self, setPoint() {}, destroy() { self.remove(); } });
    const controller = new AbortController();
    void attachWebPersonAvatarHosts(map.current!, new Map([["person", element.title]]), controller.signal).then(next => {
      if (controller.signal.aborted) { next.destroy(); return; }
      batch.current = next;
      setHosts(next.hosts);
    });
    return () => { controller.abort(); batch.current?.destroy(); element.remove(); self.remove(); };
  }, []);
  return (
    <main className="relative h-dvh w-full overflow-hidden bg-muted">
      <div ref={map} data-testid="map-renderer" className="absolute inset-0" />
      {hosts.has("person") ? <MapPersonAvatarMarker rendererElement={hosts.get("person")!}
        point={POINT} camera={null} viewport={VIEWPORT} avatarUrl={PHOTO} displayName="Demo Person" /> : null}
      {selfOverlay ? <MapSelfAvatarMarker rendererOverlay={selfOverlay} point={POINT}
        camera={null} viewport={VIEWPORT} avatarUrl={PHOTO} displayName="Demo Owner" /> : null}
      <div className="absolute bottom-4 left-4 flex gap-2">
        <button onClick={() => { marker.current!.style.left = "75%"; }}>Pan</button>
        <button onClick={() => marker.current!.remove()}>Cluster</button>
        <button onClick={() => map.current!.appendChild(marker.current!)}>Expand</button>
        <output data-testid="selections">{selections}</output>
      </div>
    </main>
  );
}

export function mountMapPersonAvatarFixture() {
  createRoot(document.getElementById("root")!).render(<MapAvatarFixture />);
}
