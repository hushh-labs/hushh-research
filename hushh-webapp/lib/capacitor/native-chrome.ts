"use client";

import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { nativeDocumentId } from "@/lib/capacitor/session-privacy";
import type { NativeControlAppearance } from "@/lib/capacitor/native-control-appearance";

// Presentation only. No route, UID, token, credential or content body crosses this bridge.
export type ChromeFrame = { x: number; y: number; width: number; height: number };
export type ChromeControlId = "top-shell-back" | "profile-back" | "chat-history-toggle" | "chat-agent-surface" | "stationary-more" | "bounded-selection" | "bounded-date" | "profile-close" | "profile-appearance" | "profile-accent";
export type ChromeFamily = "back" | "profile-back" | "history" | "agent-surface" | "more" | "selection" | "date" | "close" | "appearance" | "accent";
export type ChromeAgentSurface = "one" | "puppy";
export type ChromeOption = { value: string; label: string; disabled?: boolean };
export type ChromeControl = { kind: "back" | "profile-back" | "close" } | { kind: "history"; expanded?: boolean } |
  { kind: "agent-surface"; value: ChromeAgentSurface } |
  { kind: "appearance"; value: "light" | "dark" | "system" } |
  { kind: "accent"; value: "blue" | "gold" } |
  { kind: "more"; options: readonly ChromeOption[] } |
  { kind: "selection"; value: string; options: readonly ChromeOption[] } |
  { kind: "date"; value: string; minimum: string; maximum: string };
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
export type ChromeChoice = ChromeIdentity & { sequence: number; privacyGeneration: number; updateSequence?: number; value?: string };
export type ChromeUpdate = NativeControlAppearance & { enabled: boolean; value?: string; expanded?: boolean };
export type ChromeUpdateAcknowledgement = ChromeIdentity & { updateSequence: number };
type ChromeGeometry = Pick<ChromeControlProjection, "frame" | "viewport">;
export type ChromeFocusAcknowledgement = ChromeIdentity & { updateSequence: number; focusSequence: number; restored: boolean };
export type NativeChromeCapabilities = {
  contractVersion: number; families: readonly ChromeFamily[]; canvasAppearance?: boolean;
  independentControls?: boolean; inPlaceUpdates?: boolean; focusReturn?: boolean; rehearsalDiagnostics?: boolean;
};

export interface HushhNativeChromePlugin {
  getCapabilities(): Promise<NativeChromeCapabilities>;
  restoreFocus(options: ChromeIdentity & { updateSequence: number; focusSequence: number }): Promise<ChromeFocusAcknowledgement>;
  update(options: ChromeIdentity & ChromeUpdate & { updateSequence: number }): Promise<ChromeUpdateAcknowledgement>;
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
// Immutable wrapper metadata only, scoped to this WebView document. Never
// cache a lease, owner, geometry, permission or presentation admission here.
let discovery: { documentId: string; promise: Promise<NativeChromeCapabilities>; value?: NativeChromeCapabilities } | undefined;
export function peekNativeChromeCapabilities(): NativeChromeCapabilities | undefined {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "ios") return undefined;
  return discovery?.documentId === nativeDocumentId() ? discovery.value : undefined;
}
export function getNativeChromeCapabilities(): Promise<NativeChromeCapabilities | null> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "ios") return Promise.resolve(null);
  const documentId = nativeDocumentId();
  if (discovery?.documentId === documentId) return discovery.promise;
  const pending: NonNullable<typeof discovery> = { documentId, promise: bounded(nativeChrome.getCapabilities()).then((value) => {
    const snapshot = Object.freeze({ ...value, families: Object.freeze([...value.families]) });
    if (discovery === pending && nativeDocumentId() === documentId) pending.value = snapshot;
    return snapshot;
  }).catch((error: unknown) => {
    if (discovery === pending) discovery = undefined;
    throw error; // A later request may recover; an uncertain operation is never replayed.
  }) };
  discovery = pending;
  return pending.promise;
}
export function supportsNativeChrome(family: ChromeFamily): boolean {
  const capability = peekNativeChromeCapabilities();
  return capability?.contractVersion === 2 && capability.independentControls === true && capability.families.includes(family);
}

/** Measure only the authored slot. Resize notifications are not proof that
 * its admitted geometry changed; clipping and inert ancestors still matter. */
