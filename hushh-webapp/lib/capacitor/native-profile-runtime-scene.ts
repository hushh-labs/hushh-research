import type { PluginListenerHandle } from "@capacitor/core";
import { sameNativeDrawer, type NativeDrawerIdentity } from "./native-drawers";
import type { NativeControlAppearance } from "./native-control-appearance";
import { NativeProfileSceneFence } from "./native-profile-scene-fence";

/** Private transient credential editor, not public chrome or a key store. */
export type NativeRuntimeDraft = { credential: string; transport: "developer_api" | "vertex_api_key"; project: string; location: string };
export type NativeRuntimeIdentity = NativeDrawerIdentity & { family: "profile"; scene: "runtime-provider"; destinationId: string };
export type NativeRuntimeProjection = NativeRuntimeIdentity & NativeControlAppearance & {
  draft: NativeRuntimeDraft; updateSequence: number; privacyGeneration: number; acknowledgedEditRevision: number; draftRevision: number;
  canSave: boolean; busy: boolean; checking: boolean; primary: "validate" | "save"; error: string | null;
};
export type NativeRuntimeEdit = NativeRuntimeIdentity & { draft: NativeRuntimeDraft; updateSequence: number; privacyGeneration: number; editRevision: number; composing: boolean };
export type NativeRuntimeAction = NativeRuntimeIdentity & { updateSequence: number; privacyGeneration: number; editRevision: number; sequence: number; action: "save" | "cancel" };
export type NativeRuntimeFinalEdit = NativeRuntimeEdit & { baseDraftRevision: number; acknowledgedEditRevision: number };
export type NativeRuntimeReceipt = NativeRuntimeIdentity & { updateSequence: number; privacyGeneration: number; phase: "active" | "retired" };
export interface NativeRuntimeScenePort {
  applyProfileRuntimeScene(state: NativeRuntimeProjection): Promise<NativeRuntimeReceipt>;
  confirmProfileRuntimeAction(action: NativeRuntimeAction): Promise<{ valid: boolean }>;
  settleProfileRuntimeAction(action: NativeRuntimeAction): Promise<{ valid: boolean }>;
  retireProfileRuntimeScene(identity: NativeRuntimeIdentity): Promise<NativeRuntimeReceipt>;
  addListener(event: "profileRuntimeEdit", listener: (edit: NativeRuntimeEdit) => void): Promise<PluginListenerHandle>;
  addListener(event: "profileRuntimeAction", listener: (action: NativeRuntimeAction) => void): Promise<PluginListenerHandle>;
  addListener(event: "profileRuntimeFinalEdit", listener: (edit: NativeRuntimeFinalEdit) => void): Promise<PluginListenerHandle>;
}
const ids = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "scene", "destinationId"];
const count = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && (v as number) >= min;
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const closed = (v: object, keys: readonly string[]) => Object.keys(v).every(key => keys.includes(key));
function identity(v: NativeRuntimeIdentity): boolean {
  return !!v && v.family === "profile" && v.scene === "runtime-provider" &&
    [v.documentId, v.ownerEpoch, v.destinationId].every(id => text(id, 128) && id.length > 0) && count(v.ownerGeneration, 1) && count(v.revision, 1);
}
export function validNativeRuntimeDraft(v: NativeRuntimeDraft): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v) && closed(v, ["credential", "transport", "project", "location"]) &&
    text(v.credential, 8192) && ["developer_api", "vertex_api_key"].includes(v.transport) && text(v.project, 256) && text(v.location, 128);
}
export function validNativeRuntimeProjection(v: NativeRuntimeProjection): boolean {
  return identity(v) && validNativeRuntimeDraft(v.draft) && closed(v, [...ids, "appearance", "accentHex", "foregroundHex", "draft", "updateSequence",
    "privacyGeneration", "acknowledgedEditRevision", "draftRevision", "canSave", "busy", "checking", "primary", "error"]) && count(v.updateSequence, 1) && count(v.privacyGeneration) &&
    count(v.acknowledgedEditRevision) && count(v.draftRevision) && typeof v.canSave === "boolean" && typeof v.busy === "boolean" && typeof v.checking === "boolean" && ["validate", "save"].includes(v.primary) &&
    (v.error === null || text(v.error, 1024)) && ["light", "dark"].includes(v.appearance) &&
    [v.accentHex, v.foregroundHex].every(v => typeof v === "string" && /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(v));
}
/** Readback cannot restore actions. The caller must also check its captured
 * controller and current draft revision before reconciling this final input. */
export function validNativeRuntimeFinalEdit(v: NativeRuntimeFinalEdit, owner: NativeRuntimeIdentity): boolean {
  return identity(v) && sameNativeDrawer(v, owner) && v.destinationId === owner.destinationId && validNativeRuntimeDraft(v.draft) &&
    closed(v, [...ids, "draft", "updateSequence", "privacyGeneration", "editRevision", "composing", "baseDraftRevision", "acknowledgedEditRevision"]) &&
    count(v.updateSequence, 1) && count(v.privacyGeneration) && count(v.editRevision) && count(v.baseDraftRevision) &&
    count(v.acknowledgedEditRevision) && v.editRevision >= v.acknowledgedEditRevision && v.composing === false;
}
export class NativeRuntimeFence extends NativeProfileSceneFence<NativeRuntimeProjection, NativeRuntimeEdit, NativeRuntimeAction> {
  constructor(owner: NativeRuntimeIdentity) {
    const same = (v: NativeRuntimeIdentity) => identity(v) && sameNativeDrawer(v, owner) && v.destinationId === owner.destinationId;
    super(owner, {
      state: v => same(v) && validNativeRuntimeProjection(v),
      edit: v => same(v) && validNativeRuntimeDraft(v.draft) && closed(v, [...ids, "draft", "updateSequence", "privacyGeneration", "editRevision", "composing"]) && typeof v.composing === "boolean",
      action: v => same(v) && closed(v, [...ids, "updateSequence", "privacyGeneration", "editRevision", "sequence", "action"]) && ["save", "cancel"].includes(v.action),
    });
  }
}
