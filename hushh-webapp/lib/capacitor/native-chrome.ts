"use client";

import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { nativeDocumentId } from "@/lib/capacitor/session-privacy";
import type { NativeControlAppearance } from "@/lib/capacitor/native-control-appearance";

// Presentation only. No route, UID, token, credential or content body crosses this bridge.
export type ChromeFrame = { x: number; y: number; width: number; height: number };
export type ChromeControlId = "top-shell-back" | "chat-history-toggle" | "chat-agent-surface";
export type ChromeFamily = "back" | "history" | "agent-surface";
export type ChromeAgentSurface = "one" | "puppy";
type ChromeControl = { kind: "back" | "history" } | { kind: "agent-surface"; value: ChromeAgentSurface };
export type ChromeIdentity = {
  documentId: string;
  ownerEpoch: string;
  controlId: ChromeControlId;
  revision: number;
};
export type ChromeControlProjection = NativeControlAppearance & ChromeControl & {
  label: string;
  enabled: boolean;
  frame: ChromeFrame;
  viewport: { width: number; height: number };
};
export type ChromeProjection = ChromeIdentity & ChromeControlProjection;
export type ChromeAcknowledgement = ChromeIdentity & {
  phase: "prepared" | "active" | "retired";
  frame?: ChromeFrame;
};
export type ChromeChoice = ChromeIdentity & { sequence: number; privacyGeneration: number; value?: ChromeAgentSurface };

export interface HushhNativeChromePlugin {
  getCapabilities(): Promise<{ contractVersion: number; families: ChromeFamily[]; canvasAppearance?: boolean; independentControls?: boolean }>;
  setCanvasAppearance(options: { documentId: string; revision: number; backgroundHex: string }): Promise<{ documentId: string; revision: number }>;
  prepare(options: ChromeProjection): Promise<ChromeAcknowledgement>;
  activate(options: ChromeIdentity): Promise<ChromeAcknowledgement>;
  retire(options: ChromeIdentity & { targetRevision?: number }): Promise<ChromeAcknowledgement>;
  confirmChoice(options: ChromeChoice): Promise<{ valid: boolean }>;
  addListener(eventName: "choiceRequested", listener: (event: ChromeChoice) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "invalidated", listener: () => void): Promise<PluginListenerHandle>;
}

export const nativeChrome = registerPlugin<HushhNativeChromePlugin>("HushhNativeChrome");
let revision = 0;
let canvasRevision = 0;

/** The existing CSS canvas is authoritative even when no native control is visible. */
export async function syncNativeCanvasAppearance(): Promise<boolean> {
  const backgroundHex = getComputedStyle(document.documentElement).getPropertyValue("--background").trim();
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(backgroundHex)) return false;
  // Reserve ordering before discovery: a delayed older request must never
  // repaint a theme that React has already replaced.
  const projection = { documentId: nativeDocumentId(), revision: ++canvasRevision, backgroundHex };
  const capability = await bounded(nativeChrome.getCapabilities());
  if (capability.canvasAppearance !== true) return false; // Older wrappers retain their existing canvas.
  if (projection.revision !== canvasRevision ||
      getComputedStyle(document.documentElement).getPropertyValue("--background").trim() !== backgroundHex) return false;
  const ack = await bounded(nativeChrome.setCanvasAppearance(projection));
  if (ack.documentId !== projection.documentId || ack.revision !== projection.revision) {
    throw new Error("NATIVE_CANVAS_ACK_UNCONFIRMED");
  }
  return true;
}
// A lease survives a React remount until native retirement is confirmed. This is
// not persisted; the native document fence handles a WebView reload.
const outstanding = new Map<ChromeControlId, ChromeIdentity>();
export function chromeControlId(kind: ChromeFamily): ChromeControlId {
  if (kind === "history") return "chat-history-toggle";
  if (kind === "agent-surface") return "chat-agent-surface";
  return "top-shell-back";
}
export function nextChromeIdentity(ownerEpoch: string, controlId: ChromeControlId = "top-shell-back"): ChromeIdentity {
  return { documentId: nativeDocumentId(), ownerEpoch, controlId, revision: ++revision };
}

