import type { PluginListenerHandle } from "@capacitor/core";
import { NativeOwnedEditorFence } from "./native-owned-editor-fence";
import { sameOwnedChoice, validOwnedChoiceIdentity, type OwnedChoiceIdentity } from "./native-owned-choice";

/** Private in-process replicas only. No account identity, vault authority,
 * persistence handle, image, URL or provider operation is accepted. */
export type NativeWalletCardDraft = {
  pan: string; cardholderName: string; expiry: string; network: string; issuingRegion: string; securityCode: string;
};
export type NativeWalletCardOption = { id: string; label: string; selected: boolean };
export type NativeWalletCardProjection = OwnedChoiceIdentity & {
  updateSequence: number; privacyGeneration: number; acknowledgedEditRevision: number; draftRevision: number;
  draft: NativeWalletCardDraft; busy: boolean; canSave: boolean; error?: string;
  appearance: "light" | "dark"; accentHex: string; foregroundHex: string;
  networks: readonly NativeWalletCardOption[]; regions: readonly NativeWalletCardOption[];
  collectSecurityCode: boolean; scanEnabled: boolean; networkLoading: boolean; networkHint?: string;
};
export type NativeWalletCardEdit = OwnedChoiceIdentity & {
  updateSequence: number; privacyGeneration: number; editRevision: number; baseDraftRevision: number; composing: boolean; draft: NativeWalletCardDraft;
};
export type NativeWalletCardAction = OwnedChoiceIdentity & {
  updateSequence: number; privacyGeneration: number; editRevision: number; sequence: number;
  action: "save" | "cancel" | "change"; intent?: "camera" | "photos";
};
export type NativeWalletCardReceipt = OwnedChoiceIdentity & {
  updateSequence: number; privacyGeneration: number; phase: "active" | "retired";
};
export interface NativeWalletCardPort {
  applyWalletCardScene(state: NativeWalletCardProjection): Promise<NativeWalletCardReceipt>;
  confirmWalletCardAction(action: NativeWalletCardAction): Promise<{ valid: boolean }>;
  settleWalletCardAction(action: NativeWalletCardAction): Promise<{ valid: boolean }>;
  retireWalletCardScene(identity: OwnedChoiceIdentity): Promise<NativeWalletCardReceipt>;
  getWalletCardState(identity: OwnedChoiceIdentity): Promise<NativeWalletCardReceipt>;
  addListener(event: "walletCardEdit" | "walletCardFinalEdit", callback: (event: NativeWalletCardEdit) => void): Promise<PluginListenerHandle>;
  addListener(event: "walletCardAction", callback: (event: NativeWalletCardAction) => void): Promise<PluginListenerHandle>;
}
const identityKeys = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "visitId"];
const metadataKeys = [...identityKeys, "updateSequence", "privacyGeneration"];
const draftKeys = ["pan", "cardholderName", "expiry", "network", "issuingRegion", "securityCode"];
const closed = (value: object, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const count = (value: unknown, minimum = 0) => Number.isSafeInteger(value) && (value as number) >= minimum;
const text = (value: unknown, maximum: number) => typeof value === "string" && value.length <= maximum;
export function validNativeWalletCardDraft(value: NativeWalletCardDraft): boolean {
  return !!value && closed(value, draftKeys) && text(value.pan, 32) && text(value.cardholderName, 120) &&
    text(value.expiry, 7) && text(value.network, 64) && text(value.issuingRegion, 8) && text(value.securityCode, 4);
}
function options(value: readonly NativeWalletCardOption[], maximum: number, selected: string): boolean {
  return Array.isArray(value) && value.length > 0 && value.length <= maximum && value.every(option => !!option &&
    closed(option, ["id", "label", "selected"]) && typeof option.id === "string" && option.id.length > 0 && option.id.length <= 128 &&
    text(option.label, 256) && option.label.length > 0 && typeof option.selected === "boolean") &&
    new Set(value.map(option => option.id)).size === value.length && value.some(option => option.id === selected);
}
export function validNativeWalletCardProjection(value: NativeWalletCardProjection): boolean {
  return validOwnedChoiceIdentity(value) && closed(value, [...metadataKeys, "acknowledgedEditRevision", "draftRevision", "draft", "busy", "canSave", "error",
    "appearance", "accentHex", "foregroundHex", "networks", "regions", "collectSecurityCode", "scanEnabled", "networkLoading", "networkHint"]) &&
    count(value.updateSequence, 1) && count(value.privacyGeneration) && count(value.acknowledgedEditRevision) && count(value.draftRevision) &&
    validNativeWalletCardDraft(value.draft) && typeof value.busy === "boolean" && typeof value.canSave === "boolean" &&
    typeof value.collectSecurityCode === "boolean" && typeof value.scanEnabled === "boolean" && typeof value.networkLoading === "boolean" &&
    ["light", "dark"].includes(value.appearance) && /^#[\da-f]{6}$/i.test(value.accentHex) && /^#[\da-f]{6}([\da-f]{2})?$/i.test(value.foregroundHex) &&
    (value.error === undefined || text(value.error, 4096)) && (value.networkHint === undefined || text(value.networkHint, 1024)) &&
    options(value.networks, 64, value.draft.network) && options(value.regions, 256, value.draft.issuingRegion);
}
export function validNativeWalletCardEdit(value: NativeWalletCardEdit): boolean {
  return validOwnedChoiceIdentity(value) && closed(value, [...metadataKeys, "draft", "editRevision", "baseDraftRevision", "composing"]) &&
    count(value.updateSequence, 1) && count(value.privacyGeneration) && count(value.editRevision, 1) && count(value.baseDraftRevision) &&
    typeof value.composing === "boolean" && validNativeWalletCardDraft(value.draft);
}
export function validNativeWalletCardAction(value: NativeWalletCardAction): boolean {
  return validOwnedChoiceIdentity(value) && closed(value, [...metadataKeys, "editRevision", "sequence", "action", "intent"]) &&
    count(value.updateSequence, 1) && count(value.privacyGeneration) && count(value.editRevision) && count(value.sequence, 1) &&
    (value.action === "change" ? ["camera", "photos"].includes(value.intent ?? "") :
      ["save", "cancel"].includes(value.action) && value.intent === undefined);
}
export class NativeWalletCardFence extends NativeOwnedEditorFence<OwnedChoiceIdentity, NativeWalletCardProjection, NativeWalletCardEdit, NativeWalletCardAction> {
  constructor(identity: OwnedChoiceIdentity) {
    super(identity, { state: validNativeWalletCardProjection, edit: validNativeWalletCardEdit, action: validNativeWalletCardAction }, sameOwnedChoice);
  }
  private draftRevision = -1;
  override update(state: NativeWalletCardProjection): boolean {
    if (!super.update(state)) return false;
    this.draftRevision = state.draftRevision;
    return true;
  }
  override consumeEdit(event: NativeWalletCardEdit): boolean {
    return event.baseDraftRevision === this.draftRevision && super.consumeEdit(event);
  }
}

/** Document-start renderer selection. Older wrappers never enter admission. */
export function nativeWalletCardFormsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const bootstrap = (window as Window & { __HUSHH_NATIVE_DRAWER_BOOTSTRAP__?: { contractVersion: number; enabled: boolean; walletCardForms?: boolean } }).__HUSHH_NATIVE_DRAWER_BOOTSTRAP__;
  return bootstrap?.contractVersion === 1 && bootstrap.enabled === true && bootstrap.walletCardForms === true;
}
