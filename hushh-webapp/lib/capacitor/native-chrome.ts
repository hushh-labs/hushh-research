"use client";

import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { nativeDocumentId } from "@/lib/capacitor/session-privacy";
import type { NativeControlAppearance } from "@/lib/capacitor/native-control-appearance";

// Presentation only. No route, UID, token, credential or content body crosses this bridge.
export type ChromeFrame = { x: number; y: number; width: number; height: number };
export type ChromeIdentity = {
  documentId: string;
  ownerEpoch: string;
  controlId: "top-shell-back";
  revision: number;
};
export type ChromeProjection = ChromeIdentity & NativeControlAppearance & {
  kind: "back";
  label: string;
  enabled: boolean;
  frame: ChromeFrame;
  viewport: { width: number; height: number };
};
export type ChromeAcknowledgement = ChromeIdentity & {
  phase: "prepared" | "active" | "retired";
  frame?: ChromeFrame;
};
export type ChromeChoice = ChromeIdentity & { sequence: number; privacyGeneration: number };

export interface HushhNativeChromePlugin {
  getCapabilities(): Promise<{ contractVersion: number; families: "back"[] }>;
  prepare(options: ChromeProjection): Promise<ChromeAcknowledgement>;
  activate(options: ChromeIdentity): Promise<ChromeAcknowledgement>;
  retire(options: ChromeIdentity & { targetRevision?: number }): Promise<ChromeAcknowledgement>;
  confirmChoice(options: ChromeChoice): Promise<{ valid: boolean }>;
  addListener(eventName: "choiceRequested", listener: (event: ChromeChoice) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "invalidated", listener: () => void): Promise<PluginListenerHandle>;
}

export const nativeChrome = registerPlugin<HushhNativeChromePlugin>("HushhNativeChrome");
let revision = 0;
// A lease survives a React remount until native retirement is confirmed. This is
// not persisted; the native document fence handles a WebView reload.
let outstanding: ChromeIdentity | null = null;
export function nextChromeIdentity(ownerEpoch: string): ChromeIdentity {
  return { documentId: nativeDocumentId(), ownerEpoch, controlId: "top-shell-back", revision: ++revision };
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

export async function retireNativeChrome(ownerEpoch: string, target?: ChromeIdentity): Promise<void> {
  // A delayed failure may clean up only its own lease, never a replacement.
  if (target && outstanding && outstanding.revision !== target.revision) return;
  const identity = nextChromeIdentity(ownerEpoch);
  const ack = await bounded(nativeChrome.retire({ ...identity, targetRevision: target?.revision }));
  if (!matches(ack, identity, "retired")) throw new Error("NATIVE_CHROME_RETIRE_UNCONFIRMED");
  if (!outstanding || outstanding.revision <= identity.revision) outstanding = null;
}

/** Two-phase installation: the native control stays hidden until React commits
 * removal of the DOM interaction. A failed acknowledgement never enables both. */
export class NativeChromeLease {
  readonly projection: ChromeProjection;
  private current = true;
  private active = false;
  private sequence = 0;
  constructor(projection: Omit<ChromeProjection, keyof ChromeIdentity>, ownerEpoch: string, readonly context = "") {
    this.projection = { ...projection, ...nextChromeIdentity(ownerEpoch) };
  }
  invalidate() { this.current = false; this.active = false; }
  async prepare(): Promise<boolean> {
    outstanding = this.projection;
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
    // Consume locally before awaiting: duplicate notifications cannot race.
    this.sequence = event.sequence;
    const { valid } = await bounded(nativeChrome.confirmChoice({
      documentId: event.documentId, ownerEpoch: event.ownerEpoch, controlId: event.controlId,
      revision: event.revision, sequence: event.sequence, privacyGeneration: event.privacyGeneration,
    }));
    if (valid && this.active && this.current && event.sequence === this.sequence && allowed()) {
      action();
    }
  }
}

export function hasOutstandingNativeChrome() { return outstanding !== null; }
