import type { PluginListenerHandle } from "@capacitor/core";
import type { NativeControlAppearance } from "./native-control-appearance";
import type { NativeDrawerIdentity } from "./native-drawers";
import { NativeProfileSceneFence } from "./native-profile-scene-fence";

/** Secret fields have a separate private, memory-only contract. They never
 * enter public chrome metadata, native persistence or diagnostic receipts. */
export type NativePasswordIdentity = NativeDrawerIdentity & { family: "profile"; scene: "vault-passphrase"; destinationId: string };
export type NativePasswordProjection = NativePasswordIdentity & NativeControlAppearance & {
  updateSequence: number; privacyGeneration: number; acknowledgedEditRevision: number;
  password: string; confirmation: string; canSave: boolean; busy: boolean;
};
export type NativePasswordEdit = NativePasswordIdentity & {
  updateSequence: number; privacyGeneration: number; editRevision: number;
  password: string; confirmation: string; composing: boolean;
};
export type NativePasswordAction = NativePasswordIdentity & {
  updateSequence: number; privacyGeneration: number; editRevision: number; sequence: number; action: "save" | "cancel";
};
export type NativePasswordReceipt = NativePasswordIdentity & {
  updateSequence: number; privacyGeneration: number; phase: "active" | "retired";
};
export interface NativePasswordScenePort {
  applyProfilePasswordScene(state: NativePasswordProjection): Promise<NativePasswordReceipt>;
  confirmProfilePasswordAction(action: NativePasswordAction): Promise<{ valid: boolean }>;
  settleProfilePasswordAction(action: NativePasswordAction): Promise<{ valid: boolean }>;
  retireProfilePasswordScene(identity: NativePasswordIdentity): Promise<NativePasswordReceipt>;
  addListener(event: "profilePasswordEdit", listener: (edit: NativePasswordEdit) => void): Promise<PluginListenerHandle>;
  addListener(event: "profilePasswordAction", listener: (action: NativePasswordAction) => void): Promise<PluginListenerHandle>;
}
const identityKeys = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "scene", "destinationId"];
const closed = (value: object, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const count = (value: unknown, minimum = 0) => Number.isSafeInteger(value) && (value as number) >= minimum;
const text = (value: unknown) => typeof value === "string" && value.length <= 4096;
function identity(value: NativePasswordIdentity) {
  return !!value && value.family === "profile" && value.scene === "vault-passphrase" &&
    [value.documentId, value.ownerEpoch, value.destinationId].every(value => typeof value === "string" && value.length > 0 && value.length <= 128) &&
    count(value.ownerGeneration, 1) && count(value.revision, 1);
}
export function validNativePasswordProjection(value: NativePasswordProjection): boolean {
  return identity(value) && closed(value, [...identityKeys, "appearance", "accentHex", "foregroundHex", "updateSequence",
    "privacyGeneration", "acknowledgedEditRevision", "password", "confirmation", "canSave", "busy"]) &&
    count(value.updateSequence, 1) && count(value.privacyGeneration) && count(value.acknowledgedEditRevision) &&
    text(value.password) && text(value.confirmation) && typeof value.canSave === "boolean" && typeof value.busy === "boolean" &&
    (!value.canSave || value.password.length >= 8 && value.password === value.confirmation) &&
    ["light", "dark"].includes(value.appearance) && [value.accentHex, value.foregroundHex].every(value => /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(value));
}
export class NativePasswordFence extends NativeProfileSceneFence<NativePasswordProjection, NativePasswordEdit, NativePasswordAction> {
  private composing = false;
  constructor(value: NativePasswordIdentity) {
    super(value, {
      state: validNativePasswordProjection,
      edit: event => identity(event) && closed(event, [...identityKeys, "updateSequence", "privacyGeneration", "editRevision", "password", "confirmation", "composing"]) &&
        text(event.password) && text(event.confirmation) && typeof event.composing === "boolean",
      action: event => identity(event) && closed(event, [...identityKeys, "updateSequence", "privacyGeneration", "editRevision", "sequence", "action"]) &&
        ["save", "cancel"].includes(event.action),
    });
  }
  override consumeEdit(event: NativePasswordEdit): boolean {
    if (!super.consumeEdit(event)) return false;
    this.composing = event.composing;
    return true;
  }
  override allows(event: NativePasswordAction): boolean {
    return (event.action === "cancel" || !this.composing) && super.allows(event);
  }
}
