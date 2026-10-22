"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { Capacitor } from "@capacitor/core";
import { customNativePresentationEnabled } from "@/lib/capacitor/native-presentation-policy";
import { useAuth } from "@/hooks/use-auth";
import { boundedDock, DockEventFence, getNativeDockCapabilities, nativeDock, nativeDockRestingFrame, nextDockIdentity, sameDock, validDockEvent, type DockIdentity, type DockProjection } from "@/lib/capacitor/native-dock";
import { useNativeControlAppearance } from "@/lib/capacitor/native-control-appearance";
import { nativeShellOverlayBlocked, useNativeShellOverlayBlocked } from "@/lib/capacitor/native-navigation";
import { getNativeSessionPrivacyState, subscribeNativeSessionPrivacy } from "@/lib/capacitor/session-privacy";
import { nativeDrawerIsolation, observeNativeDrawerIsolation } from "@/lib/capacitor/native-drawers";
import { isSessionChromeSuppressed, useSessionChromeSuppressed } from "@/lib/auth/use-session-chrome-suppression";
import { activeAgentDockSeat, useAgentDockState } from "./agent-dock";
import { useNativeDockPorts } from "./native-dock-port";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { setNativeBaseAperture, removeNativeBaseAperture } from "@/lib/capacitor/native-base-apertures";
import { nativePresentationAdmission, syncNativePresentationRegions, setNativeDockPresentationFrame, useNativePresentationRegionRevision } from "@/lib/capacitor/native-presentation-regions";

let presentationOwner: symbol | null = null;
async function retireDock(identity: DockIdentity & { preserveDraft?: boolean }) {
  const ack = await boundedDock(nativeDock.retire(identity));
  if (!sameDock(identity, ack) || ack.phase !== "retired") throw new Error("NATIVE_DOCK_RETIRE_UNCONFIRMED");
  removeNativeBaseAperture("agent-dock", identity.revision);
  setNativeDockPresentationFrame(identity.documentId, identity.revision, null);
  return ack;
}
// Private text is deliberately excluded: Send consumes the committed native
// snapshot, but cannot act on a newer attachment or operation configuration.
function actionConfiguration(projection: DockProjection) {
  const { text: _text, ...configuration } = projection;
  return JSON.stringify(configuration);
}

