import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ uid: "owner", token: "private-token", unlocked: true,
  packets: vi.fn(), listing: vi.fn(), request: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: state.uid }, userId: state.uid }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultOwnerToken: state.token, isVaultUnlocked: state.unlocked }) }));
vi.mock("@/lib/services/drive-packet-service", () => ({ DrivePacketService: state }));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: {} }));

import { DrivePacketCatalog, useOwnerPacketPageModel } from "@/components/consent/drive-packet-catalog";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import type { DrivePacket } from "@/lib/services/drive-packet-service";

// Synthetic packets only: the owner's list as the server sends it.
const id = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const base = { version: 2, listingRevision: 0, description: "Monthly statements for one synthetic account.",
  state: "ready", coverageSummary: "January to June 2026", gaps: [], documentCount: 3,
  verifiedAt: "2026-10-13T10:00:00Z", freshness: "current", assessmentScore: 95, importance: 100,
  suggestedPriceCents: 1234, priceCents: 1234, listingEnabled: false, canRequest: false, canList: true };
const FILES = ["Example Bank statement Jan 2026.pdf", "Example Bank statement Feb 2026.pdf"];
const ready = { ...base, packetId: id(1), title: "Example Bank statements", contents: {
  period: { start: "2026-01-01", end: "2026-06-30" },
  documents: [
    { name: FILES[1], type: "bank statement", pages: 3, period: { start: "2026-02-01", end: "2026-02-28" } },
    { name: FILES[0], type: "bank statement", pages: 2, period: { start: "2026-01-01", end: "2026-01-31" } },
  ] } };
const listed = { ...base, packetId: id(2), title: "Example Utility bills", coverageSummary: "Utility bills for 2026",
  listingEnabled: true, listingRevision: 1, priceCents: 900, documentCount: 2 };
// The server's stand-in while a packet is rechecked.
const checking = { ...base, packetId: id(3), title: "Packet being checked", description: "Current source evidence is being checked.",
  state: "incomplete", coverageSummary: "Coverage is being checked.", gaps: ["The private agent is checking current evidence."],
  documentCount: 1, verifiedAt: null, freshness: "stale", canList: false };
// A version that isn't ready is never current on the server, so it arrives as "stale" with its reasons.
const missing = { ...base, packetId: id(4), title: "Example Payslips", state: "incomplete", freshness: "stale",
  gaps: ["The March 2026 payslip is missing."], documentCount: 2, canList: false };
const declined = { ...base, packetId: id(5), title: "Example Tax forms", listingRevision: 2, documentCount: 1 };
const checkingFile = { ...checking, packetId: id(6), contents: { period: null,
  documents: [{ name: "Example Lease 2026.pdf", type: null, pages: 4, period: null }] } };
const ALL = [checking, missing, listed, declined, ready];

beforeEach(() => {
  // Only this file's mocks: resetting every mock would also wipe the shared matchMedia stub the sheet reads.
  for (const mock of [state.packets, state.listing, state.request]) mock.mockReset();
  state.uid = "owner"; state.token = "private-token"; state.unlocked = true;
  publishValidatedAuthSessionPrincipal({ firebaseUid: "owner", ownerId: "owner", accountGeneration: 0 });
  state.packets.mockImplementation(async (_token, guard) => { guard(); return { packets: ALL, nextCursor: null }; });
  state.listing.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); advanceVaultSessionEpoch(); publishValidatedAuthSessionPrincipal(null); });

