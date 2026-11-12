import { expect, it } from "vitest";
import {
  NativeVaultGateFence,
  validNativeVaultGateAction,
  validNativeVaultGateEdit,
  validNativeVaultGateProjection,
  validNativeVaultGateReceipt,
  type NativeVaultGateProjection,
} from "@/lib/capacitor/native-vault-gate";

it("keeps the hard Vault gate private, closed, and revision fenced", () => {
  const state: NativeVaultGateProjection = {
    documentId: "synthetic-document",
    ownerEpoch: "synthetic-owner",
    ownerGeneration: 1,
    revision: 1,
    scene: "vault-hard-gate",
    destinationId: "synthetic-gate",
    updateSequence: 1,
    privacyGeneration: 0,
    acknowledgedEditRevision: 0,
    step: "create",
    title: "Set a lock",
    description: "Only you can open what you save.",
    password: "synthetic-private-passphrase",
    confirmation: "synthetic-private-passphrase",
    recoveryKeyInput: "",
    recoveryKey: "synthetic-private-recovery-key",
    error: "",
    primaryLabel: "Create password",
    primaryEnabled: true,
    busy: false,
    busyLabel: "Creating…",
    showPasswordUnlock: false,
    showGeneratedUnlock: false,
    generatedUnlockLabel: "",
    generatedUnlockEnabled: false,
    showRecoveryAction: false,
    showSignOut: false,
    signOutBusy: false,
    showLostVaultDelete: false,
    showCreateQuickUnlock: true,
    createWantsQuickUnlock: true,
    createQuickUnlockLabel: "Passkey",
    showCopy: false,
    copied: false,
    showDownload: false,
    showRecoverySaved: false,
    savedLabel: "I’ve saved my recovery key",
    quickMethodLabel: "",
    quickMethodBody: "Your password and recovery key still work.",
    quickMethodEnabled: false,
    skipMethodLabel: "Not now, continue with password",
    appearance: "light",
    accentHex: "#007aff",
    foregroundHex: "#111111",
  };

  expect(validNativeVaultGateProjection(state)).toBe(true);
  expect(validNativeVaultGateProjection({ ...state, vaultKey: "forbidden" } as never)).toBe(false);
  expect(validNativeVaultGateProjection({ ...state, password: "x".repeat(4097) })).toBe(false);

  const identity = {
    documentId: state.documentId,
    ownerEpoch: state.ownerEpoch,
    ownerGeneration: state.ownerGeneration,
    revision: state.revision,
    scene: state.scene,
    destinationId: state.destinationId,
  };
  const receipt = { ...identity, updateSequence: 1, privacyGeneration: 0, phase: "active" as const };
  expect(validNativeVaultGateReceipt(receipt, identity, 1, 0, "active")).toBe(true);
  expect(Object.keys(receipt)).not.toContain("password");
  expect(Object.keys(receipt)).not.toContain("recoveryKey");

  const fence = new NativeVaultGateFence(identity);
  const edit = {
    ...identity,
    updateSequence: 1,
    privacyGeneration: 0,
    editRevision: 1,
    step: "create" as const,
    password: "synthetic-private-passphrase",
    confirmation: "synthetic-private-passphrase",
    recoveryKeyInput: "",
    composing: false,
  };
  expect(validNativeVaultGateEdit(edit)).toBe(true);
  expect(fence.consumeEdit(edit, state)).toBe(true);
  const action = { ...identity, updateSequence: 2, privacyGeneration: 0, editRevision: 1, sequence: 1, action: "primary" as const };
  expect(validNativeVaultGateAction(action)).toBe(true);
  expect(fence.consumeAction(action, state)).toBe(false);
  expect(fence.consumeAction(action, { ...state, updateSequence: 2, acknowledgedEditRevision: 1 })).toBe(true);
  expect(fence.consumeAction(action, { ...state, updateSequence: 2, acknowledgedEditRevision: 1 })).toBe(false);
});
