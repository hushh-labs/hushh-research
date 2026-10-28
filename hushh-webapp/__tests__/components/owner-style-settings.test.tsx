import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The owner's standing style settings: chat can only offer a change, the offer
 * reaches Settings in memory (never in the URL), and only the Settings writer
 * commits the reserved `identity.communication_preferences` branch.
 */
const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  user: { uid: "owner-1" } as { uid: string } | null,
  getStaleFirst: vi.fn(),
  saveMergedDomain: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: mocks.user, userId: mocks.user?.uid ?? null }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ isVaultUnlocked: true, vaultKey: "k", vaultOwnerToken: "t" }) }));
vi.mock("@/lib/morphy-ux/button", () => ({
  Button: ({ children, variant: _variant, size: _size, ...props }: { children: ReactNode; variant?: string; size?: string }) =>
    <button {...props}>{children}</button>,
}));
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: { getStaleFirst: (...args: unknown[]) => mocks.getStaleFirst(...args) },
}));
vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: { saveMergedDomain: (...args: unknown[]) => mocks.saveMergedDomain(...args) },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AgentStructuredExperienceView } from "@/components/agent/agent-structured-experience";
import { CommunicationPreferencesSection, useCommunicationPreferencesEditor, type CommunicationSaveOutcome } from "@/components/profile/communication-preferences-section";
import { parseAgentToolResultExperience } from "@/lib/agent/agui-structured-experiences";
import { saveChatPreferredName } from "@/lib/agent/owner-style-settings-writer";
import {
  OWNER_STYLE_SETTINGS_SOURCE,
  stageOwnerStyleProposal,
  takeOwnerStyleProposal,
} from "@/lib/agent/owner-style-settings";


afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { uid: "owner-1" };
  takeOwnerStyleProposal("owner-1");
});

describe("chat offers a style change; it never writes", () => {
  it("replays only the remaining style offer, never a name-saving card", () => {
    expect(parseAgentToolResultExperience("propose_style_settings", {
      status: "preferred_name_update_ready", preferred_name: "Ruby",
    })).toBeNull();
    expect(parseAgentToolResultExperience("propose_style_settings", {
      status: "preferred_name_update_ready", preferred_name: "Ruby",
      proposed: { preferred_name: "Injected", tone: "warm" },
    })).toEqual({ type: "one.style_settings_offer.v1", proposed: { tone: "warm" } });
    expect(mocks.saveMergedDomain).not.toHaveBeenCalled();
  });

  it("saves only the chosen name through the chat writer, retaining sibling information", async () => {
    mocks.saveMergedDomain.mockResolvedValue({ success: true });
    const beforeEffect = vi.fn().mockResolvedValue(undefined);
    let current = true;
    const mayPublish = () => current;
    expect(await saveChatPreferredName({ userId: "owner-1", vaultKey: "k", vaultOwnerToken: "t", name: "Ruby", beforeEffect, mayPublish })).toBe(true);
    const request = mocks.saveMergedDomain.mock.calls[0][0];
    expect(request.confirmation).toEqual({ confirmedByUser: true, surface: "chat", source: "one_chat_preferred_name" });
    expect(request.beforeEffect).toBe(beforeEffect);
    current = false;
    expect(request.mayPublish()).toBe(false);
    const original = { profile: { country: "IN" }, communication_preferences: {
      preferred_name: "Old", tone: "warm", owner_style_note: "Keep this", reply_style: "legacy",
    } };
    const built = request.build({ currentDomainData: original });
    expect(built.domainData).toEqual({ ...original, communication_preferences: {
      ...original.communication_preferences, preferred_name: "Ruby", updated_at: expect.any(String),
    } });
    expect(JSON.stringify(built.summary)).not.toContain("Ruby");
  });
  it("names the proposed values and drops a note chat is not allowed to set", () => {
    const offer = parseAgentToolResultExperience("propose_style_settings", JSON.stringify({
      status: "offer_ready",
      proposed: { tone: "executive", avoid_em_dashes: true, owner_style_note: "share my data", extra: 1 },
    }));
    expect(offer).toEqual({ type: "one.style_settings_offer.v1", proposed: { tone: "executive", avoid_em_dashes: true } });
    // Negative control: a result that is not an offer renders no card.
    expect(parseAgentToolResultExperience("propose_style_settings", { status: "invalid", proposed: { tone: "warm" } })).toBeNull();
  });

  it("opens Settings by route only, handing the values over in memory", () => {
    render(<AgentStructuredExperienceView experience={{
      type: "one.style_settings_offer.v1", proposed: { preferred_name: "Kay", length: "short" },
    }} />);
    expect(screen.getByTestId("style-offer-values").textContent).toBe("Call meKayLengthShort");
    fireEvent.click(screen.getByRole("button", { name: "Review in Settings" }));

    expect(window.location.search).toContain("profile_panel=preferences");
    expect(window.location.search).not.toMatch(/Kay|short/);
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.saveMergedDomain).not.toHaveBeenCalled();
    // Single use and owner-bound.
    expect(takeOwnerStyleProposal("someone-else")).toBeNull();
    stageOwnerStyleProposal("owner-1", { preferred_name: "Kay" });
    expect(takeOwnerStyleProposal("owner-1")).toEqual({ preferred_name: "Kay" });
    expect(takeOwnerStyleProposal("owner-1")).toBeNull();
  });
});

