import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import type { AgentPkmPreviewCard } from "@/lib/agent/agent-pkm-memory";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), write: vi.fn(), context: vi.fn(), clear: vi.fn(), duplicate: vi.fn(), load: vi.fn() }));
vi.mock("@/lib/pkm/pkm-natural-language-ingestion", () => ({ prepareNaturalLanguagePkm: mocks.prepare }));
vi.mock("@/lib/profile/pkm-agent-lab-capture", () => ({ loadPkmAgentLabContext: mocks.context }));
vi.mock("@/lib/agent/agent-pkm-context-store", () => ({ AgentPkmContextStore: { findLocalDuplicate: mocks.duplicate, load: mocks.load } }));
vi.mock("@/lib/agent/agent-pkm-memory", async original => ({
  ...(await original<typeof import("@/lib/agent/agent-pkm-memory")>()), addToPKM: mocks.write, clearAgentPkmContext: mocks.clear,
}));
import { canReviewDriveMemory, DriveReadMemoryAction } from "@/components/agent/drive-read-memory-action";
const answer = "The team agreed to ship the Android SDK in October. Priya owns the SDK launch. [drive:1]";
const card = (id: string, source: string, recipients = 0): AgentPkmPreviewCard => ({
  card_id: id, source_text: source, write_mode: "confirm_first", target_domain: "professional", primary_json_path: `projects.sdk.${id}`,
  ...(recipients ? { sharing_impact: { active_recipient_count: recipients, recipient_labels: ["Alex"], enters_next_export_revision: true,
    summary: "This changes memory you already share with Alex.", affected_grant_ids: ["grant"], affected_export_ids: [] } } : {}),
});
const prepared = (cards = [card("launch", "The SDK launch is planned for October."), card("owner", "Priya owns the SDK launch.")]) => ({ cards, sourceCoverage: [] });
const props = { ownerId: "owner-a", vaultKey: "key-a", vaultOwnerToken: "token-a", answer, scopeId: "chat-a:answer-1",
  getCurrentToken: () => "token-a", isScopeCurrent: () => true };
const deferred = <T,>() => { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) }; };
beforeEach(() => {
  vi.clearAllMocks(); publishValidatedAuthSessionOwner("owner-a"); window.localStorage.clear();
  mocks.context.mockResolvedValue({ metadata: { domains: [{ key: "professional" }] }, manifests: {} });
  mocks.load.mockResolvedValue(null);
  mocks.prepare.mockResolvedValue(prepared()); mocks.write.mockResolvedValue({ attempted: 1, saved: 1, failed: 0, domains: ["professional"], results: [] });
});
afterEach(() => { cleanup(); publishValidatedAuthSessionOwner(null); });

