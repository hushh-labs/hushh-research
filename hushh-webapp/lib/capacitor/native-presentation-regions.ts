"use client";

import { useLayoutEffect, useSyncExternalStore, type RefObject } from "react";
import { getNativeChromeCapabilities, peekNativeChromeCapabilities, nativeChrome } from "./native-chrome";
import { nativeDocumentId } from "./session-privacy";

export type NativePresentationRegions = {
  documentId: string;
  revision: number;
  viewport: { width: number; height: number };
  top: number;
  bottom: number;
  isolated: boolean;
};

let revision = 0;
let accepted: NativePresentationRegions | undefined;
let pending: { key: string; promise: Promise<boolean> } | undefined;
let isolated = false;
const isolatedSeats = new Map<HTMLElement, boolean>();
const listeners = new Set<() => void>();
let dockFrame: { documentId: string; revision: number; y: number } | undefined;

export function setNativeDockPresentationFrame(documentId: string, revision: number, y: number | null) {
  if (documentId !== nativeDocumentId() || (dockFrame && dockFrame.revision > revision)) return;
  if (y === null) dockFrame = undefined;
  else if (Number.isFinite(y) && y >= 0 && y < window.innerHeight) dockFrame = { documentId, revision, y };
  void syncNativePresentationRegions().catch(() => undefined);
}

function isolateSeats() {
  for (const [seat, previous] of isolatedSeats) seat.inert = previous;
  isolatedSeats.clear();
  if (!isolated || !accepted) return;
  for (const seat of document.querySelectorAll<HTMLElement>("[data-app-top-bar], [data-app-bottom-shell]")) {
    isolatedSeats.set(seat, seat.inert);
    seat.inert = true;
  }
}

export function setNativePresentationRegionIsolation(active: boolean) {
  isolated = active;
  isolateSeats();
  if (!peekNativeChromeCapabilities()?.reservedPresentationRegions) return;
  void syncNativePresentationRegions().catch(() => undefined);
}

/** Geometry from the existing shell owners, never DOM-inferred actions. */
function measureRegions(): Omit<NativePresentationRegions, "revision"> {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const topShell = document.querySelector<HTMLElement>("[data-app-top-bar]");
  const history = document.querySelector<HTMLElement>('[data-native-chrome-slot="chat-history-toggle"]');
  const bottomShell = document.querySelector<HTMLElement>("[data-app-bottom-shell]");
  const top = Math.ceil(Math.max(topShell?.getBoundingClientRect().bottom ?? 0,
    history?.getBoundingClientRect().bottom ?? 0));
  const bottom = Math.ceil(Math.max(bottomShell ? viewport.height - bottomShell.getBoundingClientRect().top : 0,
    dockFrame?.documentId === nativeDocumentId() ? viewport.height - dockFrame.y : 0));
  if (![top, bottom, viewport.width, viewport.height].every(Number.isFinite) ||
      top < 0 || bottom < 0 || viewport.width <= 0 || top + bottom >= viewport.height) {
    throw new Error("NATIVE_REGIONS_GEOMETRY_INVALID");
  }
  return { documentId: nativeDocumentId(), viewport, top, bottom, isolated };
}

/** Acknowledged layout precedes native visibility. Older wrappers keep their
 * existing overlay geometry. No gesture-frame writes or protected payloads. */
export async function syncNativePresentationRegions(): Promise<boolean> {
  const capability = await getNativeChromeCapabilities();
  if (!capability?.reservedPresentationRegions) return false;
  const measured = measureRegions();
  const key = JSON.stringify(measured);
  if (!pending && accepted && JSON.stringify({ documentId: accepted.documentId, viewport: accepted.viewport,
    top: accepted.top, bottom: accepted.bottom, isolated: accepted.isolated }) === key) { isolateSeats(); return true; }
  if (pending?.key === key) return pending.promise;
  const projection = { ...measured, revision: ++revision };
  const promise = (async () => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const receipt = await Promise.race([nativeChrome.setPresentationRegions(projection),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("NATIVE_REGIONS_ACK_UNCERTAIN")), 3000); })])
      .finally(() => clearTimeout(timeout));
    if (receipt.documentId !== projection.documentId || receipt.revision !== projection.revision ||
        receipt.top !== projection.top || receipt.bottom !== projection.bottom || receipt.isolated !== projection.isolated ||
        receipt.viewport.width !== projection.viewport.width || receipt.viewport.height !== projection.viewport.height) {
      throw new Error("NATIVE_REGIONS_ACK_UNCONFIRMED");
    }
    if (projection.revision !== revision || projection.documentId !== nativeDocumentId()) return false;
    accepted = projection;
    const root = document.documentElement;
    if (root.style.getPropertyValue("--native-overlay-top") !== `${projection.top}px`) {
      // perf-lint: allow root-custom-property-write -- Acknowledged shell resize only; never a gesture, scroll or stream frame.
      root.style.setProperty("--native-overlay-top", `${projection.top}px`);
    }
    if (root.style.getPropertyValue("--native-overlay-bottom") !== `${projection.bottom}px`) {
      // perf-lint: allow root-custom-property-write -- Acknowledged shell/keyboard geometry only; no per-frame bridge writer.
      root.style.setProperty("--native-overlay-bottom", `${projection.bottom}px`);
    }
    root.classList.add("native-reserved-chrome");
    isolateSeats();
    listeners.forEach(listener => listener());
    return true;
  })();
  const request = { key, promise };
  pending = request;
  try { return await promise; }
  finally { if (pending === request) pending = undefined; }
}

/** Observe only authored shell seats. Their dimensions, rather than route or
 * animation frames, reconcile the shared overlay region. */
export function useNativePresentationRegions(ref: RefObject<HTMLElement | null>, enabled: boolean) {
  useLayoutEffect(() => {
    if (!enabled || !ref.current) return;
    const reconcile = () => { void syncNativePresentationRegions().catch(() => undefined); };
    const observer = new ResizeObserver(reconcile);
    observer.observe(ref.current);
    window.addEventListener("resize", reconcile);
    reconcile();
    return () => {
      observer.disconnect(); window.removeEventListener("resize", reconcile);
      // Reconcile after React removes the departing authored seat. An obsolete
      // header must not leave a reservation on the next route.
      queueMicrotask(reconcile);
    };
  }, [ref, enabled]);
}

export function useNativeOverlayCollisionPadding(padding: number | Partial<Record<"top" | "right" | "bottom" | "left", number>> = 0) {
  const regions = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => accepted, () => undefined);
  const existing = typeof padding === "number" ? { top: padding, right: padding, bottom: padding, left: padding } : padding;
  return { ...existing, top: Math.max(existing.top ?? 0, regions?.top ?? 0),
    bottom: Math.max(existing.bottom ?? 0, regions?.bottom ?? 0) };
}

/** Reconcile a current presentation after another shell owner supersedes its
 * pending region receipt. This is layout admission, never an action replay. */
export function useNativePresentationRegionRevision() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => accepted?.documentId === nativeDocumentId() ? accepted.revision : 0, () => 0);
}
