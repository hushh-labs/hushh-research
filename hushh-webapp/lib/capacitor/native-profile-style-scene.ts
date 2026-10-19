import type { PluginListenerHandle } from "@capacitor/core";
import { OWNER_STYLE_LANGUAGES, OWNER_STYLE_LANGUAGE_LABEL, OWNER_STYLE_LENGTHS, OWNER_STYLE_LENGTH_LABEL,
  OWNER_STYLE_TONES, OWNER_STYLE_TONE_LABEL, type OwnerStyleSettings } from "@/lib/agent/owner-style-settings";
import { sameNativeDrawer, type NativeDrawerIdentity } from "./native-drawers";
import type { NativeControlAppearance } from "./native-control-appearance";
import { NativeProfileSceneFence } from "./native-profile-scene-fence";
import type { NativeProfileSceneReceipt } from "./native-profile-scene-presentation";

export const STYLE_CHOICE_OPTIONS = {
  tone: OWNER_STYLE_TONES.map(value => ({ value, label: OWNER_STYLE_TONE_LABEL[value] })),
  length: OWNER_STYLE_LENGTHS.map(value => ({ value, label: OWNER_STYLE_LENGTH_LABEL[value] })),
  language: OWNER_STYLE_LANGUAGES.map(value => ({ value, label: OWNER_STYLE_LANGUAGE_LABEL[value] })),
};
export type NativeProfileStyleIdentity = NativeDrawerIdentity & { family: "profile"; scene: "writing-style"; destinationId?: string };
export type NativeProfileStyleProjection = NativeProfileStyleIdentity & NativeControlAppearance & {
  updateSequence: number; privacyGeneration: number; draftRevision: number; acknowledgedEditRevision: number;
  draft: OwnerStyleSettings; choices: typeof STYLE_CHOICE_OPTIONS;
  canSave: boolean; busy: boolean; unavailable: boolean; suggested: boolean; error: string | null;
};
export type NativeProfileStyleEdit = NativeProfileStyleIdentity & {
  updateSequence: number; privacyGeneration: number; editRevision: number; composing: boolean;
} & { [K in keyof Required<OwnerStyleSettings>]: { field: K; value: Required<OwnerStyleSettings>[K] | null } }[keyof OwnerStyleSettings];
export type NativeProfileStyleAction = NativeProfileStyleIdentity & {
  updateSequence: number; privacyGeneration: number; editRevision: number; sequence: number; action: "save" | "cancel";
};
export interface NativeProfileStyleScenePort {
  applyProfileStyleScene(state: NativeProfileStyleProjection): Promise<NativeProfileSceneReceipt>;
  confirmProfileStyleAction(action: NativeProfileStyleAction): Promise<{ valid: boolean }>;
  settleProfileStyleAction(action: NativeProfileStyleAction & { saved?: boolean }): Promise<{ valid: boolean }>;
  retireProfileStyleScene(identity: NativeProfileStyleIdentity): Promise<NativeProfileSceneReceipt>;
  addListener(event: "profileStyleEdit", listener: (edit: NativeProfileStyleEdit) => void): Promise<PluginListenerHandle>;
  addListener(event: "profileStyleAction", listener: (action: NativeProfileStyleAction) => void): Promise<PluginListenerHandle>;
}
const identityKeys = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "scene", "destinationId"];
const fields = ["preferred_name", "tone", "length", "language", "avoid_em_dashes", "owner_style_note"] as const;
function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
}
function count(value: unknown, minimum = 0): boolean { return Number.isSafeInteger(value) && (value as number) >= minimum; }
function identity(value: NativeProfileStyleIdentity): boolean {
  return !!value && value.family === "profile" && value.scene === "writing-style" &&
    [value.documentId, value.ownerEpoch].every(id => typeof id === "string" && id.length > 0 && id.length <= 128) &&
    count(value.ownerGeneration, 1) && count(value.revision, 1) &&
    (value.destinationId === undefined || typeof value.destinationId === "string" && value.destinationId.length > 0 && value.destinationId.length <= 128);
}
function fieldValue(field: string, value: unknown): boolean {
  if (value === null) return true;
  if (field === "avoid_em_dashes") return typeof value === "boolean";
  if (field === "preferred_name" || field === "owner_style_note") return typeof value === "string" && value.length <= (field === "preferred_name" ? 64 : 280);
  return Object.hasOwn(STYLE_CHOICE_OPTIONS, field) &&
    STYLE_CHOICE_OPTIONS[field as keyof typeof STYLE_CHOICE_OPTIONS].some(option => option.value === value);
}
export function validNativeProfileStyleProjection(value: NativeProfileStyleProjection): boolean {
  return identity(value) && closed(value, [...identityKeys, "appearance", "accentHex", "foregroundHex", "updateSequence",
    "privacyGeneration", "draftRevision", "acknowledgedEditRevision", "draft", "choices", "canSave", "busy", "unavailable", "suggested", "error"]) &&
    count(value.updateSequence, 1) && count(value.privacyGeneration) && count(value.draftRevision) && count(value.acknowledgedEditRevision) &&
    closed(value.draft, fields) && Object.entries(value.draft).every(([field, entry]) => entry !== null && fieldValue(field, entry)) &&
    JSON.stringify(value.choices) === JSON.stringify(STYLE_CHOICE_OPTIONS) &&
    [value.canSave, value.busy, value.unavailable, value.suggested].every(flag => typeof flag === "boolean") &&
    (value.error === null || typeof value.error === "string" && value.error.length <= 1024) &&
    ["light", "dark"].includes(value.appearance) && [value.accentHex, value.foregroundHex]
      .every(color => typeof color === "string" && /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(color));
}
export class NativeProfileStyleFence extends NativeProfileSceneFence<NativeProfileStyleProjection, NativeProfileStyleEdit, NativeProfileStyleAction> {
  constructor(owner: NativeProfileStyleIdentity) {
    const same = (value: NativeProfileStyleIdentity) => identity(value) && sameNativeDrawer(value, owner) && value.scene === owner.scene && value.destinationId === owner.destinationId;
    super(owner, { state: value => validNativeProfileStyleProjection(value) && same(value),
      edit: value => !!value && same(value) && closed(value, [...identityKeys, "updateSequence", "privacyGeneration", "editRevision", "field", "value", "composing"]) &&
        fields.includes(value.field) && fieldValue(value.field, value.value) && typeof value.composing === "boolean",
      action: value => !!value && same(value) && closed(value, [...identityKeys, "updateSequence", "privacyGeneration", "editRevision", "sequence", "action"]) &&
        ["save", "cancel"].includes(value.action) });
  }
}
