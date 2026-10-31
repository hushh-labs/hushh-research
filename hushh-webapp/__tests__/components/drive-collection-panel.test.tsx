import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  uid: "owner",
  token: "private-token",
  unlocked: true,
  collection: vi.fn(),
  setProcessing: vi.fn(),
  groups: vi.fn(), files: vi.fn(), groupProcessing: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: state.uid }, userId: state.uid }) }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: state.token, isVaultUnlocked: state.unlocked }),
}));
vi.mock("@/lib/services/drive-packet-service", () => ({
  DrivePacketService: { collection: state.collection, setProcessing: state.setProcessing },
}));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: {} }));
vi.mock("next/navigation", () => ({ usePathname: () => "/one/profile" }));
vi.mock("@/lib/services/drive-group-service", () => ({ DriveGroupService: {
  overview: state.groups, files: state.files, setProcessing: state.groupProcessing,
} }));
// The packet list under the row has its own tests; this file is the switch row.
vi.mock("@/components/consent/drive-packet-catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/consent/drive-packet-catalog")>()),
  DrivePacketCatalog: () => null,
}));

import { DriveCollectionPanel } from "@/components/agent/drive-collection-panel";
import { DriveDataPacketsView, useDriveDataPackets } from "@/components/agent/drive-data-packets";
import { unwindBackLayer } from "@/lib/navigation/back-layers";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";

const status = {
  enabled: false, backgroundEnabled: true, state: "not_enabled", revision: 0,
  counts: { discovered: 12, extracted: 0, indexed: 0, failed: 0, pending: 12 },
  initialStartedAt: null, initialCompletedAt: null, lastSyncedAt: null, lastIndexedAt: null,
  initialIndexingDurationMs: null, initialExtractionCompletedAt: null, lastExtractedAt: null,
  initialExtractionDurationMs: null, lastSemanticIndexingDurationMs: null,
  lastDocumentExtractionDurationMs: null, syncDurationMs: 2000,
};

const ON = {
  indexing: "Agent One is preparing your packets.",
  ready: "Your packets are up to date.",
  incomplete: "Some files need another attempt.",
  unable_to_verify: "Can’t check Drive right now.",
} as const;
const OFF = "Agent One won’t prepare new packets.";

/** The caption under "Prepare packets", read from the row itself. */
const caption = () =>
  screen
    .getByText("Prepare packets", { selector: '[data-slot="settings-row-title"]' })
    .closest("[data-row-layout]")
    ?.querySelector('[data-slot="settings-row-description"]')?.textContent;

beforeEach(() => {
  vi.resetAllMocks();
  state.uid = "owner"; state.token = "private-token"; state.unlocked = true;
  publishValidatedAuthSessionPrincipal({ firebaseUid: "owner", ownerId: "owner", accountGeneration: 0 });
  state.collection.mockImplementation(async (_token: string, guard: () => void) => { guard(); return status; });
});

