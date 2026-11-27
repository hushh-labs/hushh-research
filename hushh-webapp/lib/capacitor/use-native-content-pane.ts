"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { customNativePresentationEnabled } from "./native-presentation-policy";
import { getNativeChromeCapabilities, nativeChrome, type NativeContentPaneIdentity, type NativeContentPaneReceipt, type NativeContentPaneRetirementState } from "./native-chrome";
import { nativeDrawerAcknowledged } from "./native-drawers";
import { nativeDocumentId, getNativeSessionPrivacyState, nativePrivacyCanPrepareProfile, subscribeNativeSessionPrivacy, subscribeNativePrivacyObservation } from "./session-privacy";
import { useNativeNavigationBlocked } from "./native-navigation";

let generation = 0;
// Serialize plane retirement, not product operations. An uncertain retirement
// rejects the next admission; it never restores a duplicate or retries a send.
export class NativeContentPaneRetirementBarrier {
  private pending = new Set<Promise<unknown>>();
  private uncertain = new Set<{ confirmed: boolean; readback?: () => Promise<boolean>; reading?: Promise<boolean>; stop?: () => void; wakeRevision: number }>();
  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  track(retirement: Promise<unknown>, lateConfirmation?: Promise<boolean>, readback?: () => Promise<boolean>,
    observe?: (wake: () => void) => Promise<() => void>): void {
    const lifetime: { confirmed: boolean; readback?: () => Promise<boolean>; reading?: Promise<boolean>; stop?: () => void; wakeRevision: number } = { confirmed: false, readback, wakeRevision: 0 };
    const confirm = () => {
      lifetime.confirmed = true;
      lifetime.stop?.(); lifetime.stop = undefined;
      if (this.uncertain.delete(lifetime)) this.listeners.forEach(listener => listener());
    };
    this.pending.add(retirement);
    void retirement.then(
      () => { this.pending.delete(retirement); this.listeners.forEach(listener => listener()); },
      () => {
        if (!lifetime.confirmed) {
          this.uncertain.add(lifetime);
          if (observe && readback) void observe(() => { lifetime.wakeRevision++; void this.wait().catch(() => undefined); }).then(stop => {
            if (lifetime.confirmed || !this.uncertain.has(lifetime)) { stop(); return; }
            lifetime.stop = stop;
            // Read after registration so a dismissal during subscription is not missed.
            void this.wait().catch(() => undefined);
          }).catch(() => undefined);
        }
        this.pending.delete(retirement);
        this.listeners.forEach(listener => listener());
      },
    );
    if (lateConfirmation) void lateConfirmation.then(confirmed => {
      if (confirmed) {
        confirm();
      }
    }, () => undefined);
  }

