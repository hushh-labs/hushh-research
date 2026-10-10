import { beforeEach, describe, expect, it, vi } from "vitest";

const apiJson = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/api-client", () => ({ apiJson }));

import { DocumentPayoutService } from "@/lib/services/document-payout-service";

describe("aggregate bank payout status", () => {
  beforeEach(() => apiJson.mockReset());

  it("reads signed Stripe payout projections with vault auth", async () => {
    const response = { currency: "USD", payouts: [{
      id: "po_1", amountCents: 911, status: "paid", expectedArrivalAt: null, failureCode: null,
    }] };
    apiJson.mockResolvedValueOnce(response);
    expect(await DocumentPayoutService.bankPayouts("vault")).toEqual(response);
    expect(apiJson).toHaveBeenCalledWith("/api/one/payouts/account/bank-payouts", {
      headers: { Authorization: "Bearer vault" }, cache: "no-store",
    });
  });

  it("rejects malformed payout claims", async () => {
    apiJson.mockResolvedValueOnce({ currency: "USD", payouts: [{
      id: "po_1", amountCents: 911, status: "deposited", expectedArrivalAt: null, failureCode: null,
    }] });
    await expect(DocumentPayoutService.bankPayouts("vault")).rejects.toThrow("Invalid bank payout response");
    apiJson.mockResolvedValueOnce({ currency: "USD", payouts: [{
      id: "po_1", amountCents: -1, status: "paid", expectedArrivalAt: null, failureCode: null,
    }] });
    await expect(DocumentPayoutService.bankPayouts("vault")).rejects.toThrow("Invalid bank payout response");
  });
});

const requestId = "11111111-1111-4111-8111-111111111111";
const nextId = "22222222-2222-4222-8222-222222222222";
const wallet = () => ({
  coinName: "Hussh Coins", coinsPerDollar: 100, currency: "USD", payoutMode: "test", testPayouts: true, liveRedemptionEnabled: false, maxRedeemCoins: 50000,
  live: { balanceCoins: 911, reservedCoins: 0, availableCoins: 911, amountCents: 911, held: false },
  sandbox: { balanceCoins: 911, reservedCoins: 911, availableCoins: 0, amountCents: 911, held: false },
  latestRedemption: null, redemptionHistory: [],
});

describe("Hussh Coins financial boundary", () => {
  beforeEach(() => apiJson.mockReset());

  it("keeps real and test balances separate and accepts held debt without showing it as spendable", async () => {
    apiJson.mockResolvedValueOnce(wallet());
    expect(await DocumentPayoutService.hashcoins("vault")).toEqual(wallet());
    const debt = { ...wallet(), live: { balanceCoins: -50, amountCents: -50, reservedCoins: 0, availableCoins: 0, held: true } };
    apiJson.mockResolvedValueOnce(debt);
    expect(await DocumentPayoutService.hashcoins("vault")).toEqual(debt);
    for (const invalid of [
      { ...wallet(), coinsPerDollar: 1 }, { ...wallet(), liveRedemptionEnabled: true }, { ...wallet(), payoutMode: "live" },
      { ...wallet(), payoutMode: "unknown" }, { ...wallet(), testPayouts: undefined },
      { ...wallet(), sandbox: { ...wallet().sandbox, availableCoins: 911 } },
      { ...debt, live: { ...debt.live, held: false } },
    ]) {
      apiJson.mockResolvedValueOnce(invalid);
      await expect(DocumentPayoutService.hashcoins("vault")).rejects.toThrow(/Invalid Hussh Coins/);
    }
  });

  it("preserves authoritative live and disabled-sandbox modes without enabling cash redemption", async () => {
    const live = { ...wallet(), payoutMode: "live", testPayouts: false };
    apiJson.mockResolvedValueOnce(live);
    expect(await DocumentPayoutService.hashcoins("vault")).toEqual(live);
    const disabled = { ...wallet(), testPayouts: false };
    apiJson.mockResolvedValueOnce(disabled);
    expect(await DocumentPayoutService.hashcoins("vault")).toEqual(disabled);
  });

  it("forces test redemption, preserves the retry key, and rejects live transfer claims", async () => {
    const result = { id: requestId, clientRequestId: nextId, amountCoins: 911, status: "unknown", stripeMode: "test" };
    apiJson.mockResolvedValueOnce(result);
    expect(await DocumentPayoutService.redeemTest("vault", 911, nextId)).toEqual(result);
    expect(apiJson).toHaveBeenLastCalledWith("/api/one/payouts/hashcoins/redeem", expect.objectContaining({
      method: "POST", headers: { Authorization: "Bearer vault", "Content-Type": "application/json" },
      body: JSON.stringify({ amountCoins: 911, clientRequestId: nextId, mode: "test" }),
    }));
    apiJson.mockResolvedValueOnce({ ...result, stripeMode: "live" });
    await expect(DocumentPayoutService.redeemTest("vault", 911, nextId)).rejects.toThrow("Invalid Hussh Coins redemption");
    await expect(DocumentPayoutService.redeemTest("vault", 0.5, nextId)).rejects.toThrow("Invalid test redemption");
    await expect(DocumentPayoutService.redeemTest("", 911, nextId)).rejects.toThrow(/Unlock/);
  });
});

