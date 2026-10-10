"use client";

import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { customNativePresentationEnabled } from "./native-presentation-policy";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type Ref, type RefObject } from "react";
import { nativeDocumentId, subscribeNativeSessionPrivacy } from "@/lib/capacitor/session-privacy";
import { NATIVE_CONTROL_CONTRACT_VERSION, type NativeControlAppearance } from "@/lib/capacitor/native-control-appearance";
import type { NativeNavigationColumn } from "@/lib/capacitor/native-navigation-column";
import { setNativeBaseAperture, removeNativeBaseAperture } from "./native-base-apertures";
import type { ChromeFrame } from "./native-chrome";
import { nativePresentationAdmission, setNativePresentationRegionIsolation, syncNativePresentationRegions, useNativePresentationRegionRevision } from "./native-presentation-regions";

export const NATIVE_NAVIGATION_TABS = ["chat", "dashboard", "connect", "feed", "search"] as const;
export type NativeNavigationTab = typeof NATIVE_NAVIGATION_TABS[number];
type Geometry = { supported: boolean; contentHeight: number; bottomInset: number; frame?: ChromeFrame; presentationApplied?: boolean };
type Selection = { documentId: string; interactionEpoch: number; privacyGeneration: number; sequence: number; tab: NativeNavigationTab };
type NavigationState = NativeControlAppearance & {
  documentId: string;
  revision: number;
  interactionEpoch: number;
  visible: boolean;
  interactionEnabled: boolean;
  selected: NativeNavigationTab;
  feedAttention: boolean;
  column: NativeNavigationColumn;
  presentationRegionRevision?: number;
  privacyGeneration?: number;
};

export interface HushhNativeNavigationPlugin {
  getCapabilities(): Promise<Geometry & { contractVersion: number; columnLayout?: boolean; interactionIsolation?: boolean; underlayPresentation?: boolean; contentBackedPresentation?: boolean; reservedPresentationRegions?: boolean; fullWindowOverlays?: boolean }>;
  setState(options: NavigationState): Promise<Geometry>;
  confirmSelection(options: Selection): Promise<{ valid: boolean }>;
  addListener(eventName: "selectionRequested", listener: (event: Selection) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "geometryChanged", listener: (event: Geometry & { documentId?: string; revision?: number }) => void): Promise<PluginListenerHandle>;
}

// Registered on first use, not at import, like the session privacy plugin.
let nativeNavigationPlugin: HushhNativeNavigationPlugin | undefined;
function nativeNavigation(): HushhNativeNavigationPlugin {
  return (nativeNavigationPlugin ??= registerPlugin<HushhNativeNavigationPlugin>("HushhNativeNavigation"));
}
let documentId: string | undefined;
let revision = 0;
let operationQueue: Promise<unknown> = Promise.resolve();
let installed = false;
let nativeBottomInset = 0;
let interactionEpoch = 0;
const overlays = new Map<symbol, string | undefined>();
const subscribers = new Set<() => void>();
const subscribe = (listener: () => void) => {
  subscribers.add(listener);
  return () => { subscribers.delete(listener); };
};
function publish() {
  const drawers = new Set([...overlays.values()].flatMap(layer =>
    layer === "profile-pane" || layer === "profile-drag" ? ["profile" as const] :
    layer === "chat-history" || layer === "history-drag" ? ["history" as const] : []));
  // Ambiguous overlapping drawers never expose native pixels via one rectangle.
  setNativePresentationRegionIsolation(overlays.size > 0, drawers.size > 0,
    drawers.size === 1 ? [...drawers][0] : undefined);
  subscribers.forEach((listener) => listener());
}
function isNativeIOS() { return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios"; }
// Shared isolation authority for native shell controls. Do not create another
// overlay registry in individual plugins or feature components.
export function nativeShellOverlayBlocked(owningLayer?: string) {
  return [...overlays.values()].some((layer) => !owningLayer || layer !== owningLayer);
}
export function useNativeShellOverlayBlocked(owningLayer?: string) {
  return useSyncExternalStore(subscribe, () => nativeShellOverlayBlocked(owningLayer), () => false);
}
function setInstalled(next: boolean) {
  if (installed === next) return;
  installed = next;
  publish();
}
function sendState(state: NavigationState, current: () => boolean = () => true) {
  const operation = operationQueue.catch(() => undefined).then(() => current() ? nativeNavigation().setState(state) : undefined);
  operationQueue = operation;
  return operation;
}
function checkedHeight(height: number): number {
  if (!Number.isFinite(height) || height < 0 || height > 160) throw new Error("NATIVE_NAVIGATION_GEOMETRY_INVALID");
  return height;
}

/** Shared shell state, not a second routing or owner-information store. */
export function useNativeNavigationInstalled() {
  return useSyncExternalStore(subscribe, () => installed, () => false);
}

export function useNativeNavigationBottomInset() {
  return useSyncExternalStore(subscribe, () => installed ? nativeBottomInset : null, () => null);
}

export function useNativeNavigationBlocked(active: boolean, owningLayer?: string) {
  const token = useRef(Symbol("native-navigation-blocker"));
  useLayoutEffect(() => {
    if (!active || !isNativeIOS()) return;
    const blocker = token.current;
    overlays.set(blocker, owningLayer);
    publish();
    return () => { if (overlays.delete(blocker)) publish(); };
  }, [active, owningLayer]);
}

/** Keep the existing overlay token through the actual panel exit, including
 * interrupted/reopened transitions. Descendant loading animations do not own it. */
export function useNativeNavigationBlockedUntilSettled(active: boolean, owningLayer: string, ref: RefObject<HTMLElement | null>) {
  const [retained, setRetained] = useState(active);
  useNativeNavigationBlocked(active || retained, owningLayer);
  useLayoutEffect(() => {
    if (active) { setRetained(true); return; }
    if (!retained) return;
    let current = true;
    const frame = requestAnimationFrame(() => {
      const panel = ref.current;
      const animations = panel?.getAnimations?.().filter(animation =>
        (animation.effect as KeyframeEffect | null)?.target === panel &&
        animation.effect?.getComputedTiming().iterations !== Infinity) ?? [];
      void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
        if (current) setRetained(false);
      });
    });
    return () => { current = false; cancelAnimationFrame(frame); };
  }, [active, retained, ref]);
}