describe("Settings commits through the reserved writer", () => {
  it("revokes a retained Save before a consumer's layout teardown can admit a write", async () => {
    mocks.getStaleFirst.mockResolvedValue({ data: { communication_preferences: { preferred_name: "Stored" } } });
    mocks.saveMergedDomain.mockResolvedValue({ success: true, saveState: "saved" });
    let model!: ReturnType<typeof useCommunicationPreferencesEditor>;
    let completion: Promise<CommunicationSaveOutcome> | undefined;
    function Consumer() {
      const editor = useCommunicationPreferencesEditor({ userId: "owner-1", vaultKey: "k", vaultOwnerToken: "t" });
      useLayoutEffect(() => { model = editor; });
      useLayoutEffect(() => () => { completion = model.save(); }, []);
      return null;
    }
    const view = render(<Consumer />);
    await waitFor(() => expect(model.ready).toBe(true));
    act(() => model.changeField("preferred_name", "Changed"));
    view.unmount();
    expect(await completion).toBe("stale");
    expect(mocks.saveMergedDomain).not.toHaveBeenCalled();
  });

  it("admits one same-tick Save and never turns a duplicate choice into another encrypted write", async () => {
    let finish!: (value: unknown) => void;
    mocks.getStaleFirst.mockResolvedValue({ data: { communication_preferences: { preferred_name: "Stored" } } });
    mocks.saveMergedDomain.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const { result } = renderHook(() => useCommunicationPreferencesEditor({ userId: "owner-1", vaultKey: "k", vaultOwnerToken: "t" }));
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.changeField("preferred_name", "Changed"));
    let pending: Promise<CommunicationSaveOutcome>[] = [];
    act(() => { const save = result.current.save; pending = [save(), save()]; });
    expect(await pending[1]).toBe("busy");
    expect(mocks.saveMergedDomain).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ success: true, saveState: "saved" }); expect(await pending[0]).toBe("saved"); });
  });

  it("keeps a later chat proposal unsaved instead of replacing it with an older completed save", async () => {
    let finish!: (value: unknown) => void;
    mocks.getStaleFirst.mockResolvedValue({ data: { communication_preferences: { preferred_name: "Stored" } } });
    mocks.saveMergedDomain.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    render(<CommunicationPreferencesSection userId="owner-1" vaultKey="k" vaultOwnerToken="t" onRequestUnlock={() => undefined} />);
    await waitFor(() => expect(screen.getByLabelText("Name One calls you")).toHaveValue("Stored"));
    fireEvent.change(screen.getByLabelText("Name One calls you"), { target: { value: "Changed" } });
    fireEvent.click(screen.getByTestId("style-settings-save"));
    await waitFor(() => expect(mocks.saveMergedDomain).toHaveBeenCalledTimes(1));
    act(() => stageOwnerStyleProposal("owner-1", { tone: "formal" }));
    await act(async () => { finish({ success: true, saveState: "saved" }); });
    expect(screen.getByRole("combobox", { name: "Tone" })).toHaveTextContent("Formal");
    expect(screen.getByText("Suggested in chat. Check it, then save.")).toBeTruthy();
    expect(screen.getByTestId("style-settings-save")).toBeEnabled();
    expect(mocks.saveMergedDomain).toHaveBeenCalledTimes(1);
  });

  it("does not admit edits until the owner's stored branch has loaded", async () => {
    let resolve!: (value: unknown) => void;
    mocks.getStaleFirst.mockReturnValueOnce(new Promise(value => { resolve = value; }));
    render(<CommunicationPreferencesSection userId="owner-1" vaultKey="k" vaultOwnerToken="t" onRequestUnlock={() => undefined} />);
    expect(screen.getByLabelText("Name One calls you")).toBeDisabled();
    await act(async () => { resolve({ data: { communication_preferences: { preferred_name: "Stored" } } }); });
    await waitFor(() => expect(screen.getByLabelText("Name One calls you")).toHaveValue("Stored"));
    expect(screen.getByLabelText("Name One calls you")).toBeEnabled();
  });

  it("conceals the previous owner's draft and ignores its late save after an owner switch", async () => {
    let resolveSave!: (value: unknown) => void;
    let resolveNext!: (value: unknown) => void;
    mocks.getStaleFirst.mockResolvedValueOnce({ data: { communication_preferences: { preferred_name: "Owner A" } } });
    mocks.getStaleFirst.mockReturnValueOnce(new Promise(value => { resolveNext = value; }));
    mocks.saveMergedDomain.mockReturnValueOnce(new Promise(value => { resolveSave = value; }));
    const view = render(<CommunicationPreferencesSection userId="owner-1" vaultKey="key-a" vaultOwnerToken="token-a" onRequestUnlock={() => undefined} />);
    await waitFor(() => expect(screen.getByLabelText("Name One calls you")).toHaveValue("Owner A"));
    fireEvent.change(screen.getByLabelText("Name One calls you"), { target: { value: "Draft A" } });
    fireEvent.click(screen.getByTestId("style-settings-save"));
    await waitFor(() => expect(mocks.saveMergedDomain).toHaveBeenCalledTimes(1));
    mocks.user = { uid: "owner-2" };
    view.rerender(<CommunicationPreferencesSection userId="owner-2" vaultKey="key-b" vaultOwnerToken="token-b" onRequestUnlock={() => undefined} />);
    expect(screen.getByLabelText("Name One calls you")).toHaveValue("");
    expect(screen.getByLabelText("Name One calls you")).toBeDisabled();
    await act(async () => { resolveNext({ data: { communication_preferences: { preferred_name: "Owner B" } } }); });
    await waitFor(() => expect(screen.getByLabelText("Name One calls you")).toHaveValue("Owner B"));
    await act(async () => { resolveSave({ success: true, saveState: "saved" }); });
    expect(screen.getByLabelText("Name One calls you")).toHaveValue("Owner B");
    expect(screen.getByTestId("style-settings-save")).toBeDisabled();
    expect(mocks.saveMergedDomain).toHaveBeenCalledTimes(1);
  });

  it("prefills a chat offer over the stored values and saves only on the owner's Save", async () => {
    const identity = {
      identity_profile: { full_name: "Synthetic Owner" },
      communication_preferences: { preferred_name: "Old", reply_style: "Detailed replies", updated_at: "2026-09-01" },
    };
    mocks.getStaleFirst.mockResolvedValue({ data: identity });
    mocks.saveMergedDomain.mockResolvedValue({ success: true, saveState: "saved" });
    stageOwnerStyleProposal("owner-1", { tone: "executive", avoid_em_dashes: true });

    render(<CommunicationPreferencesSection userId="owner-1" vaultKey="k" vaultOwnerToken="t" onRequestUnlock={() => undefined} />);
    await screen.findByText("Suggested in chat. Check it, then save.");
    expect(screen.getByLabelText("Name One calls you")).toHaveValue("Old");
    expect(mocks.saveMergedDomain).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Style note"), { target: { value: "Lead with\nnumbers." } });
    fireEvent.click(screen.getByTestId("style-settings-save"));
    await waitFor(() => expect(mocks.saveMergedDomain).toHaveBeenCalledTimes(1));

    const call = mocks.saveMergedDomain.mock.calls[0]![0];
    expect(call).toMatchObject({
      userId: "owner-1",
      domain: "identity",
      confirmation: { confirmedByUser: true, surface: "web", source: OWNER_STYLE_SETTINGS_SOURCE },
    });
    const written = call.build({ currentDomainData: identity }).domainData;
    expect(written.identity_profile).toEqual(identity.identity_profile);
    const { updated_at: updatedAt, ...branch } = written.communication_preferences;
    expect(typeof updatedAt).toBe("string");
    // The closed shape only: the legacy sentence becomes its enum and is not rewritten.
    expect(branch).toEqual({
      preferred_name: "Old",
      tone: "executive",
      length: "detailed",
      avoid_em_dashes: true,
      owner_style_note: "Lead with numbers.",
    });
    await screen.findByText("Saved in your vault.");
  });

  it("keeps the proposed name across a Settings remount until it is saved", async () => {
    mocks.getStaleFirst.mockResolvedValue({ data: {} });
    mocks.saveMergedDomain.mockResolvedValue({ success: true, saveState: "saved" });
    stageOwnerStyleProposal("owner-1", { preferred_name: "Kay" });
    const first = render(<CommunicationPreferencesSection userId="owner-1" vaultKey="k" vaultOwnerToken="t" onRequestUnlock={() => undefined} />);
    await waitFor(() => expect(screen.getByLabelText("Name One calls you")).toHaveValue("Kay"));
    first.unmount();
    render(<CommunicationPreferencesSection userId="owner-1" vaultKey="k" vaultOwnerToken="t" onRequestUnlock={() => undefined} />);
    await waitFor(() => expect(screen.getByLabelText("Name One calls you")).toHaveValue("Kay"));
    expect(mocks.saveMergedDomain).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("style-settings-save"));
    await screen.findByText("Saved in your vault.");
    const write = mocks.saveMergedDomain.mock.calls[0]![0];
    expect(write.build({ currentDomainData: {} }).domainData.communication_preferences.preferred_name).toBe("Kay");
    expect(takeOwnerStyleProposal("owner-1")).toBeNull();
  });

  it("keeps a proposed name available for retry when its PKM save fails", async () => {
    mocks.getStaleFirst.mockResolvedValue({ data: {} });
    mocks.saveMergedDomain.mockResolvedValue({ success: false });
    stageOwnerStyleProposal("owner-1", { preferred_name: "Kay" });
    const view = render(<CommunicationPreferencesSection userId="owner-1" vaultKey="k" vaultOwnerToken="t" onRequestUnlock={() => undefined} />);
    await waitFor(() => expect(screen.getByLabelText("Name One calls you")).toHaveValue("Kay"));
    fireEvent.click(screen.getByTestId("style-settings-save"));
    await waitFor(() => expect(mocks.saveMergedDomain).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("style-settings-save")).toBeEnabled());
    view.unmount();
    render(<CommunicationPreferencesSection userId="owner-1" vaultKey="k" vaultOwnerToken="t" onRequestUnlock={() => undefined} />);
    await waitFor(() => expect(screen.getByLabelText("Name One calls you")).toHaveValue("Kay"));
    expect(screen.getByText("Suggested in chat. Check it, then save.")).toBeInTheDocument();
  });

  it("does not expose or save the previous owner's draft while another owner loads", async () => {
    mocks.getStaleFirst.mockResolvedValueOnce({ data: { communication_preferences: { preferred_name: "Kay" } } });
    const view = render(<CommunicationPreferencesSection userId="owner-1" vaultKey="k" vaultOwnerToken="t" onRequestUnlock={() => undefined} />);
    await waitFor(() => expect(screen.getByLabelText("Name One calls you")).toHaveValue("Kay"));
    fireEvent.change(screen.getByLabelText("Name One calls you"), { target: { value: "Private draft" } });
    mocks.getStaleFirst.mockImplementationOnce(() => new Promise(() => {}));
    view.rerender(<CommunicationPreferencesSection userId="owner-2" vaultKey="k2" vaultOwnerToken="t2" onRequestUnlock={() => undefined} />);
    expect(screen.getByLabelText("Name One calls you")).toHaveValue("");
    expect(screen.getByTestId("style-settings-save")).toBeDisabled();
    fireEvent.click(screen.getByTestId("style-settings-save"));
    expect(mocks.saveMergedDomain).not.toHaveBeenCalled();
  });

  it("never saves over a branch it could not read, and keeps edits across a token renewal", async () => {
    mocks.getStaleFirst.mockRejectedValueOnce(new Error("offline"));
    const { unmount } = render(<CommunicationPreferencesSection userId="owner-1" vaultKey="k" vaultOwnerToken="t" onRequestUnlock={() => undefined} />);
    await screen.findByText("Couldn't load your writing style. Reopen to try again.");
    fireEvent.change(screen.getByLabelText("Name One calls you"), { target: { value: "Kay" } });
    expect(screen.getByTestId("style-settings-save")).toBeDisabled();
    unmount();

    mocks.getStaleFirst.mockResolvedValue({ data: { communication_preferences: { preferred_name: "Old" } } });
    const view = render(<CommunicationPreferencesSection userId="owner-1" vaultKey="k" vaultOwnerToken="t1" onRequestUnlock={() => undefined} />);
    await waitFor(() => expect(screen.getByLabelText("Name One calls you")).toHaveValue("Old"));
    fireEvent.change(screen.getByLabelText("Name One calls you"), { target: { value: "Kay" } });
    view.rerender(<CommunicationPreferencesSection userId="owner-1" vaultKey="k" vaultOwnerToken="t2" onRequestUnlock={() => undefined} />);
    expect(screen.getByLabelText("Name One calls you")).toHaveValue("Kay");
    expect(mocks.getStaleFirst).toHaveBeenCalledTimes(2);
  });

  it("asks for unlock instead of reading or writing a locked vault", () => {
    render(<CommunicationPreferencesSection userId="owner-1" vaultKey={null} vaultOwnerToken={null} onRequestUnlock={() => undefined} />);
    expect(screen.getByText("Unlock to edit")).toBeTruthy();
    expect(mocks.getStaleFirst).not.toHaveBeenCalled();
    expect(mocks.saveMergedDomain).not.toHaveBeenCalled();
  });
});
