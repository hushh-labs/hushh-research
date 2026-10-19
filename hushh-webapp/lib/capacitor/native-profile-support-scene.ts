import type { PluginListenerHandle } from "@capacitor/core";
import type { SupportMessageKind } from "@/lib/services/support-service";
import { sameNativeDrawer, type NativeDrawerIdentity } from "./native-drawers";
import type { NativeControlAppearance } from "./native-control-appearance";
import { NativeProfileSceneFence } from "./native-profile-scene-fence";
import type { NativeProfileSceneReceipt } from "./native-profile-scene-presentation";

export const SUPPORT_KINDS: readonly SupportMessageKind[] = ["bug_report", "support_request", "developer_reachout"];
export type NativeSupportDraft = { kind: SupportMessageKind; message: string };
export type NativeSupportIdentity = NativeDrawerIdentity & { family: "profile"; scene: "support"; destinationId: string };
export type NativeSupportProjection = NativeSupportIdentity & NativeControlAppearance & {
  updateSequence: number; privacyGeneration: number; draftRevision: number; acknowledgedEditRevision: number;
  draft: NativeSupportDraft; canSave: boolean; busy: boolean; sent: boolean;
  error: string | null; replyLine: string; placeholder: string; submitLabel: string; successTitle: string; successDescription: string;
};
export type NativeSupportEdit = NativeSupportIdentity & {
  updateSequence: number; privacyGeneration: number; editRevision: number; composing: boolean; draft: NativeSupportDraft;
};
export type NativeSupportAction = NativeSupportIdentity & {
  updateSequence: number; privacyGeneration: number; editRevision: number; sequence: number; action: "save" | "cancel";
};
export interface NativeSupportScenePort {
  applyProfileSupportScene(state: NativeSupportProjection): Promise<NativeProfileSceneReceipt>;
  confirmProfileSupportAction(action: NativeSupportAction): Promise<{ valid: boolean }>;
  settleProfileSupportAction(action: NativeSupportAction & { saved?: boolean }): Promise<{ valid: boolean }>;
  retireProfileSupportScene(identity: NativeSupportIdentity): Promise<NativeProfileSceneReceipt>;
  addListener(event: "profileSupportEdit", listener: (edit: NativeSupportEdit) => void): Promise<PluginListenerHandle>;
  addListener(event: "profileSupportAction", listener: (action: NativeSupportAction) => void): Promise<PluginListenerHandle>;
}
const identityKeys = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "scene", "destinationId"];
function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
}
function count(value: unknown, minimum = 0): boolean { return Number.isSafeInteger(value) && (value as number) >= minimum; }
function text(value: unknown, maximum: number): value is string { return typeof value === "string" && value.length <= maximum; }
function identity(value: NativeSupportIdentity): boolean {
  return !!value && value.family === "profile" && value.scene === "support" &&
    [value.documentId, value.ownerEpoch, value.destinationId].every(id => text(id, 128) && id.length > 0) &&
    count(value.ownerGeneration, 1) && count(value.revision, 1);
}
function draft(value: NativeSupportDraft): boolean {
  return closed(value, ["kind", "message"]) && SUPPORT_KINDS.includes(value.kind) && text(value.message, 8000);
}
export function validNativeSupportProjection(value: NativeSupportProjection): boolean {
  return identity(value) && closed(value, [...identityKeys, "appearance", "accentHex", "foregroundHex", "updateSequence",
    "privacyGeneration", "draftRevision", "acknowledgedEditRevision", "draft", "canSave", "busy", "sent", "error", "replyLine",
    "placeholder", "submitLabel", "successTitle", "successDescription"]) &&
    count(value.updateSequence, 1) && count(value.privacyGeneration) && count(value.draftRevision) && count(value.acknowledgedEditRevision) &&
    draft(value.draft) && [value.canSave, value.busy, value.sent].every(flag => typeof flag === "boolean") &&
    !(value.sent && (value.canSave || value.busy)) &&
    (value.error === null || text(value.error, 1024)) &&
    [value.replyLine, value.placeholder, value.submitLabel, value.successTitle, value.successDescription].every(label => text(label, 1024)) &&
    ["light", "dark"].includes(value.appearance) && [value.accentHex, value.foregroundHex].every(color =>
      typeof color === "string" && /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(color));
}
export class NativeSupportFence extends NativeProfileSceneFence<NativeSupportProjection, NativeSupportEdit, NativeSupportAction> {
  constructor(owner: NativeSupportIdentity) {
    const same = (value: NativeSupportIdentity) => identity(value) && sameNativeDrawer(value, owner) && value.destinationId === owner.destinationId;
    super(owner, {
      state: value => validNativeSupportProjection(value) && same(value),
      edit: value => !!value && same(value) && closed(value, [...identityKeys, "updateSequence", "privacyGeneration", "editRevision", "composing", "draft"]) &&
        draft(value.draft) && typeof value.composing === "boolean",
      action: (value, state) => !!value && same(value) && closed(value, [...identityKeys, "updateSequence", "privacyGeneration", "editRevision", "sequence", "action"]) &&
        (value.action === "cancel" || value.action === "save" && !state.sent),
    });
  }
}