const earning = () => ({
  requestId, description: "Bank statements", status: "awaiting_fee",
  grossAmountCents: 1000, refundAmountCents: 500, platformFeeCents: 15,
  processingFeeCents: null, netAmountCents: null, reversedAmountCents: null,
  createdAt: "2026-10-10T12:00:00Z", transferredAt: null,
  expectedFiles: 2, confirmedFiles: 1,
});

describe("payout account and earnings boundary", () => {
  beforeEach(() => apiJson.mockReset());

  it("projects only account readiness and rejects unsupported money links", async () => {
    const account = { detailsSubmitted: true, transfersEnabled: true, payoutsEnabled: true, ready: true, status: "ready" };
    apiJson.mockResolvedValueOnce({ account: { ...account, stripeAccountId: "acct_private" } });
    expect(await DocumentPayoutService.account("vault")).toEqual({ account });
    for (const url of ["https://evil.invalid", "http://connect.stripe.com", "https://private@connect.stripe.com", "https://connect.stripe.com:1234",
      "https://stripe.com.evil.invalid/express/acct_owner", "https://stripe.com/payments", "http://stripe.com/express/acct_owner",
      "https://private@stripe.com/express/acct_owner", "https://stripe.com:1234/express/acct_owner",
      "https://connect.stripe.com/setup/safe_link", "https://stripe.com/express/", "https://connect.stripe.com/express/", "not-a-url"]) {
      apiJson.mockResolvedValueOnce({ url });
      await expect(DocumentPayoutService.manage("vault")).rejects.toThrow("Invalid payout link");
    }
    for (const url of ["https://connect.stripe.com/express/test", "https://stripe.com/express/acct_owner/login_token"]) {
      apiJson.mockResolvedValueOnce({ url, accountId: "acct_private" });
      expect(await DocumentPayoutService.manage("vault")).toEqual({ url });
    }
    expect(apiJson).toHaveBeenLastCalledWith("/api/one/payouts/account/manage", {
      method: "POST", headers: { Authorization: "Bearer vault" }, cache: "no-store",
    });
    apiJson.mockResolvedValueOnce({ url: "https://connect.stripe.com/setup/safe_link" });
    expect(await DocumentPayoutService.onboard("vault")).toEqual({ url: "https://connect.stripe.com/setup/safe_link" });
    apiJson.mockResolvedValueOnce({ url: "https://stripe.com/express/acct_owner/login_token" });
    await expect(DocumentPayoutService.onboard("vault")).rejects.toThrow("Invalid payout link");
  });

  it("keeps only masked bank details and rejects false readiness or full account numbers", async () => {
    const account = { detailsSubmitted: true, transfersEnabled: true, payoutsEnabled: true,
      ready: true, status: "ready", canManageBank: true, bankStatus: "linked",
      bank: { name: "Example Bank", last4: "6789", status: "verified" } };
    apiJson.mockResolvedValueOnce({ stripeMode: "live", account: { ...account,
      bank: { ...account.bank, routingNumber: "private", accountNumber: "private" } } });
    expect(await DocumentPayoutService.account("vault")).toEqual({ stripeMode: "live", account });
    for (const patch of [{ bankStatus: "missing" }, { bankStatus: "needs_attention" }, { bankStatus: "unavailable" },
      { bank: { ...account.bank, last4: "123456789" } }, { canManageBank: "yes" }]) {
      apiJson.mockResolvedValueOnce({ account: { ...account, ...patch } });
      await expect(DocumentPayoutService.account("vault")).rejects.toThrow("Invalid payout bank response");
    }
  });

  it("preserves test earnings labels when the active payout account is live", async () => {
    const item = { ...earning(), stripeMode: "test" };
    apiJson.mockResolvedValueOnce({ stripeMode: "live", currency: "USD", transactions: [item], nextCursor: null });
    expect(await DocumentPayoutService.earnings("vault")).toEqual({ stripeMode: "live", currency: "USD", transactions: [item], nextCursor: null });
    apiJson.mockResolvedValueOnce({ stripeMode: "live", currency: "USD", transactions: [{ ...item, stripeMode: "unknown" }], nextCursor: null });
    await expect(DocumentPayoutService.earnings("vault")).rejects.toThrow("Invalid earnings response");
  });

  it("does not promote incomplete onboarding to ready", async () => {
    apiJson.mockResolvedValueOnce({ account: { detailsSubmitted: false, transfersEnabled: true, payoutsEnabled: true, ready: true, status: "ready" } });
    await expect(DocumentPayoutService.account("vault")).rejects.toThrow("Invalid payout account response");
  });

  it("keeps unknown fees unknown and projects bounded owner earnings without Stripe IDs", async () => {
    const item = earning();
    apiJson.mockResolvedValueOnce({ currency: "USD", transactions: [{ ...item, stripeAccountId: "acct_private", stripeTransferId: "tr_private" }], nextCursor: nextId });
    expect(await DocumentPayoutService.earnings("vault")).toEqual({ currency: "USD", transactions: [item], nextCursor: nextId });
    apiJson.mockResolvedValueOnce({ currency: "USD", transactions: [], nextCursor: null });
    expect(await DocumentPayoutService.earnings("vault", nextId)).toEqual({ currency: "USD", transactions: [], nextCursor: null });
    expect(apiJson).toHaveBeenLastCalledWith(`/api/one/payouts/account/earnings?cursor=${nextId}`, {
      headers: { Authorization: "Bearer vault" }, cache: "no-store",
    });
  });

  it("rejects malformed amounts, identifiers, unbounded pages and looping cursors", async () => {
    for (const patch of [{ grossAmountCents: -1 }, { netAmountCents: 1.5 }, { description: "x".repeat(121) },
      { status: "bank_paid" }, { createdAt: "invalid" }, { confirmedFiles: 3 }, { requestId: "acct_private" }]) {
      apiJson.mockResolvedValueOnce({ currency: "USD", transactions: [{ ...earning(), ...patch }], nextCursor: null });
      await expect(DocumentPayoutService.earnings("vault")).rejects.toThrow("Invalid earnings response");
    }
    apiJson.mockResolvedValueOnce({ currency: "USD", transactions: Array(21).fill(earning()), nextCursor: null });
    await expect(DocumentPayoutService.earnings("vault")).rejects.toThrow("Invalid earnings response");
    apiJson.mockResolvedValueOnce({ currency: "USD", transactions: [], nextCursor: nextId });
    await expect(DocumentPayoutService.earnings("vault", nextId)).rejects.toThrow("Invalid earnings response");
    await expect(DocumentPayoutService.earnings("vault", "private-cursor")).rejects.toThrow("Invalid earnings cursor");
  });
});
