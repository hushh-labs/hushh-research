"use client";

import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { nativeDocumentId } from "./session-privacy";
import { customNativePresentationEnabled } from "./native-presentation-policy";
import type { NativeControlAppearance } from "./native-control-appearance";

/** Private, memory-only input adapter. Never put these payloads in chrome
 * metadata, diagnostics, storage or retained Capacitor listener events. */
export type DockAction = "send" | "mic" | "cancel" | "voice-tap" | "capture-start" | "capture-finish" | "capture-cancel" | "mute" | "attachment-edit" | "attachment-remove" | "collapse";
export type DockAttachment = { id: string; label: string; editable?: boolean };
export type DockProjection = {
  context: string;
  mode: "text" | "voice";
  text: string;
  placeholder: string;
  /** Authored public accessibility name; never inferred from a private context. */
  editorLabel?: "Message One" | "Message Puppy";
  expanded: boolean;
  editable: boolean;
  sendEnabled: boolean;
  micEnabled: boolean;
  cancelEnabled: boolean;
  recording: boolean;
  recordingReady: boolean;
  muted: boolean;
  supportsHold: boolean;
  attachments: readonly DockAttachment[];
  attachmentRevision: number;
  editorRevision: number;
};
export type DockIdentity = { documentId: string; ownerEpoch: string; revision: number };
export type DockState = DockIdentity & NativeControlAppearance & DockProjection & {
  updateSequence: number;
  acknowledgedEdit: number;
  privacyGeneration: number;
  presentationRegionRevision?: number;
  settledConsumption: number;
  visible: boolean;
  interactionEnabled?: boolean;
  frame: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
};
export type DockLayout = DockIdentity & {
  updateSequence: number; layoutSequence: number; privacyGeneration: number;
  frame: DockState["frame"]; viewport: DockState["viewport"];
};
export type DockAcknowledgement = DockIdentity & { updateSequence: number; phase: "active" | "retired"; height: number;
  presentationApplied?: boolean;
  layout?: DockLayout;
  recovery?: { text: string; context: string; editorRevision: number; consumed: boolean };
};
export type DockEvent = DockIdentity & {
  updateSequence: number;
  sequence: number;
  editRevision: number;
  editorRevision: number;
  privacyGeneration: number;
  context: string;
  kind: "edit" | "paste" | "action";
  text: string;
  selectionStart: number;
  selectionEnd: number;
  action?: DockAction;
  attachmentId?: string;
};
export type NativeDockCapabilities = { contractVersion: number; supported: boolean; draftSnapshot?: boolean; coherentPresentation?: boolean; underlayPresentation?: boolean; contentBackedPresentation?: boolean; reservedPresentationRegions?: boolean; fullWindowOverlays?: boolean };
export interface HushhNativeDockPlugin {
  getCapabilities(): Promise<NativeDockCapabilities>;
  snapshotDraft(options: DockIdentity & { context: string; editorRevision: number; privacyGeneration: number }): Promise<{ valid: boolean; text?: string; editorRevision?: number; editRevision?: number }>;
  apply(options: DockState): Promise<DockAcknowledgement>;
  retire(options: DockIdentity & { preserveDraft?: boolean }): Promise<DockAcknowledgement>;
  suspend(options: DockIdentity): Promise<DockAcknowledgement>;
  consumeDraft(options: Pick<DockEvent, keyof DockIdentity | "sequence" | "editRevision" | "privacyGeneration" | "context">): Promise<{ consumed: boolean; editRevision: number }>;
  beginEditingTransition(options: Pick<DockEvent, keyof DockIdentity | "sequence" | "editRevision" | "editorRevision" | "privacyGeneration" | "context">): Promise<{ accepted: boolean }>;
  confirmEvent(options: Pick<DockEvent, keyof DockIdentity | "sequence" | "updateSequence" | "privacyGeneration" | "context" | "kind" | "editRevision" | "editorRevision">): Promise<{ valid: boolean }>;
  addListener(eventName: "input", listener: (event: DockEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "layout", listener: (event: DockLayout) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "readmissionRequested", listener: () => void): Promise<PluginListenerHandle>;
}
export const nativeDock = registerPlugin<HushhNativeDockPlugin>("HushhNativeDock");

/** Measure the authored resting seat, not the CSS scroll pose sampled during
 * a draft/theme update. Native's pose may lag CSS, so its offset is not a valid
 * compensation. Keyboard `translate` remains separately owned. */
export function nativeDockRestingFrame(seat: HTMLElement) {
  const bounds = seat.getBoundingClientRect();
  const movers = new Set([
    seat.closest<HTMLElement>("[data-bottom-shell-motion-stack]"),
    seat.closest<HTMLElement>('[data-agent-chat-composer-form="root"]'),
  ].filter((node): node is HTMLElement => node !== null));
  let offset = 0;
  for (const mover of movers) {
    const transform = getComputedStyle(mover).transform;
    if (!transform || transform === "none") continue;
    try {
      const matrix = new DOMMatrixReadOnly(transform);
      if (!matrix.is2D || matrix.a !== 1 || matrix.b !== 0 || matrix.c !== 0 || matrix.d !== 1 || !Number.isFinite(matrix.f)) return null;
      offset += matrix.f;
    } catch { return null; }
  }
  return { x: bounds.x, y: bounds.y - offset, width: bounds.width, height: bounds.height };
}
let capability: { documentId: string; promise: Promise<NativeDockCapabilities | null> } | undefined;
export function getNativeDockCapabilities() {
  if (!customNativePresentationEnabled()) return Promise.resolve(null);
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "ios") return Promise.resolve(null);
  const documentId = nativeDocumentId();
  if (capability?.documentId === documentId) return capability.promise;
  capability = { documentId, promise: boundedDock(nativeDock.getCapabilities()).catch(() => null) };
  return capability.promise;
}
export function boundedDock<T>(operation: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("NATIVE_DOCK_ACK_UNCERTAIN")), 3000);
    operation.then(value => { clearTimeout(timer); resolve(value); }, () => {
      clearTimeout(timer); reject(new Error("NATIVE_DOCK_REFUSED"));
    });
  });
}
let revision = 0;
export function nextDockIdentity(): DockIdentity {
  return { documentId: nativeDocumentId(), ownerEpoch: crypto.randomUUID(), revision: ++revision };
}
export function sameDock(identity: DockIdentity, other: DockIdentity): boolean {
  return identity.documentId === other.documentId && identity.ownerEpoch === other.ownerEpoch && identity.revision === other.revision;
}

