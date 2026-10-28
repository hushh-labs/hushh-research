import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { mapPortfolioToDashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
const mocks = vi.hoisted(() => ({ capture: vi.fn(), recipients: vi.fn(), prepare: vi.fn(), publish: vi.fn(), history: vi.fn(), view: vi.fn(), decrypt: vi.fn(), review: vi.fn(), saved: vi.fn() }));
const context = { userId: "owner", vaultKey: "synthetic-key", vaultOwnerToken: "synthetic-consent", getIdToken: async () => "synthetic-token", isCurrent: () => true };
vi.mock("next/navigation", () => ({ usePathname: () => "/one/kai", useSearchParams: () => new URLSearchParams("tab=portfolio") }));
vi.mock("@/lib/finance-sharing/use-finance-share-context", () => ({ useFinanceShareContext: () => ({ capture: mocks.capture, session: "owner:1", ready: true }) }));
vi.mock("@/lib/services/finance-sharing-service", () => ({ FinanceSharingService: mocks, pendingFinanceShare: () => null }));
vi.mock("@/lib/finance-sharing/saved-source", () => ({ readSavedFinance: mocks.saved }));
vi.mock("@/components/app-ui/kai-control-surface", () => ({ KaiControlSurface: ({ open, title, children, footer }: { open: boolean; title: string; children: ReactNode; footer?: ReactNode }) => open ? <section role="dialog" aria-label={title}><h1>{title}</h1>{children}{footer}</section> : null }));
vi.mock("@/components/app-ui/shell-action-surface", () => ({ ShellActionSurface: ({ children, onClick, disabled }: { children: ReactNode; onClick?: () => void; disabled?: boolean }) => <button disabled={disabled} onClick={onClick}>{children}</button> }));
vi.mock("@/components/kai/sharing/finance-sharing-preview", () => ({ FinanceSharingPreview: ({ projection }: { projection: unknown }) => <pre>{JSON.stringify(projection)}</pre> }));
import { FinanceShareFlow } from "@/components/kai/sharing/finance-share-flow";
import { FinanceSharedDetail } from "@/components/kai/sharing/finance-shared-detail";
import { FinanceSharingManager } from "@/components/kai/sharing/finance-sharing-manager";
import { unwindBackLayer } from "@/lib/navigation/back-layers";

const model = mapPortfolioToDashboardViewModel({ total_value: 10000, holdings: [{ symbol: "AAPL", name: "Apple", quantity: 10, price: 1000, market_value: 10000 }] });
const source = { kind: "statement" as const, snapshotId: "selected" };
const policy = { version: 1, mode: "snapshot", sections: ["note"], selectionHash: "a".repeat(64), showAmounts: false, model_processing: { version: 1, allowed: true }, durationSeconds: 3600 };
const grant = { id: "grant", requestId: "request", recipientUserId: "recipient", recipientName: "Recipient", senderName: "Owner", policy, direction: "received", status: "active", revision: 1, contentHash: "a".repeat(64), createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z", serverNow: "2026-10-27T00:00:00Z", expiresAt: null };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.capture.mockReturnValue(context);
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  mocks.recipients.mockResolvedValue({ items: [{ userId: "recipient", publicPersonRef: "person", keyId: "key", publicKeyJwk: {}, displayName: "Synthetic connection" }], hasMore: false });
  mocks.history.mockResolvedValue({ items: [], nextCursor: null });
  mocks.saved.mockResolvedValue({ model, source, sourceFence: "a".repeat(64) });
  mocks.view.mockResolvedValue(grant);
  mocks.decrypt.mockResolvedValue({ schema: "finance-share-v1", source: "statement", sourcePeriod: null, note: "decrypted-sentinel" });
  mocks.review.mockResolvedValue("derived-review-sentinel");
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("requires the exact preview and explicit confirmation, with synchronous duplicate-send protection", async () => {
  let complete!: (value: unknown) => void;
  mocks.prepare.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  mocks.publish.mockResolvedValue({ items: [{ requestId: "request" }] });
  render(<FinanceShareFlow open onOpenChange={vi.fn()} model={model} source={source} />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /^Synthetic connection/ }));
  expect(screen.getByRole("checkbox", { name: /^Show dollar amounts/ })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: /^Allow their private agent/ })).not.toBeChecked();
  expect(mocks.publish).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Preview", exact: true }));
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
  fireEvent.click(screen.getByRole("button", { name: "Preview", exact: true }));
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
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Review with my private agent" })); });
  expect(screen.getByText("derived-review-sentinel")).toBeVisible();
  mocks.view.mockResolvedValue({ ...grant, status });
  await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
  expect(screen.queryByText(/decrypted-sentinel/)).toBeNull();
  expect(screen.queryByText("derived-review-sentinel")).toBeNull();
  expect(screen.getByRole("alert")).toHaveTextContent(status === "expired" ? "expired" : "stopped");
});

it("does not append a late outgoing page after the owner switches to received shares", async () => {
  let finish!: (value: unknown) => void;
  mocks.history.mockImplementation(async (_context, direction, cursor) => cursor ? new Promise(resolve => { finish = resolve; }) : ({ items: [{ ...grant, id: direction, recipientName: direction, senderName: direction }], nextCursor: direction === "outgoing" ? "next" : null }));
  render(<FinanceSharingManager open onOpenChange={vi.fn()} />);
  await screen.findByText("outgoing");
  fireEvent.click(screen.getByRole("button", { name: "More shares" }));
  fireEvent.click(screen.getByRole("button", { name: "Shared with you" }));
  await screen.findByText("received");
  await act(async () => { finish({ items: [{ ...grant, id: "late", recipientName: "Late outgoing", senderName: "Late outgoing" }], nextCursor: null }); });
  expect(screen.queryByText("Late outgoing")).toBeNull();
});
