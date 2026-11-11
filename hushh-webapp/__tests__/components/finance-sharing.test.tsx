import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { mapPortfolioToDashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
const mocks = vi.hoisted(() => ({ mobile: false, activeRecipientRefs: vi.fn(), recipient: vi.fn(), ownerConfig: vi.fn(), capture: vi.fn(), recipients: vi.fn(), prepare: vi.fn(), publish: vi.fn(), history: vi.fn(), stop: vi.fn(), view: vi.fn(), decrypt: vi.fn(), review: vi.fn(), saved: vi.fn() }));
const context = { userId: "owner", vaultKey: "synthetic-key", vaultOwnerToken: "synthetic-consent", getIdToken: async () => "synthetic-token", isCurrent: () => true };
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => mocks.mobile }));
vi.mock("next/navigation", () => ({ usePathname: () => "/one/kai", useSearchParams: () => new URLSearchParams("tab=portfolio") }));
vi.mock("@/lib/finance-sharing/use-finance-share-context", () => ({ useFinanceShareContext: () => ({ capture: mocks.capture, session: "owner:1", ready: true }) }));
vi.mock("@/lib/services/finance-sharing-service", () => ({ FinanceSharingService: mocks, pendingFinanceShare: () => null }));
vi.mock("@/lib/finance-sharing/saved-source", () => ({ readSavedFinance: mocks.saved }));
vi.mock("@/components/app-ui/kai-control-surface", () => ({ KaiControlSurface: ({ open, title, children, footer }: { open: boolean; title: string; children: ReactNode; footer?: ReactNode }) => open ? <section role="dialog" aria-label={title}><h1>{title}</h1>{children}{footer}</section> : null }));
vi.mock("@/components/app-ui/shell-action-surface", () => ({ ShellActionSurface: ({ children, onClick, disabled }: { children: ReactNode; onClick?: () => void; disabled?: boolean }) => <button disabled={disabled} onClick={onClick}>{children}</button> }));
vi.mock("@/components/kai/sharing/finance-sharing-preview", () => ({ FinanceSharingPreview: ({ projection, section }: { projection: unknown; section?: string }) => !section || section === "portfolio" ? <pre>{JSON.stringify(projection)}</pre> : null }));
import { FinanceShareFlow } from "@/components/kai/sharing/finance-share-flow";
import { FinancePortfolioSharing } from "@/components/kai/sharing/finance-portfolio-sharing";
import { FinanceSharedDetail } from "@/components/kai/sharing/finance-shared-detail";
import { FinanceSharingManager } from "@/components/kai/sharing/finance-sharing-manager";
import { unwindBackLayer } from "@/lib/navigation/back-layers";
import { PERSON_PROFILE_PREVIEW_EVENT } from "@/lib/connections/person-profile-preview";

function goToAccess() {
  for (let index = 0; index < 2; index++) {
    const next = screen.queryByRole("button", { name: "Continue", exact: true });
    if (next) fireEvent.click(next);
  }
}
function openPreview() {
  goToAccess();
  fireEvent.click(screen.getByRole("button", { name: "Preview", exact: true }));
}