const actions: readonly DockAction[] = ["send", "mic", "cancel", "voice-tap", "capture-start", "capture-finish", "capture-cancel", "mute", "attachment-edit", "attachment-remove", "collapse"];
/** Reject malformed bridge input before it reaches a feature owner. */
export function validDockEvent(event: DockEvent): boolean {
  if (!event || typeof event.text !== "string" || event.text.length > 1_000_000 ||
      typeof event.context !== "string" || !event.context || event.context.length > 128 ||
      !["edit", "paste", "action"].includes(event.kind) ||
      ![event.revision, event.updateSequence, event.sequence].every(value => Number.isSafeInteger(value) && value > 0) ||
      ![event.editRevision, event.editorRevision, event.privacyGeneration, event.selectionStart, event.selectionEnd].every(value => Number.isSafeInteger(value) && value >= 0) ||
      event.selectionEnd < event.selectionStart) return false;
  if (event.kind !== "paste" && event.selectionEnd > event.text.length) return false;
  return event.kind !== "action" || actions.includes(event.action!) &&
    (event.attachmentId === undefined || typeof event.attachmentId === "string" && event.attachmentId.length <= 128);
}

/** Consumes ordered events once. A stale action never turns into a retry. */
export class DockEventFence {
  private sequence = 0;
  private layoutSequence = 0;
  editRevision = 0;
  constructor(readonly identity: DockIdentity) {}
  acceptLayout(event: DockLayout, updateSequence: number, privacyGeneration: number, viewport: DockState["viewport"]): boolean {
    if (!event || !sameDock(this.identity, event) || event.updateSequence !== updateSequence ||
        event.privacyGeneration !== privacyGeneration || !Number.isSafeInteger(event.layoutSequence) ||
        event.layoutSequence <= this.layoutSequence || !event.frame || !event.viewport) return false;
    const { x, y, width, height } = event.frame;
    if (![x, y, width, height, viewport.width, viewport.height].every(Number.isFinite) ||
        event.viewport.width !== viewport.width || event.viewport.height !== viewport.height ||
        height < 44 || height > 340 || width < 88 || x < 0 || y < 0 ||
        x + width > viewport.width + 1 || y + height > viewport.height + 1) return false;
    this.layoutSequence = event.layoutSequence;
    return true;
  }
  acknowledgeConsumption(editRevision: number): boolean {
    if (!Number.isSafeInteger(editRevision) || editRevision !== this.editRevision + 1) return false;
    this.editRevision = editRevision;
    return true;
  }
  acknowledgeDraftSnapshot(editRevision: number): boolean {
    if (!Number.isSafeInteger(editRevision) || editRevision < this.editRevision) return false;
    this.editRevision = editRevision;
    return true; // Read-only reconciliation, never action/sequence consumption.
  }
  accept(event: DockEvent, context: string, editorRevision = 0): boolean {
    if (!validDockEvent(event) || !sameDock(this.identity, event) || event.context !== context ||
        event.editorRevision !== editorRevision ||
        !Number.isSafeInteger(event.sequence) || event.sequence <= this.sequence ||
        !Number.isSafeInteger(event.editRevision) || event.editRevision < this.editRevision) return false;
    this.sequence = event.sequence;
    this.editRevision = event.editRevision;
    return true;
  }
}
