import type { PluginListenerHandle } from "@capacitor/core";
import { sameNativeDrawer, type NativeDrawerIdentity } from "./native-drawers";
import type { NativeControlAppearance } from "./native-control-appearance";
import { NativeProfileSceneFence } from "./native-profile-scene-fence";

/** Closed, private presentation replicas. No credential, URL to execute, writer
 * or persistence authority crosses this port. Sources are edited text only. */
export type WorldModelForm =
  | { scene: "world-model-fact-edit"; draft: { text: string } }
  | { scene: "world-model-sources"; draft: { urls: string; permitted: boolean } }
  | { scene: "world-model-public-profiles"; draft: { urls: string; permitted: boolean } }
  | { scene: "world-model-invitation"; draft: { name: string; email: string; phone: string } };
export type NativeWorldModelIdentity = NativeDrawerIdentity & { family: "profile"; scene: WorldModelForm["scene"]; destinationId: string };
export type NativeWorldModelProjection = NativeWorldModelIdentity & NativeControlAppearance & WorldModelForm & {
  updateSequence: number; privacyGeneration: number; draftRevision: number; acknowledgedEditRevision: number;
  canSave: boolean; busy: boolean; error: string | null;
};
export type NativeWorldModelEdit = NativeWorldModelIdentity & WorldModelForm & {
  updateSequence: number; privacyGeneration: number; editRevision: number; composing: boolean;
};
export type NativeWorldModelAction = NativeWorldModelIdentity & {
  updateSequence: number; privacyGeneration: number; editRevision: number; sequence: number; action: "save" | "cancel";
};
export type NativeWorldModelReceipt = NativeWorldModelIdentity & { updateSequence: number; privacyGeneration: number; phase: "active" | "retired" };
export interface NativeWorldModelScenePort {
  applyProfileWorldModelScene(state: NativeWorldModelProjection): Promise<NativeWorldModelReceipt>;
  confirmProfileWorldModelAction(action: NativeWorldModelAction): Promise<{ valid: boolean }>;
  settleProfileWorldModelAction(action: NativeWorldModelAction): Promise<{ valid: boolean }>;
  retireProfileWorldModelScene(identity: NativeWorldModelIdentity): Promise<NativeWorldModelReceipt>;
  addListener(event: "profileWorldModelEdit", listener: (edit: NativeWorldModelEdit) => void): Promise<PluginListenerHandle>;
  addListener(event: "profileWorldModelAction", listener: (action: NativeWorldModelAction) => void): Promise<PluginListenerHandle>;
}
const identities = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "scene", "destinationId"];
const count = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && (v as number) >= min;
const closed = (v: object, keys: readonly string[]) => Object.keys(v).every(key => keys.includes(key));
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
function validIdentity(v: NativeWorldModelIdentity): boolean {
  return !!v && v.family === "profile" && ["world-model-fact-edit", "world-model-sources", "world-model-public-profiles", "world-model-invitation"].includes(v.scene) &&
    [v.documentId, v.ownerEpoch, v.destinationId].every(id => text(id, 128) && id.length > 0) && count(v.ownerGeneration, 1) && count(v.revision, 1);
}
function validForm(v: WorldModelForm): boolean {
  const d = v.draft;
  if (!d || typeof d !== "object" || Array.isArray(d)) return false;
  switch (v.scene) {
    case "world-model-fact-edit": return closed(d, ["text"]) && text(v.draft.text, 600);
    case "world-model-public-profiles":
    case "world-model-sources": return closed(d, ["urls", "permitted"]) && text(v.draft.urls, 6144) && typeof v.draft.permitted === "boolean";
    case "world-model-invitation": return closed(d, ["name", "email", "phone"]) && text(v.draft.name, 160) && text(v.draft.email, 320) && text(v.draft.phone, 16);
    default: return false;
  }
}
export function validNativeWorldModelProjection(v: NativeWorldModelProjection): boolean {
  return validIdentity(v) && validForm(v) && closed(v, [...identities, "appearance", "accentHex", "foregroundHex", "draft",
    "updateSequence", "privacyGeneration", "draftRevision", "acknowledgedEditRevision", "canSave", "busy", "error"]) &&
    count(v.updateSequence, 1) && count(v.privacyGeneration) && count(v.draftRevision) && count(v.acknowledgedEditRevision) &&
    typeof v.canSave === "boolean" && typeof v.busy === "boolean" && (v.error === null || text(v.error, 1024)) &&
    ["light", "dark"].includes(v.appearance) && [v.accentHex, v.foregroundHex].every(color => typeof color === "string" && /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(color));
}
export class NativeWorldModelFence extends NativeProfileSceneFence<NativeWorldModelProjection, NativeWorldModelEdit, NativeWorldModelAction> {
  constructor(identity: NativeWorldModelIdentity) {
    const same = (v: NativeWorldModelIdentity) => !!v && validIdentity(v) && sameNativeDrawer(v, identity) && v.scene === identity.scene && v.destinationId === identity.destinationId;
    super(identity, {
      state: v => same(v) && validNativeWorldModelProjection(v),
      edit: v => same(v) && validForm(v) && closed(v, [...identities, "updateSequence", "privacyGeneration", "editRevision", "composing", "draft"]) && typeof v.composing === "boolean",
      action: v => same(v) && closed(v, [...identities, "updateSequence", "privacyGeneration", "editRevision", "sequence", "action"]) && ["save", "cancel"].includes(v.action),
    });
  }
}
