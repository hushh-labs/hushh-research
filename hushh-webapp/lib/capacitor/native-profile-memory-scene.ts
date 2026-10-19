import type { PluginListenerHandle } from "@capacitor/core";
import { sameNativeDrawer } from "./native-drawers";
import { NativeProfileSceneFence } from "./native-profile-scene-fence";
import type { PrivateProfileIdentity, PrivateProfileProjection, PrivateProfileEdit, PrivateProfileAction, PrivateProfileFinalEdit } from "./native-profile-private-editor";

export const MEMORY_CONTEXT_CATEGORIES = ["general", "portfolio", "risk", "kyc", "tax", "documents"] as const;
export type MemoryContextCategory = typeof MEMORY_CONTEXT_CATEGORIES[number];
/** A private text replica only. Record IDs and vault authority remain in React. */
export type NativeMemoryDraft = { category: MemoryContextCategory; text: string };
export type NativeMemoryIdentity = PrivateProfileIdentity<"memory-financial-context">;
export type NativeMemoryProjection = PrivateProfileProjection<NativeMemoryDraft, "memory-financial-context">;
export type NativeMemoryEdit = PrivateProfileEdit<NativeMemoryDraft, "memory-financial-context">;
export type NativeMemoryAction = PrivateProfileAction<"memory-financial-context">;
export type NativeMemoryFinalEdit = PrivateProfileFinalEdit<NativeMemoryDraft, "memory-financial-context">;
export type NativeMemoryReceipt = NativeMemoryIdentity & { updateSequence: number; privacyGeneration: number; phase: "active" | "retired" };
export interface NativeMemoryScenePort {
  applyProfileMemoryScene(state: NativeMemoryProjection): Promise<NativeMemoryReceipt>;
  confirmProfileMemoryAction(action: NativeMemoryAction): Promise<{ valid: boolean }>;
  settleProfileMemoryAction(action: NativeMemoryAction): Promise<{ valid: boolean }>;
  retireProfileMemoryScene(identity: NativeMemoryIdentity): Promise<NativeMemoryReceipt>;
  addListener(event: "profileMemoryEdit", listener: (edit: NativeMemoryEdit) => void): Promise<PluginListenerHandle>;
  addListener(event: "profileMemoryAction", listener: (action: NativeMemoryAction) => void): Promise<PluginListenerHandle>;
  addListener(event: "profileMemoryFinalEdit", listener: (edit: NativeMemoryFinalEdit) => void): Promise<PluginListenerHandle>;
}
const ids = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "scene", "destinationId"];
const count = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && (v as number) >= min;
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const closed = (v: object, keys: readonly string[]) => Object.keys(v).every(key => keys.includes(key));
function identity(v: NativeMemoryIdentity): boolean {
  return !!v && v.family === "profile" && v.scene === "memory-financial-context" &&
    [v.documentId, v.ownerEpoch, v.destinationId].every(id => text(id, 128) && id.length > 0) && count(v.ownerGeneration, 1) && count(v.revision, 1);
}
export function validNativeMemoryDraft(v: unknown): v is NativeMemoryDraft {
  const d = v as NativeMemoryDraft;
  return !!d && typeof d === "object" && !Array.isArray(d) && closed(d, ["category", "text"]) &&
    MEMORY_CONTEXT_CATEGORIES.includes(d.category) && text(d.text, 100_000);
}
export function validNativeMemoryProjection(v: NativeMemoryProjection): boolean {
  return identity(v) && validNativeMemoryDraft(v.draft) && closed(v, [...ids, "appearance", "accentHex", "foregroundHex", "draft", "updateSequence",
    "privacyGeneration", "acknowledgedEditRevision", "draftRevision", "canSave", "busy", "error"]) && count(v.updateSequence, 1) && count(v.privacyGeneration) &&
    count(v.acknowledgedEditRevision) && count(v.draftRevision) && typeof v.canSave === "boolean" && typeof v.busy === "boolean" &&
    (v.error === null || text(v.error, 1024)) && ["light", "dark"].includes(v.appearance) &&
    [v.accentHex, v.foregroundHex].every(v => typeof v === "string" && /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(v));
}
export function validNativeMemoryFinalEdit(v: NativeMemoryFinalEdit, owner: NativeMemoryIdentity): boolean {
  return identity(v) && sameNativeDrawer(v, owner) && v.destinationId === owner.destinationId && validNativeMemoryDraft(v.draft) &&
    closed(v, [...ids, "draft", "updateSequence", "privacyGeneration", "editRevision", "composing", "baseDraftRevision", "acknowledgedEditRevision"]) &&
    count(v.updateSequence, 1) && count(v.privacyGeneration) && count(v.editRevision) && count(v.baseDraftRevision) &&
    count(v.acknowledgedEditRevision) && v.editRevision >= v.acknowledgedEditRevision && v.composing === false;
}
export class NativeMemoryFence extends NativeProfileSceneFence<NativeMemoryProjection, NativeMemoryEdit, NativeMemoryAction> {
  constructor(owner: NativeMemoryIdentity) {
    const same = (v: NativeMemoryIdentity) => identity(v) && sameNativeDrawer(v, owner) && v.destinationId === owner.destinationId;
    super(owner, {
      state: v => same(v) && validNativeMemoryProjection(v),
      edit: v => same(v) && validNativeMemoryDraft(v.draft) && closed(v, [...ids, "draft", "updateSequence", "privacyGeneration", "editRevision", "composing"]) && typeof v.composing === "boolean",
      action: v => same(v) && closed(v, [...ids, "updateSequence", "privacyGeneration", "editRevision", "sequence", "action"]) && ["save", "cancel"].includes(v.action),
    });
  }
}