  async wait(): Promise<void> {
    do {
      while (this.pending.size) await Promise.allSettled([...this.pending]);
      await Promise.all([...this.uncertain].map(async lifetime => {
        if (!lifetime.readback) return;
        let revision: number;
        do {
          revision = lifetime.wakeRevision;
          lifetime.reading ??= Promise.resolve().then(lifetime.readback).catch(() => false).finally(() => { lifetime.reading = undefined; });
          if (await lifetime.reading) {
            lifetime.confirmed = true;
            lifetime.stop?.(); lifetime.stop = undefined;
            if (this.uncertain.delete(lifetime)) this.listeners.forEach(listener => listener());
            break;
          }
        } while (this.uncertain.has(lifetime) && lifetime.wakeRevision !== revision);
      }));
    } while (this.pending.size);
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
export function contentPaneHandoffConfirmed(receipt: unknown, identity: NativeContentPaneIdentity): boolean {
  if (!receipt || typeof receipt !== "object") return false;
  const value = receipt as Partial<NativeContentPaneRetirementState>;
  return value.phase === "retired" && value.settled === true && value.handoffReady === true &&
    value.documentId === identity.documentId && value.ownerEpoch === identity.ownerEpoch &&
    value.generation === identity.generation && value.privacyGeneration === identity.privacyGeneration;
}
function sameContentPane(receipt: NativeContentPaneRetirementState, identity: NativeContentPaneIdentity): boolean {
  return receipt.documentId === identity.documentId && receipt.ownerEpoch === identity.ownerEpoch &&
    receipt.generation === identity.generation && receipt.privacyGeneration === identity.privacyGeneration;
}
export async function reconcileContentPaneRetirement(identity: NativeContentPaneIdentity, source: {
  getContentPaneRetirementState(identity: NativeContentPaneIdentity): Promise<NativeContentPaneRetirementState | { valid: false }>;
  cancelContentPane(identity: NativeContentPaneIdentity): Promise<NativeContentPaneRetirementState>;
}): Promise<boolean> {
  const receipt = await nativeDrawerAcknowledged(source.getContentPaneRetirementState(identity));
  if (contentPaneHandoffConfirmed(receipt, identity)) return true;
  // An explicitly unknown or still-active lifetime proves cancellation has
  // not settled. This cancellation is idempotent; it is not a product action.
  if (receipt && typeof receipt === "object" && "phase" in receipt && sameContentPane(receipt, identity) && (receipt.phase === "unknown" || receipt.phase === "active")) {
    return contentPaneHandoffConfirmed(await nativeDrawerAcknowledged(source.cancelContentPane(identity)), identity);
  }
  return false;
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
    let handoffObserver: Awaited<ReturnType<typeof nativeChrome.addListener>> | undefined;
    let releasing: Promise<void> | undefined;
    let retirementReadbackCapable = false;
    const release = () => {
      if (!identity || releasing) return releasing;
      const captured = identity;
      const operation: Promise<NativeContentPaneReceipt | NativeContentPaneRetirementState> = retirementReadbackCapable && nativeChrome.cancelContentPane
        ? nativeChrome.cancelContentPane(captured) : nativeChrome.releaseContentPane(captured);
      const confirmed = (receipt: NativeContentPaneReceipt | NativeContentPaneRetirementState) => retirementReadbackCapable
        ? contentPaneHandoffConfirmed(receipt as NativeContentPaneRetirementState, captured) : contentPaneAcknowledged(receipt as NativeContentPaneReceipt, captured, "retired");
      releasing = nativeDrawerAcknowledged(operation).then(receipt => {
        if (!confirmed(receipt)) throw new Error("NATIVE_CONTENT_PANE_RETIRE_UNCONFIRMED");
      });
      const readback = retirementReadbackCapable && nativeChrome.getContentPaneRetirementState && nativeChrome.cancelContentPane
        ? () => reconcileContentPaneRetirement(captured, {
          getContentPaneRetirementState: value => nativeChrome.getContentPaneRetirementState!(value),
          cancelContentPane: value => nativeChrome.cancelContentPane!(value),
        }) : undefined;
      const observe = readback && typeof window !== "undefined" ? async (wake: () => void) => {
        let live = true;
        let handle: Awaited<ReturnType<typeof nativeChrome.addListener>> | undefined;
        const onPageHide = (event: PageTransitionEvent) => { if (!event.persisted) stop(); };
        const stop = () => { if (!live) return; live = false; window.removeEventListener("pagehide", onPageHide); void handle?.remove().catch(() => undefined); };
        window.addEventListener("pagehide", onPageHide);
        try {
          handle = await nativeChrome.addListener("contentPaneHandoffChanged", event => { if (event.documentId === captured.documentId) wake(); });
          if (!live) void handle.remove().catch(() => undefined);
        } catch (error) { stop(); throw error; }
        return stop;
      } : undefined;
      retirementBarrier.track(releasing, operation.then(confirmed), readback, observe);
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
        const next = { ...lifetime, privacyGeneration: privacy.generation };
        const width = window.innerWidth, height = window.innerHeight;
        const visit = privacy.shielded && preparing ? preparation?.visitId : undefined;
        // A separate canceled contender must not hide an already admitted
        // pane, which may be the only surface able to dismiss that contender.
        // Native still verifies the exact owner, geometry and privacy before
        // accepting any changed projection for this retained lifetime.
        const retained = !!identity && !!acknowledged;
        if (!retained) {
          await awaitNativeContentPaneRetirement();
          if (!live || ordinal !== request) return;
        }
        if (!acknowledged || acknowledged.privacy !== privacy.generation || acknowledged.width !== width ||
            acknowledged.height !== height || visit && acknowledged.visit !== visit) {
          const admit = () => {
            if (!live || ordinal !== request) throw new Error("NATIVE_CONTENT_PANE_ADMISSION_STALE");
            identity = next; // Reserve cleanup authority immediately before native admission.
            return nativeDrawerAcknowledged(nativeChrome.acquireContentPane({ ...next,
              viewport: { width, height }, ...(visit ? { preparationVisitId: visit } : {}) }));
          };
          const receipt = await (retained ? admit() : afterNativeContentPaneRetirement(admit));
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
        retirementReadbackCapable = capabilities.contentPaneRetirementReadback === true &&
          typeof nativeChrome.cancelContentPane === "function" && typeof nativeChrome.getContentPaneRetirementState === "function";
        if (retirementReadbackCapable) {
          const pendingHandoff = nativeChrome.addListener("contentPaneHandoffChanged", event => {
            if (event.documentId === lifetime.documentId) refresh();
          });
          void pendingHandoff.then(handle => { if (!live) void handle.remove(); }).catch(() => undefined);
          handoffObserver = await pendingHandoff;
          if (!live) return;
        }
        const pendingObserver = subscribeNativeSessionPrivacy(refresh);
        void pendingObserver.then(handle => { if (!live) void handle.remove(); }).catch(() => undefined);
        observer = await pendingObserver;
        if (!live) return;
        capable = true;
        await reconcile();
      } catch { if (live) setState({ phase: "blocked" }); }
    })();
    window.addEventListener("resize", refresh);
    return () => { live = false; request++; refreshRef.current = () => undefined; unsubscribeRetirement(); unsubscribe(); release(); void observer?.remove(); void handoffObserver?.remove(); window.removeEventListener("resize", refresh); };
  }, [node, owner, enabled]);
  return state;
}
