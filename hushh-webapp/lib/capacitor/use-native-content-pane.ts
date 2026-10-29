"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { customNativePresentationEnabled } from "./native-presentation-policy";
import { getNativeChromeCapabilities, nativeChrome, type NativeContentPaneIdentity, type NativeContentPaneReceipt } from "./native-chrome";
import { nativeDrawerAcknowledged } from "./native-drawers";
import { nativeDocumentId, getNativeSessionPrivacyState, nativePrivacyCanPrepareProfile, subscribeNativeSessionPrivacy, subscribeNativePrivacyObservation } from "./session-privacy";
import { useNativeNavigationBlocked } from "./native-navigation";

let generation = 0;
// Serialize plane retirement, not product operations. An uncertain retirement
// rejects the next admission; it never restores a duplicate or retries a send.
export class NativeContentPaneRetirementBarrier {
  private pending = new Set<Promise<unknown>>();
  private uncertain = new Set<object>();
  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  track(retirement: Promise<unknown>, lateConfirmation?: Promise<boolean>): void {
    const lifetime = { confirmed: false };
    this.pending.add(retirement);
    void retirement.then(
      () => { this.pending.delete(retirement); this.listeners.forEach(listener => listener()); },
      () => {
        if (!lifetime.confirmed) this.uncertain.add(lifetime);
        this.pending.delete(retirement);
        this.listeners.forEach(listener => listener());
      },
    );
    if (lateConfirmation) void lateConfirmation.then(confirmed => {
      if (confirmed) {
        lifetime.confirmed = true;
        if (this.uncertain.delete(lifetime)) this.listeners.forEach(listener => listener());
      }
    }, () => undefined);
  }

  async wait(): Promise<void> {
    while (this.pending.size) {
      await Promise.allSettled([...this.pending]);
    }
    if (this.uncertain.size) throw new Error("NATIVE_CONTENT_PANE_RETIRE_UNCONFIRMED");
  }

  async afterRetirement<T>(start: () => Promise<T>): Promise<T> {
    do { await this.wait(); } while (this.pending.size || this.uncertain.size);
    // Check and issue the bridge call in the same JavaScript turn.
    return start();
  }
  get clear(): boolean { return this.pending.size === 0 && this.uncertain.size === 0; }
}
const retirementBarrier = new NativeContentPaneRetirementBarrier();
/** Explicit handoff waits for every retiring focused WebView plane. */
export function awaitNativeContentPaneRetirement(): Promise<void> { return retirementBarrier.wait(); }
export function afterNativeContentPaneRetirement<T>(start: () => Promise<T>): Promise<T> { return retirementBarrier.afterRetirement(start); }
export function nativeContentPaneRetirementClear(): boolean { return retirementBarrier.clear; }
export function subscribeNativeContentPaneRetirement(listener: () => void): () => void { return retirementBarrier.subscribe(listener); }
export function contentPaneAcknowledged(receipt: NativeContentPaneReceipt, identity: NativeContentPaneIdentity, phase: "active" | "retired") {
  return receipt?.phase === phase && receipt.documentId === identity.documentId && receipt.ownerEpoch === identity.ownerEpoch &&
    receipt.generation === identity.generation && receipt.privacyGeneration === identity.privacyGeneration;
}

/** The existing overlay registry owns touch isolation through the actual DOM
 * exit. This hook owns only the acknowledged WK/native paint-plane lifetime. */
