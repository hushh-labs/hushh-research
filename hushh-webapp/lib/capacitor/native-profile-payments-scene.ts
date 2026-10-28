import type { PluginListenerHandle } from "@capacitor/core";
import { sameNativeDrawer } from "./native-drawers";
import { NativeProfileSceneFence } from "./native-profile-scene-fence";
import type { PrivateProfileIdentity, PrivateProfileProjection, PrivateProfileEdit, PrivateProfileAction, PrivateProfileFinalEdit } from "./native-profile-private-editor";

/** Private ordinary field replicas. Financial authority, preview tokens and
 * idempotency keys never cross this presentation contract. */
export type NativePaymentsScene = "payment-funding" | "payment-country";
export type NativePaymentsDraft = { value: string };
export type NativePaymentsIdentity = PrivateProfileIdentity<NativePaymentsScene>;
export type NativePaymentsProjection = PrivateProfileProjection<NativePaymentsDraft, NativePaymentsScene>;
export type NativePaymentsEdit = PrivateProfileEdit<NativePaymentsDraft, NativePaymentsScene>;
export type NativePaymentsAction = PrivateProfileAction<NativePaymentsScene>;
export type NativePaymentsFinalEdit = PrivateProfileFinalEdit<NativePaymentsDraft, NativePaymentsScene>;
export type NativePaymentsReceipt = NativePaymentsIdentity & { updateSequence: number; privacyGeneration: number; phase: "active" | "retired" };
export interface NativePaymentsScenePort {
  applyProfilePaymentsScene(state: NativePaymentsProjection): Promise<NativePaymentsReceipt>;
  confirmProfilePaymentsAction(action: NativePaymentsAction): Promise<{ valid: boolean }>;
  settleProfilePaymentsAction(action: NativePaymentsAction): Promise<{ valid: boolean }>;
  retireProfilePaymentsScene(identity: NativePaymentsIdentity): Promise<NativePaymentsReceipt>;
  addListener(event: "profilePaymentsEdit", listener: (edit: NativePaymentsEdit) => void): Promise<PluginListenerHandle>;
  addListener(event: "profilePaymentsAction", listener: (action: NativePaymentsAction) => void): Promise<PluginListenerHandle>;
  addListener(event: "profilePaymentsFinalEdit", listener: (edit: NativePaymentsFinalEdit) => void): Promise<PluginListenerHandle>;
}
const ids = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "scene", "destinationId"];
const count = (v: unknown, min = 0) => Number.isSafeInteger(v) && (v as number) >= min;
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const closed = (v: object, keys: readonly string[]) => Object.keys(v).every(key => keys.includes(key));
function identity(v: NativePaymentsIdentity): boolean {
  return !!v && v.family === "profile" && ["payment-funding", "payment-country"].includes(v.scene) &&
    [v.documentId, v.ownerEpoch, v.destinationId].every(id => text(id, 128) && id.length > 0) && count(v.ownerGeneration, 1) && count(v.revision, 1);
}
export function validNativePaymentsDraft(v: unknown, scene: NativePaymentsScene): v is NativePaymentsDraft {
  const d = v as NativePaymentsDraft;
  return !!d && typeof d === "object" && !Array.isArray(d) && closed(d, ["value"]) && text(d.value, scene === "payment-country" ? 2 : 64);
}
export function validNativePaymentsProjection(v: NativePaymentsProjection): boolean {
  return identity(v) && validNativePaymentsDraft(v.draft, v.scene) && closed(v, [...ids, "appearance", "accentHex", "foregroundHex", "draft", "updateSequence",
    "privacyGeneration", "acknowledgedEditRevision", "draftRevision", "canSave", "busy", "error"]) && count(v.updateSequence, 1) && count(v.privacyGeneration) &&
    count(v.acknowledgedEditRevision) && count(v.draftRevision) && typeof v.canSave === "boolean" && typeof v.busy === "boolean" &&
    (v.error === null || text(v.error, 1024)) && ["light", "dark"].includes(v.appearance) &&
    [v.accentHex, v.foregroundHex].every(v => typeof v === "string" && /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(v));
}
export function validNativePaymentsFinalEdit(v: NativePaymentsFinalEdit, owner: NativePaymentsIdentity): boolean {
  return identity(v) && v.scene === owner.scene && sameNativeDrawer(v, owner) && v.destinationId === owner.destinationId && validNativePaymentsDraft(v.draft, v.scene) &&
    closed(v, [...ids, "draft", "updateSequence", "privacyGeneration", "editRevision", "composing", "baseDraftRevision", "acknowledgedEditRevision"]) &&
    count(v.updateSequence, 1) && count(v.privacyGeneration) && count(v.editRevision) && count(v.baseDraftRevision) &&
    count(v.acknowledgedEditRevision) && v.editRevision >= v.acknowledgedEditRevision && v.composing === false;
}
export class NativePaymentsFence extends NativeProfileSceneFence<NativePaymentsProjection, NativePaymentsEdit, NativePaymentsAction> {
  constructor(owner: NativePaymentsIdentity) {
    const same = (v: NativePaymentsIdentity) => identity(v) && v.scene === owner.scene && sameNativeDrawer(v, owner) && v.destinationId === owner.destinationId;
    super(owner, {
      state: v => same(v) && validNativePaymentsProjection(v),
      edit: v => same(v) && validNativePaymentsDraft(v.draft, v.scene) && closed(v, [...ids, "draft", "updateSequence", "privacyGeneration", "editRevision", "composing"]) && typeof v.composing === "boolean",
      action: v => same(v) && closed(v, [...ids, "updateSequence", "privacyGeneration", "editRevision", "sequence", "action"]) && ["save", "cancel"].includes(v.action),
    });
  }
}
