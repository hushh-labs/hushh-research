import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeedPaymentResult } from "@/components/feed/feed-payment-result";
import { feedPaymentSelection, isFeedPaymentMatch } from "@/lib/feed/payment-result-selection";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import type { FeedItem } from "@/lib/services/feed-service";

const source = vi.hoisted(() => ({ token: "vault" as string | null, owner: "acct_requester", checking: false, snapshot: vi.fn(), item: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "firebase-requester" }, userId: source.owner, loading: source.checking, sessionVerificationRequired: false }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultOwnerToken: source.token, getVaultOwnerToken: () => source.token }) }));
vi.mock("@/lib/services/document-request-payment-source-service", () => ({ DocumentRequestPaymentSourceService: { snapshot: source.snapshot } }));
vi.mock("@/lib/services/payout-activity-service", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/services/payout-activity-service")>(), PayoutActivityService: { item: source.item },
}));

const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const current = () => true;
const selection = { requestId: id, audience: "requester" as const };
const payment = { requestId: id, status: "paid", mode: "test", amountCents: 1000, currency: "USD", paidAt: "2026-11-19T10:00:00Z", refundStatus: null, refundAmountCents: null, reconciliationRequired: false };
const result = { id: "1", activity_group_id: `document:${id}`, event_type: "document_share_outcome", metadata: { request_id: id, feed_audience: "recipient" }, search_events: ["document_share_payment_confirmed"] } as FeedItem;

describe("Feed receipt source boundary", () => {
  beforeEach(() => { advanceVaultSessionEpoch(); source.token = "vault"; source.owner = "acct_requester"; source.checking = false; source.snapshot.mockReset(); source.item.mockReset(); });

  it("selects only a payment-only match and rechecks exact fresh workflow identity", () => {
    expect(feedPaymentSelection(result, result)).toEqual(selection);
    expect(isFeedPaymentMatch({ ...result, search_events: [] })).toBe(false);
    expect(isFeedPaymentMatch({ ...result, search_events: [...result.search_events!, "document_share_outcome"] })).toBe(false);
    expect(feedPaymentSelection(result, { ...result, metadata: { request_id: other, feed_audience: "owner" } })).toBeNull();
    expect(feedPaymentSelection(result, { ...result, activity_group_id: `document:${other}` })).toBeNull();
  });

  it("reads the exact source after delivery, labels test money, and offers no money action", async () => {
    source.snapshot.mockResolvedValue([{ ...payment, requestId: other, amountCents: 2000 }, payment]);
    render(<FeedPaymentResult selection={selection} isCurrent={current} />);
    expect(await screen.findByText("Payment confirmed")).toBeVisible();
    expect(source.snapshot).toHaveBeenCalledWith("vault", "acct_requester");
    expect(screen.getByText("Test payment")).toBeVisible();
    expect(screen.getByText("$10")).toBeVisible();
    expect(screen.queryByText("$20")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(source.item).not.toHaveBeenCalled();
  });

  it("waits for verified canonical ownership instead of reading under a Firebase identity", async () => {
    source.checking = true;
    const view = render(<FeedPaymentResult selection={selection} isCurrent={current} />);
    expect(source.snapshot).not.toHaveBeenCalled();
    source.checking = false;
    source.snapshot.mockResolvedValue([payment]);
    view.rerender(<FeedPaymentResult selection={selection} isCurrent={current} />);
    expect(await screen.findByText("$10")).toBeVisible();
    expect(source.snapshot).toHaveBeenCalledWith("vault", "acct_requester");
  });

  it("refuses absent or failed receipt sources instead of trusting the old Feed payment copy", async () => {
    source.snapshot.mockResolvedValue([{ ...payment, requestId: other }]);
    const view = render(<FeedPaymentResult selection={selection} isCurrent={current} />);
    expect(await screen.findByText("Receipt unavailable")).toBeVisible();
    expect(screen.queryByText("Payment confirmed")).not.toBeInTheDocument();
    view.unmount();
    source.snapshot.mockRejectedValue(new Error("Capacity exceeded"));
    render(<FeedPaymentResult selection={selection} isCurrent={current} />);
    expect(await screen.findByText("Receipt unavailable")).toBeVisible();
    expect(screen.queryByText("Payment confirmed")).not.toBeInTheDocument();
  });

  it("drops receipt responses after lock and clears already displayed money", async () => {
    let finish!: (rows: unknown[]) => void;
    source.snapshot.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const view = render(<FeedPaymentResult selection={selection} isCurrent={current} />);
    act(() => { source.token = null; advanceVaultSessionEpoch(); });
    await act(async () => finish([payment]));
    expect(screen.getByRole("button", { name: "Unlock to view" })).toBeVisible();
    expect(screen.queryByText("$10")).not.toBeInTheDocument();
    source.snapshot.mockResolvedValue([payment]);
    act(() => { source.token = "new-vault"; advanceVaultSessionEpoch(); });
    view.rerender(<FeedPaymentResult selection={selection} isCurrent={current} />);
    expect(await screen.findByText("$10")).toBeVisible();
    act(() => { source.token = null; advanceVaultSessionEpoch(); });
    expect(screen.queryByText("$10")).not.toBeInTheDocument();
  });

  it("uses the exact owner's earning source and requires its money mode", async () => {
    const earning = { id: `earning:${id}`, kind: "earning", status: "credited", mode: "test", coins: 911, request: null, breakdown: null, stages: [], cashOut: null, review: null, reference: null };
    source.item.mockResolvedValueOnce(earning);
    const view = render(<FeedPaymentResult selection={{ requestId: id, audience: "owner" }} isCurrent={current} />);
    expect(await screen.findByText(/Test payment/)).toBeVisible();
    expect(source.item).toHaveBeenCalledWith("vault", `earning:${id}`);
    expect(source.snapshot).not.toHaveBeenCalled();
    view.unmount();
    source.item.mockResolvedValueOnce({ ...earning, mode: null });
    render(<FeedPaymentResult selection={{ requestId: id, audience: "owner" }} isCurrent={current} />);
    expect(await screen.findByText("Receipt unavailable")).toBeVisible();
  });
});