const model = mapPortfolioToDashboardViewModel({ total_value: 10000, holdings: [{ symbol: "AAPL", name: "Apple", quantity: 10, price: 1000, market_value: 10000 }] });
const source = { kind: "statement" as const, snapshotId: "selected" };
const policy = { version: 1, mode: "snapshot", sections: ["note"], selectionHash: "a".repeat(64), showAmounts: false, model_processing: { version: 1, allowed: true }, durationSeconds: 3600 };
const grant = { id: "grant", requestId: "request", recipientUserId: "recipient", recipientName: "Recipient", senderName: "Owner", policy, direction: "received", status: "active", revision: 1, contentHash: "a".repeat(64), createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z", serverNow: "2026-10-27T00:00:00Z", expiresAt: null };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(window.matchMedia).mockImplementation(query => ({ matches: false, media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }));
  mocks.mobile = false;
  mocks.capture.mockReturnValue(context);
  mocks.activeRecipientRefs.mockResolvedValue(new Set());
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  mocks.recipients.mockResolvedValue({ items: [{ userId: "recipient", publicPersonRef: "person", keyId: "key", publicKeyJwk: {}, displayName: "Synthetic connection" }], hasMore: false });
  mocks.history.mockResolvedValue({ items: [], nextCursor: null });
  mocks.saved.mockResolvedValue({ model, source, sourceFence: "a".repeat(64) });
  mocks.view.mockResolvedValue(grant);
  mocks.decrypt.mockResolvedValue({ schema: "finance-share-v1", source: "statement", sourcePeriod: null, note: "decrypted-sentinel" });
  mocks.review.mockResolvedValue("derived-review-sentinel");
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("opens a recipient portrait without changing the sharing selection", async () => {
  const opened = vi.fn((event: Event) => event.preventDefault());
  window.addEventListener(PERSON_PROFILE_PREVIEW_EVENT, opened);
  try {
    const { container } = render(<FinanceShareFlow open onOpenChange={vi.fn()} model={model} source={source} />);
    const checkbox = await screen.findByRole("checkbox", { name: "Synthetic connection" });
    const avatar = container.querySelector<HTMLButtonElement>("[data-avatar-size] button") ?? container.querySelector<HTMLButtonElement>("button[data-avatar-size]");
    expect(avatar).not.toBeNull();
    fireEvent.click(avatar!);
    expect(checkbox).not.toBeChecked();
    expect((opened.mock.calls[0][0] as CustomEvent).detail.userId).toBe("recipient");
    fireEvent.click(checkbox);
    fireEvent.click(avatar!);
    expect(checkbox).toBeChecked();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  } finally { window.removeEventListener(PERSON_PROFILE_PREVIEW_EVENT, opened); }
});

it("allows a recipient without a portfolio to manage received access but not create shares", async () => {
  mocks.history.mockImplementation(async (_context, direction) => ({ items: direction === "received" ? [grant] : [], nextCursor: null }));
  render(<FinancePortfolioSharing />);
  expect(screen.queryByRole("button", { name: "Ask an advisor" })).toBeNull();
  expect(screen.getByRole("button", { name: "Share portfolio" })).toBeDisabled();
  expect(screen.getByText("Add a portfolio to share.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Manage sharing" }));
  expect(await screen.findByText("Owner")).toBeVisible();
  expect(screen.queryByRole("tab", { name: "Shared by you" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "View", exact: true }));
  expect(await screen.findByText(/decrypted-sentinel/)).toBeVisible();
  expect(mocks.recipients).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
});

it("keeps existing outgoing access revocable after its portfolio is removed", async () => {
  const outgoing = { ...grant, direction: "outgoing" };
  mocks.history.mockImplementation(async (_context, direction) => ({ items: direction === "outgoing" ? [outgoing] : [], nextCursor: null }));
  mocks.stop.mockResolvedValue({});
  const view = render(<FinanceSharingManager open onOpenChange={vi.fn()} />);
  await screen.findByText("Recipient");
  view.rerender(<FinanceSharingManager open hasPortfolio={false} onOpenChange={vi.fn()} />);
  await waitFor(() => expect(screen.queryByText("Recipient")).toBeNull());
  fireEvent.click(await screen.findByRole("tab", { name: "Shared by you" }));
  await screen.findByText("Recipient");
  fireEvent.click(screen.getByRole("button", { name: "Stop sharing", exact: true }));
  const confirmation = screen.getByRole("dialog", { name: "Stop sharing with Recipient?" });
  fireEvent.click(within(confirmation).getByRole("button", { name: "Stop sharing", exact: true }));
  await waitFor(() => expect(mocks.stop).toHaveBeenCalledWith(context, "grant"));
});

