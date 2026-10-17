import { createElement } from "react";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const modelMocks = vi.hoisted(() => ({
  owner: { userId: "vault-method-owner", generation: 1 }, epoch: 1,
  getVaultState: vi.fn(), invalidate: vi.fn(), select: vi.fn(), add: vi.fn(), remove: vi.fn(), password: vi.fn(),
  feedback: vi.fn(), dismiss: vi.fn(), info: vi.fn(), outcomes: [] as string[],
  privacy: undefined as { generation: number; shielded: boolean; appIsActive: boolean } | undefined,
  privacyListeners: new Set<() => void>(),
}));
vi.mock("@/lib/capacitor/session-privacy", () => ({
  nativePrivacyObservation: () => ({ state: modelMocks.privacy }),
  subscribeNativePrivacyObservation: (listener: () => void) => {
    modelMocks.privacyListeners.add(listener); return () => modelMocks.privacyListeners.delete(listener);
  },
}));
vi.mock("@/lib/auth/session-owner", () => ({ snapshotValidatedAuthSessionOwner: () => modelMocks.owner,
  isValidatedAuthSessionOwnerCurrent: (owner: unknown) => owner === modelMocks.owner }));
vi.mock("@/lib/vault/session-epoch", () => ({ snapshotVaultSessionEpoch: () => modelMocks.epoch }));
vi.mock("@/lib/services/vault-method-service", () => ({ VaultMethodService: {
  getCapabilityMatrix: async () => ({ passphrase: true, generatedWebPrf: true, generatedNativeBiometric: false,
    recommendedMethod: "generated_default_web_prf" }),
  switchMethod: modelMocks.add, removeMethod: modelMocks.remove, changePassphrase: modelMocks.password,
} }));
vi.mock("@/lib/services/vault-bootstrap-service", () => ({ VaultBootstrapService: {
  getDeviceBiometricWrapperId: async () => null,
} }));
vi.mock("@/lib/services/vault-service", () => ({ VaultService: {
  getVaultState: modelMocks.getVaultState, invalidateVaultStateCache: modelMocks.invalidate,
  setPrimaryVaultMethod: modelMocks.select,
  getWrapperByMethod: (state: { wrappers: VaultWrapper[] }, method: string) => state.wrappers.find(wrapper => wrapper.method === method),
  getPrimaryWrapper: (state: { wrappers: VaultWrapper[]; primaryMethod: string }) => state.wrappers.find(wrapper => wrapper.method === state.primaryMethod),
} }));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: { info: modelMocks.info, dismiss: modelMocks.dismiss,
  promise: (operation: Promise<boolean>, labels: { isCurrent: () => boolean; success: string; error: string }) => {
    modelMocks.feedback(operation, labels);
    void operation.then(() => { if (labels.isCurrent()) modelMocks.outcomes.push("success"); },
      () => { if (labels.isCurrent()) modelMocks.outcomes.push("error"); });
    return "vault-method-feedback";
  },
} }));

import { VaultMethodsPanel } from "@/components/profile/vault-methods-panel";
import { useProfileVaultMethodsModel } from "@/components/profile/use-profile-vault-methods-model";
import type { VaultWrapper } from "@/lib/services/vault-service";

const passwordWrapper: VaultWrapper = { method: "passphrase", wrapperId: "default", encryptedVaultKey: "fixture", salt: "fixture", iv: "fixture" };
const passkeyWrapper: VaultWrapper = { ...passwordWrapper, method: "generated_default_web_prf", wrapperId: "fixture-passkey" };
const secondPasskeyWrapper: VaultWrapper = { ...passkeyWrapper, wrapperId: "fixture-second-passkey" };
const initialVault = { primaryMethod: "passphrase", primaryWrapperId: "default", wrappers: [passwordWrapper, passkeyWrapper, secondPasskeyWrapper] };
const modelPorts = { userId: "vault-method-owner", vaultKey: "fixture-memory-only-key", vaultOwnerToken: "fixture-memory-only-authority",
  hasVault: true, authLoading: false, canMutate: true, active: true, displayName: "Fixture", requestUnlock: vi.fn() };

