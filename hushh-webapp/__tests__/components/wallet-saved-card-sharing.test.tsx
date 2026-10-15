import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ state: vi.fn(), recipients: vi.fn(), receipts: vi.fn(), revoke: vi.fn(), observe: vi.fn(), disconnect: vi.fn() }));
vi.mock("@/lib/services/wallet-card-access-service", () => ({ WalletCardAccessService: { state: mocks.state, revoke: mocks.revoke, recipients: mocks.recipients }, CardAccessUnavailableError: class extends Error {} }));
vi.mock("@/lib/services/wallet-service", () => ({ WalletService: { listCardShareReceipts: mocks.receipts } }));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/profile/profile-pane-icons", () => ({ ProfilePaneAccountIcon: () => <span data-testid="person-icon" />, ProfilePaneInviteIcon: () => <span />, ProfilePaneSecurityIcon: () => <span /> }));
vi.mock("@/components/profile/settings-ui", () => ({
 SettingsPresentationProvider: ({ children }: any) => children,
 SettingsDetailPanel: ({ open, children }: any) => open ? <div>{children}</div> : null,
 SettingsGroup: ({ title, children }: any) => <section aria-label={title}>{children}</section>,
 SettingsRow: ({ title, description, icon: Icon, trailing, onClick }: any) => <div><button onClick={onClick}>{Icon ? <Icon /> : null}{title}</button>{description}{trailing}</div>,
}));
import { WalletSavedCardSharing } from "@/components/wallet/wallet-saved-card-sharing";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { registerBackLayer, unwindBackLayer } from "@/lib/navigation/back-layers";
const context = { userId: "owner", getIdToken: async () => "token", vaultOwnerToken: "consent", isCurrent: () => true };
const getContext = () => context;
const card = { cardId: "card", nickname: "Card", brand: "visa" as const, last4: "4242", expiryMonth: 4, expiryYear: 2030, issuingRegion: "US", createdAt: "" };
const grant = (id: string) => ({ id, recipientName: `Person ${id}`, createdAt: "2026-10-12T10:00:00Z", expiresAt: "2026-10-12T10:10:00Z", status: "expired" });
let intersect: IntersectionObserverCallback;
beforeEach(() => {
 vi.resetAllMocks();
 vi.stubGlobal("IntersectionObserver", class { constructor(callback: IntersectionObserverCallback) { intersect = callback; } observe = mocks.observe; disconnect = mocks.disconnect; });
 mocks.state.mockResolvedValue({ eligible: true, grants: [grant("1")], nextCursor: "1", hasMore: true });
 mocks.receipts.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllGlobals());
it("limits recipients across searches while allowing deselection", async () => {
 const people = Array.from({ length: 21 }, (_, i) => ({ personRef: `p${i}`, displayName: `Connection ${i}`, trusted: false }));
 mocks.recipients.mockResolvedValue({ items: people.slice(0, 20), hasMore: true });
 render(<WalletSavedCardSharing card={card} getContext={getContext} disabled={false} />);
 await screen.findByText("Person 1");
 fireEvent.click(screen.getByRole("button", { name: "Share card" }));
 await screen.findByRole("checkbox", { name: "Share with Connection 0", exact: true });
 for (let i = 0; i < 20; i++) fireEvent.click(screen.getByRole("checkbox", { name: `Share with Connection ${i}`, exact: true }));
 mocks.recipients.mockResolvedValue({ items: [people[0], people[20]], hasMore: false });
 fireEvent.change(screen.getByRole("textbox", { name: "Search connections" }), { target: { value: "Connection" } });
 const extra = await screen.findByRole("checkbox", { name: "Share with Connection 20", exact: true });
 expect(extra).toBeDisabled();
 expect(screen.getByRole("checkbox", { name: "Share with Connection 0", exact: true })).not.toBeDisabled();
 fireEvent.click(screen.getByRole("checkbox", { name: "Share with Connection 0", exact: true }));
 expect(extra).not.toBeDisabled();
 fireEvent.click(extra);
 expect(screen.getByText(/20 of 20 connections selected/)).toBeVisible();
});
it("shows one-person icons and sharing dates while omitting an empty sent-copy disclosure", async () => {
 render(<WalletSavedCardSharing card={card} getContext={getContext} disabled={false} />);
 await screen.findByText("Person 1");
 expect(screen.getByTestId("person-icon")).toBeInTheDocument();
 const time = document.querySelector("time");
 expect(time).toHaveAttribute("datetime", "2026-10-12T10:00:00Z");
 expect(time).toHaveTextContent("Shared");
 expect(screen.queryByRole("button", { name: "Previously sent copies" })).toBeNull();
 expect(mocks.receipts).toHaveBeenCalledExactlyOnceWith({ ...context, cardId: "card" });
});
it("preserves receipt-only copy inspection and clears it when the vault retires", async () => {
 mocks.state.mockResolvedValue({ eligible: true, grants: [], nextCursor: null });
 mocks.receipts.mockResolvedValue([{ messageId: "copy", conversationId: "conversation", recipientPersonRef: "person", recipientName: "Copy recipient", sentAt: "2026-10-12T10:00:00Z" }]);
 render(<WalletSavedCardSharing card={card} getContext={getContext} disabled={false} />);
 const disclosure = await screen.findByRole("button", { name: "Previously sent copies" });
 expect(screen.queryByText("Copy recipient")).toBeNull();
 fireEvent.click(disclosure);
 expect(await screen.findByText("Copy recipient")).toBeVisible();
 expect(screen.getByText(/Sent copy · cannot be recalled/)).toBeVisible();
 expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
 const parentBack = vi.fn(() => true);
 const releaseParent = registerBackLayer({ pathname: "/one/wallet", depth: 1, back: parentBack });
 try {
  act(() => expect(unwindBackLayer("/one/wallet")).toBe(true));
  expect(screen.queryByText("Copy recipient")).toBeNull();
  expect(parentBack).not.toHaveBeenCalled();
  act(() => expect(unwindBackLayer("/one/wallet")).toBe(true));
  expect(parentBack).toHaveBeenCalledOnce();
 } finally { releaseParent(); }
 fireEvent.click(disclosure);
 await screen.findByText("Copy recipient");
 act(() => advanceVaultSessionEpoch());
 expect(screen.queryByText("Copy recipient")).toBeNull();
 expect(screen.queryByRole("button", { name: "Previously sent copies" })).toBeNull();
});
it("discards a delayed sent-copy result after card retirement", async () => {
 let finish!: (value: unknown) => void;
 mocks.receipts.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
 const view = render(<WalletSavedCardSharing card={card} getContext={getContext} disabled={false} />);
 await waitFor(() => expect(finish).toBeTypeOf("function"));
 view.rerender(<WalletSavedCardSharing card={{ ...card, cardId: "other" }} getContext={getContext} disabled={false} />);
 await act(async () => finish([{ messageId: "retired", recipientName: "Retired copy", sentAt: "2026-10-12T10:00:00Z" }]));
 expect(screen.queryByRole("button", { name: "Previously sent copies" })).toBeNull();
});
it("appends the next page on scroll and suppresses duplicate rows", async () => {
 render(<WalletSavedCardSharing card={card} getContext={getContext} disabled={false} />);
 await screen.findByText("Person 1");
 mocks.state.mockResolvedValue({ eligible: true, grants: [grant("1"), grant("2")], nextCursor: null, hasMore: false });
 await waitFor(() => expect(mocks.observe).toHaveBeenCalled());
 await act(async () => intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
 await screen.findByText("Person 2");
 expect(screen.getAllByText("Person 1")).toHaveLength(1);
 expect(mocks.state).toHaveBeenLastCalledWith(context, "card", expect.any(AbortSignal), "1");
 expect(screen.queryByRole("button", { name: "Load more shares" })).toBeNull();
});
it("keeps loaded rows and permits retry after a paging failure", async () => {
 render(<WalletSavedCardSharing card={card} getContext={getContext} disabled={false} />);
 await screen.findByText("Person 1");
 mocks.state.mockRejectedValueOnce(new Error("offline"));
 fireEvent.click(screen.getByRole("button", { name: "Load more shares" }));
 const retry = await screen.findByRole("button", { name: "Retry loading shares" });
 expect(screen.getByText("Person 1")).toBeInTheDocument();
 mocks.state.mockResolvedValue({ eligible: true, grants: [grant("2")], nextCursor: null });
 fireEvent.click(retry);
 await screen.findByText("Person 2");
});
it("discards a delayed page when the card changes", async () => {
 let finish!: (value: unknown) => void;
 const view = render(<WalletSavedCardSharing card={card} getContext={getContext} disabled={false} />);
 await screen.findByText("Person 1");
 mocks.state.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
 fireEvent.click(screen.getByRole("button", { name: "Load more shares" }));
 await waitFor(() => expect(finish).toBeTypeOf("function"));
 mocks.state.mockResolvedValue({ eligible: true, grants: [grant("new")], nextCursor: null });
 view.rerender(<WalletSavedCardSharing card={{ ...card, cardId: "other" }} getContext={getContext} disabled={false} />);
 await screen.findByText("Person new");
 await act(async () => finish({ eligible: true, grants: [grant("old")], nextCursor: null }));
 expect(screen.queryByText("Person old")).toBeNull();
});
it("preserves loaded history when access is revoked", async () => {
 mocks.state.mockResolvedValueOnce({ eligible: true, grants: [{ ...grant("1"), status: "active" }], nextCursor: "1" });
 mocks.revoke.mockResolvedValue({ revoked: true });
 render(<WalletSavedCardSharing card={card} getContext={getContext} disabled={false} />);
 await screen.findByText("Person 1");
 mocks.state.mockResolvedValue({ eligible: true, grants: [grant("2")], nextCursor: null });
 fireEvent.click(screen.getByRole("button", { name: "Load more shares" }));
 await screen.findByText("Person 2");
 fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
 await waitFor(() => expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull());
 expect(screen.queryByText("Access revoked")).toBeNull();
 expect(screen.getByText("Person 2")).toBeInTheDocument();
 expect(mocks.state).toHaveBeenCalledTimes(2);
});
