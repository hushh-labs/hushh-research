import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted and vi.mock are file-scoped, so each payouts test file repeats this setup.
const state = vi.hoisted(() => ({ apiJson: vi.fn(), receipts: new Map<string, unknown>() }));

vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultOwnerToken: "owner-token" }) }));
vi.mock("@/lib/vault/session-epoch", () => ({ snapshotVaultSessionEpoch: () => 1, isVaultSessionEpochCurrent: () => true }));
vi.mock("@/lib/payouts/payout-live-store", () => ({
  usePayoutFreshness: () => ({ lastSuccessAt: null, refreshing: false, failures: 0, online: true, stream: "live" }),
}));
vi.mock("@/lib/services/api-client", () => ({ apiJson: state.apiJson }));

import { PayoutReceiptSheet } from "@/components/consent/payouts/receipts/payout-receipt-sheet";
import { receiptDateTime, receiptDay } from "@/components/consent/payouts/receipts/activity-copy";
import { holdNextStepCopy, holdReasonCopy } from "@/lib/payouts/review-copy";

const requestId = "11111111-1111-4111-8111-111111111111";
const redemptionId = "22222222-2222-4222-8222-222222222222";
const at = "2026-10-10T17:04:00+00:00";
const request = { id: requestId, label: "March statements", confirmedFiles: 3, expectedFiles: 3 };
const earning = {
  id: `earning:${requestId}`, kind: "earning", status: "credited", coins: 911, reference: "HC-11111111", request,
  breakdown: { grossCents: 1000, refundCents: 0, platformFeeCents: 30, processingFeeCents: 59, netCents: 911 },
  stages: [{ stage: "paid", at }, { stage: "delivered", at }, { stage: "credited", at }],
  cashOut: { itemId: `redemption:${redemptionId}`, status: "succeeded" }, review: null,
};
const redemption = {
  id: `redemption:${redemptionId}`, kind: "redemption", status: "succeeded", mode: "live", coins: 911, amountCents: 911,
  reference: "HC-22222222", request, earning: null,
  transfer: { status: "sent", requestedAt: at, sentAt: at, completedAt: at, reference: "tr_1Private" },
  reversal: { status: "none", at: null }, funds: { status: "pending", availableOn: "2026-10-14T00:00:00+00:00" },
  bankDeposit: { id: "deposit:po_1Abc", status: "in_transit", arrivalAt: "2026-10-15T00:00:00+00:00", bank: { name: "Old Bank", last4: "1234" } },
  review: null, stripeTransferId: "tr_1Private",
};
const deposit = {
  id: "deposit:po_1Abc", kind: "deposit", status: "in_transit", amountCents: 1550, createdAt: at,
  expectedArrivalAt: "2026-10-15T00:00:00+00:00", paidAt: null, failedAt: null, failureCode: null, method: "standard",
  automatic: true, bank: { name: "Old Bank", last4: "1234" }, bankReference: "091000019876543",
  contents: { status: "complete", otherCents: 839, items: [
    { itemId: `redemption:${redemptionId}`, type: "cash_out", requestLabel: "March statements", amountCents: 911 },
    { itemId: null, type: "refund", requestLabel: null, amountCents: -200 },
  ] },
  actionRequired: null,
};
const PROVIDER_IDS = /(acct|ch|pi|tr|trr|py|po)_[A-Za-z0-9]/;
const topDialog = () => screen.getAllByRole("dialog").at(-1)!;
const row = (scope: HTMLElement, title: string) => within(scope).getByText(title).closest("[data-testid='settings-row']") as HTMLElement;

