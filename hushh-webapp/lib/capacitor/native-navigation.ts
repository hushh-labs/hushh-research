"use client";

import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type Ref } from "react";
import { nativeDocumentId, subscribeNativeSessionPrivacy } from "@/lib/capacitor/session-privacy";
import { NATIVE_CONTROL_CONTRACT_VERSION, type NativeControlAppearance } from "@/lib/capacitor/native-control-appearance";

export const NATIVE_NAVIGATION_TABS = ["chat", "dashboard", "connect", "feed", "search"] as const;
export type NativeNavigationTab = typeof NATIVE_NAVIGATION_TABS[number];
type Geometry = { supported: boolean; contentHeight: number; bottomInset: number };
type Selection = { documentId: string; interactionEpoch: number; privacyGeneration: number; sequence: number; tab: NativeNavigationTab };
type NavigationState = NativeControlAppearance & {
  documentId: string;
  revision: number;
  interactionEpoch: number;
  visible: boolean;
  selected: NativeNavigationTab;
  feedAttention: boolean;
};

export interface HushhNativeNavigationPlugin {
  getCapabilities(): Promise<Geometry & { contractVersion: number }>;
  setState(options: NavigationState): Promise<Geometry>;
  confirmSelection(options: Selection): Promise<{ valid: boolean }>;
  addListener(eventName: "selectionRequested", listener: (event: Selection) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "geometryChanged", listener: (event: { contentHeight: number; bottomInset: number }) => void): Promise<PluginListenerHandle>;
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
  const operation = operationQueue.catch(() => undefined).then(() => nativeNavigation().setState(state));
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

export function useNativeNavigation({ enabled, visible, selected, feedAttention, appearance, accentHex, foregroundHex, onSelect }: NativeControlAppearance & {
  enabled: boolean;
  visible: boolean;
  selected: NativeNavigationTab;
  feedAttention: boolean;
  onSelect: (tab: NativeNavigationTab) => void;
}) {
  const [supported, setSupported] = useState(false);
  const [ready, setReady] = useState(false);
  const [height, setHeight] = useState(49);
  const overlayBlocked = useSyncExternalStore(subscribe, () => overlays.size > 0, () => false);
  const current = useRef<NavigationState | null>(null);
  const select = useRef(onSelect);
  const lastSelection = useRef(0);
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
        if (!capability.supported || capability.contractVersion !== NATIVE_CONTROL_CONTRACT_VERSION || cancelled) return;
        documentId ??= nativeDocumentId();
        await retain(subscribeNativeSessionPrivacy(invalidateConfirmations));
        await retain(nativeNavigation().addListener("selectionRequested", (event) => {
          const state = current.current;
          if (!state?.visible || overlays.size > 0 || event.documentId !== state.documentId ||
              event.interactionEpoch !== state.interactionEpoch || !Number.isSafeInteger(event.sequence) ||
              event.sequence <= lastSelection.current || !NATIVE_NAVIGATION_TABS.includes(event.tab)) return;
          const requestEpoch = confirmationEpoch;
          void nativeNavigation().confirmSelection(event).then(({ valid }) => {
            const latest = current.current;
            if (!valid || cancelled || requestEpoch !== confirmationEpoch || !latest?.visible || overlays.size > 0 ||
                document.visibilityState === "hidden" || event.documentId !== latest.documentId ||
                event.interactionEpoch !== latest.interactionEpoch || event.sequence <= lastSelection.current) return;
            lastSelection.current = event.sequence;
            select.current(event.tab);
          }).catch(() => undefined);
        }));
        await retain(nativeNavigation().addListener("geometryChanged", (event) => {
          if (!cancelled) {
            try {
              const contentHeight = checkedHeight(event.contentHeight);
              nativeBottomInset = checkedHeight(event.bottomInset);
              setHeight(contentHeight);
              publish();
            } catch { /* Retain the last valid reservation. */ }
          }
        }));
        if (!cancelled) setSupported(true);
      } catch { /* Old wrappers and non-iOS builds retain the existing web navigation. */ }
    })();
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", invalidateConfirmations);
      handles.forEach((handle) => { void handle.remove(); });
      const state = current.current;
      current.current = null;
      if (state) void sendState({ ...state, visible: false, revision: ++revision }).catch(() => undefined);
      setInstalled(false);
    };
  }, [enabled]);

  useLayoutEffect(() => {
    if (!supported || !documentId) return;
    const nextVisible = visible && !overlayBlocked;
    if (!current.current || current.current.visible !== nextVisible) interactionEpoch += 1;
    const state: NavigationState = {
      documentId, revision: ++revision, interactionEpoch, visible: nextVisible,
      selected, feedAttention, appearance, accentHex, foregroundHex,
    };
    current.current = state;
    let cancelled = false;
    void sendState(state).then((result) => {
      if (cancelled || current.current !== state || !result.supported) return;
      setHeight(checkedHeight(result.contentHeight));
      nativeBottomInset = checkedHeight(result.bottomInset);
      setReady(true);
      setInstalled(true);
      publish();
    }).catch(() => {
      // Never expose duplicate DOM tabs after a previously accepted native installation.
      // No provider/session content enters this diagnostic.
      console.warn("NATIVE_NAVIGATION_STATE_UNAVAILABLE");
    });
    return () => { cancelled = true; };
  }, [supported, visible, overlayBlocked, selected, feedAttention, appearance, accentHex, foregroundHex]);

  return { ready, height };
}