const row = (title: string) => screen.getByRole("button", { name: new RegExp(`^${title}`) });
const section = (page: HTMLElement, title: string) => within(page).getByRole("heading", { name: title }).closest("section")!;
async function openPacket(title: string) {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${title}`) }));
  return screen.findByRole("dialog", { name: title });
}

describe("owner packets as a history list", () => {
  it("keeps the price editor in its existing owner without publishing on Done or accepting a retired visit", async () => {
    let authorized = true;
    const guard = () => { if (!authorized) throw new Error("session_changed"); };
    const changed = vi.fn();
    const view = renderHook(() => useOwnerPacketPageModel({ packet: ready as DrivePacket, token: "synthetic-token", guard, onChanged: changed }));
    act(() => view.result.current.actions.find(action => action.id === "price")?.onSelect?.());
    const firstCurrent = view.result.current.editorCurrent, firstCancel = view.result.current.cancelPrice;
    expect(firstCurrent()).toBe(true);
    const revision = view.result.current.inputRevision();
    act(() => { expect(view.result.current.changePrice("19.95", revision)).toBe(true); });
    act(() => { expect(view.result.current.changePrice("1.00", revision)).toBe(false); });
    await act(async () => { expect(await view.result.current.finishPrice()).toBe(true); });
    expect(view.result.current.price).toBe("19.95");
    expect(state.listing).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
    expect(firstCurrent()).toBe(false);
    act(() => view.result.current.actions.find(action => action.id === "price")?.onSelect?.());
    act(() => firstCancel());
    expect(view.result.current.editingPrice).toBe(true);
    act(() => view.result.current.changePrice("22.00"));
    act(() => view.result.current.cancelPrice());
    expect(view.result.current.price).toBe("19.95");
    // Authority is checked synchronously, not after another React render.
    authorized = false;
    act(() => { expect(view.result.current.changePrice("33.00")).toBe(false); });
    expect(view.result.current.current()).toBe(false);
  });
  it("shows one row per packet with plain status words, document count, dates and price", async () => {
    render(<DrivePacketCatalog />);
    await screen.findByText("Example Bank statements");
    const list = screen.getByRole("region", { name: "Your document packets" });
    expect(within(list).getByRole("heading", { name: "Packets" })).toBeInTheDocument();
    expect(row("Example Bank statements")).toHaveTextContent("Ready to list · 3 documents · Jan–Jun 2026");
    expect(row("Example Bank statements")).toHaveTextContent("$12.34");
    expect(row("Example Utility bills")).toHaveTextContent("Listed · 2 documents");
    expect(row("Example Utility bills")).toHaveTextContent("$9");
    expect(row("Example Tax forms")).toHaveTextContent("Not listed · 1 document");
    expect(row("Example Payslips")).toHaveTextContent("Needs attention · 2 documents");
    expect(row("New packet")).toHaveTextContent("Checking · 1 document");
    // Only a packet that can be listed shows a price.
    expect(row("Example Payslips").textContent).not.toContain("$");
    expect(row("New packet").textContent).not.toContain("$");
    // Decisions first, then live listings, then work in progress.
    expect(within(list).getAllByRole("button").map(button => button.querySelector("[data-slot='settings-row-title']")?.textContent))
      .toEqual(["Example Bank statements", "Example Utility bills", "Example Tax forms", "Example Payslips", "New packet"]);
    // Rows hold no actions, no document picking and no jargon.
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(within(list).queryByRole("button", { name: /^(Allow|Deny|Edit price|List for|Don’t list|Change price)/ })).toBeNull();
    expect(list.textContent).not.toMatch(/coverage|private agent|evidence|being checked|assessment|importance/i);
  });

  it("names a packet being checked by its file when known, and gives it no actions", async () => {
    state.packets.mockResolvedValue({ packets: [checking, checkingFile], nextCursor: null });
    render(<DrivePacketCatalog />);
    expect(await screen.findByRole("button", { name: /^Example Lease 2026\.pdf/ })).toHaveTextContent("Checking · 1 document");
    const page = await openPacket("New packet");
    expect(section(page, "Status")).toHaveTextContent("Checking");
    // Without the owner's file list (an older server), the page still says how much is inside.
    expect(within(section(page, "What’s inside")).getAllByTestId("settings-row").map(item => item.textContent)).toEqual(["1 document"]);
    expect(within(page).queryByRole("heading", { name: "What buyers see" })).toBeNull();
    expect(within(page).queryByRole("heading", { name: "Price" })).toBeNull();
    expect(within(page).getAllByRole("button").map(button => button.getAttribute("aria-label") ?? button.textContent))
      .toEqual(["Close detail panel"]);
    expect(page.textContent).not.toMatch(/coverage|private agent|evidence|being checked/i);
    expect(state.listing).not.toHaveBeenCalled();
  });

  it("opens a packet's page: what's inside, what buyers see, price and status", async () => {
    render(<DrivePacketCatalog />);
    const page = await openPacket("Example Bank statements");
    expect(within(page).getByText("Ready to list · 3 documents · Jan–Jun 2026")).toBeInTheDocument();
    const inside = section(page, "What’s inside");
    // Oldest first, each with its type, pages and the dates it covers.
    expect(within(inside).getAllByTestId("settings-row").map(item => item.textContent)).toEqual([
      `${FILES[0]}Bank statement · 2 pages · Jan 2026`,
      `${FILES[1]}Bank statement · 3 pages · Feb 2026`,
      "1 more document"]);
    const buyers = section(page, "What buyers see");
    expect(buyers).toHaveTextContent("Example Bank statements");
    expect(buyers).toHaveTextContent("January to June 2026");
    for (const name of FILES) expect(buyers.textContent).not.toContain(name);
    expect(buyers.textContent).not.toMatch(/\.pdf|Example Bank statement (Jan|Feb)/);
    expect(section(page, "Price")).toHaveTextContent("$12.34");
    expect(section(page, "Status")).toHaveTextContent("Ready to list");
    expect(within(page).getByRole("button", { name: "List for $12.34" })).toBeEnabled();
    expect(within(page).getByRole("button", { name: "Don’t list" })).toBeEnabled();
    expect(within(page).getByRole("button", { name: "Change price" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(within(page).getByRole("button", { name: "Close detail panel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(row("Example Bank statements")).toBeInTheDocument();
  });

  it("shows the owner the same plain note buyers see when the Drive is not fully read", async () => {
    // The server's note for a Drive that is not fully read yet; buyers read it in plain words.
    const partial = { ...ready, description: `${ready.description} Covers only its verified documents and stated span. ` +
      "Other Drive files remain unverified; this is not a complete inventory of matching records." };
    state.packets.mockResolvedValue({ packets: [partial, listed], nextCursor: null });
    render(<DrivePacketCatalog />);
    let page = await openPacket("Example Bank statements");
    expect(within(section(page, "What buyers see")).getAllByTestId("settings-row").map(item => item.textContent))
      .toEqual(["Example Bank statementsJanuary to June 2026", "It may not include every matching file."]);
    expect(page.textContent).not.toMatch(/inventory|verified documents/i);
    fireEvent.click(within(page).getByRole("button", { name: "Close detail panel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    page = await openPacket("Example Utility bills");
    expect(within(section(page, "What buyers see")).getAllByTestId("settings-row")).toHaveLength(1);
  });

  it("lists, re-prices and unlists through the same listing service, with the same price bounds", async () => {
    render(<DrivePacketCatalog />);
    let page = await openPacket("Example Bank statements");
    fireEvent.click(within(page).getByRole("button", { name: "List for $12.34" }));
    await waitFor(() => expect(state.listing).toHaveBeenCalledWith("private-token", ready, "allow", 1234, expect.any(Function)));
    await waitFor(() => expect(state.packets).toHaveBeenCalledTimes(2));
    fireEvent.click(within(page).getByRole("button", { name: "Change price" }));
    const field = within(page).getByLabelText("New price");
    fireEvent.change(field, { target: { value: "0.10" } });
    expect(within(page).getByText("Enter $0.50–$500, up to two decimal places.")).toBeInTheDocument();
    expect(within(page).getByRole("button", { name: /^List for/ })).toBeDisabled();
    // Don't list keeps the saved price, whatever is typed, and a decision closes the field.
    fireEvent.change(within(page).getByLabelText("New price"), { target: { value: "20" } });
    expect(within(page).getByRole("button", { name: "List for $20" })).toBeEnabled();
    fireEvent.click(within(page).getByRole("button", { name: "Don’t list" }));
    await waitFor(() => expect(state.listing).toHaveBeenLastCalledWith("private-token", ready, "deny", 1234, expect.any(Function)));
    await waitFor(() => expect(within(page).queryByLabelText("New price")).toBeNull());
    fireEvent.click(within(page).getByRole("button", { name: "Change price" }));
    expect(within(page).getByLabelText("New price")).toHaveValue("12.34");
    fireEvent.change(within(page).getByLabelText("New price"), { target: { value: "56.78" } });
    expect(section(page, "Price")).toHaveTextContent("$56.78");
    fireEvent.click(within(page).getByRole("button", { name: "List for $56.78" }));
    await waitFor(() => expect(state.listing).toHaveBeenLastCalledWith("private-token", ready, "allow", 5678, expect.any(Function)));
    fireEvent.click(within(page).getByRole("button", { name: "Close detail panel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    page = await openPacket("Example Utility bills");
    expect(within(page).queryByRole("button", { name: /^List for/ })).toBeNull();
    expect(section(page, "Status")).toHaveTextContent("Listed");
    fireEvent.click(within(page).getByRole("button", { name: "Don’t list" }));
    await waitFor(() => expect(state.listing).toHaveBeenLastCalledWith("private-token", listed, "deny", 900, expect.any(Function)));
    expect(state.request).not.toHaveBeenCalled();
  });

  it("says why a packet can't be listed, instead of calling it checked", async () => {
    render(<DrivePacketCatalog />);
    const page = await openPacket("Example Payslips");
    const status = section(page, "Status");
    expect(within(status).getAllByTestId("settings-row").map(item => item.textContent))
      .toEqual(["Needs attentionIt can’t be listed yet.", "The March 2026 payslip is missing.", "CheckedOct 13, 2026"]);
    expect(page.textContent).not.toMatch(/Checking|private agent|evidence/i);
    expect(within(page).getAllByRole("button").map(button => button.getAttribute("aria-label") ?? button.textContent))
      .toEqual(["Close detail panel"]);
  });

  it("keeps a page from a later page open through a reload, and closes it for good once the packet is gone", async () => {
    const listedNow = { ...ready, listingEnabled: true, listingRevision: 1 };
    let pageTwo!: (value: unknown) => void;
    state.packets.mockReset()
      .mockImplementationOnce(async (_token, guard) => { guard(); return { packets: [listed], nextCursor: "page-2" }; })
      .mockImplementationOnce(async (_token, guard) => { guard(); return { packets: [ready], nextCursor: null }; })
      // Listing it reloads from the first page; the packet is on the next one.
      .mockImplementationOnce(async (_token, guard) => { guard(); return { packets: [listed], nextCursor: "page-2" }; })
      .mockImplementationOnce(() => new Promise(done => { pageTwo = done; }))
      // A later reload has it nowhere, then a later one has it again.
      .mockImplementationOnce(async (_token, guard) => { guard(); return { packets: [listed], nextCursor: null }; })
      .mockImplementation(async (_token, guard) => { guard(); return { packets: [listed, listedNow], nextCursor: null }; });
    const view = render(<DrivePacketCatalog />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    const page = await openPacket("Example Bank statements");
    fireEvent.click(within(page).getByRole("button", { name: "List for $12.34" }));
    await waitFor(() => expect(state.packets).toHaveBeenCalledTimes(4));
    expect(state.packets).toHaveBeenLastCalledWith("private-token", expect.any(Function), undefined, "page-2");
    // While the rest of the list loads, the same page stays open.
    expect(screen.getByRole("dialog", { name: "Example Bank statements" })).toBe(page);
    await act(async () => pageTwo({ packets: [listedNow], nextCursor: null }));
    await waitFor(() => expect(section(page, "Status")).toHaveTextContent("Listed"));
    view.rerender(<DrivePacketCatalog refreshKey={1} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // It comes back in a later reload: its page doesn't open by itself.
    view.rerender(<DrivePacketCatalog refreshKey={2} />);
    await waitFor(() => expect(state.packets).toHaveBeenCalledTimes(6));
    await screen.findByRole("button", { name: /^Example Bank statements/ });
    // A page that opened by itself would show after one more effect; give it the time.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(state.listing).toHaveBeenCalledOnce();
  });

  it("keeps the rows from Load more when the list refreshes, as Payouts history does", async () => {
    let pageTwo!: (value: unknown) => void;
    state.packets.mockReset()
      .mockImplementationOnce(async (_token, guard) => { guard(); return { packets: [listed], nextCursor: "page-2" }; })
      .mockImplementationOnce(async (_token, guard) => { guard(); return { packets: [ready], nextCursor: null }; })
      // The periodic refresh brings back both pages, the second one later.
      .mockImplementationOnce(async (_token, guard) => { guard(); return { packets: [listed], nextCursor: "page-2" }; })
      .mockImplementationOnce(() => new Promise(done => { pageTwo = done; }));
    const view = render(<DrivePacketCatalog />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await screen.findByRole("button", { name: /^Example Bank statements/ });
    view.rerender(<DrivePacketCatalog refreshKey={1} />);
    await waitFor(() => expect(state.packets).toHaveBeenCalledTimes(4));
    expect(state.packets).toHaveBeenNthCalledWith(3, "private-token", expect.any(Function), undefined, undefined);
    expect(state.packets).toHaveBeenLastCalledWith("private-token", expect.any(Function), undefined, "page-2");
    // Until the whole refresh is in, the rows on screen stay.
    expect(row("Example Bank statements")).toHaveTextContent("Ready to list");
    await act(async () => pageTwo({ packets: [{ ...ready, listingEnabled: true, listingRevision: 1 }], nextCursor: null }));
    await waitFor(() => expect(row("Example Bank statements")).toHaveTextContent("Listed"));
    expect(row("Example Utility bills")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("explains a changed packet and reloads it", async () => {
    state.listing.mockRejectedValueOnce(Object.assign(new Error("changed"), { code: "listing_changed" }));
    render(<DrivePacketCatalog />);
    const page = await openPacket("Example Tax forms");
    expect(section(page, "Status")).toHaveTextContent("Not listed");
    fireEvent.click(within(page).getByRole("button", { name: "List for $12.34" }));
    expect(await within(page).findByRole("status")).toHaveTextContent("This packet changed. Check it and try again.");
    expect(state.packets).toHaveBeenCalledTimes(2);
  });
});