export function useNativeContentPane(node: HTMLElement | null, owner: string | null, enabled: boolean, layer = "profile-pane",
  preparation?: { visitId: string; ready: boolean }) {
  const [state, setState] = useState<{ phase: "preparing" | "web" | "native" | "blocked"; identity?: NativeContentPaneIdentity }>({ phase: "preparing" });
  const preparationRef = useRef(preparation);
  const refreshRef = useRef<() => void>(() => undefined);
  const preparationVisit = preparation?.visitId, preparationReady = preparation?.ready;
  useLayoutEffect(() => {
    preparationRef.current = preparationVisit ? { visitId: preparationVisit, ready: preparationReady === true } : undefined;
    refreshRef.current();
  }, [preparationVisit, preparationReady]);
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
      const operation = nativeChrome.releaseContentPane(captured);
      releasing = nativeDrawerAcknowledged(operation).then(receipt => {
        if (!contentPaneAcknowledged(receipt, captured, "retired")) throw new Error("NATIVE_CONTENT_PANE_RETIRE_UNCONFIRMED");
      });
      retirementBarrier.track(releasing, operation.then(receipt => contentPaneAcknowledged(receipt, captured, "retired")));
      return releasing;
    };
    let capable = false;
    let preparationCapable = false;
    let acknowledged: { privacy: number; width: number; height: number; visit?: string } | undefined;
    let paintReceipt: string | undefined;
    const reconcile = async () => {
      const ordinal = ++request;
      try {
        const privacy = await getNativeSessionPrivacyState();
        if (!live || ordinal !== request) return;
        const preparation = preparationRef.current;
        const preparing = preparationCapable && !!preparation && nativePrivacyCanPrepareProfile(privacy) &&
          privacy.preparationBody === "pane" && privacy.preparationVisitId === preparation.visitId;
        if (!privacy.appIsActive || privacy.shielded && !preparing) { setState({ phase: "blocked" }); return; }
        await awaitNativeContentPaneRetirement();
        if (!live || ordinal !== request) return;
        const next = { ...lifetime, privacyGeneration: privacy.generation };
        const width = window.innerWidth, height = window.innerHeight;
        const visit = privacy.shielded && preparing ? preparation?.visitId : undefined;
        if (!acknowledged || acknowledged.privacy !== privacy.generation || acknowledged.width !== width ||
            acknowledged.height !== height || visit && acknowledged.visit !== visit) {
          const receipt = await afterNativeContentPaneRetirement(() => {
            if (!live || ordinal !== request) throw new Error("NATIVE_CONTENT_PANE_ADMISSION_STALE");
            identity = next; // Reserve cleanup authority immediately before native admission.
            return nativeDrawerAcknowledged(nativeChrome.acquireContentPane({ ...next,
              viewport: { width, height }, ...(visit ? { preparationVisitId: visit } : {}) }));
          });
          if (!live) { release(); return; }
          if (ordinal !== request) return;
          if (!contentPaneAcknowledged(receipt, next, "active")) throw new Error("NATIVE_CONTENT_PANE_UNCONFIRMED");
          acknowledged = { privacy: privacy.generation, width, height, visit };
        }
        // A prior covered/failed observation may have concealed the React
        // pane without retiring its acquired plane. Restore this committed
        // state on cached admission too, before measuring any body paint.
        setState(previous => previous.phase === "native" && previous.identity?.privacyGeneration === next.privacyGeneration
          ? previous : { phase: "native", identity: next });
        if (privacy.shielded && preparing && preparation?.ready && privacy.profileMenuConcealed &&
            privacy.profilePreparationId && paintReceipt !== privacy.profilePreparationId) {
          // This is a body-paint receipt, not an auth or operation receipt.
          // Covered native chrome and the whole React header/body stay inert.
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          if (!live || ordinal !== request || preparationRef.current?.visitId !== visit || !preparationRef.current?.ready) return;
          const frame = node.getBoundingClientRect();
          if (!node.isConnected || getComputedStyle(node).visibility !== "visible" || frame.width <= 0 || frame.height <= 0) return;
          if (!nativeChrome.confirmContentPanePreparation) throw new Error("NATIVE_CONTENT_PANE_PAINT_UNAVAILABLE");
          const receipt = await nativeDrawerAcknowledged(nativeChrome.confirmContentPanePreparation({ ...next,
            preparationVisitId: visit!, preparationId: privacy.profilePreparationId }));
          if (!live || ordinal !== request) return;
          if (!contentPaneAcknowledged(receipt, next, "active")) throw new Error("NATIVE_CONTENT_PANE_PAINT_UNCONFIRMED");
          paintReceipt = privacy.profilePreparationId;
        }
      } catch {
        if (live && ordinal === request) setState({ phase: "blocked" });
      }
    };
    const refresh = () => { if (live && capable) void reconcile(); };
    refreshRef.current = refresh;
    const unsubscribeRetirement = retirementBarrier.subscribe(refresh);
    const unsubscribe = subscribeNativePrivacyObservation(refresh);
    setState({ phase: "preparing" });
    void (async () => {
      try {
        const capabilities = await getNativeChromeCapabilities();
        if (!live) return;
        if (capabilities?.ownedContentPane !== true) { setState({ phase: "web" }); return; }
        preparationCapable = capabilities.contentPanePreparation === true;
        const pendingObserver = subscribeNativeSessionPrivacy(refresh);
        void pendingObserver.then(handle => { if (!live) void handle.remove(); }).catch(() => undefined);
        observer = await pendingObserver;
        if (!live) return;
        capable = true;
        await reconcile();
      } catch { if (live) setState({ phase: "blocked" }); }
    })();
    window.addEventListener("resize", refresh);
    return () => { live = false; request++; refreshRef.current = () => undefined; unsubscribeRetirement(); unsubscribe(); release(); void observer?.remove(); window.removeEventListener("resize", refresh); };
  }, [node, owner, enabled]);
  return state;
}
