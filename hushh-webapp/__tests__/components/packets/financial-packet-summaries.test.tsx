import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ uid: "viewer", ownerId: "viewer", unlocked: false, list: vi.fn(), publish: vi.fn(), packets: vi.fn(), request: vi.fn(), identity: vi.fn(), getIdToken: vi.fn(), checkout: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: state.uid, getIdToken: state.getIdToken }, userId: state.ownerId }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultOwnerToken: "private-token", isVaultUnlocked: state.unlocked }) }));
vi.mock("@/lib/services/financial-packet-summary-service", () => ({ FinancialPacketSummaryService: state }));
vi.mock("@/lib/services/drive-packet-service", () => ({ DrivePacketService: state }));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: { documentRequestIdentityToken: state.identity } }));
vi.mock("@/lib/services/drive-request-payment-service", () => ({ DriveRequestPaymentService: { checkout: state.checkout } }));
import { FinancialPacketSummaries } from "@/components/consent/packets/financial-packet-summaries";
import { usePacketPublicSummary } from "@/components/consent/packets/packet-public-summary-control";
import { CONNECTION_GRAPH_CHANGED_EVENT } from "@/lib/connections/connection-graph-events";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import { CacheService } from "@/lib/services/cache-service";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import type { DrivePacket } from "@/lib/services/drive-packet-service";
const person = "11111111-1111-4111-8111-111111111111", packetId = "22222222-2222-4222-8222-222222222222";
const summary = { packetId, version: 1, category: "financial", title: "Financial documents", periodStart: "2026-07-01", periodEnd: "2026-08-31",
  timezone: "Asia/Kolkata", documentCount: null, countBasis: "discovery_matches", complete: false, updatedAt: null,
  priceCents: 500, currency: "USD", availability: "preparing", viewerAction: "connect" };
const packet = { ...summary, kind: "provider_discovery", description: "Drive search matches", state: "ready", freshness: "current", listingEnabled: true,
  listingRevision: 2, coverageSummary: "Search period", canList: false, canRequest: true, documentCount: 2,
  requestId: null, purchaseState: "none" } as unknown as DrivePacket;