/** One retained native host; existing features retain all operation authority. */
export function NativeAgentDock({ enabled }: { enabled: boolean }) {
  const { user } = useAuth();
  const dock = useAgentDockState();
  const ports = useNativeDockPorts();
  const theme = useNativeControlAppearance("secondary");
  const suppressed = useSessionChromeSuppressed();
  const webOverlay = useNativeShellOverlayBlocked();
  const nativeCovered = useSyncExternalStore(observeNativeDrawerIsolation, () => nativeDrawerIsolation().isolated, () => false);
  const overlay = webOverlay || nativeCovered;
  const regionRevision = useNativePresentationRegionRevision();
  const [supported, setSupported] = useState(false);
  const [discovered, setDiscovered] = useState(false);
  const [listenersReady, setListenersReady] = useState(false);
  const [measurement, measure] = useState(0);
  const family: "text" | "voice" = dock?.composerVisible ? "text" : "voice";
  const port = ports?.get(family);
  const current = useRef({ enabled, user: user?.uid, dock, ports, theme, suppressed, overlay, family, port });
  current.current = { enabled, user: user?.uid, dock, ports, theme, suppressed, overlay, family, port };
  const identity = useRef<DockIdentity | null>(null);
  const underlay = useRef(false);
  const reservedRegions = useRef(false);
  const coherentPresentation = useRef(false);
  const snapshotSupported = useRef(false);
  const fence = useRef<DockEventFence | null>(null);
  const generation = useRef(0);
  const previousOverlay = useRef(overlay);
  const update = useRef(0);
  const settledConsumption = useRef(0);
  const pending = useRef<Promise<void>>(Promise.resolve());
  const failed = useRef(false);
  const presentation = useRef(Symbol("native-dock"));
  const applied = useRef<{ sequence: number; configuration: string; privacyGeneration: number } | null>(null);
  const [active, setActive] = useState(false);
  const owner = useRef(user?.uid);
  useLayoutEffect(() => {
    if (previousOverlay.current === overlay) return;
    previousOverlay.current = overlay;
    // Presentation survives coverage; a pending action must not survive an
    // open/close cycle just because the same editor is retained.
    generation.current++;
    if (!overlay || !snapshotSupported.current || !identity.current || !applied.current || !port || port.projection.mode !== "text") return;
    const captured = identity.current, privacyGeneration = applied.current.privacyGeneration, account = user?.uid, handoffGeneration = generation.current;
    const original = port.projection;
    // The drawer may synchronously revoke input choices before the final edit
    // receipt reaches JS. Reconcile the committed text only, never an action.
    pending.current = pending.current.then(async () => {
      const result = await boundedDock(nativeDock.snapshotDraft({ ...captured, context: original.context,
        editorRevision: original.editorRevision, privacyGeneration }));
      const live = current.current, next = live.ports?.get(live.family);
      if (!result.valid || typeof result.text !== "string" || result.text.length > 1_000_000 || identity.current !== captured ||
          generation.current !== handoffGeneration || live.user !== account || !live.enabled || live.suppressed || isSessionChromeSuppressed() || !next || next.projection.context !== original.context ||
          next.projection.editorRevision !== original.editorRevision || next.projection.text !== original.text ||
          result.editorRevision !== original.editorRevision || applied.current?.privacyGeneration !== privacyGeneration ||
          typeof result.editRevision !== "number" || !fence.current?.acknowledgeDraftSnapshot(result.editRevision)) return;
      flushSync(() => next.onEdit?.(result.text!));
    }).catch(() => { /* No action or uncertain read is replayed. */ });
  }, [overlay, port, user?.uid]);
  useLayoutEffect(() => {
    if (owner.current === user?.uid) return;
    owner.current = user?.uid; generation.current++; failed.current = false;
    const previous = identity.current;
    identity.current = null; fence.current = null; settledConsumption.current = 0;
    // Clear the departing owner's private replica immediately, rather than
    // leaving it onscreen behind an outstanding feature operation.
    if (previous) {
      const retirement = (async () => {
      const ack = await retireDock(previous);
      if (!sameDock(previous, ack) || ack.phase !== "retired") throw new Error("NATIVE_DOCK_RETIRE_UNCONFIRMED");
      })();
      pending.current = Promise.all([pending.current.catch(() => undefined), retirement]).then(() => undefined)
        .catch(() => { failed.current = true; });
    }
  }, [user?.uid]);

  useLayoutEffect(() => {
    if (!customNativePresentationEnabled() || discovered || !enabled || !ports || !Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "ios") return;
    // Cold capability discovery is read-only. Reserve presentation before the
    // first paint rather than briefly exposing the DOM composer underneath it.
    presentationOwner = presentation.current;
    ports.present(true);
  }, [discovered, enabled, ports]);
  useEffect(() => { let live = true; void getNativeDockCapabilities().then(value => {
    if (!live) return;
    const admitted = value?.supported === true && value.contractVersion === 1;
    snapshotSupported.current = value?.draftSnapshot === true;
    underlay.current = admitted && value?.underlayPresentation === true;
    reservedRegions.current = admitted && value?.reservedPresentationRegions === true;
    coherentPresentation.current = admitted && value?.coherentPresentation === true;
    setDiscovered(true);
    setSupported(admitted);
    if (!admitted && !identity.current && presentationOwner === presentation.current) {
      ports?.present(false); setActive(false);
    }
  }); return () => { live = false; }; }, [ports]);

  useEffect(() => {
    if (!supported) return;
    let live = true;
    const subscriptions = [nativeDock.addListener("input", event => {
      const capturedGeneration = generation.current;
      let dispatched = false;
      let consuming: DockIdentity | null = null;
      const restoreUnsent = async () => {
        if (!consuming || identity.current !== consuming) return;
        // Consumption may have completed despite an uncertain receipt. Freeze
        // and retire that replica before restoring the unsent feature snapshot.
        failed.current = true;
        const ack = await retireDock({ ...consuming, preserveDraft: true });
        if (!sameDock(consuming, ack) || ack.phase !== "retired") throw new Error("NATIVE_DOCK_RETIRE_UNCONFIRMED");
        if (identity.current !== consuming) return;
        const port = current.current.ports?.get(current.current.family);
        const recovery = ack.recovery;
        if (port && recovery && recovery.consumed === false && recovery.context === port.projection.context &&
            recovery.editorRevision === port.projection.editorRevision && typeof recovery.text === "string" && recovery.text.length <= 1_000_000) {
          flushSync(() => port.onEdit?.(recovery.text));
        }
        identity.current = null; fence.current = null; failed.current = false;
        measure(value => value + 1);
      };
      pending.current = pending.current.then(async () => {
        const before = current.current;
        if (!validDockEvent(event) || !identity.current || !sameDock(identity.current, event) || !before.ports?.get(before.family) ||
            !before.enabled || before.suppressed || before.overlay || before.dock?.suppressed ||
            isSessionChromeSuppressed() || nativeShellOverlayBlocked()) return;
        const { documentId, ownerEpoch, revision, updateSequence, sequence, editRevision, editorRevision, privacyGeneration, context, kind } = event;
        const isolation = nativeDrawerIsolation();
        const confirmation = await boundedDock(nativeDock.confirmEvent({ documentId, ownerEpoch, revision, updateSequence, sequence, editRevision, editorRevision, privacyGeneration, context, kind }));
        const after = current.current;
        const afterPort = after.ports?.get(after.family);
        if (!confirmation.valid || isolation.isolated || nativeDrawerIsolation().isolated || isolation.generation !== nativeDrawerIsolation().generation || capturedGeneration !== generation.current || !after.enabled || after.dock?.suppressed || after.suppressed || after.overlay ||
            isSessionChromeSuppressed() || nativeShellOverlayBlocked() || !afterPort ||
            event.editorRevision !== afterPort.projection.editorRevision ||
            event.kind === "action" && (applied.current?.sequence !== event.updateSequence || applied.current.configuration !== actionConfiguration(afterPort.projection)) ||
            !fence.current?.accept(event, afterPort.projection.context, afterPort.projection.editorRevision)) return;
        if (event.kind === "action" && event.action === "send") {
          consuming = identity.current;
          const consumptionFence = fence.current;
          const consumption = await boundedDock(nativeDock.consumeDraft(event));
          const latest = current.current;
          const latestPort = latest.ports?.get(latest.family);
          if (identity.current !== consuming || fence.current !== consumptionFence) return;
          if (capturedGeneration !== generation.current || nativeDrawerIsolation().isolated ||
              isolation.generation !== nativeDrawerIsolation().generation) {
            // An overlay can invalidate admission while native consumption is
            // in flight. Retire that exact held replica without dispatching or
            // replaying Send; otherwise its editor would remain frozen.
            if (consumption.consumed) await restoreUnsent();
            return;
          }
          if (!consumption.consumed) {
            measure(value => value + 1);
            morphyToast.error("Your draft changed. Tap Send again when you’re ready.");
            return; // A newer native edit remains intact; do not retire it.
          }
          if (!consumptionFence?.acknowledgeConsumption(consumption.editRevision) ||
              !latest.enabled || latest.suppressed || latest.overlay || latest.dock?.suppressed ||
              isSessionChromeSuppressed() || nativeShellOverlayBlocked() || !latestPort || latestPort.projection.context !== event.context ||
              actionConfiguration(latestPort.projection) !== actionConfiguration(afterPort.projection)) {
            await restoreUnsent();
            morphyToast.error("Your draft changed. Tap Send again when you’re ready.");
            return; // Restore from the authoritative owner; never replay Send.
          }
          dispatched = true;
          let operation: void | Promise<void> = undefined;
          flushSync(() => { operation = latestPort.onAction(event); });
          await operation;
          if (identity.current === consuming && fence.current === consumptionFence) {
            settledConsumption.current = consumption.editRevision;
            measure(value => value + 1);
          }
        } else {
          const replacingEditor = event.kind === "paste" || event.kind === "action" &&
            ["attachment-edit", "attachment-remove", "collapse"].includes(event.action ?? "");
          if (replacingEditor) {
            consuming = identity.current;
            const transition = await boundedDock(nativeDock.beginEditingTransition({ documentId, ownerEpoch, revision, sequence, editRevision, editorRevision, privacyGeneration, context }));
            const latest = current.current;
            if (!transition.accepted) { morphyToast.error("Your draft changed. Try the edit again."); return; }
            if (capturedGeneration !== generation.current || nativeDrawerIsolation().isolated ||
                isolation.generation !== nativeDrawerIsolation().generation || identity.current !== consuming ||
                latest.ports?.get(latest.family) !== afterPort || latest.overlay || latest.suppressed || !latest.enabled ||
                isSessionChromeSuppressed() || nativeShellOverlayBlocked()) { await restoreUnsent(); return; }
          }
          if (event.kind === "edit") flushSync(() => afterPort.onEdit?.(event.text));
          else if (event.kind === "paste") flushSync(() => afterPort.onPaste?.(event.text, event.selectionStart, event.selectionEnd));
          else if (event.kind === "action") flushSync(() => afterPort.onAction(event));
        }
      }).catch(async () => {
        if (!dispatched && consuming) await restoreUnsent().catch(() => { failed.current = true; });
        if (dispatched && consuming && identity.current === consuming) {
          settledConsumption.current = fence.current?.editRevision ?? 0;
          measure(value => value + 1);
        }
        if (event?.kind === "action" && event.action === "send" && capturedGeneration === generation.current) {
          morphyToast.error(dispatched ? "Send wasn’t confirmed. Check the conversation before trying again." : "Send wasn’t confirmed. Your draft has not been sent.");
        }
      }); // Never log a private bridge error/payload or replay.
    }), nativeDock.addListener("layout", event => {
      const snapshot = applied.current;
      if (snapshot && current.current.enabled && !current.current.suppressed &&
          !isSessionChromeSuppressed() && (reservedRegions.current || coherentPresentation.current || !nativeShellOverlayBlocked()) &&
          snapshot.sequence === update.current && fence.current?.acceptLayout(event, snapshot.sequence, snapshot.privacyGeneration,
            { width: window.innerWidth, height: window.innerHeight })) {
        current.current.ports?.setLayout(event);
        if (reservedRegions.current) setNativeDockPresentationFrame(event.documentId, event.revision, event.frame.y);
        if (underlay.current) setNativeBaseAperture("agent-dock", event.revision, event.frame);
      }
    }), nativeDock.addListener("readmissionRequested", () => { generation.current++; measure(value => value + 1); })];
    const removePrivacy = subscribeNativeSessionPrivacy(() => {
      generation.current++; current.current.ports?.setLayout(null); measure(value => value + 1);
    });
    const handles = [...subscriptions, removePrivacy];
    const remove = () => handles.forEach(handle => { void handle.then(value => value.remove()).catch(() => undefined); });
    void Promise.all(handles.map(handle => boundedDock(handle))).then(() => {
      if (live) setListenersReady(true);
    }).catch(() => {
      if (!live) return;
      live = false; generation.current++; failed.current = true;
      remove();
      // No editor can have been admitted before all operation/privacy listeners
      // are ready. Restore only this presentation's untouched web fallback.
      if (!identity.current && presentationOwner === presentation.current) {
        current.current.ports?.present(false); setActive(false);
      }
    });
    return () => { live = false; remove(); };
  }, [supported]);

  useEffect(() => {
    const shell = dock?.host?.closest<HTMLElement>("[data-agent-bar-shell]");
    if (!supported || !shell) return;
    const observer = new ResizeObserver(() => measure(value => value + 1));
    observer.observe(shell);
    const resize = () => measure(value => value + 1);
    window.addEventListener("resize", resize);
    return () => { observer.disconnect(); window.removeEventListener("resize", resize); };
  }, [supported, dock?.host]);

  useLayoutEffect(() => {
    if (!supported || !listenersReady || !ports) return;
    if (!user?.uid || suppressed || dock?.suppressed) {
      generation.current++;
      const previous = identity.current;
      identity.current = null; fence.current = null;
      if (previous) void (async () => {
        const ack = await retireDock(previous);
        if (!sameDock(previous, ack) || ack.phase !== "retired") throw new Error("NATIVE_DOCK_RETIRE_UNCONFIRMED");
        if (!identity.current && presentationOwner === presentation.current) { ports.present(false); setActive(false); }
      })().catch(() => { ports.present(true); });
      return;
    }
    if (!enabled || overlay && !reservedRegions.current && !coherentPresentation.current || !port) {
      generation.current++;
      ports.setLayout(null);
      const lease = identity.current;
      if (lease) void (async () => {
        if (identity.current !== lease) return;
        const ack = await boundedDock(nativeDock.suspend(lease));
        if (!sameDock(lease, ack) || ack.phase !== "active") throw new Error("NATIVE_DOCK_SUSPEND_UNCONFIRMED");
      })().catch(() => { failed.current = true; });
      return;
    }
    if (!theme || !port || !dock?.host || failed.current) return;
    const shell = dock.host.closest<HTMLElement>("[data-agent-bar-shell]");
    const seat = family === "text" ? activeAgentDockSeat(dock.host) : shell?.querySelector<HTMLElement>("[data-agent-dock-surface]");
    if (!seat) return;
    const bounds = nativeDockRestingFrame(seat);
    if (!bounds || bounds.width < 88 || bounds.height < 44) return;
    const lease = identity.current ?? nextDockIdentity();
    if (!identity.current) { identity.current = lease; fence.current = new DockEventFence(lease); update.current = 0; settledConsumption.current = 0; }
    const sequence = ++update.current;
    const applyGeneration = generation.current;
    const configuration = actionConfiguration(port.projection);
    const snapshot = {
      ...lease, ...theme, ...port.projection, updateSequence: sequence,
      acknowledgedEdit: fence.current?.editRevision ?? 0,
      settledConsumption: settledConsumption.current,
      visible: enabled && (!overlay || reservedRegions.current || coherentPresentation.current),
      interactionEnabled: !overlay,
      frame: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
    // Conceal the fallback before preparation. It is never an active second editor.
    presentationOwner = presentation.current; ports.present(true); setActive(true);
    let admissionStage = 0;
    pending.current = pending.current.then(async () => {
      const isCurrent = () => identity.current === lease && !failed.current &&
        sequence === update.current && applyGeneration === generation.current;
      if (!isCurrent()) return;
      admissionStage = 1;
      const privacy = await boundedDock(getNativeSessionPrivacyState());
      if (privacy.shielded || !privacy.appIsActive || !isCurrent()) return;
      admissionStage = 2;
      if (reservedRegions.current && !await syncNativePresentationRegions()) return;
      // Layout admission is asynchronous too. It cannot authorize a snapshot
      // invalidated by an overlay, owner change or newer draft while waiting.
      if (!isCurrent()) return;
      admissionStage = 3;
      const ack = await boundedDock(nativeDock.apply({ ...snapshot, ...nativePresentationAdmission(), privacyGeneration: privacy.generation }));
      if (!isCurrent()) return;
      admissionStage = 4;
      if (!sameDock(lease, ack) || ack.updateSequence !== sequence || ack.phase !== "active") throw new Error("NATIVE_DOCK_ACK_UNCONFIRMED");
      if (ack.presentationApplied === false) return;
      if (underlay.current && ack.layout && sequence === update.current && applyGeneration === generation.current) {
        setNativeBaseAperture("agent-dock", lease.revision, ack.layout.frame);
      }
      applied.current = { sequence, configuration, privacyGeneration: privacy.generation };
      if (reservedRegions.current && ack.layout && sequence === update.current && applyGeneration === generation.current) {
        setNativeDockPresentationFrame(lease.documentId, lease.revision, ack.layout.frame.y);
      }
      if (ack.layout && sequence === update.current && applyGeneration === generation.current &&
          fence.current?.acceptLayout(ack.layout, sequence, privacy.generation, snapshot.viewport)) ports.setLayout(ack.layout);
    }).catch(async error => {
      if (identity.current !== lease || sequence !== update.current || applyGeneration !== generation.current) return;
      if (window.__HUSHH_NATIVE_TEST__?.enabled === true && shell) {
        // Opt-in public stage codes only; no error object, editor projection,
        // account/lease identity or provider response enters diagnostics.
        const codes = ["NATIVE_DOCK_ACK_UNCERTAIN", "NATIVE_DOCK_REFUSED", "NATIVE_DOCK_ACK_UNCONFIRMED",
          "NATIVE_REGIONS_GEOMETRY_INVALID", "NATIVE_REGIONS_ACK_UNCERTAIN", "NATIVE_REGIONS_ACK_UNCONFIRMED",
          "NATIVE_REGIONS_INVALID", "NATIVE_REGIONS_STALE", "NATIVE_REGIONS_PRIVACY_STALE", "NATIVE_REGIONS_INITIAL_POSE_INVALID"];
        shell.dataset.nativeDockFailureStage = String(admissionStage);
        shell.dataset.nativeDockFailureCode = String(error instanceof Error ? codes.indexOf(error.message) + 1 : 0);
      }
      failed.current = true;
      try {
        const ack = await retireDock(lease);
        if (!sameDock(lease, ack) || ack.phase !== "retired") return;
        identity.current = null; fence.current = null; ports.present(false); setActive(false);
      } catch { /* uncertain ownership remains concealed and noninteractive */ }
    });
  }, [supported, listenersReady, user?.uid, suppressed, dock?.suppressed, dock?.host, enabled, overlay, theme, port, measurement, ports, family, regionRevision]);

  useEffect(() => {
    const generationCounter = generation;
    const ownerAtUnmount = presentation.current;
    return () => {
      generationCounter.current++;
      const lease = identity.current;
      identity.current = null;
      if (lease) void retireDock(lease).then(ack => {
        if (sameDock(lease, ack) && ack.phase === "retired" && presentationOwner === ownerAtUnmount) {
          removeNativeBaseAperture("agent-dock", lease.revision);
          presentationOwner = null; current.current.ports?.present(false);
        }
      }).catch(() => undefined);
    };
  }, []);
  return active ? <span hidden data-native-agent-dock-active /> : null;
}
