"use client";

import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { customNativePresentationEnabled } from "./native-presentation-policy";
import { nativeDrawerIsolation } from "./native-drawers";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type Ref, type RefObject } from "react";
import { nativeDocumentId, nativePrivacyObservation, subscribeNativePrivacyObservation, subscribeNativeSessionPrivacy, type NativeSessionPrivacyState } from "@/lib/capacitor/session-privacy";
import { type NativeControlAppearance } from "@/lib/capacitor/native-control-appearance";
import { setNativeBaseAperture, removeNativeBaseAperture } from "./native-base-apertures";
import type { ChromeFrame } from "./native-chrome";
import { nativePresentationAdmission, setNativePresentationRegionIsolation, syncNativePresentationRegions, useNativePresentationRegionRevision } from "./native-presentation-regions";
import { bottomChromeScrollTravel, snapKaiBottomChromeVisible, subscribeKaiBottomChromeProgress } from "@/lib/navigation/kai-bottom-chrome-visibility";
import { NativeNavigationScrollDelivery, type NativeNavigationScroll, type NativeNavigationScrollReset } from "./native-navigation-scroll";

export const NATIVE_NAVIGATION_CONTRACT_VERSION = 3;
export const NATIVE_NAVIGATION_TABS = ["chat", "dashboard", "connect", "feed"] as const;
export type NativeNavigationTab = typeof NATIVE_NAVIGATION_TABS[number];
type Geometry = { supported: boolean; contentHeight: number; bottomInset: number; frame?: ChromeFrame; presentationApplied?: boolean;
  scrollGeneration?: number; privacyGeneration?: number; scrollFollowing?: boolean };
type Selection = { documentId: string; interactionEpoch: number; privacyGeneration: number; sequence: number; tab: NativeNavigationTab };
type NavigationState = NativeControlAppearance & {
  documentId: string;
  revision: number;
  interactionEpoch: number;
  visible: boolean;
  interactionEnabled: boolean;
  selected: NativeNavigationTab;
  feedAttention: boolean;
  scrollFollowing?: boolean;
  presentationRegionRevision?: number;
  privacyGeneration?: number;
};