describe("payout receipts", () => {
  beforeEach(() => {
    state.receipts.clear();
    for (const receipt of [earning, redemption, deposit]) state.receipts.set(receipt.id, receipt);
    state.apiJson.mockReset().mockImplementation(async (path: string) => {
      const receipt = state.receipts.get(decodeURIComponent(path.slice("/api/one/payouts/activity/".length)));
      if (!receipt) throw Object.assign(new Error("Not found"), { name: "ApiError", status: 404 });
      return receipt;
    });
  });

  it("shows an earning's fees, stages and reference, and opens its redemption and deposit over it", async () => {
    render(<PayoutReceiptSheet itemId={`earning:${requestId}`} onOpenChange={vi.fn()} />);
    const sheet = await screen.findByRole("dialog", { name: "$9.11" });
    expect(sheet).toHaveTextContent("Earned");
    expect(row(sheet, "March statements")).toHaveTextContent("3 of 3 files delivered");
    for (const [title, value] of [["Paid", "$10.00"], ["Hussh (3%)", "−$0.30"], ["Stripe fees", "−$0.59"],
      ["Your earnings", "$9.11"], ["Hussh Coins", "911"], ["Buyer paid", receiptDateTime(at)],
      ["Files delivered", receiptDateTime(at)], ["Hussh Coins credited", receiptDateTime(at)]]) {
      expect(row(sheet, title)).toHaveTextContent(value);
    }
    expect(within(sheet).queryByText("Refund")).toBeNull();
    expect(row(sheet, "Hussh reference")).toHaveTextContent("HC-11111111");
    expect(within(sheet).getByRole("button", { name: "Copy hussh reference" })).toBeVisible();

    fireEvent.click(within(sheet).getByRole("button", { name: /^Sent to Stripe/ }));
    expect(await within(topDialog()).findByText("Requested")).toBeVisible();
    const cashOut = topDialog();
    expect(cashOut).not.toBe(sheet);
    expect(row(cashOut, "Settling in Stripe")).toHaveTextContent(`Available ${receiptDay("2026-10-14T00:00:00Z")}`);
    expect(row(cashOut, "On the way")).toHaveTextContent("Old Bank •••• 1234");
    expect(row(cashOut, "On the way")).toHaveTextContent(`Expected ${receiptDay("2026-10-15T00:00:00Z")}`);
    expect(document.body).not.toHaveTextContent(PROVIDER_IDS);

    fireEvent.click(within(cashOut).getByRole("button", { name: /^On the way/ }));
    expect(await within(topDialog()).findByText("Includes")).toBeVisible();
    const bankDeposit = topDialog();
    // The redemption that holds this deposit is already open, so it is not linked again.
    expect(within(bankDeposit).queryByRole("button", { name: /March statements/ })).toBeNull();
    expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(3);
    expect(state.apiJson.mock.calls.every(([path]) => String(path).startsWith("/api/one/payouts/activity/"))).toBe(true);
  });

  it("shows a deposit's own bank and contents, and says so when the bank was not recorded", async () => {
    const view = render(<PayoutReceiptSheet itemId="deposit:po_1Abc" onOpenChange={vi.fn()} />);
    const sheet = await screen.findByRole("dialog", { name: "$15.50" });
    expect(row(sheet, "Old Bank •••• 1234")).toBeTruthy();
    expect(row(sheet, "Bank reference")).toHaveTextContent("091000019876543");
    expect(row(sheet, "Expected")).toHaveTextContent(receiptDay("2026-10-15T00:00:00Z"));
    expect(row(sheet, "Refund")).toHaveTextContent("−$2.00");
    expect(row(sheet, "Other")).toHaveTextContent("$8.39");
    expect(within(sheet).queryByRole("button", { name: /^Refund/ })).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: /^March statements/ }));
    expect(await screen.findAllByRole("dialog", { hidden: true })).toHaveLength(2);
    expect(document.body).not.toHaveTextContent(PROVIDER_IDS);

    state.receipts.set("deposit:po_2Abc", { ...deposit, id: "deposit:po_2Abc", bank: null, bankReference: null,
      contents: { status: "pending", items: [], otherCents: 0 } });
    view.rerender(<PayoutReceiptSheet itemId="deposit:po_2Abc" onOpenChange={vi.fn()} />);
    expect(await screen.findByText("Bank not recorded")).toBeVisible();
    expect(screen.getByText("Matching deposits…")).toBeVisible();
    expect(screen.queryByText("Old Bank •••• 1234")).toBeNull();
  });

  it("says what an adjustment changed and why, and never calls an unknown state a refund", async () => {
    state.receipts.set(`reversal:${requestId}`, {
      id: `reversal:${requestId}`, kind: "adjustment", type: "earning_reversed", coins: -911, reference: "HC-11111111",
      request, at, relatedItemId: `earning:${requestId}`,
    });
    const view = render(<PayoutReceiptSheet itemId={`reversal:${requestId}`} onOpenChange={vi.fn()} />);
    const sheet = await screen.findByRole("dialog", { name: "−$9.11" });
    expect(row(sheet, "Hussh Coins removed")).toHaveTextContent("The buyer's payment was refunded, disputed or failed.");
    fireEvent.click(within(sheet).getByRole("button", { name: /^Earning/ }));
    expect(await screen.findByRole("dialog", { name: "$9.11" })).toBeVisible();

    state.receipts.set(`redemption:${redemptionId}`, { ...redemption, status: "settling_v2",
      transfer: { ...redemption.transfer, status: "settling_v2" }, reversal: { status: "partial_v2", at: null },
      funds: null, bankDeposit: null, review: { reason: "payment_disputed", nextStep: "wait_for_bank" } });
    view.rerender(<PayoutReceiptSheet itemId={`redemption:${redemptionId}`} onOpenChange={vi.fn()} />);
    const cashOut = await screen.findByRole("dialog", { name: "$9.11" });
    expect(cashOut).toHaveTextContent("Status updating");
    expect(cashOut).not.toHaveTextContent(/refund/i);
    expect(within(cashOut).getByText(holdReasonCopy("payment_disputed"))).toBeVisible();
    expect(row(cashOut, "Next step")).toHaveTextContent(holdNextStepCopy("wait_for_bank"));
  });
});