it("opens the existing advisor, sharing and access-management flows from Portfolio", async () => {
  const view = () => render(<FinancePortfolioSharing model={model} source={source} />);
  view();
  expect(screen.queryByRole("button", { name: "Ask an advisor" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Share portfolio" }));
  expect(screen.getByRole("dialog", { name: "Share Finance" })).toBeTruthy();
  cleanup();
  view();
  fireEvent.click(screen.getByRole("button", { name: "Manage sharing" }));
  expect(screen.getByRole("dialog", { name: "Finance sharing" })).toBeTruthy();
  await waitFor(() => expect(mocks.history).toHaveBeenCalled());
});

it.each([false, true])("uses the same controls for an advisor, with Always available (model review: %s)", async allowModel => {
  mocks.recipients.mockResolvedValue({ items: [
    { userId: "recipient", publicPersonRef: "person", keyId: "key", publicKeyJwk: {}, displayName: "Advisor", isFinanceAdvisor: true },
    { userId: "other", publicPersonRef: "other", keyId: "other-key", publicKeyJwk: {}, displayName: "Other person", isFinanceAdvisor: false },
  ], hasMore: false });
  mocks.prepare.mockResolvedValue({ requestId: "request" });
  mocks.publish.mockResolvedValue({ items: [{ requestId: "request", status: "active" }] });
  render(<FinanceShareFlow open onOpenChange={vi.fn()} model={model} source={source} />);
  expect(await screen.findByLabelText("Verified advisor")).toBeTruthy();
  fireEvent.click(await screen.findByRole("checkbox", { name: /^Advisor/ }));
  expect(screen.getByRole("checkbox", { name: /^Other person/ })).toBeTruthy();
  goToAccess();
  fireEvent.change(screen.getByLabelText("Access ends"), { target: { value: "until_stopped" } });
  if (allowModel) fireEvent.click(screen.getByRole("checkbox", { name: "Allow their Agent One to review" }));
  fireEvent.click(screen.getByRole("button", { name: "Preview", exact: true }));
  fireEvent.click(await screen.findByRole("button", { name: "Share with 1 person" }));
  await waitFor(() => expect(mocks.publish).toHaveBeenCalled());
  expect(mocks.prepare.mock.calls[0][3]).toMatchObject({ version: 3, purpose: "verified_ria_share", mode: "snapshot", durationSeconds: null, sections: ["allocation", "performance"], showAmounts: false, model_processing: { allowed: allowModel } });
});

it("supports a custom connection duration and blocks invalid values before preview", async () => {
  render(<FinanceShareFlow open onOpenChange={vi.fn()} model={model} source={source} />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /^Synthetic connection/ }));
  goToAccess();
  expect(screen.queryByRole("option", { name: "Always", exact: true })).toBeNull();
  fireEvent.change(screen.getByLabelText("Access ends"), { target: { value: "custom" } });
  fireEvent.change(screen.getByLabelText("Duration amount"), { target: { value: "999" } });
  expect(screen.getByRole("button", { name: "Preview", exact: true })).toBeDisabled();
  expect(mocks.prepare).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Duration amount"), { target: { value: "3" } });
  fireEvent.change(screen.getByLabelText("Duration unit"), { target: { value: "3600" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview", exact: true }));
  expect(await screen.findByText("After 3 hours")).toBeTruthy();
});

it("does not report an ended confirmation as active sharing", async () => {
  mocks.prepare.mockResolvedValue({ requestId: "request" });
  mocks.publish.mockResolvedValue({ items: [{ requestId: "request", status: "stopped" }] });
  render(<FinanceShareFlow open onOpenChange={vi.fn()} model={model} source={source} />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /^Synthetic connection/ }));
  openPreview();
  fireEvent.click(await screen.findByRole("button", { name: "Share with 1 person" }));
  expect(await screen.findByRole("heading", { name: "Sharing ended" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Finance shared" })).toBeNull();
});

it("opens an advisor snapshot in the recipient account without offering AI processing", async () => {
  const advisorGrant = { ...grant, policy: { version: 2, purpose: "verified_ria_review", mode: "snapshot", sections: ["allocation", "performance", "holdings"], selectionHash: "a".repeat(64), showAmounts: true, model_processing: { version: 1, allowed: false }, durationSeconds: 3600 }, expiresAt: "2026-10-27T01:00:00Z" };
  mocks.view.mockResolvedValue(advisorGrant);
  mocks.decrypt.mockResolvedValue({ schema: "finance-share-v2", source: "statement", sourcePeriod: null, allocation: [], performance: { balanceChangePct: null, unit: "USD", history: [] }, holdings: [], cashBalance: { value: 100, currency: "USD" } });
  render(<FinanceSharedDetail grantId="grant" onClose={vi.fn()} />);
  expect(await screen.findByRole("tab", { name: "Portfolio" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Review with Agent One" })).toBeNull();
});

it("requires the exact preview and explicit confirmation, with synchronous duplicate-send protection", async () => {
  let complete!: (value: unknown) => void;
  mocks.prepare.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  mocks.publish.mockResolvedValue({ items: [{ requestId: "request", status: "active" }] });
  render(<FinanceShareFlow open onOpenChange={vi.fn()} model={model} source={source} />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /^Synthetic connection/ }));
  goToAccess();
  expect(screen.getByRole("checkbox", { name: /^Show dollar amounts/ })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: /^Allow their Agent One/ })).not.toBeChecked();
  expect(mocks.publish).not.toHaveBeenCalled();
  openPreview();
  const send = await screen.findByRole("button", { name: "Share with 1 person" });
  expect(mocks.publish).not.toHaveBeenCalled();
  act(() => { fireEvent.click(send); fireEvent.click(send); });
  await waitFor(() => expect(mocks.prepare).toHaveBeenCalledTimes(1));
  await act(async () => { complete({ requestId: "request" }); });
  await screen.findByRole("heading", { name: "Finance shared" });
  expect(mocks.publish).toHaveBeenCalledTimes(1);
});

it("unwinds the reviewed sharing layer before Portfolio and releases it on unmount", async () => {
  const view = render(<FinanceShareFlow open onOpenChange={vi.fn()} model={model} source={source} />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /^Synthetic connection/ }));
  openPreview();
  await screen.findByRole("heading", { name: "Review before sharing" });
  act(() => { expect(unwindBackLayer("/one/kai", new URLSearchParams("tab=portfolio"))).toBe(true); });
  expect(screen.getByRole("heading", { name: "Share Finance" })).toBeVisible();
  expect(mocks.publish).not.toHaveBeenCalled();
  view.unmount();
  expect(unwindBackLayer("/one/kai", new URLSearchParams("tab=portfolio"))).toBe(false);
});

it.each(["expired", "stopped"])("clears decrypted contents and derived review when a viewed share becomes %s", async status => {
  vi.useFakeTimers();
  render(<FinanceSharedDetail grantId="grant" onClose={vi.fn()} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getByText(/decrypted-sentinel/)).toBeVisible();
  expect(mocks.review).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Review with Agent One" })); });
  expect(screen.getByText("derived-review-sentinel")).toBeVisible();
  mocks.view.mockResolvedValue({ ...grant, status });
  await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
  expect(screen.queryByText(/decrypted-sentinel/)).toBeNull();
  expect(screen.queryByText("derived-review-sentinel")).toBeNull();
  expect(screen.getByRole("alert")).toHaveTextContent(status === "expired" ? "expired" : "stopped");
});

it("renders the Agent One review as formatted text instead of raw markdown", async () => {
  mocks.review.mockResolvedValue(["Here is the snapshot:", "", "- **Mostly equities**: 80% stocks", "- **Known limit**: history is incomplete"].join("\n"));
  render(<FinanceSharedDetail grantId="grant" onClose={vi.fn()} />);
  await screen.findByText(/decrypted-sentinel/);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Review with Agent One" })); });
  expect(screen.getByText("Mostly equities").tagName).toBe("STRONG");
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(document.body.textContent).not.toContain("**");
});

it("returns from allocation to the portfolio before closing the shared view", async () => {
  const close = vi.fn();
  render(<FinanceSharedDetail grantId="grant" onClose={close} />);
  await screen.findByText(/decrypted-sentinel/);
  fireEvent.click(screen.getByRole("tab", { name: "Allocation" }));
  expect(screen.getByRole("tab", { name: "Allocation" })).toHaveAttribute("aria-selected", "true");
  act(() => { expect(unwindBackLayer("/one/kai", new URLSearchParams("tab=portfolio"))).toBe(true); });
  expect(screen.getByRole("tab", { name: "Portfolio" })).toHaveAttribute("aria-selected", "true");
  expect(close).not.toHaveBeenCalled();
  act(() => { expect(unwindBackLayer("/one/kai", new URLSearchParams("tab=portfolio"))).toBe(true); });
  expect(close).toHaveBeenCalledOnce();
});

it("selects and clears every stock with one button", async () => {
  const two = mapPortfolioToDashboardViewModel({ total_value: 20000, holdings: [
    { symbol: "AAPL", name: "Apple", quantity: 10, price: 1000, market_value: 10000 },
    { symbol: "MSFT", name: "Microsoft", quantity: 10, price: 1000, market_value: 10000 },
  ] });
  render(<FinanceShareFlow open onOpenChange={vi.fn()} model={two} source={source} />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /^Synthetic connection/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue", exact: true }));
  fireEvent.click(await screen.findByRole("checkbox", { name: /^Selected stocks/ }));
  fireEvent.click(screen.getByRole("button", { name: "Select all" }));
  expect(screen.getByRole("checkbox", { name: /^AAPL/ })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: /^MSFT/ })).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
  expect(screen.getByRole("checkbox", { name: /^AAPL/ })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: /^MSFT/ })).not.toBeChecked();
});