export interface HushhNativeNavigationPlugin {
  getCapabilities(): Promise<Geometry & { contractVersion: number; interactionIsolation?: boolean; underlayPresentation?: boolean; contentBackedPresentation?: boolean; reservedPresentationRegions?: boolean; fullWindowOverlays?: boolean; wholeNativeDrawers?: boolean; synchronizedBottomScroll?: boolean }>;
  setState(options: NavigationState): Promise<Geometry>;
  setScroll?(options: NativeNavigationScroll): Promise<{ applied: boolean }>;
  confirmSelection(options: Selection): Promise<{ valid: boolean }>;
  addListener(eventName: "selectionRequested", listener: (event: Selection) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "geometryChanged", listener: (event: Geometry & { documentId?: string; revision?: number }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "scrollResetRequested", listener: (event: NativeNavigationScrollReset) => void): Promise<PluginListenerHandle>;
}

const nativeNavigation = registerPlugin<HushhNativeNavigationPlugin>("HushhNativeNavigation");
let documentId: string | undefined;
let revision = 0;
let operationQueue: Promise<unknown> = Promise.resolve();
let installed = false;
let nativeBottomInset = 0;
let nativeBottomContentHeight = 49;
let nativeScrollFollowing = false;
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
  const operation = operationQueue.catch(() => undefined).then(() => current() ? nativeNavigation.setState(state) : undefined);
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

export function useNativeNavigationScrollFollowing() {
  return useSyncExternalStore(subscribe, () => installed && nativeScrollFollowing, () => false);
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

export function useNativeNavigation({ enabled, visible, interactionEnabled = true, selected, feedAttention, appearance, accentHex, foregroundHex, onSelect }: NativeControlAppearance & {
  enabled: boolean;
  visible: boolean;
  interactionEnabled?: boolean;
  selected: NativeNavigationTab;
  feedAttention: boolean;
  onSelect: (tab: NativeNavigationTab) => void;
}) {
  const [supported, setSupported] = useState(false);
  const [interactionIsolation, setInteractionIsolation] = useState(false);
  const [ready, setReady] = useState(false);
  const [discovering, setDiscovering] = useState(() => enabled && isNativeIOS());
  const [height, setHeight] = useState(49);
  const [scrollFailed, setScrollFailed] = useState(false);
  const [privacyAdmissionRevision, setPrivacyAdmissionRevision] = useState(0);
  const overlayBlocked = useSyncExternalStore(subscribe, () => overlays.size > 0, () => false);
  const regionRevision = useNativePresentationRegionRevision();
  const current = useRef<NavigationState | null>(null);
  const scrollDelivery = useRef<NativeNavigationScrollDelivery | null>(null);
  const scrollGeneration = useRef(-1);
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
    let releasedPrivacyGeneration: number | undefined;
    const invalidateConfirmations = () => {
      confirmationEpoch += 1;
      // A late visible event must not revoke the native release receipt that
      // already re-admitted motion during foreground settlement.
      if (document.visibilityState === "hidden") scrollDelivery.current?.update(null);
    };
    document.addEventListener("visibilitychange", invalidateConfirmations);
    const handles: PluginListenerHandle[] = [];
    let removeScroll: (() => void) | undefined;
    let removePrivacyObservation: (() => void) | undefined;
    const reconcilePrivacyAdmission = (event: NativeSessionPrivacyState) => {
      if (cancelled) return;
      invalidateConfirmations();
      if (event.shielded || !event.appIsActive) {
        releasedPrivacyGeneration = undefined;
        scrollDelivery.current?.update(null);
      } else if (releasedPrivacyGeneration !== event.generation) {
        releasedPrivacyGeneration = event.generation;
        // Retry only presentation admission, never a choice. Validation can
        // release the cover through its completion without a listener event.
        setPrivacyAdmissionRevision(value => value + 1);
      }
    };
    const retain = async (pending: Promise<PluginListenerHandle>) => {
      const handle = await pending;
      if (cancelled) await handle.remove(); else handles.push(handle);
    };
    void (async () => {
      try {
        const capability = await nativeNavigation.getCapabilities();
        if (!capability.supported || capability.contractVersion !== NATIVE_NAVIGATION_CONTRACT_VERSION || cancelled) return;
        // Experimental wrappers requiring apertures/regions cannot host the
        // recovery renderer. Use their established web fallback, never strand
        // a reserved bar or resurrect the rejected custom composition.
        if (!customNativePresentationEnabled() && (capability.underlayPresentation ||
            capability.contentBackedPresentation || capability.reservedPresentationRegions)) return;
        underlayPresentation.current = capability.underlayPresentation === true;
        reservedRegions.current = capability.reservedPresentationRegions === true;
        documentId ??= nativeDocumentId();
        if (capability.synchronizedBottomScroll === true && nativeNavigation.setScroll) {
          const delivery = new NativeNavigationScrollDelivery({ setScroll: sample => nativeNavigation.setScroll!(sample) },
            () => { if (!cancelled) setScrollFailed(true); });
          scrollDelivery.current = delivery;
          removeScroll = subscribeKaiBottomChromeProgress(progress => delivery.publish(
            window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : progress));
          await retain(nativeNavigation.addListener("scrollResetRequested", event => {
            const state = current.current;
            if (cancelled || !state || event.documentId !== state.documentId || event.revision !== state.revision ||
                event.interactionEpoch !== state.interactionEpoch || !Number.isSafeInteger(event.scrollGeneration) ||
                !Number.isSafeInteger(event.privacyGeneration) || event.scrollGeneration < scrollGeneration.current) return;
            scrollGeneration.current = event.scrollGeneration;
            // Reset is an explicit native keyboard/press intent, not inferred
            // navigation. The shared owner still decides all scroll movement.
            if (event.snap) snapKaiBottomChromeVisible();
            delivery.update(event.active && state.visible && state.interactionEnabled && overlays.size === 0
              ? { documentId: state.documentId, revision: state.revision, interactionEpoch: state.interactionEpoch,
                privacyGeneration: event.privacyGeneration, scrollGeneration: event.scrollGeneration,
                travel: bottomChromeScrollTravel(checkedHeight(nativeBottomContentHeight)) } : null);
          }));
        }
        removePrivacyObservation = subscribeNativePrivacyObservation(() => {
          const { state } = nativePrivacyObservation();
          if (state) reconcilePrivacyAdmission(state);
        });
        await retain(subscribeNativeSessionPrivacy(reconcilePrivacyAdmission));
        await retain(nativeNavigation.addListener("selectionRequested", (event) => {
          const state = current.current;
          if (!state?.visible || !state.interactionEnabled || overlays.size > 0 || event.documentId !== state.documentId ||
              event.interactionEpoch !== state.interactionEpoch || !Number.isSafeInteger(event.sequence) ||
              event.sequence <= lastSelection.current || !NATIVE_NAVIGATION_TABS.includes(event.tab)) return;
          const requestEpoch = confirmationEpoch;
          const isolation = nativeDrawerIsolation();
          void nativeNavigation.confirmSelection(event).then(({ valid }) => {
            const latest = current.current;
            if (!valid || cancelled || isolation.isolated || nativeDrawerIsolation().isolated || isolation.generation !== nativeDrawerIsolation().generation || requestEpoch !== confirmationEpoch || !latest?.visible || !latest.interactionEnabled || overlays.size > 0 ||
                document.visibilityState === "hidden" || event.documentId !== latest.documentId ||
                event.interactionEpoch !== latest.interactionEpoch || event.sequence <= lastSelection.current) return;
            lastSelection.current = event.sequence;
            select.current(event.tab);
          }).catch(() => undefined);
        }));
        await retain(nativeNavigation.addListener("geometryChanged", (event) => {
          if (!cancelled) {
            try {
              const state = current.current;
              if (underlayPresentation.current && (!state || event.documentId !== state.documentId || event.revision !== state.revision)) return;
              const contentHeight = checkedHeight(event.contentHeight);
              nativeBottomContentHeight = contentHeight;
              nativeBottomInset = checkedHeight(event.bottomInset);
              setHeight(contentHeight);
              if (state && event.documentId === state.documentId && event.revision === state.revision &&
                  Number.isSafeInteger(event.scrollGeneration) && Number.isSafeInteger(event.privacyGeneration) &&
                  event.scrollGeneration! >= scrollGeneration.current) {
                scrollGeneration.current = event.scrollGeneration!;
                scrollDelivery.current?.update(state.visible && state.interactionEnabled && overlays.size === 0 ? {
                  documentId: state.documentId, revision: state.revision, interactionEpoch: state.interactionEpoch,
                  privacyGeneration: event.privacyGeneration!, scrollGeneration: event.scrollGeneration!,
                  travel: bottomChromeScrollTravel(contentHeight),
                } : null);
              }
              if (state && event.documentId === state.documentId && event.revision === state.revision) applyAperture(event, state);
              publish();
            } catch { /* Retain the last valid reservation. */ }
          }
        }));
        if (!cancelled) {
          // Qualified regions keep DOM overlays away from the native strip.
          // Older foreground pilots still conceal safely during coverage.
          setInteractionIsolation(capability.interactionIsolation === true &&
            (capability.wholeNativeDrawers === true || customNativePresentationEnabled() &&
              (capability.contentBackedPresentation !== true || reservedRegions.current)));
          setSupported(true);
        }
      } catch { /* Old wrappers and non-iOS builds retain the existing web navigation. */ }
      finally { if (!cancelled) setDiscovering(false); }
    })();
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", invalidateConfirmations);
      handles.forEach((handle) => { void handle.remove(); });
      removePrivacyObservation?.();
      removeScroll?.(); scrollDelivery.current?.stop(); scrollDelivery.current = null;
      nativeScrollFollowing = false;
      const state = current.current;
      current.current = null;
      if (apertureRevision.current !== undefined) removeNativeBaseAperture("bottom-navigation", apertureRevision.current);
      apertureRevision.current = undefined;
      if (state) void sendState({ ...state, visible: false, interactionEnabled: false, revision: ++revision }).catch(() => undefined);
      setInstalled(false);
    };
  }, [enabled, applyAperture]);

  useLayoutEffect(() => {
    if (!supported || !documentId || !/^#[\da-f]{6}$/i.test(accentHex) || !/^#[\da-f]{6}$/i.test(foregroundHex)) return;
    const nextInteractionEnabled = visible && interactionEnabled && !overlayBlocked;
    // Legacy wrappers lack a separate interaction fence: retain their safe hide
    // behavior. Negotiated wrappers retain presentation during overlay isolation.
    const nextVisible = visible && (interactionIsolation || nextInteractionEnabled);
    if (!current.current || current.current.visible !== nextVisible ||
        current.current.interactionEnabled !== nextInteractionEnabled) interactionEpoch += 1;
    const state: NavigationState = {
      documentId, revision: ++revision, interactionEpoch, visible: nextVisible, interactionEnabled: nextInteractionEnabled,
      selected, feedAttention, appearance, accentHex, foregroundHex,
      ...(scrollDelivery.current ? { scrollFollowing: !scrollFailed } : {}),
    };
    current.current = state;
    scrollDelivery.current?.update(null);
    let cancelled = false;
    void (reservedRegions.current ? syncNativePresentationRegions() : Promise.resolve(true)).then((confirmed) => {
      if (!confirmed || cancelled || current.current !== state) return undefined;
      return sendState({ ...state, ...nativePresentationAdmission() }, () => !cancelled && current.current === state);
    }).then((result) => {
      if (!result || result.presentationApplied === false) return;
      if (cancelled || current.current !== state || !result.supported) return;
      setHeight(checkedHeight(result.contentHeight));
      nativeBottomContentHeight = checkedHeight(result.contentHeight);
      nativeBottomInset = checkedHeight(result.bottomInset);
      applyAperture(result, state);
      setReady(true);
      setInstalled(true);
      nativeScrollFollowing = !!scrollDelivery.current && !scrollFailed && result.scrollFollowing === true;
      if (nativeScrollFollowing && scrollDelivery.current && Number.isSafeInteger(result.scrollGeneration) &&
          Number.isSafeInteger(result.privacyGeneration) && result.scrollGeneration! >= scrollGeneration.current) {
        scrollGeneration.current = result.scrollGeneration!;
        scrollDelivery.current.update(state.visible && state.interactionEnabled && !overlayBlocked ? {
          documentId: state.documentId, revision: state.revision, interactionEpoch: state.interactionEpoch,
          privacyGeneration: result.privacyGeneration!, scrollGeneration: result.scrollGeneration!,
          travel: bottomChromeScrollTravel(result.contentHeight),
        } : null);
      }
      publish();
    }).catch(() => {
      // Never expose duplicate DOM tabs after a previously accepted native installation.
      // No provider/session content enters this diagnostic.
      console.warn("NATIVE_NAVIGATION_STATE_UNAVAILABLE");
    });
    return () => { cancelled = true; };
  }, [supported, interactionIsolation, visible, interactionEnabled, overlayBlocked, selected, feedAttention, appearance, accentHex, foregroundHex, applyAperture, regionRevision, scrollFailed, privacyAdmissionRevision]);

  return { ready, height, reserved: ready || discovering || supported };
}
