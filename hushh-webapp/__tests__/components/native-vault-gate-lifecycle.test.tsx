import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => {
  const receipt = (state: Record<string, unknown>, phase: "active" | "retired") => ({
    documentId: state.documentId,
    ownerEpoch: state.ownerEpoch,
    ownerGeneration: state.ownerGeneration,
    revision: state.revision,
    scene: state.scene,
    destinationId: state.destinationId,
    updateSequence: state.updateSequence,
    privacyGeneration: state.privacyGeneration,
    phase,
  });
  return {
    plugin: {
      getCapabilities: vi.fn(async () => ({ available: true })),
      addListener: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
      applyVaultGateScene: vi.fn(async (state: Record<string, unknown>) => receipt(state, "active")),
      retireVaultGateScene: vi.fn(async (state: Record<string, unknown>) => receipt(state, "retired")),
    },
  };
});

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => "ios" } }));
vi.mock("@/lib/capacitor/native-control-appearance", () => ({
  readNativeControlAppearance: () => ({ appearance: "light", accentHex: "#123456", foregroundHex: "#111111" }),
}));
vi.mock("@/lib/capacitor/session-privacy", () => ({
  getNativeSessionPrivacyState: async () => ({ generation: 1 }),
  nativeDocumentId: () => "test-document",
  nativePrivacyCanInteract: () => true,
  subscribeNativeSessionPrivacy: async () => ({ remove: vi.fn(async () => undefined) }),
}));
vi.mock("@/lib/capacitor/native-vault-gate", () => ({
  NativeVaultGateFence: class { retire() {} },
  nativeVaultGate: () => bridge.plugin,
  sameNativeVaultGate: () => true,
  validNativeVaultGateProjection: () => true,
  validNativeVaultGateReceipt: (receipt: { phase?: string }, _identity: unknown, _sequence: number,
    _privacyGeneration: number, phase: string) => receipt.phase === phase,
}));

import { NativeVaultGate, type NativeVaultGateFields } from "@/components/vault/native-vault-gate";

const fields: NativeVaultGateFields = {
  step: "unlock",
  title: "Unlock One",
  description: "Enter your password.",
  password: "",
  confirmation: "",
  recoveryKeyInput: "",
  recoveryKey: "",
  error: "",
  primaryLabel: "Unlock",
  primaryEnabled: false,
  busy: false,
  busyLabel: "Unlocking…",
  showPasswordUnlock: false,
  showGeneratedUnlock: false,
  generatedUnlockLabel: "",
  generatedUnlockEnabled: false,
  showRecoveryAction: false,
  showSignOut: false,
  signOutBusy: false,
  showLostVaultDelete: false,
  showCreateQuickUnlock: false,
  createWantsQuickUnlock: false,
  createQuickUnlockLabel: "",
  showCopy: false,
  copied: false,
  showDownload: false,
  showRecoverySaved: false,
  savedLabel: "",
  quickMethodLabel: "",
  quickMethodBody: "",
  quickMethodEnabled: false,
  skipMethodLabel: "",
};

describe("NativeVaultGate owner retirement", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("clears VaultFlow drafts when its captured owner is no longer current", async () => {
    let previousOwnerIsCurrent = true;
    const clearPreviousOwnerDrafts = vi.fn();
    const view = render(
      <NativeVaultGate
        key="owner-one"
        fields={fields}
        ownerIsCurrent={() => previousOwnerIsCurrent}
        onEdit={() => undefined}
        onAction={() => undefined}
        onInterrupted={clearPreviousOwnerDrafts}
      />,
    );
    await waitFor(() => expect(bridge.plugin.applyVaultGateScene).toHaveBeenCalledOnce());

    previousOwnerIsCurrent = false;
    view.rerender(
      <NativeVaultGate
        key="owner-two"
        fields={fields}
        ownerIsCurrent={() => true}
        onEdit={() => undefined}
        onAction={() => undefined}
        onInterrupted={() => undefined}
      />,
    );

    expect(clearPreviousOwnerDrafts).toHaveBeenCalledOnce();
  });

  it("preserves the React-owned draft on same-owner renderer fallback", async () => {
    const ownerDrafts = vi.fn();
    const view = render(
      <NativeVaultGate
        fields={fields}
        ownerIsCurrent={() => true}
        onEdit={() => undefined}
        onAction={() => undefined}
        onInterrupted={ownerDrafts}
      />,
    );
    await waitFor(() => expect(bridge.plugin.applyVaultGateScene).toHaveBeenCalled());
    view.unmount();
    expect(ownerDrafts).not.toHaveBeenCalled();
  });
});
