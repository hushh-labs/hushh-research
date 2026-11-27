import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SecretItemsPanel, type SecretPanelItem } from "@/components/secrets/secret-items-panel";
import { useSecretReveal } from "@/components/secrets/use-secret-reveal";
import { useSecretsListModel } from "@/components/secrets/use-secrets-list-model";
import { useWebsiteLogins } from "@/components/secrets/use-website-logins";
import { WebsiteLoginsWorkspace } from "@/components/secrets/website-logins-workspace";
import { unwindBackLayer } from "@/lib/navigation/back-layers";
import { WebsiteLoginEditor } from "@/components/secrets/website-login-editor";
import { stageSecretOffer } from "@/lib/pkm/secret-offer-handoff";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import type { NativeSessionPrivacyState } from "@/lib/capacitor/session-privacy";
import { ApiService } from "@/lib/services/api-service";

const paneFixture = vi.hoisted(() => ({ open: false }));
vi.mock("next/navigation", () => ({ usePathname: () => "/one", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/navigation/use-profile-pane-presentation", () => ({ useProfilePanePresentation: () => paneFixture.open ? { open: true } : null }));

const revealFixture = vi.hoisted(() => ({ uid: "fixture-a", key: "fixture-key-a", authorized: true,
  reveal: vi.fn(), list: vi.fn(), remove: vi.fn(), mark: vi.fn(), file: vi.fn(),
  privacy: undefined as NativeSessionPrivacyState | undefined, listeners: new Set<() => void>() }));
const credentialFixture = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), remove: vi.fn(), reveal: vi.fn(), rotate: vi.fn(), custody: vi.fn() }));
function fixtureToken() { return revealFixture.authorized ? "fixture-owner" : null; }
function fixtureKey() { return revealFixture.key; }
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: revealFixture.uid }, userId: revealFixture.uid }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultKey: revealFixture.key, getVaultKey: fixtureKey, getVaultOwnerToken: fixtureToken }) }));
vi.mock("@/lib/capacitor/session-privacy", () => ({
  nativePrivacyObservation: () => ({ state: revealFixture.privacy }),
  subscribeNativePrivacyObservation: (listener: () => void) => { revealFixture.listeners.add(listener); return () => revealFixture.listeners.delete(listener); },
}));
vi.mock("@/lib/pkm/secrets-vault-service", () => ({ SecretsVaultService: {
  listWebsiteLogins: credentialFixture.list, saveWebsiteLogin: credentialFixture.save, removeWebsiteLogin: credentialFixture.remove, readWebsiteLogin: credentialFixture.reveal, importLegacyWebsiteLogins: vi.fn(),
  revealSecret: revealFixture.reveal, listSecrets: revealFixture.list, removeSecret: revealFixture.remove, markFiled: revealFixture.mark,
} }));
vi.mock("@/lib/services/kyc-identity-documents-service", () => ({ identityDocumentTypeFor: () => "passport", KycIdentityDocumentsService: { fileDocument: revealFixture.file } }));
afterEach(() => { paneFixture.open = false; cleanup(); publishValidatedAuthSessionOwner(null); vi.restoreAllMocks(); vi.clearAllMocks(); });

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
  const browserLogin = { id: "sec_" + "a".repeat(16), label: "Synthetic portal", boundOrigins: ["https://portal.example.com"],
    staySignedInEnabled: false, revision: 1, updatedAt: "2026-11-26" };
  const forgotten = { fenced: true, persisted: true, deletion_requested: true, physical_deletion: "subject_to_cloud_retention", remote_logout: false };
  function browserForgetFixture() {
    revealFixture.uid = "fixture-a"; revealFixture.key = "fixture-key-a"; revealFixture.authorized = true; revealFixture.privacy = undefined;
    publishValidatedAuthSessionOwner(revealFixture.uid);
    credentialFixture.list.mockResolvedValue([browserLogin]);
    const admission = vi.spyOn(ApiService, "getComputerUseAdmission").mockResolvedValue({ ownerId: "fixture-a", podId: "ha1_fixture", environment: "uat" });
    const request = vi.spyOn(ApiService, "ownerPodRequest").mockImplementation(async () => Response.json(forgotten));
    return { admission, request };
  }
  it("forgets only selected origins from Secrets without revealing or starting Browser, and retries an incomplete receipt honestly", async () => {
    const { request } = browserForgetFixture();
    request.mockResolvedValueOnce(Response.json({ ...forgotten, deletion_requested: false }));
    render(<WebsiteLoginsWorkspace />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Forget browser sign-in" }));
    await vi.waitFor(() => expect(screen.getByText(/Browser sign-in removal is incomplete/)).toBeTruthy());
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]).toEqual(["browser/sessions/forget", expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal),
      body: JSON.stringify({ sec_id: browserLogin.id, origins: browserLogin.boundOrigins }) }), false, undefined, "ha1_fixture", expect.any(Function)]);
    expect(credentialFixture.reveal).not.toHaveBeenCalled(); expect(credentialFixture.save).not.toHaveBeenCalled(); expect(credentialFixture.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Forget browser sign-in" }));
    await vi.waitFor(() => expect(screen.getByText(/Forgot browser sign-in for these origins/)).toBeTruthy());
    expect(request).toHaveBeenCalledTimes(2);
    expect(screen.getByText(browserLogin.label)).toBeTruthy();
    expect(screen.getByText(/Website sign-out is not confirmed; cloud retention may apply/)).toBeTruthy();
    request.mockResolvedValueOnce(Response.json({ ...forgotten, unverified: true }));
    fireEvent.click(screen.getByRole("button", { name: "Forget browser sign-in" }));
    await vi.waitFor(() => expect(screen.getByText(/Browser sign-in removal was not confirmed/)).toBeTruthy());
    expect(screen.queryByText(/Forgot browser sign-in for these origins/)).toBeNull();
  });
  it("refuses changed saved-login origins before Browser cleanup without opening secret fields", async () => {
    const { admission, request } = browserForgetFixture();
    const hook = renderHook(() => useWebsiteLogins()); await act(async () => {});
    credentialFixture.list.mockResolvedValueOnce([{ ...browserLogin, boundOrigins: ["https://changed.example.com"], revision: 2 }]);
    await act(async () => { expect(await hook.result.current.forgetBrowserSignIn(browserLogin)).toBe(false); });
    expect(admission).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
    expect(credentialFixture.reveal).not.toHaveBeenCalled();
    expect(hook.result.current.message).toBe("This saved login changed. Refresh before forgetting its browser sign-in.");
  });
  it.each(["owner", "vault"])("retires Forget before dispatch and after its receipt when the %s changes", async retirement => {
    const { admission, request } = browserForgetFixture();
    const retire = () => {
      if (retirement === "owner") { revealFixture.uid = "fixture-b"; publishValidatedAuthSessionOwner(revealFixture.uid); }
      else { revealFixture.authorized = false; advanceVaultSessionEpoch(); }
    };
    let finishAdmission!: (value: Awaited<ReturnType<typeof ApiService.getComputerUseAdmission>>) => void;
    admission.mockImplementationOnce(() => new Promise(resolve => { finishAdmission = resolve; }));
    const hook = renderHook(() => useWebsiteLogins()); await act(async () => {});
    let pending!: Promise<boolean>;
    act(() => { pending = hook.result.current.forgetBrowserSignIn(browserLogin); });
    await vi.waitFor(() => expect(admission).toHaveBeenCalledOnce());
    act(() => { retire(); hook.rerender(); });
    await act(async () => { finishAdmission({ ownerId: "fixture-a", podId: "ha1_fixture", environment: "uat" }); await pending; });
    expect(await pending).toBe(false); expect(request).not.toHaveBeenCalled();
    expect(hook.result.current.message).toBeNull(); hook.unmount();

    revealFixture.uid = "fixture-a"; revealFixture.authorized = true; publishValidatedAuthSessionOwner(revealFixture.uid); advanceVaultSessionEpoch();
    let finishRequest!: (value: Response) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { finishRequest = resolve; }));
    const currentHook = renderHook(() => useWebsiteLogins()); await act(async () => {});
    act(() => { pending = currentHook.result.current.forgetBrowserSignIn(browserLogin); });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const guard = request.mock.calls[0]![5]!;
    act(() => { retire(); currentHook.rerender(); });
    expect(guard()).toBe(false); expect(request.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    await act(async () => { finishRequest(Response.json(forgotten)); await pending; });
    expect(await pending).toBe(false); expect(currentHook.result.current.message).toBeNull();
    currentHook.unmount();
  });
  it("preserves existing credential fields when editing only the private notes", async () => {
    const initial = { label: "Synthetic account", boundOrigins: ["https://example.com"], username: "synthetic-owner",
      password: "SYNTHETIC_PASSWORD", totpSecret: "JBSWY3DPEHPK3PXP", notes: "before", staySignedInEnabled: false };
    const save = vi.fn(async () => {});
    render(<WebsiteLoginEditor initial={initial} busy={false} disabled={false} onSave={save} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Private notes (optional)"), { target: { value: "after" } });
    fireEvent.submit(screen.getByRole("form", { name: "Edit website login" }));
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith({ ...initial, notes: "after" }));
  });
  it("retires website login reads and secret edits with their exact owner presentation", async () => {
    revealFixture.uid = "fixture-a"; revealFixture.key = "fixture-key-a"; revealFixture.authorized = true; revealFixture.privacy = undefined;
    publishValidatedAuthSessionOwner(revealFixture.uid);
    const item = { id: "sec_" + "a".repeat(16), label: "Synthetic portal", boundOrigins: ["https://portal.example.com"], staySignedInEnabled: false, revision: 1, updatedAt: "2026-11-26" };
    credentialFixture.list.mockResolvedValue([item]);
    let finish!: (value: unknown) => void;
    credentialFixture.reveal.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const hook = renderHook(() => useWebsiteLogins());
    await act(async () => {});
    expect(hook.result.current.items).toEqual([item]);
    let pending!: Promise<unknown>;
    act(() => { pending = hook.result.current.reveal(item); });
    act(() => { revealFixture.uid = "fixture-b"; publishValidatedAuthSessionOwner(revealFixture.uid); hook.rerender(); });
    await act(async () => { finish({ password: "synthetic-private-value" }); });
    expect(await pending).toBeNull();
    const before = credentialFixture.save.mock.calls.length;
    revealFixture.authorized = false;
    await act(async () => { hook.rerender(); });
    expect(hook.result.current.locked).toBe(true);
    await act(async () => { expect(await hook.result.current.save({ label: "Synthetic portal", boundOrigins: item.boundOrigins,
      username: "synthetic-user", password: "synthetic-password", staySignedInEnabled: false })).toBe(false); });
    expect(credentialFixture.save).toHaveBeenCalledTimes(before);
  });

  it("keeps an uncertain save blocked until a successful authoritative refresh", async () => {
    revealFixture.uid = "fixture-a"; revealFixture.key = "fixture-key-a"; revealFixture.authorized = true; revealFixture.privacy = undefined;
    publishValidatedAuthSessionOwner(revealFixture.uid);
    credentialFixture.list.mockResolvedValue([]);
    credentialFixture.save.mockResolvedValueOnce(false);
    const hook = renderHook(() => useWebsiteLogins());
    await act(async () => {});
    await act(async () => { expect(await hook.result.current.save({ label: "Synthetic portal", boundOrigins: ["https://portal.example.com"],
      username: "synthetic-user", password: "synthetic-password", staySignedInEnabled: false })).toBe(false); });
    expect(hook.result.current.uncertain).toBe(true);
    credentialFixture.list.mockRejectedValueOnce(new Error("authority_unavailable"));
    await act(async () => { await hook.result.current.refresh(); });
    expect(hook.result.current.uncertain).toBe(true);
    await act(async () => { await hook.result.current.refresh(); });
    expect(hook.result.current.uncertain).toBe(false);
  });
  it("unwinds the canonical Secrets editor and sharing inside the current Profile pane", async () => {
    revealFixture.uid = "fixture-a"; revealFixture.key = "fixture-key-a"; revealFixture.authorized = true; revealFixture.privacy = undefined;
    publishValidatedAuthSessionOwner(revealFixture.uid); paneFixture.open = true;
    credentialFixture.list.mockResolvedValue([{ id: "sec_" + "a".repeat(16), label: "Synthetic portal", boundOrigins: ["https://example.com"],
      revision: 1, updatedAt: "2026-11-26", staySignedInEnabled: false }]);
    render(<WebsiteLoginsWorkspace />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Add website login" }));
    expect(screen.getByRole("form", { name: "Add website login" })).toBeTruthy();
    act(() => { expect(unwindBackLayer("/one", new URLSearchParams("profile_pane=1"), { profile_pane: "1" })).toBe(true); });
    expect(screen.queryByRole("form", { name: "Add website login" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(screen.getByRole("region", { name: "Share saved website login" })).toBeTruthy();
    await act(async () => { expect(unwindBackLayer("/one", new URLSearchParams("profile_pane=1"), { profile_pane: "1" })).toBe(true); });
    expect(screen.queryByRole("region", { name: "Share saved website login" })).toBeNull();
    expect(credentialFixture.save).not.toHaveBeenCalled();
  });
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