const groupOverview = { status: { enabled: true, state: "ready", indexedFiles: 1, counts: {
  financial_statements: 1, insurance_statements: 0, non_financial_statements: 0, personal_documents: 0, kept: 0,
} }, groups: [
  { shelf: "financial_statements", name: "Financial Assets" }, { shelf: "insurance_statements", name: "Insurance" },
  { shelf: "non_financial_statements", name: "Non-Financial Records" }, { shelf: "personal_documents", name: "Personal Documents" },
] };
function GroupPanel({ connection = "connection-one", active = true }: { connection?: string; active?: boolean }) {
  const model = useDriveDataPackets(active, connection, true);
  return <DriveDataPacketsView model={model} />;
}
describe("Drive data packet folders", () => {
  it("keeps all four categories visible, pages files on demand and Back closes the selected folder", async () => {
    state.groups.mockResolvedValue(groupOverview);
    const first = { ref: "a", title: "Synthetic statement", day: "2026-10-22", viewUrl: "https://drive.google.com/file/d/synthetic-file/view" };
    state.files.mockResolvedValueOnce({ items: [first], total: 2, nextCursor: 1 })
      .mockResolvedValueOnce({ items: [{ ...first, ref: "b", title: "Second synthetic statement" }], total: 2, nextCursor: null });
    render(<GroupPanel />);
    for (const group of groupOverview.groups) expect(await screen.findByRole("button", { name: `Open ${group.name}` })).toBeVisible();
    expect(state.files).not.toHaveBeenCalled(); expect(state.groupProcessing).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open Financial Assets" }));
    expect(await screen.findByText(first.title)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load more files" }));
    expect(await screen.findByText("Second synthetic statement")).toBeVisible();
    expect(state.files.mock.calls.map(call => call.slice(1, 3))).toEqual([["financial_statements", 0], ["financial_statements", 1]]);
    act(() => { expect(unwindBackLayer("/one/profile")).toBe(true); });
    expect(screen.queryByText(first.title)).not.toBeInTheDocument();
  });
  it("retires a pending private page on connection replacement and refuses the old response", async () => {
    state.groups.mockResolvedValue(groupOverview);
    let finish!: (value: unknown) => void;
    state.files.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const view = render(<GroupPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Financial Assets" }));
    view.rerender(<GroupPanel connection="replacement-connection" />);
    await act(async () => finish({ items: [{ ref: "old", title: "Retired private title" }], total: 1, nextCursor: null }));
    expect(screen.queryByText("Retired private title")).not.toBeInTheDocument();
    const retiredGuard = state.files.mock.calls[0][3];
    expect(retiredGuard).toThrow();
  });
});
afterEach(() => {
  cleanup();
  advanceVaultSessionEpoch();
  publishValidatedAuthSessionPrincipal(null);
});

describe("Prepare packets switch row", () => {
  it.each(Object.entries(ON))("shows On with an On caption while %s", async (driveState, text) => {
    state.collection.mockResolvedValue({ ...status, enabled: true, state: driveState });
    render(<DriveCollectionPanel backgroundEnabled />);
    const toggle = await screen.findByRole("switch", { name: "Prepare packets" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toBeEnabled();
    expect(caption()).toBe(text);
  });

  it.each(["not_enabled", "paused"])("shows Off with the Off caption once the owner turned it off (%s)", async (driveState) => {
    state.collection.mockResolvedValue({ ...status, enabled: false, state: driveState });
    render(<DriveCollectionPanel backgroundEnabled />);
    const toggle = await screen.findByRole("switch", { name: "Prepare packets" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toBeEnabled();
    expect(caption()).toBe(OFF);
  });

  it("says plainly why it can’t be turned on while Background Drive access is off", async () => {
    state.collection.mockResolvedValue({ ...status, enabled: false, backgroundEnabled: false, state: "paused" });
    render(<DriveCollectionPanel backgroundEnabled={false} />);
    const toggle = await screen.findByRole("switch", { name: "Prepare packets" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toBeDisabled();
    expect(caption()).toBe("Turn on Background Drive access first.");
  });

  it("keeps a saved On choice on, and says it is paused, while Background Drive access is off", async () => {
    state.collection.mockResolvedValue({ ...status, enabled: true, backgroundEnabled: false, state: "paused" });
    render(<DriveCollectionPanel backgroundEnabled={false} />);
    const toggle = await screen.findByRole("switch", { name: "Prepare packets" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toBeEnabled();
    expect(caption()).toBe("Paused while Background Drive access is off.");
  });

  it("shows no switch until the saved choice is known", async () => {
    let finish!: (value: unknown) => void;
    state.collection.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    render(<DriveCollectionPanel backgroundEnabled />);
    await waitFor(() => expect(caption()).toBe("Checking preparation…"));
    expect(screen.queryByRole("switch", { name: "Prepare packets" })).toBeNull();
    await act(async () => finish({ ...status, enabled: true, state: "indexing" }));
    expect(await screen.findByRole("switch", { name: "Prepare packets" })).toHaveAttribute("aria-checked", "true");
    expect(caption()).toBe(ON.indexing);
  });

  it("says Saving… while a change is in flight, then shows the saved state", async () => {
    let finish!: (value: unknown) => void;
    state.setProcessing.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    render(<DriveCollectionPanel backgroundEnabled />);
    const toggle = await screen.findByRole("switch", { name: "Prepare packets" });
    expect(caption()).toBe(OFF);
    fireEvent.click(toggle);
    await waitFor(() => expect(caption()).toBe("Saving…"));
    expect(toggle).toBeDisabled();
    await act(async () => finish({ ...status, enabled: true, state: "indexing", revision: 1 }));
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toBeEnabled();
    expect(caption()).toBe(ON.indexing);
  });

  it.each([
    { was: "off", saved: false, text: "Couldn’t turn on. Try again." },
    { was: "on", saved: true, text: "Couldn’t turn off. Try again." },
  ])("leaves the switch $was and says it couldn’t update when the change fails", async ({ saved, text }) => {
    state.collection.mockResolvedValue({ ...status, enabled: saved, state: saved ? "indexing" : "not_enabled" });
    state.setProcessing.mockRejectedValue(new Error("synthetic failure"));
    render(<DriveCollectionPanel backgroundEnabled />);
    const toggle = await screen.findByRole("switch", { name: "Prepare packets" });
    fireEvent.click(toggle);
    await waitFor(() => expect(caption()).toBe(text));
    expect(toggle).toHaveAttribute("aria-checked", String(saved));
    expect(toggle).toBeEnabled();
    // The switch is how to try again; a Retry that only re-reads the setting would not.
    expect(screen.queryByRole("button", { name: "Retry preparation" })).toBeNull();
    expect(state.setProcessing).toHaveBeenCalledWith("private-token", !saved, expect.any(Function));
  });

  it("says it couldn’t check, with no switch, when the saved choice can’t be read", async () => {
    state.collection.mockRejectedValue(new Error("synthetic failure"));
    render(<DriveCollectionPanel backgroundEnabled />);
    await waitFor(() => expect(caption()).toBe("Couldn’t check preparation."));
    expect(screen.queryByRole("switch", { name: "Prepare packets" })).toBeNull();
    expect(screen.getByRole("button", { name: "Retry preparation" })).toBeEnabled();
  });
});
