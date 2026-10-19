import type { PluginListenerHandle } from "@capacitor/core";
import type { NativeControlAppearance } from "./native-control-appearance";
import { sameNativeDrawer, type NativeDrawerIdentity } from "./native-drawers";
import { NativeProfileSceneFence } from "./native-profile-scene-fence";
import type { NativeProfileSceneReceipt } from "./native-profile-scene-presentation";

/** Private volatile number/OTP field replicas. Provider challenges, Firebase
 * objects and owner/vault credentials remain with the authentication owner. */
export type NativePhoneStep = "phone" | "code" | "linked";
export type NativePhoneDraft = { country: string; number: string; code: string };
export type NativePhoneIntent = "send" | "verify" | "resend" | "back" | "continue";
export type NativePhoneIdentity = NativeDrawerIdentity & { family: "profile"; scene: "phone"; destinationId: string };
export type NativePhoneProjection = NativePhoneIdentity & NativeControlAppearance & {
  updateSequence: number; privacyGeneration: number; draftRevision: number; acknowledgedEditRevision: number;
  draft: NativePhoneDraft; step: NativePhoneStep; mode: "link" | "replace";
  countries: readonly { value: string; label: string; dialCode: string }[];
  maskedDestination: string; canSave: boolean; busy: boolean; error: string | null;
};
export type NativePhoneEdit = NativePhoneIdentity & {
  updateSequence: number; privacyGeneration: number; editRevision: number;
  step: NativePhoneStep; draft: NativePhoneDraft; composing: boolean;
};
export type NativePhoneAction = NativePhoneIdentity & {
  updateSequence: number; privacyGeneration: number; editRevision: number; sequence: number;
  action: "change" | "cancel"; intent?: NativePhoneIntent;
};
export interface NativePhoneScenePort {
  applyProfilePhoneScene(state: NativePhoneProjection): Promise<NativeProfileSceneReceipt>;
  confirmProfilePhoneAction(action: NativePhoneAction): Promise<{ valid: boolean }>;
  settleProfilePhoneAction(action: NativePhoneAction): Promise<{ valid: boolean }>;
  retireProfilePhoneScene(identity: NativePhoneIdentity): Promise<NativeProfileSceneReceipt>;
  addListener(event: "profilePhoneEdit", listener: (edit: NativePhoneEdit) => void): Promise<PluginListenerHandle>;
  addListener(event: "profilePhoneAction", listener: (action: NativePhoneAction) => void): Promise<PluginListenerHandle>;
}
const identityKeys = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "scene", "destinationId"];
function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
}
function count(value: unknown, min = 0): boolean { return Number.isSafeInteger(value) && (value as number) >= min; }
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.length <= max; }
function identity(value: NativePhoneIdentity): boolean {
  return !!value && value.family === "profile" && value.scene === "phone" &&
    [value.documentId, value.ownerEpoch, value.destinationId].every(id => text(id, 128) && id.length > 0) &&
    count(value.ownerGeneration, 1) && count(value.revision, 1);
}
function draft(value: NativePhoneDraft): boolean {
  return closed(value, ["country", "number", "code"]) && typeof value.country === "string" && /^[A-Z]{2}$/.test(value.country) &&
    text(value.number, 64) && text(value.code, 64);
}
export function phoneIntentAllowed(step: NativePhoneStep, intent: NativePhoneIntent | undefined): boolean {
  return step === "phone" ? intent === "send" : step === "code" ? ["verify", "resend", "back"].includes(intent ?? "") : intent === "continue";
}
export function validNativePhoneProjection(value: NativePhoneProjection): boolean {
  return identity(value) && closed(value, [...identityKeys, "appearance", "accentHex", "foregroundHex", "updateSequence",
    "privacyGeneration", "draftRevision", "acknowledgedEditRevision", "draft", "step", "mode", "countries", "maskedDestination", "canSave", "busy", "error"]) &&
    count(value.updateSequence, 1) && [value.privacyGeneration, value.draftRevision, value.acknowledgedEditRevision].every(n => count(n)) &&
    draft(value.draft) && ["phone", "code", "linked"].includes(value.step) && ["link", "replace"].includes(value.mode) &&
    Array.isArray(value.countries) && value.countries.length > 0 && value.countries.length <= 256 &&
    new Set(value.countries.map(option => option.value)).size === value.countries.length && value.countries.every(option =>
      closed(option, ["value", "label", "dialCode"]) && typeof option.value === "string" && /^[A-Z]{2}$/.test(option.value) &&
      text(option.label, 128) && option.label.length > 0 && typeof option.dialCode === "string" && /^\+\d{1,4}$/.test(option.dialCode)) &&
    value.countries.some(option => option.value === value.draft.country) && text(value.maskedDestination, 64) &&
    [value.canSave, value.busy].every(flag => typeof flag === "boolean") && (value.error === null || text(value.error, 1024)) &&
    ["light", "dark"].includes(value.appearance) && [value.accentHex, value.foregroundHex].every(color =>
      typeof color === "string" && /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(color));
}
export class NativePhoneFence extends NativeProfileSceneFence<NativePhoneProjection, NativePhoneEdit, NativePhoneAction> {
  private step: NativePhoneStep | null = null;
  constructor(owner: NativePhoneIdentity) {
    const same = (value: NativePhoneIdentity) => identity(value) && sameNativeDrawer(value, owner) && value.destinationId === owner.destinationId;
    super(owner, { state: value => validNativePhoneProjection(value) && same(value),
      edit: value => !!value && same(value) && closed(value, [...identityKeys, "updateSequence", "privacyGeneration", "editRevision", "step", "draft", "composing"]) &&
        draft(value.draft) && typeof value.composing === "boolean",
      action: (value, state) => !!value && same(value) && closed(value, [...identityKeys, "updateSequence", "privacyGeneration", "editRevision", "sequence", "action", "intent"]) &&
        (value.action === "cancel" ? value.intent === undefined : value.action === "change" && phoneIntentAllowed(state.step, value.intent)),
    });
  }
  override update(value: NativePhoneProjection): boolean {
    if (!super.update(value)) return false;
    this.step = value.step; return true;
  }
  override consumeEdit(value: NativePhoneEdit): boolean { return value.step === this.step && super.consumeEdit(value); }
}
