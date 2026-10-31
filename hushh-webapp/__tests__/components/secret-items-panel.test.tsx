import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SecretItemsPanel, type SecretPanelItem } from "@/components/secrets/secret-items-panel";
import { useSecretReveal } from "@/components/secrets/use-secret-reveal";
import { useSecretsListModel } from "@/components/secrets/use-secrets-list-model";
import { stageSecretOffer } from "@/lib/pkm/secret-offer-handoff";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import type { NativeSessionPrivacyState } from "@/lib/capacitor/session-privacy";

const revealFixture = vi.hoisted(() => ({ uid: "fixture-a", key: "fixture-key-a", authorized: true,
  reveal: vi.fn(), list: vi.fn(), remove: vi.fn(), mark: vi.fn(), file: vi.fn(),
  privacy: undefined as NativeSessionPrivacyState | undefined, listeners: new Set<() => void>() }));
function fixtureToken() { return revealFixture.authorized ? "fixture-owner" : null; }
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: revealFixture.uid }, userId: revealFixture.uid }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultKey: revealFixture.key, getVaultOwnerToken: fixtureToken }) }));
vi.mock("@/lib/capacitor/session-privacy", () => ({
  nativePrivacyObservation: () => ({ state: revealFixture.privacy }),
  subscribeNativePrivacyObservation: (listener: () => void) => { revealFixture.listeners.add(listener); return () => revealFixture.listeners.delete(listener); },
}));
vi.mock("@/lib/pkm/secrets-vault-service", () => ({ SecretsVaultService: {
  revealSecret: revealFixture.reveal, listSecrets: revealFixture.list, removeSecret: revealFixture.remove, markFiled: revealFixture.mark,
} }));
vi.mock("@/lib/services/kyc-identity-documents-service", () => ({ identityDocumentTypeFor: () => "passport", KycIdentityDocumentsService: { fileDocument: revealFixture.file } }));
afterEach(() => { cleanup(); publishValidatedAuthSessionOwner(null); vi.clearAllMocks(); });

/**
 * The secure Secrets card shows a value only for an unlocked vault, and puts it
 * on the clipboard only after a second, confirming tap.
 */

const VALUE = ["s", "k-proj-", "fakefake0000fakefake9f2a"].join("");
const ITEM: SecretPanelItem = {
  id: "sec_00000000000000a1",
  label: "openai API key ending 9f2a",
  kindLabel: "Key, token or password",
  offer: null,
  filedLabel: null,
};

function panel(overrides: Partial<Parameters<typeof SecretItemsPanel>[0]> = {}) {
  const props = {
    testId: "secret-capture-card",
    title: "Kept in Secrets",
    description: "One knows these only by name.",
    items: [ITEM],
    revealed: {},
    locked: false,
    onReveal: vi.fn(),
    onHide: vi.fn(),
    onUnlock: vi.fn(),
    ...overrides,
  };
  render(<SecretItemsPanel {...props} />);
  return props;
}

