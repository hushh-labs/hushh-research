import type { PluginListenerHandle } from "@capacitor/core";
import { sameNativeDrawer, type NativeDrawerIdentity } from "./native-drawers";
import type { NativeControlAppearance } from "./native-control-appearance";
import { NativeProfileSceneFence } from "./native-profile-scene-fence";

/** Private NativeDrawers v1 extension. Name replicas never enter Chrome, Dock,
 * persistent storage, diagnostics or a provider transport. */
export type NativeProfileNameIdentity = NativeDrawerIdentity & {
  family: "profile";
  scene: "account-name";
  destinationId?: string;
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
const identityKeys = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "scene", "destinationId"];
function validIdentity(value: NativeProfileNameIdentity): boolean {
  return !!value && value.family === "profile" && value.scene === "account-name" &&
    [value.documentId, value.ownerEpoch].every(id => typeof id === "string" && id.length > 0 && id.length <= 128) &&
    count(value.ownerGeneration, 1) && count(value.revision, 1) &&
    (value.destinationId === undefined || typeof value.destinationId === "string" && value.destinationId.length > 0 && value.destinationId.length <= 128);
}
function sameScene(a: NativeProfileNameIdentity, b: NativeProfileNameIdentity): boolean {
  return validIdentity(a) && sameNativeDrawer(a, b) && a.scene === b.scene && a.destinationId === b.destinationId;
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
export class NativeProfileNameFence extends NativeProfileSceneFence<NativeProfileNameProjection, NativeProfileNameEdit, NativeProfileNameAction> {
  constructor(identity: NativeProfileNameIdentity) {
    super(identity, {
      state: state => validNativeProfileNameProjection(state) && sameScene(state, identity),
      edit: edit => !!edit && sameScene(edit, identity) &&
        closed(edit, [...identityKeys, "updateSequence", "privacyGeneration", "editRevision", "text", "composing"]) &&
        typeof edit.text === "string" && edit.text.length <= 4096 && typeof edit.composing === "boolean",
      action: action => !!action && sameScene(action, identity) &&
        closed(action, [...identityKeys, "updateSequence", "privacyGeneration", "editRevision", "sequence", "action"]) &&
        ["save", "cancel"].includes(action.action),
    });
  }
}
