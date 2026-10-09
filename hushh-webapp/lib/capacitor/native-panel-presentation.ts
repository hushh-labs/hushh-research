"use client";

import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { getNativeChromeCapabilities, nativeChrome, type ChromeFrame } from "./native-chrome";
import { getNativeSessionPrivacyState, nativeDocumentId, subscribeNativeSessionPrivacy } from "./session-privacy";

export type NativePanelIdentity = {
  documentId: string; ownerEpoch: string; group: "profile" | "history"; generation: number;
};
export type NativePanelPose = NativePanelIdentity & {
  sequence: number; privacyGeneration: number; frame: ChromeFrame;
  offset: number; opacity: number; settled: boolean; sampledAtMs?: number;
};
export type NativePanelReceipt = NativePanelIdentity & { sequence: number; privacyGeneration: number };
type Entry = { identity: NativePanelIdentity; confirmed: boolean; offset: number; frame: ChromeFrame };
export const NATIVE_PANEL_LAYOUT_EVENT = "hushh:native-panel-layout";
const panels = new WeakMap<HTMLElement, Entry>();
let generation = 0;

/** The owning pane authors this registration; no inferred DOM action or content. */
export function nativePanelGeometry(slot: HTMLElement) {
  const panel = slot.closest<HTMLElement>("[data-native-panel-group]");
  const entry = panel && panels.get(panel);
  if (!entry?.confirmed || entry.identity.documentId !== nativeDocumentId()) return undefined;
  return { presentationGroup: entry.identity.group, presentationOwnerEpoch: entry.identity.ownerEpoch,
    presentationGeneration: entry.identity.generation, offset: entry.offset };
}

/** Bounded latest-wins transport. A delayed pose never builds a per-frame queue. */
export class NativePanelPoseWriter {
  private pending: NativePanelPose | undefined;
  private sending = false;
  private retired = false;
  constructor(private readonly send: (pose: NativePanelPose) => Promise<NativePanelReceipt>,
    private readonly failed: () => void, private readonly receipt?: (roundTripMs: number) => void) {}
  publish(pose: NativePanelPose) {
    if (this.retired) return;
    this.pending = pose;
    void this.flush();
  }
  retire() { this.retired = true; this.pending = undefined; }
  private async flush() {
    if (this.sending || this.retired || !this.pending) return;
    const pose = this.pending;
    this.pending = undefined; this.sending = true;
    const started = performance.now();
    try {
      const ack = await new Promise<NativePanelReceipt>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("NATIVE_PANEL_ACK_UNCERTAIN")), 3000);
        this.send(pose).then(result => { clearTimeout(timer); resolve(result); },
          error => { clearTimeout(timer); reject(error); });
      });
      if (this.retired) return;
      if (ack.documentId !== pose.documentId || ack.ownerEpoch !== pose.ownerEpoch || ack.group !== pose.group ||
          ack.generation !== pose.generation || ack.sequence !== pose.sequence || ack.privacyGeneration !== pose.privacyGeneration) {
        throw new Error("NATIVE_PANEL_ACK_UNCONFIRMED");
      }
      this.receipt?.(performance.now() - started);
    } catch { if (!this.retired) { this.retire(); this.failed(); } }
    finally { this.sending = false; if (!this.retired) void this.flush(); }
  }
}

/** Mirror the existing full-panel gesture/animation, never a gesture decision.
 * Reads/writes remain panel-local; React state is not updated on animation frames. */