export function measureNativeChromeGeometry(slot: HTMLElement, kind: ChromeFamily): ChromeGeometry | null {
  if (slot.closest("[inert]")) return null;
  const frame = slot.getBoundingClientRect();
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const minimumWidth = kind === "appearance" ? 132 : kind === "agent-surface" ? 88 : 44;
  const widthAdmitted = kind === "agent-surface" || kind === "appearance"
    ? frame.width >= minimumWidth && frame.width <= 320 : frame.width === 44;
  if (!widthAdmitted || frame.height !== 44 ||
      ![frame.x, frame.y, viewport.width, viewport.height].every(Number.isFinite) ||
      frame.left < 0 || frame.top < 0 || frame.right > viewport.width || frame.bottom > viewport.height) return null;
  if (kind === "appearance" || kind === "accent") {
    for (let parent = slot.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const bounds = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY) && (frame.top < bounds.top || frame.bottom > bounds.bottom) ||
          /(auto|scroll|hidden|clip)/.test(style.overflowX) && (frame.left < bounds.left || frame.right > bounds.right)) return null;
    }
  }
  return { frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height }, viewport };
}

/** The existing CSS canvas is authoritative even when no native control is visible. */
export async function syncNativeCanvasAppearance(): Promise<boolean> {
  const backgroundHex = getComputedStyle(document.documentElement).getPropertyValue("--background").trim();
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(backgroundHex)) return false;
  // Reserve ordering before discovery: a delayed older request must never
  // repaint a theme that React has already replaced.
  const projection = { documentId: nativeDocumentId(), revision: ++canvasRevision, backgroundHex };
  const capability = await getNativeChromeCapabilities();
  if (capability?.canvasAppearance !== true) return false; // Older wrappers retain their existing canvas.
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
  if (kind === "profile-back") return "profile-back";
  if (kind === "history") return "chat-history-toggle";
  if (kind === "agent-surface") return "chat-agent-surface";
  if (kind === "appearance") return "profile-appearance";
  if (kind === "accent") return "profile-accent";
  if (kind === "more") return "stationary-more";
  if (kind === "selection") return "bounded-selection";
  if (kind === "date") return "bounded-date";
  if (kind === "close") return "profile-close";
  return "top-shell-back";
}

