import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { NativeControlAppearance } from "./native-control-appearance";

export type NativeVaultGateIdentity = {
  documentId: string;
  ownerEpoch: string;
  ownerGeneration: number;
  revision: number;
  scene: "vault-hard-gate";
  destinationId: string;
};

export type NativeVaultGateStep = "create" | "unlock" | "recovery" | "recovery-disclosure" | "method";
export type NativeVaultGateActionName = "primary" | "generated_unlock" | "recovery" | "password" |
  "sign_out" | "delete_lost_vault" | "copy_recovery" | "download_recovery" | "recovery_saved" |
  "enable_quick_unlock" | "skip_quick_unlock" | "toggle_quick_unlock";

export type NativeVaultGateProjection = NativeVaultGateIdentity & NativeControlAppearance & {
  updateSequence: number;
  privacyGeneration: number;
  acknowledgedEditRevision: number;
  step: NativeVaultGateStep;
  title: string;
  description: string;
  password: string;
  confirmation: string;
  recoveryKeyInput: string;
  recoveryKey: string;
  error: string;
  primaryLabel: string;
  primaryEnabled: boolean;
  busy: boolean;
  busyLabel: string;
  showPasswordUnlock: boolean;
  showGeneratedUnlock: boolean;
  generatedUnlockLabel: string;
  generatedUnlockEnabled: boolean;
  showRecoveryAction: boolean;
  showSignOut: boolean;
  signOutBusy: boolean;
  showLostVaultDelete: boolean;
  showCreateQuickUnlock: boolean;
  createWantsQuickUnlock: boolean;
  createQuickUnlockLabel: string;
  showCopy: boolean;
  copied: boolean;
  showDownload: boolean;
  showRecoverySaved: boolean;
  savedLabel: string;
  quickMethodLabel: string;
  quickMethodBody: string;
  quickMethodEnabled: boolean;
  skipMethodLabel: string;
};

export type NativeVaultGateEdit = NativeVaultGateIdentity & {
  updateSequence: number;
  privacyGeneration: number;
  editRevision: number;
  step: NativeVaultGateStep;
  password: string;
  confirmation: string;
  recoveryKeyInput: string;
  composing: boolean;
};

export type NativeVaultGateAction = NativeVaultGateIdentity & {
  updateSequence: number;
  privacyGeneration: number;
  editRevision: number;
  sequence: number;
  action: NativeVaultGateActionName;
};

export type NativeVaultGateReceipt = NativeVaultGateIdentity & {
  updateSequence: number;
  privacyGeneration: number;
  phase: "active" | "retired";
};

export interface NativeVaultGatePlugin {
  getCapabilities(): Promise<{ available: boolean }>;
  applyVaultGateScene(state: NativeVaultGateProjection): Promise<NativeVaultGateReceipt>;
  confirmVaultGateAction(action: NativeVaultGateAction): Promise<{ valid: boolean }>;
  settleVaultGateAction(action: NativeVaultGateAction): Promise<{ valid: boolean }>;
  retireVaultGateScene(identity: NativeVaultGateIdentity & { updateSequence: number; privacyGeneration: number }): Promise<NativeVaultGateReceipt>;
  addListener(event: "vaultGateEdit", listener: (event: NativeVaultGateEdit) => void): Promise<PluginListenerHandle>;
  addListener(event: "vaultGateAction", listener: (event: NativeVaultGateAction) => void): Promise<PluginListenerHandle>;
  addListener(event: "vaultGateRetired", listener: (event: NativeVaultGateReceipt) => void): Promise<PluginListenerHandle>;
}

let registeredPlugin: NativeVaultGatePlugin | undefined;
export function nativeVaultGate(): NativeVaultGatePlugin {
  return registeredPlugin ??= registerPlugin<NativeVaultGatePlugin>("HushhNativeVaultGate");
}

const identityKeys = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "scene", "destinationId"] as const;
const projectionKeys = [...identityKeys, "appearance", "accentHex", "foregroundHex", "updateSequence", "privacyGeneration",
  "acknowledgedEditRevision", "step", "title", "description", "password", "confirmation", "recoveryKeyInput", "recoveryKey",
  "error", "primaryLabel", "primaryEnabled", "busy", "busyLabel", "showPasswordUnlock", "showGeneratedUnlock",
  "generatedUnlockLabel", "generatedUnlockEnabled", "showRecoveryAction", "showSignOut", "signOutBusy", "showLostVaultDelete",
  "showCreateQuickUnlock", "createWantsQuickUnlock", "createQuickUnlockLabel", "showCopy", "copied", "showDownload", "showRecoverySaved", "savedLabel", "quickMethodLabel", "quickMethodBody",
  "quickMethodEnabled", "skipMethodLabel"] as const;
const editKeys = [...identityKeys, "updateSequence", "privacyGeneration", "editRevision", "step", "password", "confirmation",
  "recoveryKeyInput", "composing"] as const;
const actionKeys = [...identityKeys, "updateSequence", "privacyGeneration", "editRevision", "sequence", "action"] as const;

