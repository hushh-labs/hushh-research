import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ uid: "buyer", token: "private-token", unlocked: true,
  packets: vi.fn(), listing: vi.fn(), request: vi.fn(), identity: vi.fn(), linkIdentity: vi.fn(), checkout: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: state.uid }, userId: state.uid }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultOwnerToken: state.token, isVaultUnlocked: state.unlocked }) }));
vi.mock("@/lib/services/drive-packet-service", () => ({ DrivePacketService: state }));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: { documentRequestIdentityToken: state.identity, linkGoogleIdentity: state.linkIdentity } }));
// Buying a packet only asks for it. Checkout stays on the request after the seller approves, so it must never start here.
vi.mock("@/lib/services/drive-request-payment-service", () => ({ DriveRequestPaymentService: { checkout: state.checkout } }));

import { DrivePacketCatalog } from "@/components/consent/drive-packet-catalog";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";

// Synthetic packets only: a seller's listed packets as a buyer's list receives them.
const seller = "11111111-1111-4111-8111-111111111111";
const REQUEST = "22222222-2222-4222-8222-222222222222";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (n: number) => `${String(n).padStart(8, "0")}-3333-4333-8333-333333333333`;
const base = { version: 2, listingRevision: 1, description: "Monthly statements for one synthetic account.",
  state: "ready", coverageSummary: "January to June 2026", gaps: [], documentCount: 3,
  verifiedAt: "2026-10-13T10:00:00Z", freshness: "current", assessmentScore: 95, importance: 100,
  suggestedPriceCents: 1234, priceCents: 1234, listingEnabled: true, canRequest: true, canList: false };
// The server's note for a seller whose Drive is not fully read yet.
const PARTIAL = "Monthly statements for one synthetic account. Covers only its verified documents and stated span. " +
  "Other Drive files remain unverified; this is not a complete inventory of matching records.";
// A buyer's list never carries the seller's files. This one does, to prove the buyer view would not show them.
const FILE = "Example Bank statement Jan 2026.pdf";
const bank = { ...base, packetId: id(1), title: "Example Bank statements", description: PARTIAL,
  contents: { period: null, documents: [{ name: FILE, type: "bank statement", pages: 2, period: null }] } };
const bills = { ...base, packetId: id(2), title: "Example Utility bills", coverageSummary: "Utility bills for 2026",
  documentCount: 1, priceCents: 900 };
const stale = { ...base, packetId: id(3), title: "Example Payslips", freshness: "stale",
  gaps: ["Agent One is checking current evidence."], canRequest: false };
const ALL = [stale, bank, bills];

beforeEach(() => {
  // Only this file's mocks: resetting every mock would also wipe the shared matchMedia stub the sheet reads.
  for (const mock of [state.packets, state.listing, state.request, state.identity, state.linkIdentity, state.checkout]) mock.mockReset();
  state.uid = "buyer"; state.token = "private-token"; state.unlocked = true;
  publishValidatedAuthSessionPrincipal({ firebaseUid: "buyer", ownerId: "buyer", accountGeneration: 0 });
  state.packets.mockImplementation(async (_token, guard) => { guard(); return { packets: ALL, nextCursor: null }; });
  state.identity.mockImplementation(async (_uid, current) => { if (!current()) throw new Error("session_changed"); return "firebase-token"; });
  state.linkIdentity.mockResolvedValue("linked-firebase-token");
  state.request.mockResolvedValue({ requestId: REQUEST, existingAccess: false });
});
afterEach(() => { cleanup(); advanceVaultSessionEpoch(); publishValidatedAuthSessionPrincipal(null); });

const Catalog = () => <DrivePacketCatalog ownerPersonRef={seller} ownerName="Avery" />;
const row = (title: string) => screen.getByRole("button", { name: new RegExp(`^${title}`) });
const section = (page: HTMLElement, title: string) => within(page).getByRole("heading", { name: title }).closest("section")!;
const titles = (list: HTMLElement) => within(list).getAllByRole("button")
  .map(button => button.querySelector("[data-slot='settings-row-title']")?.textContent);