function admittedValue(projection: ChromeControlProjection, value: string | undefined): boolean {
  if (projection.kind === "agent-surface") return value === "one" || value === "puppy";
  if (projection.kind === "appearance") return value === "light" || value === "dark" || value === "system";
  if (projection.kind === "accent") return value === "blue" || value === "gold";
  if (projection.kind === "selection" || projection.kind === "more") {
    return projection.options.some((option) => !option.disabled && option.value === value);
  }
  if (projection.kind === "date") {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const instant = Date.parse(value);
    return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value &&
      value >= projection.minimum && value <= projection.maximum;
  }
  return value === undefined;
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
  private layoutConfirmed = false;
  private sequence = 0;
  private requestedUpdate = 0;
  private appliedUpdate = 0;
  private activation: Promise<void> | undefined;
  private focusSequence = 0;
  constructor(projection: ChromeControlProjection, ownerEpoch: string, readonly context = "", readonly inPlaceUpdates = false) {
    this.projection = { ...projection, ...nextChromeIdentity(ownerEpoch, chromeControlId(projection.kind)) };
  }
  invalidate() { this.current = false; this.active = false; }
  /** Exact equality, not the one-pixel acknowledgement tolerance. A real move,
   * changed viewport, or unconfirmed/invalidated lease must be re-admitted. */
  matchesGeometry(geometry: ChromeGeometry): boolean {
    return this.current && this.layoutConfirmed &&
      (Object.keys(this.projection.frame) as (keyof ChromeFrame)[]).every((key) =>
        geometry.frame[key] === this.projection.frame[key]) &&
      geometry.viewport.width === this.projection.viewport.width && geometry.viewport.height === this.projection.viewport.height;
  }
  async prepare(): Promise<boolean> {
    outstanding.set(this.projection.controlId, this.projection);
    const ack = await bounded(nativeChrome.prepare(this.projection));
    if (!matches(ack, this.projection, "prepared") || !ack.frame ||
        (Object.keys(this.projection.frame) as (keyof ChromeFrame)[]).some((key) =>
          !Number.isFinite(ack.frame![key]) || Math.abs(ack.frame![key] - this.projection.frame[key]) > 1)) {
      throw new Error("NATIVE_CHROME_LAYOUT_UNCONFIRMED");
    }
    this.layoutConfirmed = true;
    return this.current;
  }
  async activate(): Promise<void> {
    if (!this.current) return;
    this.activation ??= (async () => {
      const ack = await bounded(nativeChrome.activate(this.projection));
      if (!matches(ack, this.projection, "active")) throw new Error("NATIVE_CHROME_ACTIVATE_UNCONFIRMED");
      this.active = this.current;
    })();
    await this.activation;
  }
  /** Presentation only; a focus transfer cannot replay an authored action. */
  async restoreFocus(allowed: () => boolean): Promise<boolean> {
    if (!this.active || !this.current || !this.projection.enabled || !allowed() ||
        this.requestedUpdate !== this.appliedUpdate) return false;
    const updateSequence = this.appliedUpdate;
    const focusSequence = ++this.focusSequence;
    const ack = await bounded(nativeChrome.restoreFocus({ ...this.projection, updateSequence, focusSequence }));
    if (!matches({ ...ack, phase: "active" }, this.projection, "active") ||
        ack.updateSequence !== updateSequence || ack.focusSequence !== focusSequence || ack.restored !== true) {
      throw new Error("NATIVE_CHROME_FOCUS_UNCONFIRMED");
    }
    return this.current && this.active && allowed() && this.focusSequence === focusSequence &&
      this.requestedUpdate === updateSequence && this.appliedUpdate === updateSequence;
  }
  /** Fence choices synchronously; only the latest acknowledged snapshot is usable.
   * A stale update failure cannot retire or overwrite a newer presentation. */
  async update(presentation: ChromeUpdate): Promise<boolean> {
    if (!this.current || !this.inPlaceUpdates) return false;
    if (this.projection.kind !== "more" && !admittedValue(this.projection, presentation.value) ||
        this.projection.kind === "more" && presentation.value !== undefined) {
      throw new Error("NATIVE_CHROME_UPDATE_INVALID");
    }
    if (this.active && this.requestedUpdate === this.appliedUpdate &&
        presentation.appearance === this.projection.appearance && presentation.accentHex === this.projection.accentHex &&
        presentation.foregroundHex === this.projection.foregroundHex && presentation.enabled === this.projection.enabled &&
        presentation.value === ("value" in this.projection ? this.projection.value : undefined) &&
        presentation.expanded === ("expanded" in this.projection ? this.projection.expanded : undefined)) return true;
    const updateSequence = ++this.requestedUpdate;
    await this.activate();
    if (!this.current || updateSequence !== this.requestedUpdate) return false;
    try {
      const ack = await bounded(nativeChrome.update({ ...this.projection, ...presentation, updateSequence }));
      if (!this.current || updateSequence !== this.requestedUpdate) return false;
      if (!matches({ ...ack, phase: "active" }, this.projection, "active") || ack.updateSequence !== updateSequence) {
        throw new Error("NATIVE_CHROME_UPDATE_UNCONFIRMED");
      }
      Object.assign(this.projection, presentation);
      this.appliedUpdate = updateSequence;
      return true;
    } catch (error) {
      if (!this.current || updateSequence !== this.requestedUpdate) return false;
      throw error;
    }
  }
  async choose(event: ChromeChoice, allowed: () => boolean, action: () => void): Promise<void> {
    if (!this.active || !this.current || !this.projection.enabled || !allowed() ||
        (this.inPlaceUpdates && (this.requestedUpdate !== this.appliedUpdate || event.updateSequence !== this.appliedUpdate)) ||
        !matches({ ...event, phase: "active" }, this.projection, "active") ||
        !Number.isSafeInteger(event.sequence) || event.sequence <= this.sequence) return;
    if (!admittedValue(this.projection, event.value)) return;
    // Consume locally before awaiting: duplicate notifications cannot race.
    this.sequence = event.sequence;
    const { valid } = await bounded(nativeChrome.confirmChoice({
      documentId: event.documentId, ownerEpoch: event.ownerEpoch, controlId: event.controlId,
      revision: event.revision, sequence: event.sequence, privacyGeneration: event.privacyGeneration,
      ...(this.inPlaceUpdates ? { updateSequence: event.updateSequence } : {}),
      ...(event.value === undefined ? {} : { value: event.value }),
    }));
    if (valid && this.active && this.current && event.sequence === this.sequence &&
        (!this.inPlaceUpdates || this.requestedUpdate === this.appliedUpdate && event.updateSequence === this.appliedUpdate) && allowed()) {
      action();
    }
  }
}

export function hasOutstandingNativeChrome(controlId: ChromeControlId = "top-shell-back") { return outstanding.has(controlId); }
