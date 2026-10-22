import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  uid: "owner",
  token: "private-token",
  unlocked: true,
  collection: vi.fn(),
  setProcessing: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: state.uid } }) }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: state.token, isVaultUnlocked: state.unlocked }),
}));
vi.mock("@/lib/services/drive-packet-service", () => ({
  DrivePacketService: { collection: state.collection, setProcessing: state.setProcessing },
}));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: {} }));
// The packet list under the row has its own tests; this file is the switch row.
vi.mock("@/components/consent/drive-packet-catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/consent/drive-packet-catalog")>()),
  DrivePacketCatalog: () => null,
}));

import { DriveCollectionPanel } from "@/components/agent/drive-collection-panel";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
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
  publishValidatedAuthSessionOwner("owner");
  state.collection.mockImplementation(async (_token: string, guard: () => void) => { guard(); return status; });
});
afterEach(() => {
  cleanup();
  advanceVaultSessionEpoch();
  publishValidatedAuthSessionOwner(null);
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