describe("SecretItemsPanel", () => {
  it("fences shared list/reveal/filing work across owner retirement and preserves committed removal", async () => {
    revealFixture.uid = "fixture-a"; revealFixture.key = "fixture-key-a"; revealFixture.authorized = true; revealFixture.privacy = undefined;
    publishValidatedAuthSessionOwner(revealFixture.uid);
    const item = { id: ITEM.id, label: "Synthetic passport", kind: "identity_number", patternId: "passport_number", fileTo: "kyc_identity_documents", offerNoun: "passport", createdAt: "2026-10-18", filedTo: null };
    let finish!: (value: unknown[]) => void;
    revealFixture.list.mockImplementationOnce(() => new Promise<unknown[]>(resolve => { finish = resolve; })).mockResolvedValue([]);
    const current = () => true;
    const hook = renderHook(({ active }) => useSecretsListModel({ active, native: false, current }), { initialProps: { active: true } });
    hook.rerender({ active: false });
    await act(async () => { finish([item]); });
    expect(hook.result.current.items).toEqual([]);
    revealFixture.list.mockResolvedValue([item]);
    await act(async () => { hook.rerender({ active: true }); });
    expect(hook.result.current.items).toHaveLength(1);
    act(() => { hook.result.current.askRemove(ITEM.id); });
    revealFixture.remove.mockResolvedValue(true);
    revealFixture.list.mockRejectedValue(new Error("refresh_failed"));
    await act(async () => { await hook.result.current.remove(); });
    expect(hook.result.current.items).toEqual([]);
    expect(hook.result.current.outcome).toBe("Removed from Secrets");
    expect(hook.result.current.failed).toBe(true);
    const guard = revealFixture.remove.mock.calls.at(-1)![0].beforeEffect;
    hook.rerender({ active: false });
    await expect(guard()).rejects.toThrow("secret_owner_retired");

    revealFixture.list.mockResolvedValue([item]);
    stageSecretOffer({ ownerUserId: revealFixture.uid, secretId: ITEM.id, fileTo: "kyc_identity_documents" });
    await act(async () => { hook.rerender({ active: true }); });
    let decrypt!: (value: string) => void;
    revealFixture.reveal.mockImplementationOnce(() => new Promise<string>(resolve => { decrypt = resolve; }));
    let pending!: Promise<void>;
    act(() => { pending = hook.result.current.file(); });
    hook.rerender({ active: false });
    await act(async () => { decrypt("SYNTHETIC_NUMBER"); await pending; });
    expect(revealFixture.file).not.toHaveBeenCalled();
    expect(revealFixture.mark).not.toHaveBeenCalled();
    revealFixture.reveal.mockResolvedValue("SYNTHETIC_NUMBER");
    revealFixture.file.mockResolvedValue({ success: true });
    revealFixture.mark.mockRejectedValue(new Error("bookkeeping_failed"));
    await act(async () => { hook.rerender({ active: true }); });
    await act(async () => { await hook.result.current.file(); });
    expect(hook.result.current.filing?.state).toBe("filed");
    act(() => { hook.result.current.dismissFiling(); hook.result.current.offer(ITEM.id); });
    await act(async () => { await hook.result.current.file(); });
    hook.rerender({ active: false });
    await act(async () => { hook.rerender({ active: true }); });
    act(() => { hook.result.current.offer(ITEM.id); });
    await act(async () => { await hook.result.current.file(); });
    expect(revealFixture.file).toHaveBeenCalledTimes(1);
    expect(hook.result.current.filing?.state).toBe("filed");
    hook.unmount();
    stageSecretOffer({ ownerUserId: revealFixture.uid, secretId: ITEM.id, fileTo: "kyc_identity_documents" });
    let commit!: (value: { success: boolean }) => void;
    revealFixture.file.mockImplementationOnce(() => new Promise<{ success: boolean }>(resolve => { commit = resolve; }));
    const resumed = renderHook(({ active }) => useSecretsListModel({ active, native: false, current }), { initialProps: { active: true } });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { pending = resumed.result.current.file(); await Promise.resolve(); });
    expect(resumed.result.current.pending).toBe(true);
    resumed.rerender({ active: false });
    await act(async () => { resumed.rerender({ active: true }); });
    expect(resumed.result.current.filing?.state).toBe("filing");
    await act(async () => { commit({ success: true }); await pending; });
    expect(resumed.result.current.filing?.state).toBe("filed");
    expect(resumed.result.current.pending).toBe(false);
  });
  it("rejects a reveal after vault/owner replacement or Hide, but permits the current owner", async () => {
    revealFixture.uid = "fixture-a"; revealFixture.key = "fixture-key-a"; revealFixture.authorized = true;
    publishValidatedAuthSessionOwner(revealFixture.uid);
    let finish!: (value: string) => void;
    revealFixture.reveal.mockImplementation(() => new Promise<string>(resolve => { finish = resolve; }));
    const { result, rerender } = renderHook(() => useSecretReveal());
    let pending!: Promise<void>;
    act(() => { pending = result.current.reveal(ITEM.id); });
    act(() => { advanceVaultSessionEpoch(); });
    await act(async () => { finish(VALUE); await pending; });
    expect(result.current.revealed).toEqual({});

    act(() => { pending = result.current.reveal(ITEM.id); });
    await act(async () => { finish(VALUE); await pending; });
    expect(result.current.revealed[ITEM.id]).toBe(VALUE);
    const retained = result.current.reveal;
    const retainedHide = result.current.hide;
    act(() => {
      revealFixture.uid = "fixture-b"; revealFixture.key = "fixture-key-b";
      publishValidatedAuthSessionOwner(revealFixture.uid); rerender();
    });
    expect(result.current.revealed).toEqual({});
    await act(async () => { await retained(ITEM.id); });
    expect(revealFixture.reveal).toHaveBeenCalledTimes(2);

    act(() => { pending = result.current.reveal(ITEM.id); });
    act(() => { retainedHide(ITEM.id); });
    await act(async () => { finish(VALUE); await pending; });
    expect(result.current.revealed[ITEM.id]).toBe(VALUE);
    act(() => { result.current.hide(ITEM.id); });

    act(() => { pending = result.current.reveal(ITEM.id); });
    act(() => { result.current.hide(ITEM.id); });
    await act(async () => { finish(VALUE); await pending; });
    expect(result.current.revealed).toEqual({});

    act(() => { pending = result.current.reveal(ITEM.id); });
    revealFixture.authorized = false;
    await act(async () => { finish(VALUE); await pending; });
    expect(result.current.revealed).toEqual({});
    revealFixture.authorized = true;

    act(() => { pending = result.current.reveal(ITEM.id); });
    act(() => {
      revealFixture.privacy = { shielded: true, generation: 1, appIsActive: false, cause: "inactive" };
      revealFixture.listeners.forEach(listener => listener());
    });
    await act(async () => { finish(VALUE); await pending; });
    expect(result.current.locked).toBe(true);
    expect(result.current.revealed).toEqual({});
    act(() => { revealFixture.privacy = undefined; revealFixture.listeners.forEach(listener => listener()); });

  });

  it("never shows a value while the vault is locked, and asks to unlock instead (negative control)", () => {
    const props = panel({ locked: true, revealed: { [ITEM.id]: VALUE } });
    expect(screen.queryByText(VALUE)).toBeNull();
    expect(screen.queryByTestId("secret-reveal")).toBeNull();
    fireEvent.click(screen.getByTestId("secret-unlock"));
    expect(props.onUnlock).toHaveBeenCalledTimes(1);
    expect(props.onReveal).not.toHaveBeenCalled();
  });

  it("shows the value an unlocked host decrypted, and copies it only on the second tap", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    panel({ revealed: { [ITEM.id]: VALUE } });
    expect(screen.getByTestId("secret-revealed-value").textContent).toBe(VALUE);

    const copy = screen.getByTestId("secret-copy");
    fireEvent.click(copy);
    expect(writeText).not.toHaveBeenCalled();
    expect(copy.getAttribute("data-copy-state")).toBe("confirm");
    fireEvent.click(copy);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(VALUE));
  });
});