it("does not append a late outgoing page after the owner switches to received shares", async () => {
  let finish!: (value: unknown) => void;
  mocks.history.mockImplementation(async (_context, direction, cursor) => cursor ? new Promise(resolve => { finish = resolve; }) : ({ items: [{ ...grant, id: direction, recipientName: direction, senderName: direction }], nextCursor: direction === "outgoing" ? "next" : null }));
  render(<FinanceSharingManager open onOpenChange={vi.fn()} />);
  await screen.findByText("outgoing");
  fireEvent.click(screen.getByRole("button", { name: "More shares" }));
  fireEvent.click(screen.getByRole("tab", { name: "Shared with you" }));
  await screen.findByText("received");
  await act(async () => { finish({ items: [{ ...grant, id: "late", recipientName: "Late outgoing", senderName: "Late outgoing" }], nextCursor: null }); });
  expect(screen.queryByText("Late outgoing")).toBeNull();
});

it("keeps selections through all three sharing steps and preview Back without publishing", async () => {
  mocks.mobile = true;
  const close = vi.fn();
  render(<FinanceShareFlow open onOpenChange={close} model={model} source={source} />);
  const next = screen.getByRole("button", { name: "Continue" });
  expect(next).toBeDisabled();
  fireEvent.click(await screen.findByRole("checkbox", { name: /^Synthetic connection/ }));
  expect(screen.queryByRole("heading", { name: "Access" })).toBeNull();
  fireEvent.click(next);
  await waitFor(() => expect(screen.getByRole("heading", { name: "What do you want to share?" })).toHaveFocus());
  expect(screen.queryByRole("heading", { name: "Access" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Continue", exact: true }));
  await waitFor(() => expect(screen.getByRole("heading", { name: "Access" })).toHaveFocus());
  expect(mocks.saved).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox", { name: /^Show dollar amounts/ }));
  openPreview();
  await screen.findByRole("heading", { name: "Review before sharing" });
  act(() => { unwindBackLayer("/one/kai", new URLSearchParams("tab=portfolio")); });
  expect(screen.getByRole("checkbox", { name: /^Show dollar amounts/ })).toBeChecked();
  act(() => { unwindBackLayer("/one/kai", new URLSearchParams("tab=portfolio")); });
  expect(screen.getByRole("heading", { name: "What do you want to share?" })).toBeVisible();
  act(() => { unwindBackLayer("/one/kai", new URLSearchParams("tab=portfolio")); });
  expect(screen.getByRole("checkbox", { name: /^Synthetic connection/ })).toBeChecked();
  expect(close).not.toHaveBeenCalled();
  expect(mocks.publish).not.toHaveBeenCalled();
});

it("uses the other person's identity in either sharing direction @feature_connected_profiles", async () => {
  mocks.history.mockImplementation(async (_context, direction) => ({ items: [{ ...grant, direction, ownerUserId: "sender", recipientPersonRef: "recipient-public" }], nextCursor: null }));
  const preview = vi.fn(); window.addEventListener("hussh:person-profile-preview", preview);
  try {
    render(<FinanceSharingManager open onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "View Recipient's profile" }));
    expect(preview.mock.calls[0][0].detail).toMatchObject({ personRef: "recipient-public", userId: "recipient" });
    fireEvent.click(screen.getByRole("tab", { name: "Shared with you" }));
    fireEvent.click(await screen.findByRole("button", { name: "View Owner's profile" }));
    expect(preview.mock.calls[1][0].detail.userId).toBe("sender");
    expect(preview.mock.calls[1][0].detail.personRef).toBeUndefined();
    expect(mocks.stop).not.toHaveBeenCalled(); expect(mocks.decrypt).not.toHaveBeenCalled();
  } finally { window.removeEventListener("hussh:person-profile-preview", preview); }
});

it("appends repeat shares under one person while retaining each approved view and stop control", async () => {
  mocks.history.mockImplementation(async (_context, direction) => ({ items: direction === "outgoing" ? [
    { ...grant, id: "older", status: "stopped", ownerUserId: "owner", direction: "outgoing", createdAt: "2026-10-26T00:00:00Z" },
    { ...grant, id: "newer", ownerUserId: "owner", direction: "outgoing", createdAt: "2026-10-28T00:00:00Z" },
  ] : [], nextCursor: null }));
  render(<FinanceSharingManager open onOpenChange={vi.fn()} />);
  await screen.findByText("Earlier shares (1)");
  expect(screen.getAllByTestId("finance-sharing-person")).toHaveLength(1);
  expect(screen.getAllByRole("heading", { name: "Recipient" })).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "View", exact: true })).toHaveLength(1);
  fireEvent.click(screen.getByText("Earlier shares (1)"));
  expect(document.querySelectorAll("[data-finance-grant]")).toHaveLength(2);
});