describe("consented Drive answer memory", () => {
  it("offers review only for a settled, cited Drive content read; metadata and mixed Mail answers are excluded", () => {
    const read = { type: "one.connector_read.v1", connector: "drive", status: "ok", metadataOnly: false, sourceRefs: ["drive:1"], truncated: false };
    expect(canReviewDriveMemory("done", answer, [read])).toBe(true);
    for (const variant of [ { ...read, metadataOnly: true }, { ...read, status: "unavailable" }, { ...read, sourceRefs: [] }, { type: read.type } ])
      expect(canReviewDriveMemory("done", answer, [variant])).toBe(false);
    expect(canReviewDriveMemory("streaming", answer, [read])).toBe(false);
    expect(canReviewDriveMemory("done", "", [read])).toBe(false);
    expect(canReviewDriveMemory("done", answer, [read, { ...read, connector: "mail" }])).toBe(false);
  });

  it("prepares only after a tap, shows notes, and writes only the reviewed selection after a second explicit tap", async () => {
    render(<DriveReadMemoryAction {...props} />);
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save to memory" }));
    await screen.findByText("The SDK launch is planned for October.");
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.prepare.mock.calls[0][0]).toMatchObject({ message: answer, source: "drive_read_review", allowEmpty: true });
    expect(mocks.prepare.mock.calls[0][0]).toHaveProperty("findDuplicate", expect.any(Function));
    expect(mocks.load).toHaveBeenCalledWith({ userId: "owner-a", vaultKey: "key-a", vaultOwnerToken: "token-a" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep: Priya owns the SDK launch." }));
    fireEvent.click(screen.getByRole("button", { name: "Save 1 of 2" }));
    await screen.findByText("1 note saved to memory.");
    expect(mocks.write).toHaveBeenCalledTimes(1);
    const write = mocks.write.mock.calls[0][0];
    expect(write.cards.map((item: AgentPkmPreviewCard) => item.card_id)).toEqual(["launch"]);
    expect(write).toMatchObject({ vaultKey: "key-a", sourceMessage: answer, source: "drive_read_review",
      confirmation: { confirmedByUser: true, surface: "chat", source: "drive_read_review", sharingImpactAcknowledged: false } });
    expect(write.beforeEffect).toEqual(expect.any(Function)); expect(write.mayPublish()).toBe(true);
    expect(window.localStorage.length).toBe(0);
  });

  it("requires a separate sharing acknowledgment and Cancel writes nothing", async () => {
    mocks.prepare.mockResolvedValue(prepared([card("owner", "Priya owns the SDK launch.", 1)]));
    render(<DriveReadMemoryAction {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Save to memory" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save all 1" }));
    expect(await screen.findByRole("alertdialog", { name: "Update shared memory?" })).toBeTruthy();
    expect(mocks.write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel", exact: true }));
    expect(mocks.write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save all 1" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save and update sharing" }));
    await screen.findByText("1 note saved to memory.");
    expect(mocks.write.mock.calls[0][0].confirmation.sharingImpactAcknowledged).toBe(true);
  });

  it.each(["cancel", "unmount", "owner", "vault", "token", "conversation"])("discards late preparation after %s without writing or publishing notes", async cause => {
    const pending = deferred<ReturnType<typeof prepared>>(); mocks.prepare.mockReturnValue(pending.promise);
    let token = "token-a"; let sameChat = true;
    const root = render(<DriveReadMemoryAction {...props} getCurrentToken={() => token} isScopeCurrent={() => sameChat} />);
    fireEvent.click(screen.getByRole("button", { name: "Save to memory" }));
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledTimes(1));
    if (cause === "cancel") fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    if (cause === "unmount") root.unmount();
    if (cause === "owner") publishValidatedAuthSessionOwner("owner-b");
    if (cause === "vault") advanceVaultSessionEpoch();
    if (cause === "token") token = "token-b";
    if (cause === "conversation") sameChat = false;
    await act(async () => { pending.resolve(prepared()); });
    expect(mocks.write).not.toHaveBeenCalled();
    expect(screen.queryByText("The SDK launch is planned for October.")).toBeNull();
    expect(mocks.prepare.mock.calls[0][0].isEffectCurrent()).toBe(false);
  });

  it("does not republish an accepted old-session save receipt or clear replacement-session context", async () => {
    const pending = deferred<{ saved: number; failed: number }>(); mocks.write.mockReturnValue(pending.promise);
    const root = render(<DriveReadMemoryAction {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Save to memory" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save all 2" }));
    await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(1));
    const write = mocks.write.mock.calls[0][0];
    root.unmount(); publishValidatedAuthSessionOwner("owner-b");
    await act(async () => { pending.resolve({ saved: 2, failed: 0 }); });
    expect(write.mayPublish()).toBe(false);
    await expect(write.beforeEffect()).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(screen.queryByText(/saved to memory/)).toBeNull();
  });

  it.each(["owner", "token"])("stops after inventory hydration if the %s changes", async cause => {
    const pending = deferred<null>(); mocks.load.mockReturnValue(pending.promise);
    let token = "token-a";
    render(<DriveReadMemoryAction {...props} getCurrentToken={() => token} />);
    fireEvent.click(screen.getByRole("button", { name: "Save to memory" }));
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(1));
    if (cause === "owner") publishValidatedAuthSessionOwner("owner-b");
    else token = "token-b";
    await act(async () => { pending.resolve(null); });
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(screen.queryByText("The SDK launch is planned for October.")).toBeNull();
  });

  it("reuses duplicate-aware preparation after refresh and never blindly repeats a save", async () => {
    const first = render(<DriveReadMemoryAction {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Save to memory" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save all 2" }));
    await screen.findByText("1 note saved to memory."); first.unmount();
    mocks.prepare.mockResolvedValue({ cards: [], sourceCoverage: [{ disposition: "intentionally_ignored", duplicateCount: 2 }] });
    render(<DriveReadMemoryAction {...props} />);
    expect(mocks.write).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Save to memory" }));
    await screen.findByText("Nothing new to save from this answer.");
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });

  it("filters reserved and degraded proposals and reports incomplete preparation honestly", async () => {
    mocks.prepare.mockResolvedValue({ cards: [card("launch", "The SDK launch is planned for October."),
      { ...card("secret", "Secret diagnostic"), preview_degraded: true }, { ...card("skip", "Never keep"), write_mode: "do_not_save" }],
      sourceCoverage: [{ disposition: "failed", preparationIssue: "preparation_timeout" }] });
    render(<DriveReadMemoryAction {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Save to memory" }));
    await screen.findByText("Some notes could not be prepared. Only the notes you review here can be saved.");
    expect(screen.queryByText("Secret diagnostic")).toBeNull(); expect(screen.queryByText("Never keep")).toBeNull();
    expect(screen.getByRole("button", { name: "Save all 1" })).toBeTruthy();
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