describe("Vault methods privacy and mutation authority", () => {
  beforeEach(() => {
    for (const mock of [modelMocks.getVaultState, modelMocks.invalidate, modelMocks.select, modelMocks.add, modelMocks.remove,
      modelMocks.password, modelMocks.feedback, modelMocks.dismiss, modelMocks.info]) mock.mockReset();
    modelMocks.epoch = 1; modelMocks.outcomes = [];
    modelMocks.privacy = undefined; modelMocks.privacyListeners.clear();
    modelMocks.owner = { userId: "vault-method-owner", generation: 1 };
    modelMocks.getVaultState.mockResolvedValue(initialVault);
    modelMocks.select.mockResolvedValue(undefined);
    modelMocks.add.mockResolvedValue({ method: passkeyWrapper.method });
    modelMocks.remove.mockResolvedValue({ primaryMethod: "passphrase" });
  });
  it("keeps credential identifiers private and viewing methods cannot mutate them", () => {
    const make = (id: string): VaultWrapper => ({ method: "generated_default_web_prf", wrapperId: id,
      encryptedVaultKey: "synthetic-ciphertext", salt: "synthetic-salt", iv: "synthetic-iv",
      passkeyCredentialId: `credential-${id}`, passkeyDeviceLabel: "Browser passkey", passkeyRpId: "example.test" });
    const first = make("private-wrapper-first");
    const second = make("private-wrapper-second");
    const select = vi.fn(); const remove = vi.fn();
    const props = { wrappers: [first, second], primaryMethod: first.method, primaryWrapperId: first.wrapperId!,
      mutable: true, busy: false, needsRefresh: false, onSelect: select, onRemove: remove,
      onChangePassphrase: vi.fn(), onRefresh: vi.fn() };
    const view = render(createElement(VaultMethodsPanel, props));
    fireEvent.click(screen.getByRole("button", { name: "Browser passkey 2" }));
    const details = screen.getByRole("dialog");
    expect(document.body.innerHTML).not.toContain("private-wrapper");
    expect(document.body.innerHTML).not.toContain("credential-");
    expect(select).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(details).getByRole("button", { name: "Remove passkey" }));
    expect(remove).toHaveBeenCalledExactlyOnceWith(second);
    view.rerender(createElement(VaultMethodsPanel, { ...props, mutable: false }));
    fireEvent.click(screen.getByRole("button", { name: "Browser passkey 2" }));
    expect(screen.getByRole("button", { name: "Remove passkey" })).toBeDisabled();
    expect(select).not.toHaveBeenCalled(); expect(remove).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("scrubs cancelled password drafts and rejects cancelled removal and departed-visit callbacks", async () => {
    const view = renderHook(({ active }) => useProfileVaultMethodsModel({ ...modelPorts, active }), { initialProps: { active: true } });
    await waitFor(() => expect(view.result.current.owner).toBe(modelPorts.userId));
    act(() => view.result.current.openPassword());
    act(() => { view.result.current.editPassword("password", "synthetic secret"); view.result.current.editPassword("confirmation", "synthetic secret"); });
    const oldSave = view.result.current.savePassword;
    act(() => view.result.current.closePassword());
    expect(view.result.current.password).toBe(""); expect(view.result.current.confirmation).toBe("");
    act(() => view.result.current.openPassword());
    act(() => { view.result.current.editPassword("password", "different synthetic secret"); view.result.current.editPassword("confirmation", "different synthetic secret"); });
    await act(async () => oldSave());
    expect(modelMocks.password).not.toHaveBeenCalled();
    act(() => {
      modelMocks.privacy = { generation: 1, shielded: true, appIsActive: false };
      modelMocks.privacyListeners.forEach(listener => listener());
    });
    expect(view.result.current.password).toBe(""); expect(view.result.current.confirmation).toBe("");
    act(() => view.result.current.openPassword());
    expect(view.result.current.passphraseOpen).toBe(false);
    act(() => {
      modelMocks.privacy = { generation: 1, shielded: false, appIsActive: true };
      modelMocks.privacyListeners.forEach(listener => listener());
    });
    act(() => view.result.current.requestRemove(passkeyWrapper));
    const oldRemove = view.result.current.remove;
    act(() => view.result.current.cancelRemove());
    act(() => view.result.current.requestRemove(secondPasskeyWrapper));
    await act(async () => oldRemove());
    expect(modelMocks.remove).not.toHaveBeenCalled();
    act(() => view.result.current.cancelRemove());
    const oldSelect = view.result.current.select;
    view.rerender({ active: false }); view.rerender({ active: true });
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    await act(async () => oldSelect(passkeyWrapper));
    expect(modelMocks.select).not.toHaveBeenCalled();
    view.unmount();
  });

  it("exposes current-owner loading and refresh failure before the first successful read", async () => {
    let rejectRead!: (error: Error) => void;
    modelMocks.getVaultState.mockImplementationOnce(() => new Promise((_, reject) => { rejectRead = reject; }));
    const view = renderHook(() => useProfileVaultMethodsModel(modelPorts));
    await waitFor(() => expect(modelMocks.getVaultState).toHaveBeenCalledOnce());
    expect(view.result.current.loading).toBe(true);
    await act(async () => rejectRead(new Error("synthetic read failure")));
    expect(view.result.current.loading).toBe(false);
    expect(view.result.current.needsRefresh).toBe(true);
    expect(view.result.current.wrappers).toEqual([]);
    await act(async () => view.result.current.select(passkeyWrapper));
    expect(modelMocks.select).not.toHaveBeenCalled();
    view.unmount();
  });

  it("reconciles an uncertain write with a post-attempt fresh read without replaying the change", async () => {
    const view = renderHook(() => useProfileVaultMethodsModel(modelPorts));
    await waitFor(() => expect(view.result.current.owner).toBe(modelPorts.userId));
    let finishRead!: (value: typeof initialVault) => void;
    modelMocks.getVaultState.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    modelMocks.select.mockRejectedValueOnce(new Error("synthetic transport uncertainty"));
    await act(async () => view.result.current.select(passkeyWrapper));
    expect(view.result.current.needsRefresh).toBe(true);
    expect(modelMocks.invalidate).toHaveBeenCalledWith(modelPorts.userId);
    expect(modelMocks.getVaultState).toHaveBeenLastCalledWith(modelPorts.userId, { forceFresh: true });
    await act(async () => view.result.current.select(passkeyWrapper));
    expect(modelMocks.select).toHaveBeenCalledOnce();
    await act(async () => finishRead({ ...initialVault, primaryMethod: passkeyWrapper.method, primaryWrapperId: passkeyWrapper.wrapperId! }));
    expect(view.result.current.primaryMethod).toBe(passkeyWrapper.method);
    expect(view.result.current.needsRefresh).toBe(false);
    expect(modelMocks.select).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("keeps an acknowledged password change successful through its intentional vault lock and later failure", async () => {
    const view = renderHook(() => useProfileVaultMethodsModel(modelPorts));
    await waitFor(() => expect(view.result.current.owner).toBe(modelPorts.userId));
    act(() => view.result.current.openPassword());
    act(() => { view.result.current.editPassword("password", " synthetic secret "); view.result.current.editPassword("confirmation", " synthetic secret "); });
    modelMocks.password.mockImplementationOnce(async ({ onCommitted }: { onCommitted: (result: { primaryMethod: string }) => void }) => {
      onCommitted({ primaryMethod: "passphrase" }); modelMocks.epoch++;
      throw new Error("synthetic post-commit failure");
    });
    await act(async () => view.result.current.savePassword());
    expect(modelMocks.password).toHaveBeenCalledOnce();
    expect(modelMocks.password).toHaveBeenCalledWith(expect.objectContaining({ newPassphrase: " synthetic secret " }));
    expect(view.result.current.password).toBe(""); expect(view.result.current.confirmation).toBe("");
    expect(modelMocks.outcomes).toEqual(["success"]);
    view.unmount();
  });
});