beforeEach(() => {
  CacheService.getInstance().clear();
  vi.clearAllMocks(); state.uid = "viewer"; state.ownerId = "viewer"; state.unlocked = false; publishValidatedAuthSessionPrincipal({ firebaseUid: "viewer", ownerId: "viewer", accountGeneration: 0 });
  state.getIdToken.mockResolvedValue("firebase-token"); state.identity.mockResolvedValue("firebase-token");
  state.list.mockResolvedValue({ packets: [summary], nextCursor: null }); state.packets.mockResolvedValue({ packets: [packet], nextCursor: null });
});
afterEach(cleanup);
const openPeriod = async () => { fireEvent.click(await screen.findByRole("button", { name: /Jul–Aug 2026/ })); return screen.findByRole("dialog"); };
describe("@feature_drive_packets @trace_loop public summaries and private requests", () => {
  it("keeps a fresh same-session summary visible without another read", async () => {
    const props = { personRef: person, ownerName: "Avery", onConnect: vi.fn(), onUnlock: vi.fn() };
    let view = render(<FinancialPacketSummaries {...props} />);
    await screen.findByRole("button", { name: /Jul–Aug 2026/ });
    view.unmount();
    view = render(<FinancialPacketSummaries {...props} />);
    expect(screen.getByRole("button", { name: /Jul–Aug 2026/ })).toBeInTheDocument();
    expect(screen.queryByText("Loading financial documents…")).not.toBeInTheDocument();
    await act(async () => {});
    expect(state.list).toHaveBeenCalledTimes(1);
    view.unmount();
  });
  it("coalesces concurrent mounts and forces an explicit connection refresh", async () => {
    const props = { personRef: person, ownerName: "Avery", onConnect: vi.fn(), onUnlock: vi.fn() };
    render(<><FinancialPacketSummaries {...props} /><FinancialPacketSummaries {...props} /></>);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Jul–Aug 2026/ })).toHaveLength(2));
    expect(state.list).toHaveBeenCalledTimes(1);
    state.list.mockResolvedValue({ packets: [], nextCursor: null });
    await act(async () => { window.dispatchEvent(new CustomEvent(CONNECTION_GRAPH_CHANGED_EVENT, { detail: { userId: "viewer", changedAt: 1 } })); });
    await waitFor(() => expect(screen.queryAllByRole("button", { name: /Jul–Aug 2026/ })).toHaveLength(0));
    expect(screen.getAllByText("No financial documents available")).toHaveLength(2);
    expect(state.list.mock.calls.length).toBeGreaterThan(1);
  });
  it("keeps loaded periods after a consent refresh", async () => {
    const later = { ...summary, packetId: "33333333-3333-4333-8333-333333333333", periodStart: "2026-09-01", periodEnd: "2026-10-31" };
    state.list.mockImplementation(async (_person, _token, current, cursor) => {
      current(); return cursor ? { packets: [later], nextCursor: null } : { packets: [summary], nextCursor: "next" };
    });
    render(<FinancialPacketSummaries personRef={person} ownerName="Avery" onConnect={vi.fn()} onUnlock={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await screen.findByRole("button", { name: /Sep–Oct 2026/ });
    state.list.mockClear();
    await act(async () => { window.dispatchEvent(new Event(CONSENT_STATE_CHANGED_EVENT)); });
    await waitFor(() => expect(state.list).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: /Jul–Aug 2026/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sep–Oct 2026/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });
  it("retains newer counts while honoring a refresh that removes request authority", async () => {
    state.list.mockResolvedValue({ packets: [{ ...summary, documentCount: 51, saleDocumentCount: 7,
      complete: true, updatedAt: "2026-10-26T10:00:00Z", viewerAction: "request", availability: "ready" }], nextCursor: null });
    render(<FinancialPacketSummaries personRef={person} ownerName="Avery" onConnect={vi.fn()} onUnlock={vi.fn()} />);
    expect(await screen.findByRole("button", { name: /Jul–Aug 2026/ })).toHaveTextContent("Request for $5");
    state.list.mockResolvedValue({ packets: [{ ...summary, documentCount: 0, saleDocumentCount: 0,
      complete: true, updatedAt: "2026-10-26T09:00:00Z", viewerAction: "unavailable", availability: "unavailable" }], nextCursor: null });
    await act(async () => { window.dispatchEvent(new Event(CONSENT_STATE_CHANGED_EVENT)); });
    await waitFor(() => expect(screen.getByRole("button", { name: /Jul–Aug 2026/ })).not.toHaveTextContent("Request for $5"));
    const page = await openPeriod();
    expect(within(page).queryByRole("button", { name: "Request for $5" })).not.toBeInTheDocument();
    expect(within(page).getByText("51 search matches")).toBeInTheDocument();
    expect(within(page).getByText("7 files in the packet")).toBeInTheDocument();
    expect(within(page).getByText("Not available right now")).toBeInTheDocument();
    expect(state.request).not.toHaveBeenCalled();
  });
  it("reads a new account generation and rejects a retired same-Firebase response", async () => {
    state.ownerId = `acct_${"1".repeat(32)}`;
    publishValidatedAuthSessionPrincipal({ firebaseUid: state.uid, ownerId: state.ownerId, accountGeneration: 1 });
    const props = { personRef: person, ownerName: "Avery", onConnect: vi.fn(), onUnlock: vi.fn() };
    const view = render(<FinancialPacketSummaries {...props} />);
    await screen.findByRole("button", { name: /Jul–Aug 2026/ });
    let release!: (value: unknown) => void;
    state.list.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    view.rerender(<FinancialPacketSummaries {...props} refreshKey="refresh" />);
    await waitFor(() => expect(state.list).toHaveBeenCalledTimes(2));
    state.ownerId = `acct_${"2".repeat(32)}`;
    publishValidatedAuthSessionPrincipal({ firebaseUid: state.uid, ownerId: state.ownerId, accountGeneration: 2 });
    state.list.mockResolvedValue({ packets: [], nextCursor: null });
    view.rerender(<FinancialPacketSummaries {...props} refreshKey="refresh" />);
    await screen.findByText("No financial documents available");
    await act(async () => release({ packets: [summary], nextCursor: null }));
    expect(screen.queryByRole("button", { name: /Jul–Aug 2026/ })).not.toBeInTheDocument();
  });
  it("shows unknown counts without unlock, connects once, and makes pending read-only", async () => {
    const connect = vi.fn(), unlock = vi.fn();
    render(<FinancialPacketSummaries personRef={person} ownerName="Avery" onConnect={connect} onUnlock={unlock} />);
    const page = await openPeriod();
    expect(within(page).getByText("File count not available yet")).toBeInTheDocument();
    expect(within(page).queryByText(/0 (files|search)/)).not.toBeInTheDocument();
    state.list.mockResolvedValue({ packets: [{ ...summary, viewerAction: "pending" }], nextCursor: null });
    fireEvent.click(within(page).getByRole("button", { name: "Connect to request" }));
    await waitFor(() => expect(within(page).getByText("Request sent")).toBeInTheDocument());
    expect(within(page).queryByRole("button", { name: /Connect to request|Request for/ })).not.toBeInTheDocument();
    expect(connect).toHaveBeenCalledTimes(1); expect(unlock).not.toHaveBeenCalled(); expect(state.packets).not.toHaveBeenCalled(); expect(state.request).not.toHaveBeenCalled();
  });
  it("shows discovered matches without inventing sale readiness or starting a request", async () => {
    state.list.mockResolvedValue({ packets: [{ ...summary, documentCount: 51, saleDocumentCount: 0,
      complete: true, viewerAction: "unavailable", availability: "preparing" }], nextCursor: null });
    render(<FinancialPacketSummaries personRef={person} ownerName="Avery" onConnect={vi.fn()} onUnlock={vi.fn()} />);
    const row = await screen.findByRole("button", { name: /Jul–Aug 2026/ });
    expect(row).toHaveTextContent("51 search matches");
    expect(row).toHaveTextContent("$5"); expect(row).toHaveTextContent("one-time");
    fireEvent.click(row);
    const page = await screen.findByRole("dialog");
    expect(within(page).getByText("51 search matches")).toBeInTheDocument();
    expect(within(page).queryByRole("button", { name: /^Request for/ })).not.toBeInTheDocument();
    expect(state.packets).not.toHaveBeenCalled(); expect(state.request).not.toHaveBeenCalled(); expect(state.checkout).not.toHaveBeenCalled();
  });
  it("requires unlock, re-reads private authority, and reuses the request without checkout", async () => {
    state.list.mockResolvedValue({ packets: [{ ...summary, viewerAction: "request", availability: "ready", complete: true, documentCount: 2 }], nextCursor: null });
    const unlock = vi.fn(), props = { personRef: person, ownerName: "Avery", onConnect: vi.fn(), onUnlock: unlock };
    const view = render(<FinancialPacketSummaries {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: /Jul–Aug 2026/ }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(unlock).toHaveBeenCalledTimes(1); expect(state.packets).not.toHaveBeenCalled();
    state.unlocked = true; view.rerender(<FinancialPacketSummaries {...props} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /^Request for \$5/ })).toBeInTheDocument());
    await waitFor(() => expect(state.packets).toHaveBeenCalled());
    const page = screen.getByRole("dialog"); expect(within(page).getByText("You pay after Avery approves.")).toBeInTheDocument();
    state.request.mockResolvedValue({ requestId: person, existingAccess: true });
    fireEvent.click(within(page).getByRole("button", { name: /^Request for \$5/ }));
    expect(await within(page).findByText("You already have these files. Nothing was charged.")).toBeInTheDocument();
    expect(within(page).getByRole("link", { name: "View files" })).toHaveAttribute("href", expect.stringContaining("document_share_request"));
    expect(state.request).toHaveBeenCalledTimes(1);
  });
  it("opens one private review from a connected row without sending or charging until requested", async () => {
    state.unlocked = true;
    state.list.mockResolvedValue({ packets: [{ ...summary, viewerAction: "request", availability: "ready" }], nextCursor: null });
    state.request.mockResolvedValue({ requestId: person, existingAccess: false });
    render(<FinancialPacketSummaries personRef={person} ownerName="Avery" onConnect={vi.fn()} onUnlock={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Jul–Aug 2026/ }));
    const request = await screen.findByRole("button", { name: "Request for $5" });
    expect(state.packets).toHaveBeenCalledTimes(1);
    expect(state.request).not.toHaveBeenCalled(); expect(state.checkout).not.toHaveBeenCalled();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.click(request);
    await screen.findByText("Request sent.");
    expect(state.request).toHaveBeenCalledTimes(1); expect(state.checkout).not.toHaveBeenCalled();
  });
  it.each([
    ["pending", "view_request", "View request", "Request sent"],
    ["paid", "view_request", "View request", "Sharing files"],
    ["delivered", "view_files", "View files", "Files available"],
  ] as const)("reopens a withdrawn listing’s %s receipt without a new purchase", async (purchaseState, viewerAction, label, status) => {
    state.unlocked = true;
    const requestId = "33333333-3333-4333-8333-333333333333";
    state.list.mockResolvedValue({ packets: [{ ...summary, viewerAction, availability: "unavailable", complete: true, documentCount: 2 }], nextCursor: null });
    state.packets.mockResolvedValue({ packets: [{ ...packet, listingEnabled: false, canRequest: false, requestId, purchaseState }], nextCursor: null });
    render(<FinancialPacketSummaries personRef={person} ownerName="Avery" onConnect={vi.fn()} onUnlock={vi.fn()} />);
    await openPeriod();
    const link = await screen.findByRole("link", { name: label });
    expect(within(screen.getByRole("dialog")).getByText(status)).toBeInTheDocument();
    const target = new URL(link.getAttribute("href")!, "https://app.example");
    expect(target.pathname).toBe("/one/consent");
    expect(target.searchParams.get("requestId")).toBe(`document_share_request:${requestId}`);
    expect(target.searchParams.get("requestView")).toBe("sent");
    expect(target.searchParams.get("tab")).toBe("pending");
    expect(within(screen.getByRole("dialog")).queryByRole("button", { name: /Request for|Buy for|Pay/ })).not.toBeInTheDocument();
    expect(state.request).not.toHaveBeenCalled(); expect(state.checkout).not.toHaveBeenCalled(); expect(state.identity).not.toHaveBeenCalled();
  });
  it("does not turn a stale requestable summary into private purchase authority", async () => {
    state.unlocked = true;
    state.list.mockResolvedValue({ packets: [{ ...summary, viewerAction: "request", availability: "ready" }], nextCursor: null });
    state.packets.mockResolvedValue({ packets: [{ ...packet, canRequest: false }], nextCursor: null });
    render(<FinancialPacketSummaries personRef={person} ownerName="Avery" onConnect={vi.fn()} onUnlock={vi.fn()} />);
    await openPeriod();
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveTextContent("Not available right now"));
    expect(within(screen.getByRole("dialog")).queryByRole("button", { name: /^Request for/ })).not.toBeInTheDocument();
    expect(state.request).not.toHaveBeenCalled();
  });
  it("drops a delayed summary from the previous viewer", async () => {
    let release!: (value: unknown) => void;
    state.list.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const props = { personRef: person, ownerName: "Avery", onConnect: vi.fn(), onUnlock: vi.fn() };
    const view = render(<FinancialPacketSummaries {...props} />);
    await waitFor(() => expect(state.list).toHaveBeenCalledTimes(1));
    state.uid = "other"; state.ownerId = "other"; publishValidatedAuthSessionPrincipal({ firebaseUid: "other", ownerId: "other", accountGeneration: 0 }); state.list.mockResolvedValue({ packets: [], nextCursor: null });
    view.rerender(<FinancialPacketSummaries {...props} />); await screen.findByText("No financial documents available");
    await act(async () => release({ packets: [summary], nextCursor: null }));
    expect(screen.queryByRole("button", { name: /Jul–Aug/ })).not.toBeInTheDocument();
  });
  it("requires new-version acknowledgment and allows withdrawal while sale/background access is paused", async () => {
    const publication = { enabled: false, revision: 7, version: 0, disclosure: "drive-packet-public-summary-v1" };
    const owner = { ...packet, canRequest: false, canList: false, freshness: "paused", publicSummary: publication } as DrivePacket;
    const changed = vi.fn(), guard = vi.fn();
    const { result, rerender } = renderHook(({ value }) => usePacketPublicSummary(value, "owner-token", guard, changed), { initialProps: { value: owner } });
    await act(async () => result.current.submit()); expect(state.publish).not.toHaveBeenCalled();
    act(() => result.current.acknowledge(true)); state.publish.mockResolvedValue({ ...publication, version: 1, enabled: true, revision: 8 });
    await act(async () => result.current.submit());
    expect(state.publish).toHaveBeenCalledWith("owner-token", packetId, { ...publication, version: 1 }, true, expect.any(Function));
    expect(result.current.enabled).toBe(false);
    rerender({ value: { ...owner, publicSummary: { ...publication, enabled: true, version: 1, revision: 8 } } as DrivePacket });
    await act(async () => result.current.submit());
    expect(state.publish).toHaveBeenLastCalledWith("owner-token", packetId, expect.objectContaining({ revision: 8, version: 1 }), false, expect.any(Function));
    expect(changed).toHaveBeenCalledTimes(2);
    rerender({ value: owner });
    expect(result.current.canWithdraw).toBe(true);
    await act(async () => result.current.withdraw());
    expect(state.publish).toHaveBeenLastCalledWith("owner-token", packetId, expect.objectContaining({ revision: 7, version: 0 }), false, expect.any(Function));
  });
});
