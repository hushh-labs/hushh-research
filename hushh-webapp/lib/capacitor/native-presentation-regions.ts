"use client";

import { useLayoutEffect, useState, useSyncExternalStore, type RefObject } from "react";
import { customNativePresentationEnabled } from "./native-presentation-policy";
import { getNativeChromeCapabilities, peekNativeChromeCapabilities, nativeChrome } from "./native-chrome";
import { getNativeSessionPrivacyState, nativeDocumentId, subscribeNativeSessionPrivacy, type NativeSessionPrivacyState } from "./session-privacy";
import type { NativePanelIdentity, NativePanelPose } from "./native-panel-presentation";

export type NativePresentationRegions = {
  documentId: string;
  revision: number;
  viewport: { width: number; height: number };
  top: number;
  bottom: number;
  isolated: boolean;
  covered?: boolean;
  privacyGeneration?: number;
  drawer?: "profile" | "history";
  initialDrawerPose?: NativePanelPose;
  /** Receipt only: false retains newer acknowledged same-owner geometry. */
  initialDrawerPoseApplied?: boolean;
};

let revision = 0;
let accepted: NativePresentationRegions | undefined;
let acceptedKey: string | undefined;
let pending: { key: string; promise: Promise<boolean> } | undefined;
let isolated = false;
let covered = false;
let drawer: NativePresentationRegions["drawer"];
const isolatedSeats = new Map<HTMLElement, boolean>();
const listeners = new Set<() => void>();
let dockFrame: { documentId: string; revision: number; y: number } | undefined;
const drawerSources = new Map<NativePanelIdentity["group"], {
  identity: NativePanelIdentity; sample: (privacyGeneration: number) => NativePanelPose | undefined;
}>();

/** Authored presentation only. Dormant registration changes no admission. */
export function registerNativeDrawerPose(identity: NativePanelIdentity,
  sample: (privacyGeneration: number) => NativePanelPose | undefined) {
  if (!customNativePresentationEnabled()) return () => undefined;
  const source = { identity, sample };
  drawerSources.set(identity.group, source);
  if (covered && drawer === identity.group) void syncNativePresentationRegions().catch(() => undefined);
  return () => { if (drawerSources.get(identity.group) === source) drawerSources.delete(identity.group); };
}

export function setNativeDockPresentationFrame(documentId: string, revision: number, y: number | null) {
  if (!customNativePresentationEnabled()) return;
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

export function setNativePresentationRegionIsolation(active: boolean, cover = false, owningDrawer?: NativePresentationRegions["drawer"]) {
  isolated = active;
  covered = active && cover;
  drawer = covered ? owningDrawer : undefined;
  isolateSeats();
  if (!customNativePresentationEnabled() || !peekNativeChromeCapabilities()?.reservedPresentationRegions) return;
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
  if (!customNativePresentationEnabled()) return false;
  const capability = await getNativeChromeCapabilities();
  if (!capability?.reservedPresentationRegions) return false;
  const privacy = capability.fullWindowOverlays ? await getNativeSessionPrivacyState() : undefined;
  const measured = { ...measureRegions(), ...(privacy ? { covered, privacyGeneration: privacy.generation } : {}),
    ...(capability.drawerClipping && covered && drawer ? { drawer } : {}) };
  const source = capability.atomicDrawerCoverage && measured.drawer ? drawerSources.get(measured.drawer) : undefined;
  const currentSource = source?.identity.documentId === measured.documentId ? source : undefined;
  const key = JSON.stringify([measured, currentSource?.identity]);
  if (!pending && accepted && acceptedKey === key) { isolateSeats(); return true; }
  if (pending?.key === key) return pending.promise;
  const initialDrawerPose = privacy && currentSource?.sample(privacy.generation);
  const projection = { ...measured, revision: ++revision, ...(initialDrawerPose ? { initialDrawerPose } : {}) };
  const promise = (async () => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const receipt = await Promise.race([nativeChrome.setPresentationRegions(projection),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("NATIVE_REGIONS_ACK_UNCERTAIN")), 3000); })])
      .finally(() => clearTimeout(timeout));
    if (receipt.documentId !== projection.documentId || receipt.revision !== projection.revision ||
        receipt.top !== projection.top || receipt.bottom !== projection.bottom || receipt.isolated !== projection.isolated ||
        receipt.covered !== projection.covered || receipt.privacyGeneration !== projection.privacyGeneration ||
        receipt.drawer !== projection.drawer ||
        (projection.initialDrawerPose && (!receipt.initialDrawerPose ||
          ["documentId", "ownerEpoch", "group", "generation", "sequence", "privacyGeneration"].some(field =>
            receipt.initialDrawerPose![field as keyof NativePanelPose] !== projection.initialDrawerPose![field as keyof NativePanelPose]))) ||
        receipt.viewport.width !== projection.viewport.width || receipt.viewport.height !== projection.viewport.height) {
      throw new Error("NATIVE_REGIONS_ACK_UNCONFIRMED");
    }
    if (projection.revision !== revision || projection.documentId !== nativeDocumentId() ||
        projection.covered !== undefined && (projection.covered !== covered || projection.isolated !== isolated ||
          capability.drawerClipping && projection.drawer !== drawer ||
          (await getNativeSessionPrivacyState()).generation !== projection.privacyGeneration)) return false;
    // Privacy readback is asynchronous; a newer cover request can arrive while
    // it is in flight even when the earlier revision check already passed.
    if (projection.revision !== revision || projection.documentId !== nativeDocumentId()) return false;
    if (capability.atomicDrawerCoverage && measured.drawer && drawerSources.get(measured.drawer) !== currentSource) return false;
    accepted = projection;
    acceptedKey = key;
    const root = document.documentElement;
    const top = projection.covered ? 0 : projection.top;
    const bottom = projection.covered ? 0 : projection.bottom;
    if (root.style.getPropertyValue("--native-overlay-top") !== `${top}px`) {
      // perf-lint: allow root-custom-property-write -- Acknowledged shell resize only; never a gesture, scroll or stream frame.
      root.style.setProperty("--native-overlay-top", `${top}px`);
    }
    if (root.style.getPropertyValue("--native-overlay-bottom") !== `${bottom}px`) {
      // perf-lint: allow root-custom-property-write -- Acknowledged shell/keyboard geometry only; no per-frame bridge writer.
      root.style.setProperty("--native-overlay-bottom", `${bottom}px`);
    }
    root.classList.add("native-reserved-chrome");
    root.classList.toggle("native-full-window-overlays", capability.fullWindowOverlays === true);
    root.toggleAttribute("data-native-full-window-covered", projection.covered === true);
    isolateSeats();
    listeners.forEach(listener => listener());
    return true;
  })();
  const request = { key, promise };
  pending = request;
  try { return await promise; }
  catch (error) {
    // Native rejects out-of-order layout work. Its failure belongs to that
    // superseded projection, not to the current dock/control awaiting it.
    // A current failure still reaches its owner and retires fail-closed.
    if (projection.revision !== revision || projection.documentId !== nativeDocumentId() ||
        capability.atomicDrawerCoverage && measured.drawer && drawerSources.get(measured.drawer) !== currentSource) return false;
    throw error;
  }
  finally { if (pending === request) pending = undefined; }
}