it("keeps people with active access out of Share portfolio", async () => {
  mocks.activeRecipientRefs.mockResolvedValue(new Set(["person"]));
  render(<FinanceShareFlow open onOpenChange={vi.fn()} model={model} source={source} />);
  await waitFor(() => expect(mocks.activeRecipientRefs).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByRole("checkbox", { name: /^Synthetic connection/ })).toBeNull());
  expect(screen.getByRole("button", { name: "Manage sharing" })).toBeTruthy();
});

it("opens existing owner access in Manage sharing and requires preview before updating", async () => {
  const existing = { ...grant, ownerUserId: "owner", recipientPersonRef: "person", direction: "outgoing" };
  mocks.history.mockResolvedValue({ items: [existing], nextCursor: null });
  mocks.view.mockResolvedValue(existing);
  mocks.ownerConfig.mockResolvedValue({ source, sourceFence: "a".repeat(64), selection: { sections: ["allocation"], holdingSymbols: [], showAmounts: false, note: "" } });
  mocks.recipient.mockResolvedValue({ userId: "recipient", publicPersonRef: "person", displayName: "Recipient", keyId: "key", publicKeyJwk: {} });
  const latestSource = { ...source, snapshotId: "latest-active-source" };
  mocks.saved.mockImplementation(async (_context, chosen) => ({ model, source: chosen, sourceFence: "b".repeat(64) }));
  render(<FinanceSharingManager open preferredSource={latestSource} onOpenChange={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Update access", exact: true }));
  await screen.findByRole("dialog", { name: "Update access", exact: true });
  expect(mocks.saved).toHaveBeenCalledWith(context, latestSource);
  expect(mocks.publish).not.toHaveBeenCalled();
  expect(screen.getByRole("checkbox", { name: "Allocation", exact: true })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Performance", exact: true })).not.toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Continue", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Preview", exact: true }));
  await screen.findByRole("dialog", { name: "Review before sharing" });
  expect(mocks.publish).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Update access", exact: true })).toBeTruthy();
});
