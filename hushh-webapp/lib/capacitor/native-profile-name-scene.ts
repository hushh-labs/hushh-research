import type { PluginListenerHandle } from "@capacitor/core";
import { sameNativeDrawer, type NativeDrawerIdentity } from "./native-drawers";
import type { NativeControlAppearance } from "./native-control-appearance";

/** Private NativeDrawers v1 extension. Name replicas never enter Chrome, Dock,
 * persistent storage, diagnostics or a provider transport. */
export type NativeProfileNameIdentity = NativeDrawerIdentity & {
  family: "profile";
  scene: "account-name";
};
export type NativeProfileNameProjection = NativeProfileNameIdentity & NativeControlAppearance & {
  updateSequence: number;
  privacyGeneration: number;
  draftRevision: number;
  acknowledgedEditRevision: number;
  draft: string;
  canSave: boolean;
  busy: boolean;
  error: string | null;
};
export type NativeProfileNameReceipt = NativeProfileNameIdentity & {
  updateSequence: number;
  privacyGeneration: number;
  phase: "active" | "retired";
};
export type NativeProfileNameEdit = NativeProfileNameIdentity & {
  updateSequence: number;
  privacyGeneration: number;
  editRevision: number;
  text: string;
  composing: boolean;
};
export type NativeProfileNameAction = NativeProfileNameIdentity & {
  updateSequence: number;
  privacyGeneration: number;
  editRevision: number;
  sequence: number;
  action: "save" | "cancel";
};
export interface NativeProfileNameScenePort {
  applyProfileNameScene(state: NativeProfileNameProjection): Promise<NativeProfileNameReceipt>;
  confirmProfileNameAction(action: NativeProfileNameAction): Promise<{ valid: boolean }>;
  settleProfileNameAction(action: NativeProfileNameAction): Promise<{ valid: boolean }>;
  retireProfileNameScene(identity: NativeProfileNameIdentity): Promise<NativeProfileNameReceipt>;
  addListener(event: "profileNameEdit", listener: (edit: NativeProfileNameEdit) => void): Promise<PluginListenerHandle>;
  addListener(event: "profileNameAction", listener: (action: NativeProfileNameAction) => void): Promise<PluginListenerHandle>;
}

function count(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}
function closed(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}
const identityKeys = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "scene"];
function validIdentity(value: NativeProfileNameIdentity): boolean {
  return !!value && value.family === "profile" && value.scene === "account-name" &&
    [value.documentId, value.ownerEpoch].every(id => typeof id === "string" && id.length > 0 && id.length <= 128) &&
    count(value.ownerGeneration, 1) && count(value.revision, 1);
}
function sameScene(a: NativeProfileNameIdentity, b: NativeProfileNameIdentity): boolean {
  return validIdentity(a) && sameNativeDrawer(a, b) && a.scene === b.scene;
}
export function validNativeProfileNameProjection(value: NativeProfileNameProjection): boolean {
  return validIdentity(value) && closed(value, [...identityKeys, "appearance", "accentHex", "foregroundHex",
    "updateSequence", "privacyGeneration", "draftRevision", "acknowledgedEditRevision", "draft", "canSave", "busy", "error"]) &&
    count(value.updateSequence, 1) && count(value.privacyGeneration) && count(value.draftRevision) &&
    count(value.acknowledgedEditRevision) && typeof value.draft === "string" && value.draft.length <= 4096 &&
    typeof value.canSave === "boolean" && typeof value.busy === "boolean" &&
    (value.error === null || typeof value.error === "string" && value.error.length <= 1024) &&
    ["light", "dark"].includes(value.appearance) &&
    [value.accentHex, value.foregroundHex].every(color => typeof color === "string" && /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(color));
}

/** Edit ordering and one-shot actions are separate from authoritative Save.
 * The feature still validates the name and uses its existing service writer. */
export class NativeProfileNameFence {
  private state: NativeProfileNameProjection | null = null;
  private editRevision = 0;
  private consumedAction = 0;
  private retired = false;

  constructor(private readonly identity: NativeProfileNameIdentity) {}

  update(state: NativeProfileNameProjection): boolean {
    if (this.retired || !validNativeProfileNameProjection(state) || !sameScene(state, this.identity) ||
        this.state && (state.updateSequence <= this.state.updateSequence || state.privacyGeneration !== this.state.privacyGeneration) ||
        state.acknowledgedEditRevision !== this.editRevision) return false;
    this.state = { ...state };
    return true;
  }

  consumeEdit(edit: NativeProfileNameEdit): boolean {
    const state = this.state;
    if (this.retired || !state || !edit || !sameScene(edit, this.identity) ||
        !closed(edit, [...identityKeys, "updateSequence", "privacyGeneration", "editRevision", "text", "composing"]) ||
        edit.privacyGeneration !== state.privacyGeneration || !count(edit.updateSequence, 1) || edit.updateSequence > state.updateSequence ||
        !count(edit.editRevision, 1) || edit.editRevision <= this.editRevision ||
        typeof edit.text !== "string" || edit.text.length > 4096 || typeof edit.composing !== "boolean" || state.busy) return false;
    this.editRevision = edit.editRevision;
    return true;
  }

  allows(action: NativeProfileNameAction): boolean {
    const state = this.state;
    return !this.retired && !!state && !!action && sameScene(action, this.identity) &&
      closed(action, [...identityKeys, "updateSequence", "privacyGeneration", "editRevision", "sequence", "action"]) &&
      action.privacyGeneration === state.privacyGeneration && count(action.updateSequence, 1) &&
      (action.action === "cancel" ? action.updateSequence <= state.updateSequence : action.updateSequence === state.updateSequence) &&
      count(action.sequence, 1) && count(action.editRevision) && action.sequence > this.consumedAction && !state.busy &&
      (action.action === "cancel" || action.action === "save" && state.canSave &&
        action.editRevision === this.editRevision && state.acknowledgedEditRevision === this.editRevision);
  }

  async consumeAction(action: NativeProfileNameAction, confirm: () => Promise<{ valid: boolean }>, ownerIsCurrent: () => boolean): Promise<boolean> {
    if (!this.allows(action) || !ownerIsCurrent()) return false;
    // Consume before awaiting: duplicate events cannot race the same callback.
    this.consumedAction = action.sequence;
    const state = this.state;
    const accepted = await confirm();
    return accepted.valid && !this.retired && ownerIsCurrent() &&
      (action.action === "cancel" ? this.state !== null && !this.state.busy : this.state === state && action.editRevision === this.editRevision);
  }

  retire(): void { this.retired = true; this.state = null; }
}