const closed = (value: object, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const count = (value: unknown, minimum = 0) => Number.isSafeInteger(value) && (value as number) >= minimum &&
  (value as number) < Number.MAX_SAFE_INTEGER;
const text = (value: unknown, maximum: number) => typeof value === "string" && value.length <= maximum;
const boundedLabel = (value: unknown, maximum = 128) => text(value, maximum);

function validIdentity(value: NativeVaultGateIdentity): boolean {
  return !!value && value.scene === "vault-hard-gate" &&
    [value.documentId, value.ownerEpoch, value.destinationId].every(id => text(id, 128) && id.length > 0) &&
    count(value.ownerGeneration, 1) && count(value.revision, 1);
}

export function validNativeVaultGateProjection(value: NativeVaultGateProjection): boolean {
  return validIdentity(value) && closed(value, projectionKeys) &&
    count(value.updateSequence, 1) && count(value.privacyGeneration) && count(value.acknowledgedEditRevision) &&
    ["create", "unlock", "recovery", "recovery-disclosure", "method"].includes(value.step) &&
    ["light", "dark"].includes(value.appearance) &&
    [value.accentHex, value.foregroundHex].every(color => /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(color)) &&
    text(value.password, 4096) && text(value.confirmation, 4096) && text(value.recoveryKeyInput, 256) && text(value.recoveryKey, 256) &&
    boundedLabel(value.title, 128) && boundedLabel(value.description, 256) && boundedLabel(value.error, 512) &&
    [value.primaryLabel, value.busyLabel, value.generatedUnlockLabel, value.savedLabel, value.quickMethodLabel,
      value.quickMethodBody, value.skipMethodLabel, value.createQuickUnlockLabel].every(label => boundedLabel(label, 512)) &&
    [value.primaryEnabled, value.busy, value.showPasswordUnlock, value.showGeneratedUnlock, value.generatedUnlockEnabled,
      value.showRecoveryAction, value.showSignOut, value.signOutBusy, value.showLostVaultDelete, value.showCopy,
      value.copied, value.showDownload, value.showRecoverySaved, value.quickMethodEnabled, value.showCreateQuickUnlock, value.createWantsQuickUnlock].every(flag => typeof flag === "boolean") &&
    (!value.primaryEnabled || !value.busy) && (!value.generatedUnlockEnabled || value.showGeneratedUnlock && !value.busy) &&
    (value.step !== "create" || !value.primaryEnabled || value.password.length >= 8 && value.password === value.confirmation) &&
    (value.step !== "recovery-disclosure" || value.recoveryKey.length > 0);
}

export function validNativeVaultGateEdit(value: NativeVaultGateEdit): boolean {
  return validIdentity(value) && closed(value, editKeys) && count(value.updateSequence, 1) && count(value.privacyGeneration) &&
    count(value.editRevision, 1) && ["create", "unlock", "recovery", "recovery-disclosure", "method"].includes(value.step) &&
    text(value.password, 4096) && text(value.confirmation, 4096) && text(value.recoveryKeyInput, 256) && typeof value.composing === "boolean";
}

export function validNativeVaultGateAction(value: NativeVaultGateAction): boolean {
  return validIdentity(value) && closed(value, actionKeys) && count(value.updateSequence, 1) && count(value.privacyGeneration) &&
    count(value.editRevision) && count(value.sequence, 1) && ["primary", "generated_unlock", "recovery", "password", "sign_out",
      "delete_lost_vault", "copy_recovery", "download_recovery", "recovery_saved", "enable_quick_unlock", "skip_quick_unlock", "toggle_quick_unlock"]
      .includes(value.action);
}

export function sameNativeVaultGate(left: NativeVaultGateIdentity, right: NativeVaultGateIdentity): boolean {
  return left.documentId === right.documentId && left.ownerEpoch === right.ownerEpoch &&
    left.ownerGeneration === right.ownerGeneration && left.revision === right.revision &&
    left.scene === right.scene && left.destinationId === right.destinationId;
}

/** Receipts are deliberately metadata-only. Private fields exist only in the
 * volatile projection and edit event and never enter diagnostics or storage. */
export function validNativeVaultGateReceipt(value: NativeVaultGateReceipt, expected: NativeVaultGateIdentity,
  updateSequence: number, privacyGeneration: number, phase: "active" | "retired"): boolean {
  return !!value && closed(value, [...identityKeys, "updateSequence", "privacyGeneration", "phase"]) &&
    sameNativeVaultGate(value, expected) && count(value.updateSequence) && count(value.privacyGeneration) &&
    value.updateSequence === updateSequence && value.privacyGeneration === privacyGeneration && value.phase === phase;
}

/** Local event ordering only; the Swift scene independently fences every edit
 * and action against its current projection before emitting it. */
export class NativeVaultGateFence {
  private editRevision = 0;
  private actionSequence = 0;
  private composing = false;
  constructor(readonly identity: NativeVaultGateIdentity) {}
  consumeEdit(event: NativeVaultGateEdit, current: NativeVaultGateProjection): boolean {
    if (!validNativeVaultGateEdit(event) || !sameNativeVaultGate(event, this.identity) ||
        event.updateSequence !== current.updateSequence || event.privacyGeneration !== current.privacyGeneration ||
        event.editRevision <= this.editRevision || event.step !== current.step) return false;
    this.editRevision = event.editRevision;
    this.composing = event.composing;
    return true;
  }
  consumeAction(event: NativeVaultGateAction, current: NativeVaultGateProjection): boolean {
    if (!validNativeVaultGateAction(event) || !sameNativeVaultGate(event, this.identity) ||
        event.updateSequence !== current.updateSequence || event.privacyGeneration !== current.privacyGeneration ||
        event.sequence <= this.actionSequence || event.editRevision !== current.acknowledgedEditRevision || this.composing) return false;
    this.actionSequence = event.sequence;
    return true;
  }
  retire() { this.composing = false; }
}