/** Native controls are outside the DOM: authored overlay mounts must isolate them too. */
export function useNativeNavigationOverlayRef<T extends HTMLElement>(forwardedRef?: Ref<T>, enabled = true, owningLayer?: string) {
  const token = useRef(Symbol("native-navigation-overlay"));
  const release = useCallback(() => {
    if (overlays.delete(token.current)) publish();
  }, []);
  useLayoutEffect(() => release, [release]);
  return useCallback((node: T | null) => {
    if (isNativeIOS()) {
      if (node && enabled) { overlays.set(token.current, owningLayer); publish(); } else release();
    }
    if (typeof forwardedRef === "function") forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  }, [enabled, forwardedRef, release, owningLayer]);
}

export function useNativeNavigation({ enabled, visible, interactionEnabled = true, selected, feedAttention, appearance, accentHex, foregroundHex, column, onSelect }: NativeControlAppearance & {
  enabled: boolean;
  visible: boolean;
  interactionEnabled?: boolean;
  selected: NativeNavigationTab;
  feedAttention: boolean;
  column: NativeNavigationColumn | null;
  onSelect: (tab: NativeNavigationTab) => void;
}) {
  const [supported, setSupported] = useState(false);
  const [interactionIsolation, setInteractionIsolation] = useState(false);
  const [ready, setReady] = useState(false);
  const [discovering, setDiscovering] = useState(() => enabled && isNativeIOS());
  const [height, setHeight] = useState(49);
  const overlayBlocked = useSyncExternalStore(subscribe, () => overlays.size > 0, () => false);
  const regionRevision = useNativePresentationRegionRevision();
  const current = useRef<NavigationState | null>(null);
  const select = useRef(onSelect);
  const lastSelection = useRef(0);
  const underlayPresentation = useRef(false);
  const reservedRegions = useRef(false);
  const apertureRevision = useRef<number | undefined>(undefined);
  const applyAperture = useCallback((geometry: Geometry, state: NavigationState) => {
    if (!underlayPresentation.current) return;
    if (!state.visible) {
      if (apertureRevision.current !== undefined) removeNativeBaseAperture("bottom-navigation", apertureRevision.current);
      apertureRevision.current = undefined;
      return;
    }
    const frame = geometry.frame;
    if (!frame || ![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) ||
        frame.x < 0 || frame.y < 0 || frame.width <= 0 || frame.height <= 0 ||
        frame.x + frame.width > window.innerWidth + 1 || frame.y + frame.height > window.innerHeight + 1) {
      throw new Error("NATIVE_NAVIGATION_GEOMETRY_INVALID");
    }
    setNativeBaseAperture("bottom-navigation", state.revision, frame);
    apertureRevision.current = state.revision;
  }, []);
  select.current = onSelect;

  useEffect(() => {
    if (!enabled || !isNativeIOS()) return;
    let cancelled = false;
    let confirmationEpoch = 0;
    const invalidateConfirmations = () => { confirmationEpoch += 1; };
    document.addEventListener("visibilitychange", invalidateConfirmations);
    const handles: PluginListenerHandle[] = [];
    const retain = async (pending: Promise<PluginListenerHandle>) => {
      const handle = await pending;
      if (cancelled) await handle.remove(); else handles.push(handle);
    };
    void (async () => {
      try {
        const capability = await nativeNavigation().getCapabilities();
        if (!capability.supported || capability.contractVersion !== NATIVE_CONTROL_CONTRACT_VERSION || capability.columnLayout !== true || cancelled) return;
        // Experimental wrappers requiring apertures/regions cannot host the
        // recovery renderer. Use their established web fallback, never strand
        // a reserved bar or resurrect the rejected custom composition.
        if (!customNativePresentationEnabled() && (capability.underlayPresentation ||
            capability.contentBackedPresentation || capability.reservedPresentationRegions)) return;
        underlayPresentation.current = capability.underlayPresentation === true;
        reservedRegions.current = capability.reservedPresentationRegions === true;
        documentId ??= nativeDocumentId();
        await retain(subscribeNativeSessionPrivacy(invalidateConfirmations));
        await retain(nativeNavigation().addListener("selectionRequested", (event) => {
          const state = current.current;
          if (!state?.visible || !state.interactionEnabled || overlays.size > 0 || event.documentId !== state.documentId ||
              event.interactionEpoch !== state.interactionEpoch || !Number.isSafeInteger(event.sequence) ||
              event.sequence <= lastSelection.current || !NATIVE_NAVIGATION_TABS.includes(event.tab)) return;
          const requestEpoch = confirmationEpoch;
          void nativeNavigation().confirmSelection(event).then(({ valid }) => {
            const latest = current.current;
            if (!valid || cancelled || requestEpoch !== confirmationEpoch || !latest?.visible || !latest.interactionEnabled || overlays.size > 0 ||
                document.visibilityState === "hidden" || event.documentId !== latest.documentId ||
                event.interactionEpoch !== latest.interactionEpoch || event.sequence <= lastSelection.current) return;
            lastSelection.current = event.sequence;
            select.current(event.tab);
          }).catch(() => undefined);
        }));
        await retain(nativeNavigation().addListener("geometryChanged", (event) => {
          if (!cancelled) {
            try {
              const state = current.current;
              if (underlayPresentation.current && (!state || event.documentId !== state.documentId || event.revision !== state.revision)) return;
              const contentHeight = checkedHeight(event.contentHeight);
              nativeBottomInset = checkedHeight(event.bottomInset);
              setHeight(contentHeight);
              if (state && event.documentId === state.documentId && event.revision === state.revision) applyAperture(event, state);
              publish();
            } catch { /* Retain the last valid reservation. */ }
          }
        }));
        if (!cancelled) {
          // Qualified regions keep DOM overlays away from the native strip.
          // Older foreground pilots still conceal safely during coverage.
          setInteractionIsolation(customNativePresentationEnabled() && capability.interactionIsolation === true &&
            (capability.contentBackedPresentation !== true || reservedRegions.current));
          setSupported(true);
        }
      } catch { /* Old wrappers and non-iOS builds retain the existing web navigation. */ }
      finally { if (!cancelled) setDiscovering(false); }
    })();
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", invalidateConfirmations);
      handles.forEach((handle) => { void handle.remove(); });
      const state = current.current;
      current.current = null;
      if (apertureRevision.current !== undefined) removeNativeBaseAperture("bottom-navigation", apertureRevision.current);
      apertureRevision.current = undefined;
      if (state) void sendState({ ...state, visible: false, interactionEnabled: false, revision: ++revision }).catch(() => undefined);
      setInstalled(false);
    };
  }, [enabled, applyAperture]);

  useLayoutEffect(() => {
    const retainedColumn = column ?? current.current?.column;
    if (!supported || !documentId || !retainedColumn || !/^#[\da-f]{6}$/i.test(accentHex) || !/^#[\da-f]{6}$/i.test(foregroundHex)) return;
    const nextInteractionEnabled = visible && column !== null && interactionEnabled && !overlayBlocked;
    // Legacy wrappers lack a separate interaction fence: retain their safe hide
    // behavior. Negotiated wrappers retain presentation during overlay isolation.
    const nextVisible = visible && column !== null && (interactionIsolation || nextInteractionEnabled);
    if (!current.current || current.current.visible !== nextVisible ||
        current.current.interactionEnabled !== nextInteractionEnabled) interactionEpoch += 1;
    const state: NavigationState = {
      documentId, revision: ++revision, interactionEpoch, visible: nextVisible, interactionEnabled: nextInteractionEnabled,
      selected, feedAttention, appearance, accentHex, foregroundHex, column: retainedColumn,
    };
    current.current = state;
    let cancelled = false;
    void (reservedRegions.current ? syncNativePresentationRegions() : Promise.resolve(true)).then((confirmed) => {
      if (!confirmed || cancelled || current.current !== state) return undefined;
      return sendState({ ...state, ...nativePresentationAdmission() }, () => !cancelled && current.current === state);
    }).then((result) => {
      if (!result || result.presentationApplied === false) return;
      if (cancelled || current.current !== state || !result.supported) return;
      setHeight(checkedHeight(result.contentHeight));
      nativeBottomInset = checkedHeight(result.bottomInset);
      applyAperture(result, state);
      setReady(true);
      setInstalled(true);
      publish();
    }).catch(() => {
      // Never expose duplicate DOM tabs after a previously accepted native installation.
      // No provider/session content enters this diagnostic.
      console.warn("NATIVE_NAVIGATION_STATE_UNAVAILABLE");
    });
    return () => { cancelled = true; };
  }, [supported, interactionIsolation, visible, interactionEnabled, overlayBlocked, selected, feedAttention, appearance, accentHex, foregroundHex, applyAperture, regionRevision, column]);

  return { ready, height, reserved: ready || discovering || supported };
}