/** Observe only authored shell seats. Their dimensions, rather than route or
 * animation frames, reconcile the shared overlay region. */
export function useNativePresentationRegions(ref: RefObject<HTMLElement | null>, enabled: boolean) {
  useLayoutEffect(() => {
    if (!customNativePresentationEnabled() || !enabled || !ref.current) return;
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
  if (regions?.covered) return existing;
  return { ...existing, top: Math.max(existing.top ?? 0, regions?.top ?? 0),
    bottom: Math.max(existing.bottom ?? 0, regions?.bottom ?? 0) };
}

/** Full-height modal admission is independent of its requested open state. */
export function useNativeFullWindowOverlayReady(active: boolean) {
  const ready = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => !customNativePresentationEnabled() || !active || !peekNativeChromeCapabilities()?.fullWindowOverlays ||
      accepted?.documentId === nativeDocumentId() && accepted.covered === true && accepted.isolated &&
      covered && isolated && accepted.revision === revision, () => true);
  const [entry, setEntry] = useState({ active, admitted: ready });
  if (entry.active !== active || ready && !entry.admitted) setEntry({ active, admitted: ready });
  // A newer geometry receipt must not remount an already admitted open pane.
  return !active || ready || entry.active === active && entry.admitted;
}

/** Optional ordered admission fence for wrappers supporting full-window cover. */
export function nativePresentationAdmission() {
  return accepted?.documentId === nativeDocumentId() && accepted.privacyGeneration !== undefined
    ? { presentationRegionRevision: accepted.revision, privacyGeneration: accepted.privacyGeneration } : {};
}

/** Pose metadata for the currently acknowledged authored drawer, never content. */
export function nativeDrawerPresentationAdmission(group: "profile" | "history") {
  return accepted?.documentId === nativeDocumentId() && accepted.covered && accepted.drawer === group &&
    accepted.revision === revision ? nativePresentationAdmission() : undefined;
}

/** Stop the writer before calling this. Normal teardown keeps the last bounded
 * presentation until current coverage is released; privacy or uncertainty ends
 * the wait so the captured generation can retire fail-closed. No action replay. */
export function waitForNativeDrawerCoverageRelease(documentId: string, privacyGeneration: number):
  Promise<"released" | "invalidated" | "uncertain"> {
  return new Promise(resolve => {
    let finished = false, privacyValidated = false;
    let handle: Awaited<ReturnType<typeof subscribeNativeSessionPrivacy>> | undefined;
    const finish = (result: "released" | "invalidated" | "uncertain") => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); listeners.delete(inspect);
      void handle?.remove().catch(() => undefined);
      resolve(result);
    };
    const inspect = () => {
      if (documentId !== nativeDocumentId()) { finish("invalidated"); return; }
      if (privacyValidated && !covered && accepted?.documentId === documentId &&
          accepted.revision === revision && accepted.covered === false &&
          accepted.privacyGeneration === privacyGeneration) finish("released");
    };
    const observePrivacy = (state: NativeSessionPrivacyState) => {
      if (state.shielded || !state.appIsActive || state.generation !== privacyGeneration) {
        finish("invalidated"); return;
      }
      privacyValidated = true; inspect();
    };
    const timer = setTimeout(() => finish("uncertain"), 3000);
    listeners.add(inspect);
    inspect();
    void (async () => {
      try {
        const subscription = await subscribeNativeSessionPrivacy(observePrivacy);
        if (finished) { await subscription.remove(); return; }
        handle = subscription;
        observePrivacy(await getNativeSessionPrivacyState());
      } catch { finish("uncertain"); }
    })();
  });
}

/** Reconcile a current presentation after another shell owner supersedes its
 * pending region receipt. This is layout admission, never an action replay. */
export function useNativePresentationRegionRevision() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => accepted?.documentId === nativeDocumentId() ? accepted.revision : 0, () => 0);
}
