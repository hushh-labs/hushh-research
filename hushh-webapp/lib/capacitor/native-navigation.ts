"use client";

import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type Ref } from "react";
import { nativeDocumentId, subscribeNativeSessionPrivacy } from "@/lib/capacitor/session-privacy";
import { NATIVE_CONTROL_CONTRACT_VERSION, type NativeControlAppearance } from "@/lib/capacitor/native-control-appearance";
import { setNativeBaseAperture, removeNativeBaseAperture } from "./native-base-apertures";
import type { ChromeFrame } from "./native-chrome";

export const NATIVE_NAVIGATION_TABS = ["chat", "dashboard", "connect", "feed", "search"] as const;
export type NativeNavigationTab = typeof NATIVE_NAVIGATION_TABS[number];
type Geometry = { supported: boolean; contentHeight: number; bottomInset: number; frame?: ChromeFrame };
type Selection = { documentId: string; interactionEpoch: number; privacyGeneration: number; sequence: number; tab: NativeNavigationTab };
type NavigationState = NativeControlAppearance & {
  documentId: string;
  revision: number;
  interactionEpoch: number;
  visible: boolean;
  interactionEnabled: boolean;
  selected: NativeNavigationTab;
  feedAttention: boolean;
};

export interface HushhNativeNavigationPlugin {
  getCapabilities(): Promise<Geometry & { contractVersion: number; interactionIsolation?: boolean; underlayPresentation?: boolean }>;
  setState(options: NavigationState): Promise<Geometry>;
  confirmSelection(options: Selection): Promise<{ valid: boolean }>;
  addListener(eventName: "selectionRequested", listener: (event: Selection) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "geometryChanged", listener: (event: Geometry & { documentId?: string; revision?: number }) => void): Promise<PluginListenerHandle>;
}

const nativeNavigation = registerPlugin<HushhNativeNavigationPlugin>("HushhNativeNavigation");
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
function publish() { subscribers.forEach((listener) => listener()); }
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
function sendState(state: NavigationState) {
  const operation = operationQueue.catch(() => undefined).then(() => nativeNavigation.setState(state));
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
  const [height, setHeight] = useState(49);
  const overlayBlocked = useSyncExternalStore(subscribe, () => overlays.size > 0, () => false);
  const current = useRef<NavigationState | null>(null);
  const select = useRef(onSelect);
  const lastSelection = useRef(0);
  const underlayPresentation = useRef(false);
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
        const capability = await nativeNavigation.getCapabilities();
        if (!capability.supported || capability.contractVersion !== NATIVE_CONTROL_CONTRACT_VERSION || cancelled) return;
        underlayPresentation.current = capability.underlayPresentation === true;
        documentId ??= nativeDocumentId();
        await retain(subscribeNativeSessionPrivacy(invalidateConfirmations));
        await retain(nativeNavigation.addListener("selectionRequested", (event) => {
          const state = current.current;
          if (!state?.visible || !state.interactionEnabled || overlays.size > 0 || event.documentId !== state.documentId ||
              event.interactionEpoch !== state.interactionEpoch || !Number.isSafeInteger(event.sequence) ||
              event.sequence <= lastSelection.current || !NATIVE_NAVIGATION_TABS.includes(event.tab)) return;
          const requestEpoch = confirmationEpoch;
          void nativeNavigation.confirmSelection(event).then(({ valid }) => {
            const latest = current.current;
            if (!valid || cancelled || requestEpoch !== confirmationEpoch || !latest?.visible || !latest.interactionEnabled || overlays.size > 0 ||
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
              nativeBottomInset = checkedHeight(event.bottomInset);
              setHeight(contentHeight);
              if (state && event.documentId === state.documentId && event.revision === state.revision) applyAperture(event, state);
              publish();
            } catch { /* Retain the last valid reservation. */ }
          }
        }));
        if (!cancelled) {
          setInteractionIsolation(capability.interactionIsolation === true);
          setSupported(true);
        }
      } catch { /* Old wrappers and non-iOS builds retain the existing web navigation. */ }
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
    if (!supported || !documentId) return;
    const nextInteractionEnabled = visible && interactionEnabled && !overlayBlocked;
    // Legacy wrappers lack a separate interaction fence: retain their safe hide
    // behavior. Negotiated wrappers retain presentation during overlay isolation.
    const nextVisible = visible && (interactionIsolation || nextInteractionEnabled);
    if (!current.current || current.current.visible !== nextVisible ||
        current.current.interactionEnabled !== nextInteractionEnabled) interactionEpoch += 1;
    const state: NavigationState = {
      documentId, revision: ++revision, interactionEpoch, visible: nextVisible, interactionEnabled: nextInteractionEnabled,
      selected, feedAttention, appearance, accentHex, foregroundHex,
    };
    current.current = state;
    let cancelled = false;
    void sendState(state).then((result) => {
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
  }, [supported, interactionIsolation, visible, interactionEnabled, overlayBlocked, selected, feedAttention, appearance, accentHex, foregroundHex, applyAperture]);

  return { ready, height };
}