async function openPacket(title: string) {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${title}`) }));
  return screen.findByRole("dialog", { name: title });
}
async function closePage(page: HTMLElement) {
  fireEvent.click(within(page).getByRole("button", { name: "Close detail panel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}
const JARGON = /coverage|private agent|evidence|assessment|importance|verified|inventory/i;

describe("a seller's packets, as a buyer sees them", () => {
  it.each([7, null] as const)("uses frozen membership %s without advertising the live discovery count", async (saleDocumentCount) => {
    const period = { ...base, packetId: id(4), kind: "provider_discovery", category: "financial", version: 1,
      title: "Financial documents", documentCount: 51, saleDocumentCount, canRequest: saleDocumentCount !== null,
      periodStart: "2026-07-01", periodEnd: "2026-08-31", timezone: "UTC", requestId: null, purchaseState: "none" };
    state.packets.mockResolvedValue({ packets: [period], nextCursor: null });
    render(<Catalog />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Financial documents" }));
    fireEvent.click(screen.getByRole("button", { name: /^Jul–Aug 2026/ }));
    const page = await screen.findByRole("dialog", { name: "Financial documents" });
    expect(within(page).getByText(saleDocumentCount === null ? "File count unavailable" : "7 documents")).toBeInTheDocument();
    expect(within(page).queryByText(/51 documents/)).not.toBeInTheDocument();
    if (saleDocumentCount === null) expect(within(page).queryByRole("button", { name: /^Request for/ })).not.toBeInTheDocument();
    expect(state.request).not.toHaveBeenCalled(); expect(state.checkout).not.toHaveBeenCalled();
  });
  it("keeps existing receipts reachable without exposing hidden period offers", async () => {
    const receipt = { ...base, packetId: id(4), kind: "provider_discovery", category: "financial", version: 1,
      title: "Financial documents", documentCount: 51, saleDocumentCount: 7, canRequest: false, listingEnabled: false,
      periodStart: "2026-07-01", periodEnd: "2026-08-31", timezone: "UTC", requestId: REQUEST, purchaseState: "paid" };
    const hiddenOffer = { ...receipt, packetId: id(5), periodStart: "2026-09-01", periodEnd: "2026-10-31", requestId: null, purchaseState: "none" };
    state.packets.mockResolvedValue({ packets: [receipt, hiddenOffer], nextCursor: null });
    render(<DrivePacketCatalog ownerPersonRef={seller} ownerName="Avery" customPacketsOnly />);
    const link = await screen.findByRole("link", { name: /Jul–Aug 2026/ });
    expect(screen.getByRole("heading", { name: "Your requests" })).toBeInTheDocument();
    expect(link.getAttribute("href")).toContain(encodeURIComponent(`document_share_request:${REQUEST}`));
    expect(link).toHaveTextContent("Sharing files");
    expect(screen.queryByText(/Sep–Oct 2026/)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Other document packets" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Request for|Buy for/ })).not.toBeInTheDocument();
    expect(state.request).not.toHaveBeenCalled(); expect(state.checkout).not.toHaveBeenCalled();
  });
  it("restores a paid category-period receipt after remount without another purchase", async () => {
    const purchased = { kind: "provider_discovery", category: "bank", packetId: id(4), version: 1,
      listingRevision: 3, title: "Account statements", description: "Drive search matches", coverageSummary: "July–August 2026",
      periodStart: "2026-07-01", periodEnd: "2026-08-31", timezone: "Asia/Kolkata", state: "ready",
      documentCount: 2, freshness: "current", priceCents: 500, listingEnabled: true, canList: false, canRequest: true,
      requestId: REQUEST, purchaseState: "delivered" };
    state.packets.mockResolvedValue({ packets: [purchased], nextCursor: null });
    let view = render(<Catalog />);
    for (let visit = 0; visit < 2; visit++) {
      fireEvent.click(await screen.findByRole("button", { name: "Open Account statements" }));
      fireEvent.click(screen.getByRole("button", { name: /^Jul–Aug 2026/ }));
      const page = await screen.findByRole("dialog", { name: purchased.title });
      expect(within(page).getByRole("link", { name: "View files" }).getAttribute("href"))
        .toContain(encodeURIComponent(`document_share_request:${REQUEST}`));
      expect(within(page).queryByRole("button", { name: /^Buy/ })).toBeNull();
      expect(within(page).queryByRole("heading", { name: "Price" })).toBeNull();
      await closePage(page); view.unmount();
      if (visit === 0) view = render(<Catalog />);
    }
    expect(state.request).not.toHaveBeenCalled(); expect(state.checkout).not.toHaveBeenCalled();
  });
  it("shows one history row per listed packet: name, what it covers and price, with no buttons", async () => {
    render(<Catalog />);
    const list = screen.getByRole("region", { name: "Available document packets" });
    await within(list).findByText("Example Bank statements");
    expect(within(list).getByRole("heading", { name: "Available packets" })).toBeInTheDocument();
    expect(row("Example Bank statements")).toHaveTextContent("3 documents · January to June 2026");
    expect(row("Example Bank statements")).toHaveTextContent("$12.34");
    expect(row("Example Utility bills")).toHaveTextContent("1 document · Utility bills for 2026");
    expect(row("Example Utility bills")).toHaveTextContent("$9");
    expect(row("Example Payslips")).toHaveTextContent("Not available right now");
    expect(row("Example Payslips").textContent).not.toContain("$");
    // Packets you can buy first, then the rest, each in the seller's order.
    expect(titles(list)).toEqual(["Example Bank statements", "Example Utility bills", "Example Payslips"]);
    // Rows only open a page: no Buy, no old card buttons, no jargon, never the seller's files.
    expect(within(list).queryByRole("button", { name: /^(Buy|Request packet|View details)/ })).toBeNull();
    expect(list.textContent).not.toMatch(JARGON);
    expect(list.textContent).not.toContain(FILE);
  });

  it("opens a packet's page: what's included, the price, when you pay, and Buy; Back returns to the row", async () => {
    render(<Catalog />);
    const page = await openPacket("Example Bank statements");
    expect(within(page).getByText("3 documents · January to June 2026")).toBeInTheDocument();
    const included = section(page, "What’s included");
    expect(within(included).getAllByTestId("settings-row").map(item => item.textContent))
      .toEqual(["3 documentsJanuary to June 2026", "It may not include every matching file."]);
    const price = section(page, "Price");
    expect(price).toHaveTextContent("$12.34");
    expect(price).toHaveTextContent("You pay after Avery approves.");
    expect(within(page).getByRole("button", { name: "Buy for $12.34" })).toBeEnabled();
    expect(page.textContent).not.toMatch(JARGON);
    expect(page.textContent).not.toContain(FILE);
    await closePage(page);
    await waitFor(() => expect(row("Example Bank statements")).toHaveFocus());
    expect(state.request).not.toHaveBeenCalled();
  });

  it("buys with today's packet request, once, then shows it as requested and never starts checkout", async () => {
    render(<Catalog />);
    const page = await openPacket("Example Bank statements");
    const buy = within(page).getByRole("button", { name: "Buy for $12.34" });
    fireEvent.click(buy);
    fireEvent.click(buy);
    const link = await within(page).findByRole("link", { name: "View request" });
    expect(link.getAttribute("href")).toContain(encodeURIComponent(`document_share_request:${REQUEST}`));
    expect(link.getAttribute("href")).toContain("requestView=sent");
    expect(state.identity).toHaveBeenCalledWith("buyer", expect.any(Function));
    expect(state.request).toHaveBeenCalledOnce();
    expect(state.request).toHaveBeenCalledWith("private-token", "firebase-token", bank, expect.stringMatching(UUID), expect.any(Function));
    expect(within(page).getByRole("status")).toHaveTextContent("Request sent.");
    expect(within(page).getByText("Request sent")).toBeInTheDocument();
    expect(section(page, "Price")).toHaveTextContent("You pay after Avery approves.");
    expect(within(page).queryByRole("button", { name: /^Buy/ })).toBeNull();
    await closePage(page);
    expect(row("Example Bank statements")).toHaveTextContent("Request sent");
    expect(state.checkout).not.toHaveBeenCalled();
    expect(state.listing).not.toHaveBeenCalled();
  });

  it("says the buyer already has the files, charges nothing and links to them", async () => {
    state.request.mockResolvedValueOnce({ requestId: REQUEST, existingAccess: true });
    render(<Catalog />);
    const page = await openPacket("Example Bank statements");
    fireEvent.click(within(page).getByRole("button", { name: "Buy for $12.34" }));
    expect(await within(page).findByRole("status")).toHaveTextContent("You already have these files. Nothing was charged.");
    expect(within(page).getByRole("link", { name: "View files" }).getAttribute("href"))
      .toContain(encodeURIComponent(`document_share_request:${REQUEST}`));
    expect(within(page).queryByRole("heading", { name: "Price" })).toBeNull();
    expect(within(page).queryByRole("button", { name: /^Buy/ })).toBeNull();
    await closePage(page);
    expect(row("Example Bank statements")).toHaveTextContent("You have these files");
    expect(row("Example Bank statements").textContent).not.toContain("$");
    expect(state.checkout).not.toHaveBeenCalled();
  });

  it("keeps one retry key per packet version, across a failed try and a reopened page", async () => {
    state.request.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce({ requestId: REQUEST, existingAccess: false });
    render(<Catalog />);
    let page = await openPacket("Example Bank statements");
    fireEvent.click(within(page).getByRole("button", { name: "Buy for $12.34" }));
    expect(await within(page).findByRole("status")).toHaveTextContent("Couldn’t confirm your request. Try again. It won’t be sent twice.");
    await closePage(page);
    page = await openPacket("Example Bank statements");
    expect(within(page).queryByRole("status")).toBeNull();
    fireEvent.click(within(page).getByRole("button", { name: "Buy for $12.34" }));
    await within(page).findByRole("link", { name: "View request" });
    expect(state.request).toHaveBeenCalledTimes(2);
    expect(state.request.mock.calls[1][3]).toBe(state.request.mock.calls[0][3]);
  });

  it("adds a Google account only after the buyer taps it, then retries with the same key", async () => {
    state.request.mockRejectedValueOnce(Object.assign(new Error("identity"), { code: "verify_google_identity_required" }))
      .mockResolvedValueOnce({ requestId: REQUEST, existingAccess: false });
    render(<Catalog />);
    const page = await openPacket("Example Bank statements");
    fireEvent.click(within(page).getByRole("button", { name: "Buy for $12.34" }));
    const add = await within(page).findByRole("button", { name: "Add Google account" });
    expect(within(page).getByRole("status")).toHaveTextContent("Add a Google account once to receive original files.");
    expect(state.linkIdentity).not.toHaveBeenCalled();
    fireEvent.click(add);
    await within(page).findByRole("link", { name: "View request" });
    expect(state.linkIdentity).toHaveBeenCalledWith("buyer", expect.any(Function));
    expect(state.request.mock.calls[1][1]).toBe("linked-firebase-token");
    expect(state.request.mock.calls[1][3]).toBe(state.request.mock.calls[0][3]);
  });

  it.each([
    ["identity_link_web_required", "Open One on the web to add your Google account once."],
    ["identity_cancelled", "Google verification was cancelled. No new request was sent."],
    ["connection_required", "You need an active connection with this person."],
    ["request_failed", "Couldn’t confirm your request. Try again. It won’t be sent twice."],
  ])("says %s in plain words", async (code, copy) => {
    state.request.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
    render(<Catalog />);
    const page = await openPacket("Example Bank statements");
    fireEvent.click(within(page).getByRole("button", { name: "Buy for $12.34" }));
    expect(await within(page).findByRole("status")).toHaveTextContent(copy);
    expect(within(page).getByRole("button", { name: "Buy for $12.34" })).toBeEnabled();
  });

  it("explains a changed packet, shows its new price, and buys that version with a new key", async () => {
    const repriced = { ...bank, version: 3, priceCents: 1500 };
    state.packets.mockImplementationOnce(async (_token, guard) => { guard(); return { packets: ALL, nextCursor: null }; })
      .mockImplementation(async (_token, guard) => { guard(); return { packets: [stale, repriced, bills], nextCursor: null }; });
    state.request.mockRejectedValueOnce(Object.assign(new Error("changed"), { code: "price_changed" }))
      .mockResolvedValueOnce({ requestId: REQUEST, existingAccess: false });
    render(<Catalog />);
    const page = await openPacket("Example Bank statements");
    fireEvent.click(within(page).getByRole("button", { name: "Buy for $12.34" }));
    expect(await within(page).findByRole("status")).toHaveTextContent("This packet changed. Check the new details.");
    fireEvent.click(await within(page).findByRole("button", { name: "Buy for $15" }));
    await within(page).findByRole("link", { name: "View request" });
    expect(state.packets).toHaveBeenCalledTimes(2);
    expect(state.request.mock.calls[1][2]).toEqual(repriced);
    expect(state.request.mock.calls[1][3]).not.toBe(state.request.mock.calls[0][3]);
  });

  it("keeps the page open, saying it can't be bought, when the packet is gone after a reload", async () => {
    state.packets.mockImplementationOnce(async (_token, guard) => { guard(); return { packets: ALL, nextCursor: null }; })
      .mockImplementation(async (_token, guard) => { guard(); return { packets: [bills], nextCursor: null }; });
    state.request.mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "packet_unavailable" }));
    render(<Catalog />);
    const page = await openPacket("Example Bank statements");
    fireEvent.click(within(page).getByRole("button", { name: "Buy for $12.34" }));
    expect(await within(page).findByRole("status")).toHaveTextContent("This packet isn’t available right now.");
    await waitFor(() => expect(within(page).queryByRole("button", { name: /^Buy/ })).toBeNull());
    expect(within(page).getByText("Not available right now")).toBeInTheDocument();
    await closePage(page);
    expect(screen.queryByText("Example Bank statements")).toBeNull();
    expect(state.request).toHaveBeenCalledOnce();
  });

  it("finds a packet from a later page again after a reload, instead of calling it unavailable", async () => {
    const repriced = { ...bank, version: 3, priceCents: 1500 };
    let pageTwo!: (value: unknown) => void;
    state.packets.mockReset()
      .mockImplementationOnce(async (_token, guard) => { guard(); return { packets: [bills], nextCursor: "page-2" }; })
      .mockImplementationOnce(async (_token, guard) => { guard(); return { packets: [bank], nextCursor: null }; })
      // The reload after a change starts again from the first page...
      .mockImplementationOnce(async (_token, guard) => { guard(); return { packets: [bills], nextCursor: "page-2" }; })
      // ...and the open packet is on the next one.
      .mockImplementationOnce(() => new Promise(done => { pageTwo = done; }));
    state.request.mockRejectedValueOnce(Object.assign(new Error("changed"), { code: "price_changed" }));
    render(<Catalog />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    const page = await openPacket("Example Bank statements");
    fireEvent.click(within(page).getByRole("button", { name: "Buy for $12.34" }));
    expect(await within(page).findByRole("status")).toHaveTextContent("This packet changed. Check the new details.");
    await waitFor(() => expect(state.packets).toHaveBeenCalledTimes(4));
    expect(state.packets).toHaveBeenLastCalledWith("private-token", expect.any(Function), seller, "page-2");
    // While the rest of the list loads, the page keeps what it last showed.
    expect(within(page).queryByText("Not available right now")).toBeNull();
    await act(async () => pageTwo({ packets: [repriced], nextCursor: null }));
    expect(await within(page).findByRole("button", { name: "Buy for $15" })).toBeEnabled();
    expect(within(page).queryByText("Not available right now")).toBeNull();
  });

  it("shows a packet that can't be bought now with no Buy and no price", async () => {
    render(<Catalog />);
    const page = await openPacket("Example Payslips");
    expect(within(page).getByText("Not available right now")).toBeInTheDocument();
    expect(section(page, "What’s included")).toHaveTextContent("3 documents");
    expect(within(page).queryByRole("heading", { name: "Price" })).toBeNull();
    expect(within(page).getAllByRole("button").map(button => button.getAttribute("aria-label") ?? button.textContent))
      .toEqual(["Close detail panel"]);
    expect(page.textContent).not.toMatch(JARGON);
  });

  it("closes the page and drops a late result when the account changes", async () => {
    let finish!: (value: unknown) => void;
    state.request.mockReturnValueOnce(new Promise(done => { finish = done; }));
    const view = render(<Catalog />);
    const page = await openPacket("Example Bank statements");
    fireEvent.click(within(page).getByRole("button", { name: "Buy for $12.34" }));
    await waitFor(() => expect(state.request).toHaveBeenCalledOnce());
    state.uid = "other-buyer"; state.token = "other-token"; publishValidatedAuthSessionPrincipal({ firebaseUid: "other-buyer", ownerId: "other-buyer", accountGeneration: 0 });
    state.packets.mockImplementation(async (_token, guard) => { guard(); return { packets: [], nextCursor: null }; });
    view.rerender(<Catalog />);
    await act(async () => finish({ requestId: REQUEST, existingAccess: false }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Example Bank statements")).toBeNull();
    expect(screen.queryByText(/Requested/)).toBeNull();
  });

  it("says when there are none, retries a failed load, and loads more without duplicates", async () => {
    state.packets.mockResolvedValueOnce({ packets: [], nextCursor: null });
    const view = render(<Catalog />);
    expect(await screen.findByText("No packets yet")).toBeInTheDocument();
    view.unmount();
    // A new vault session has no warm snapshot; exercise a cold read failure.
    advanceVaultSessionEpoch();
    state.packets.mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ packets: [bank], nextCursor: "next" })
      .mockResolvedValueOnce({ packets: [bank, bills], nextCursor: null });
    render(<Catalog />);
    expect(await screen.findByText("Couldn’t load packets.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Example Bank statements");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("Example Utility bills");
    expect(state.packets).toHaveBeenLastCalledWith("private-token", expect.any(Function), seller, "next");
    expect(screen.getAllByText("Example Bank statements")).toHaveLength(1);
  });
});