function matches(ack: ChromeAcknowledgement, identity: ChromeIdentity, phase: ChromeAcknowledgement["phase"]) {
  return ack.phase === phase && ack.documentId === identity.documentId && ack.ownerEpoch === identity.ownerEpoch &&
    ack.controlId === identity.controlId && ack.revision === identity.revision;
}

/** A bounded wait is not a retry: an uncertain presentation must be retired. */
function bounded<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("NATIVE_CHROME_ACK_UNCERTAIN")), 3000);
    promise.then((result) => { clearTimeout(timer); resolve(result); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

export async function retireNativeChrome(ownerEpoch: string, target?: ChromeIdentity, controlId: ChromeControlId = target?.controlId ?? "top-shell-back"): Promise<void> {
  // A delayed failure may clean up only its own lease, never a replacement.
  if (target && target.controlId !== controlId) return;
  const pending = outstanding.get(controlId);
  if (target && pending && !matches({ ...pending, phase: "active" }, target, "active")) return;
  const identity = nextChromeIdentity(ownerEpoch, controlId);
  const ack = await bounded(nativeChrome.retire({ ...identity, targetRevision: target?.revision }));
  if (!matches(ack, identity, "retired")) throw new Error("NATIVE_CHROME_RETIRE_UNCONFIRMED");
  const latest = outstanding.get(controlId);
  if (!latest || latest.revision <= identity.revision) outstanding.delete(controlId);
}

/** Two-phase installation: the native control stays hidden until React commits
 * removal of the DOM interaction. A failed acknowledgement never enables both. */
export class NativeChromeLease {
  readonly projection: ChromeProjection;
  private current = true;
  private active = false;
  private sequence = 0;
  constructor(projection: ChromeControlProjection, ownerEpoch: string, readonly context = "") {
    this.projection = { ...projection, ...nextChromeIdentity(ownerEpoch, chromeControlId(projection.kind)) };
  }
  invalidate() { this.current = false; this.active = false; }
  async prepare(): Promise<boolean> {
    outstanding.set(this.projection.controlId, this.projection);
    const ack = await bounded(nativeChrome.prepare(this.projection));
    if (!matches(ack, this.projection, "prepared") || !ack.frame ||
        (Object.keys(this.projection.frame) as (keyof ChromeFrame)[]).some((key) =>
          !Number.isFinite(ack.frame![key]) || Math.abs(ack.frame![key] - this.projection.frame[key]) > 1)) {
      throw new Error("NATIVE_CHROME_LAYOUT_UNCONFIRMED");
    }
    return this.current;
  }
  async activate(): Promise<void> {
    if (!this.current) return;
    const ack = await bounded(nativeChrome.activate(this.projection));
    if (!matches(ack, this.projection, "active")) throw new Error("NATIVE_CHROME_ACTIVATE_UNCONFIRMED");
    this.active = this.current;
  }
  async choose(event: ChromeChoice, allowed: () => boolean, action: () => void): Promise<void> {
    if (!this.active || !this.current || !this.projection.enabled || !allowed() ||
        !matches({ ...event, phase: "active" }, this.projection, "active") ||
        !Number.isSafeInteger(event.sequence) || event.sequence <= this.sequence) return;
    if (this.projection.kind === "agent-surface" ? event.value !== "one" && event.value !== "puppy" : event.value !== undefined) return;
    // Consume locally before awaiting: duplicate notifications cannot race.
    this.sequence = event.sequence;
    const { valid } = await bounded(nativeChrome.confirmChoice({
      documentId: event.documentId, ownerEpoch: event.ownerEpoch, controlId: event.controlId,
      revision: event.revision, sequence: event.sequence, privacyGeneration: event.privacyGeneration,
      ...(event.value === undefined ? {} : { value: event.value }),
    }));
    if (valid && this.active && this.current && event.sequence === this.sequence && allowed()) {
      action();
    }
  }
}

export function hasOutstandingNativeChrome(controlId: ChromeControlId = "top-shell-back") { return outstanding.has(controlId); }
