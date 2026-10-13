"use client";

import { useLayoutEffect, useState } from "react";
import { customNativePresentationEnabled } from "./native-presentation-policy";
import { getNativeChromeCapabilities, nativeChrome, type NativeContentPaneIdentity, type NativeContentPaneReceipt } from "./native-chrome";
import { nativeDrawerAcknowledged } from "./native-drawers";
import { nativeDocumentId, getNativeSessionPrivacyState, subscribeNativeSessionPrivacy, subscribeNativePrivacyObservation } from "./session-privacy";
import { useNativeNavigationBlocked } from "./native-navigation";

let generation = 0;
// Serialize plane retirement, not product operations. An uncertain retirement
// rejects the next admission; it never restores a duplicate or retries a send.
let retirement: Promise<unknown> = Promise.resolve();
export function contentPaneAcknowledged(receipt: NativeContentPaneReceipt, identity: NativeContentPaneIdentity, phase: "active" | "retired") {
  return receipt?.phase === phase && receipt.documentId === identity.documentId && receipt.ownerEpoch === identity.ownerEpoch &&
    receipt.generation === identity.generation && receipt.privacyGeneration === identity.privacyGeneration;
}

/** The existing overlay registry owns touch isolation through the actual DOM
 * exit. This hook owns only the acknowledged WK/native paint-plane lifetime. */
export function useNativeContentPane(node: HTMLElement | null, owner: string | null, enabled: boolean, layer = "profile-pane") {
  const [state, setState] = useState<{ phase: "preparing" | "web" | "native" | "blocked"; identity?: NativeContentPaneIdentity }>({ phase: "preparing" });
  useNativeNavigationBlocked(!!node && enabled, layer);
  useLayoutEffect(() => {
    if (!owner || !enabled || !customNativePresentationEnabled()) { setState({ phase: "web" }); return; }
    if (!node) { setState({ phase: "preparing" }); return; }
    let live = true;
    let request = 0;
    let identity: NativeContentPaneIdentity | undefined;
    const lifetime = { documentId: nativeDocumentId(), ownerEpoch: crypto.randomUUID(), generation: ++generation };
    let observer: Awaited<ReturnType<typeof subscribeNativeSessionPrivacy>> | undefined;
    let releasing: Promise<void> | undefined;
    const release = () => {
      if (!identity || releasing) return releasing;
      const captured = identity;
      releasing = nativeDrawerAcknowledged(nativeChrome.releaseContentPane(captured)).then(receipt => {
        if (!contentPaneAcknowledged(receipt, captured, "retired")) throw new Error("NATIVE_CONTENT_PANE_RETIRE_UNCONFIRMED");
      });
      retirement = releasing;
      void releasing.catch(() => undefined);
      return releasing;
    };
    let capable = false;
    const reconcile = async () => {
      const ordinal = ++request;
      try {
        const privacy = await getNativeSessionPrivacyState();
        if (!live || ordinal !== request) return;
        if (!privacy.appIsActive || privacy.shielded) { setState({ phase: "blocked" }); return; }
        await retirement;
        if (!live || ordinal !== request) return;
        const next = { ...lifetime, privacyGeneration: privacy.generation };
        identity = next; // Reserve cleanup authority before asynchronous admission.
        const receipt = await nativeDrawerAcknowledged(nativeChrome.acquireContentPane({ ...next,
          viewport: { width: window.innerWidth, height: window.innerHeight } }));
        if (!live) { release(); return; }
        if (ordinal !== request) return;
        if (!contentPaneAcknowledged(receipt, next, "active")) throw new Error("NATIVE_CONTENT_PANE_UNCONFIRMED");
        setState({ phase: "native", identity: next });
      } catch {
        if (live && ordinal === request) setState({ phase: "blocked" });
      }
    };
    const refresh = () => { if (live && capable) void reconcile(); };
    const unsubscribe = subscribeNativePrivacyObservation(refresh);
    setState({ phase: "preparing" });
    void (async () => {
      try {
        const capabilities = await getNativeChromeCapabilities();
        if (!live) return;
        if (capabilities?.ownedContentPane !== true) { setState({ phase: "web" }); return; }
        const pendingObserver = subscribeNativeSessionPrivacy(refresh);
        void pendingObserver.then(handle => { if (!live) void handle.remove(); }).catch(() => undefined);
        observer = await pendingObserver;
        if (!live) return;
        capable = true;
        await reconcile();
      } catch { if (live) setState({ phase: "blocked" }); }
    })();
    window.addEventListener("resize", refresh);
    return () => { live = false; request++; unsubscribe(); release(); void observer?.remove(); window.removeEventListener("resize", refresh); };
  }, [node, owner, enabled]);
  return state;
}
