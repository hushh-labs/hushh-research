import type { PluginListenerHandle } from "@capacitor/core";
import { sameNativeDrawer, type NativeDrawerIdentity } from "./native-drawers";
import type { NativeControlAppearance } from "./native-control-appearance";
import { NativeProfileSceneFence } from "./native-profile-scene-fence";

/** Private NativeDrawers v1 extension. Price replicas never enter Chrome, Dock,
 * persistent storage, diagnostics or a provider transport. */
export type NativeProfilePricingIdentity = NativeDrawerIdentity & {
  family: "profile";
  scene: "request-price";
  destinationId: string;
};
export type NativeProfilePricingProjection = NativeProfilePricingIdentity & NativeControlAppearance & {
  updateSequence: number;
  privacyGeneration: number;
  draftRevision: number;
  acknowledgedEditRevision: number;
  draft: string;
  canSave: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
};
export type NativeProfilePricingReceipt = NativeProfilePricingIdentity & {
  updateSequence: number;
  privacyGeneration: number;
  phase: "active" | "retired";
};
export type NativeProfilePricingEdit = NativeProfilePricingIdentity & {
  updateSequence: number;
  privacyGeneration: number;
  editRevision: number;
  text: string;
  composing: boolean;
};
export type NativeProfilePricingAction = NativeProfilePricingIdentity & {
  updateSequence: number;
  privacyGeneration: number;
  editRevision: number;
  sequence: number;
  action: "save" | "cancel";
};
export interface NativeProfilePricingScenePort {
  applyProfilePricingScene(state: NativeProfilePricingProjection): Promise<NativeProfilePricingReceipt>;
  confirmProfilePricingAction(action: NativeProfilePricingAction): Promise<{ valid: boolean }>;
  settleProfilePricingAction(action: NativeProfilePricingAction): Promise<{ valid: boolean }>;
  retireProfilePricingScene(identity: NativeProfilePricingIdentity): Promise<NativeProfilePricingReceipt>;
  addListener(event: "profilePricingEdit", listener: (edit: NativeProfilePricingEdit) => void): Promise<PluginListenerHandle>;
  addListener(event: "profilePricingAction", listener: (action: NativeProfilePricingAction) => void): Promise<PluginListenerHandle>;
}

function count(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}
function closed(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}
const identityKeys = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "scene", "destinationId"];
function validIdentity(value: NativeProfilePricingIdentity): boolean {
  return !!value && value.family === "profile" && value.scene === "request-price" &&
    [value.documentId, value.ownerEpoch, value.destinationId].every(id => typeof id === "string" && id.length > 0 && id.length <= 128) &&
    count(value.ownerGeneration, 1) && count(value.revision, 1);
}
function sameScene(a: NativeProfilePricingIdentity, b: NativeProfilePricingIdentity): boolean {
  return validIdentity(a) && sameNativeDrawer(a, b) && a.scene === b.scene && a.destinationId === b.destinationId;
}
export function validNativeProfilePricingProjection(value: NativeProfilePricingProjection): boolean {
  return validIdentity(value) && closed(value, [...identityKeys, "appearance", "accentHex", "foregroundHex",
    "updateSequence", "privacyGeneration", "draftRevision", "acknowledgedEditRevision", "draft", "canSave", "busy", "error", "notice"]) &&
    count(value.updateSequence, 1) && count(value.privacyGeneration) && count(value.draftRevision) &&
    count(value.acknowledgedEditRevision) && typeof value.draft === "string" && value.draft.length <= 32 &&
    typeof value.canSave === "boolean" && typeof value.busy === "boolean" &&
    (value.error === null || typeof value.error === "string" && value.error.length <= 1024) &&
    (value.notice === null || typeof value.notice === "string" && value.notice.length <= 1024) &&
    ["light", "dark"].includes(value.appearance) &&
    [value.accentHex, value.foregroundHex].every(color => typeof color === "string" && /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(color));
}

/** Edit ordering and one-shot actions are separate from authoritative Save.
 * The feature still validates the amount and uses its existing service writer. */
export class NativeProfilePricingFence extends NativeProfileSceneFence<NativeProfilePricingProjection, NativeProfilePricingEdit, NativeProfilePricingAction> {
  private composing = false;
  constructor(identity: NativeProfilePricingIdentity) {
    super(identity, {
      state: state => validNativeProfilePricingProjection(state) && sameScene(state, identity),
      edit: edit => !!edit && sameScene(edit, identity) &&
        closed(edit, [...identityKeys, "updateSequence", "privacyGeneration", "editRevision", "text", "composing"]) &&
        typeof edit.text === "string" && edit.text.length <= 32 && typeof edit.composing === "boolean",
      action: action => !!action && sameScene(action, identity) &&
        closed(action, [...identityKeys, "updateSequence", "privacyGeneration", "editRevision", "sequence", "action"]) &&
        ["save", "cancel"].includes(action.action),
    });
  }
  override consumeEdit(event: NativeProfilePricingEdit): boolean {
    if (!super.consumeEdit(event)) return false;
    this.composing = event.composing; return true;
  }
  override allows(event: NativeProfilePricingAction): boolean {
    return (event.action === "cancel" || !this.composing) && super.allows(event);
  }
}
