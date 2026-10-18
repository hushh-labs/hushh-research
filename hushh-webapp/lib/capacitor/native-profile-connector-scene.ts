import type { PluginListenerHandle } from "@capacitor/core";
import { sameNativeDrawer, type NativeDrawerIdentity } from "./native-drawers";
import type { NativeControlAppearance } from "./native-control-appearance";
import { NativeProfileSceneFence } from "./native-profile-scene-fence";

/** Private transient credential editor, not public chrome or a key store. */
export type NativeConnectorDraft = { name: string; endpoint: string; credential: string; oauthIssuer: string; oauthClientId: string; oauthClientSecret: string; oauthAuthMethod: "none" | "client_secret_post" | "client_secret_basic" };
export type NativeConnectorIdentity = NativeDrawerIdentity & { family: "profile"; scene: "connector-custom-server"; destinationId: string };
export type NativeConnectorProjection = NativeConnectorIdentity & NativeControlAppearance & {
  draft: NativeConnectorDraft; updateSequence: number; privacyGeneration: number; acknowledgedEditRevision: number; draftRevision: number;
  canSave: boolean; busy: boolean; error: string | null;
};
export type NativeConnectorEdit = NativeConnectorIdentity & { draft: NativeConnectorDraft; updateSequence: number; privacyGeneration: number; editRevision: number; composing: boolean };
export type NativeConnectorAction = NativeConnectorIdentity & { updateSequence: number; privacyGeneration: number; editRevision: number; sequence: number; action: "save" | "cancel" };
export type NativeConnectorFinalEdit = NativeConnectorEdit & { baseDraftRevision: number; acknowledgedEditRevision: number };
export type NativeConnectorReceipt = NativeConnectorIdentity & { updateSequence: number; privacyGeneration: number; phase: "active" | "retired" };
export interface NativeConnectorScenePort {
  applyProfileConnectorScene(state: NativeConnectorProjection): Promise<NativeConnectorReceipt>;
  confirmProfileConnectorAction(action: NativeConnectorAction): Promise<{ valid: boolean }>;
  settleProfileConnectorAction(action: NativeConnectorAction): Promise<{ valid: boolean }>;
  retireProfileConnectorScene(identity: NativeConnectorIdentity): Promise<NativeConnectorReceipt>;
  addListener(event: "profileConnectorEdit", listener: (edit: NativeConnectorEdit) => void): Promise<PluginListenerHandle>;
  addListener(event: "profileConnectorAction", listener: (action: NativeConnectorAction) => void): Promise<PluginListenerHandle>;
  addListener(event: "profileConnectorFinalEdit", listener: (edit: NativeConnectorFinalEdit) => void): Promise<PluginListenerHandle>;
}
const ids = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "scene", "destinationId"];
const count = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && (v as number) >= min;
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const closed = (v: object, keys: readonly string[]) => Object.keys(v).every(key => keys.includes(key));
function identity(v: NativeConnectorIdentity): boolean {
  return !!v && v.family === "profile" && v.scene === "connector-custom-server" &&
    [v.documentId, v.ownerEpoch, v.destinationId].every(id => text(id, 128) && id.length > 0) && count(v.ownerGeneration, 1) && count(v.revision, 1);
}
export function validNativeConnectorDraft(v: NativeConnectorDraft): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v) && closed(v, ["name", "endpoint", "credential", "oauthIssuer", "oauthClientId", "oauthClientSecret", "oauthAuthMethod"]) &&
    text(v.name, 100) && text(v.endpoint, 2048) && text(v.credential, 8192) && text(v.oauthIssuer, 2048) &&
    text(v.oauthClientId, 8192) && text(v.oauthClientSecret, 8192) && ["none", "client_secret_post", "client_secret_basic"].includes(v.oauthAuthMethod) &&
    (v.oauthAuthMethod !== "none" || v.oauthClientSecret === "");
}
export function validNativeConnectorProjection(v: NativeConnectorProjection): boolean {
  return identity(v) && validNativeConnectorDraft(v.draft) && closed(v, [...ids, "appearance", "accentHex", "foregroundHex", "draft", "updateSequence",
    "privacyGeneration", "acknowledgedEditRevision", "draftRevision", "canSave", "busy", "error"]) && count(v.updateSequence, 1) && count(v.privacyGeneration) &&
    count(v.acknowledgedEditRevision) && count(v.draftRevision) && typeof v.canSave === "boolean" && typeof v.busy === "boolean" &&
    (v.error === null || text(v.error, 1024)) && ["light", "dark"].includes(v.appearance) &&
    [v.accentHex, v.foregroundHex].every(v => typeof v === "string" && /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(v));
}
/** Readback cannot restore actions. The caller must also check its captured
 * controller and current draft revision before reconciling this final input. */
export function validNativeConnectorFinalEdit(v: NativeConnectorFinalEdit, owner: NativeConnectorIdentity): boolean {
  return identity(v) && sameNativeDrawer(v, owner) && v.destinationId === owner.destinationId && validNativeConnectorDraft(v.draft) &&
    closed(v, [...ids, "draft", "updateSequence", "privacyGeneration", "editRevision", "composing", "baseDraftRevision", "acknowledgedEditRevision"]) &&
    count(v.updateSequence, 1) && count(v.privacyGeneration) && count(v.editRevision) && count(v.baseDraftRevision) &&
    count(v.acknowledgedEditRevision) && v.editRevision >= v.acknowledgedEditRevision && v.composing === false;
}
export class NativeConnectorFence extends NativeProfileSceneFence<NativeConnectorProjection, NativeConnectorEdit, NativeConnectorAction> {
  constructor(owner: NativeConnectorIdentity) {
    const same = (v: NativeConnectorIdentity) => identity(v) && sameNativeDrawer(v, owner) && v.destinationId === owner.destinationId;
    super(owner, {
      state: v => same(v) && validNativeConnectorProjection(v),
      edit: v => same(v) && validNativeConnectorDraft(v.draft) && closed(v, [...ids, "draft", "updateSequence", "privacyGeneration", "editRevision", "composing"]) && typeof v.composing === "boolean",
      action: v => same(v) && closed(v, [...ids, "updateSequence", "privacyGeneration", "editRevision", "sequence", "action"]) && ["save", "cancel"].includes(v.action),
    });
  }
}