export function useNativePanelPresentation(group: "profile" | "history", owner: string | null,
  panelRef: RefObject<HTMLElement | null>, open: boolean) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [recovery, setRecovery] = useState(0);
  const openState = useRef(open);
  const wakeCurrent = useRef<(() => void) | undefined>(undefined);
  useLayoutEffect(() => { openState.current = open; wakeCurrent.current?.(); }, [open]);
  const attach = useCallback((element: HTMLElement | null) => {
    panelRef.current = element;
    setNode(element);
  }, [panelRef]);
  useLayoutEffect(() => {
    const panel = node;
    if (!owner || !panel) return;
    let cancelled = false, frame = 0, sequence = 0, privacyGeneration = -1;
    let writer: NativePanelPoseWriter | undefined;
    let handle: Awaited<ReturnType<typeof subscribeNativeSessionPrivacy>> | undefined;
    let previous = "";
    const identity: NativePanelIdentity = { documentId: nativeDocumentId(), ownerEpoch: crypto.randomUUID(), group, generation: ++generation };
    const entry: Entry = { identity, confirmed: false, offset: 0, frame: { x: 0, y: 0, width: 0, height: 0 } };
    const fail = () => {
      panel.setAttribute("data-native-panel-status", "unconfirmed");
      panels.delete(panel);
      window.dispatchEvent(new Event(NATIVE_PANEL_LAYOUT_EVENT));
      if (writer) void nativeChrome.retirePanel(identity).catch(() => undefined);
      // No operation retry or native-to-web swap is performed by the pose writer.
    };
    const sample = () => {
      frame = 0;
      if (cancelled || !panel.isConnected || privacyGeneration < 0) return;
      const bounds = panel.getBoundingClientRect();
      const x = group === "profile" ? window.innerWidth - bounds.width : 0;
      const style = getComputedStyle(panel);
      const moving = panel.getAnimations().some(animation => animation.playState === "running") ||
        panel.dataset.profilePull === "drag" || panel.dataset.profilePull === "spring";
      const pose: NativePanelPose = { ...identity, sequence: sequence + 1, privacyGeneration, sampledAtMs: Date.now(),
        frame: { x, y: bounds.y, width: bounds.width, height: bounds.height },
        offset: Math.max(-bounds.width, Math.min(bounds.width, bounds.x - x)),
        opacity: style.visibility === "hidden" ? 0 : Math.max(0, Math.min(1, Number.parseFloat(style.opacity) || (style.opacity === "0" ? 0 : 1))),
        settled: !moving && Math.abs(bounds.x - x) < 1 && openState.current };
      entry.offset = pose.offset; entry.frame = pose.frame;
      const signature = JSON.stringify([pose.frame, pose.offset, pose.opacity, pose.settled, privacyGeneration]);
      if (signature !== previous) { previous = signature; sequence += 1; writer?.publish(pose); }
      if (moving) frame = requestAnimationFrame(sample);
    };
    const wake = () => { if (!cancelled && !frame) frame = requestAnimationFrame(sample); };
    wakeCurrent.current = wake;
    // Only the authored panel's presentation writes wake sampling. Content,
    // loading indicators and our timing probe cannot create an idle RAF loop.
    const changes = new MutationObserver(wake);
    changes.observe(panel, { attributes: true, attributeFilter: ["style", "class", "data-state", "data-profile-pull"] });
    const resize = new ResizeObserver(wake); resize.observe(panel);
    const viewportChanged = () => { if (!cancelled) setRecovery(value => value + 1); };
    window.addEventListener("resize", viewportChanged);
    for (const event of ["transitionrun", "transitionend", "transitioncancel", "animationstart", "animationend", "animationcancel"]) panel.addEventListener(event, wake);
    void (async () => {
      try {
        const capability = await getNativeChromeCapabilities();
        if (cancelled || capability?.panelPresentation !== true) return;
        handle = await subscribeNativeSessionPrivacy(state => {
          if (privacyGeneration < 0) return; // Initial retained events are caught up by the read below.
          if (state.shielded || !state.appIsActive) { writer?.retire(); fail(); }
          else if ((state.generation !== privacyGeneration || !writer) && !cancelled) setRecovery(value => value + 1);
        });
        if (cancelled) { await handle.remove(); return; }
        const privacy = await getNativeSessionPrivacyState();
        if (cancelled) return;
        privacyGeneration = privacy.generation;
        if (privacy.shielded || !privacy.appIsActive) return;
        panels.set(panel, entry);
        writer = new NativePanelPoseWriter(async pose => {
          const ack = await nativeChrome.applyPanelPose(pose);
          return ack;
        }, fail, age => {
          // Public, bounded timing only; no identity or protected body in probes.
          if (!entry.confirmed) {
            entry.confirmed = true;
            window.dispatchEvent(new Event(NATIVE_PANEL_LAYOUT_EVENT));
          }
          panel.dataset.nativePanelMaxRoundTripMs = String(Math.round(Math.max(age,
            Number(panel.dataset.nativePanelMaxRoundTripMs) || 0) * 100) / 100);
        });
        wake();
      } catch { if (!cancelled) fail(); }
    })();
    return () => {
      cancelled = true; cancelAnimationFrame(frame); writer?.retire(); void handle?.remove();
      if (wakeCurrent.current === wake) wakeCurrent.current = undefined;
      changes.disconnect(); resize.disconnect();
      window.removeEventListener("resize", viewportChanged);
      for (const event of ["transitionrun", "transitionend", "transitioncancel", "animationstart", "animationend", "animationcancel"]) panel.removeEventListener(event, wake);
      if (panels.get(panel) === entry) panels.delete(panel);
      if (writer) void nativeChrome.retirePanel(identity).catch(() => {
        // Uncertain retirement remains noninteractive; it is not retried.
      });
    };
  }, [group, owner, node, recovery]);
  return attach;
}
