import { beforeEach, describe, expect, it, vi } from "vitest";

const apiJson = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/api-client", () => ({ apiJson }));

import { HOLD_REASONS, holdReasonCopy } from "@/lib/payouts/review-copy";
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
const contractFailure = { name: "PayoutContractError", message: expect.stringMatching(/^Invalid Hussh Coins/) };

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
      await expect(DocumentPayoutService.hashcoins("vault")).rejects.toMatchObject(contractFailure);
    }
  });

  it("reads additive wallet changes as fewer rows or unknown states, never as another amount or mode", async () => {
    const transfer = (n: number, patch: object = {}) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      amountCoins: 911, status: "succeeded", stripeMode: "live", reversalStatus: "none", ...patch });
    const history = Array.from({ length: 12 }, (_, n) => transfer(n));
    history[0] = transfer(0, { status: "queued" });
    history[1] = transfer(1, { reversalStatus: "clawback_due" });
    history[2] = transfer(2, { stripeMode: "test" });
    history[3] = transfer(3, { amountCoins: 50001 });
    // Negative control: the server's own "unknown" stays a refund-recovery state.
    history[4] = transfer(4, { reversalStatus: "unknown" });
    const live = { ...wallet(), payoutMode: "live", testPayouts: false, liveRedemptionEnabled: true, maxRedeemCoins: 100000,
      sandbox: { ...wallet().sandbox, reservedCoins: 0, availableCoins: 911 }, redemptionHistory: history,
      latestRedemption: transfer(12, { status: "pending", amountCoins: 50001, clientRequestId: nextId }) };
    apiJson.mockResolvedValueOnce(live);
    expect(await DocumentPayoutService.hashcoins("vault")).toEqual({ ...live, maxRedeemCoins: 50000,
      live: { ...live.live, nextRedeemCoins: 0 }, latestRedemption: null, redeemBlocked: true,
      redemptionHistory: [{ ...history[0], status: "unknown" }, { ...history[1], reversalStatus: "unrecognized" }, ...history.slice(4, 10)] });

    const pending = { id: requestId, clientRequestId: nextId, amountCoins: 911, status: "pending", stripeMode: "test" };
    apiJson.mockResolvedValueOnce({ ...wallet(), maxRedeemCoins: 0, redemptionHistory: [{ ...pending, reversalStatus: "none" }],
      latestRedemption: { ...pending, status: "awaiting_bank" } });
    expect(await DocumentPayoutService.hashcoins("vault")).toEqual({ ...wallet(), maxRedeemCoins: 1,
      redemptionHistory: [pending], latestRedemption: { ...pending, status: "unknown" } });

    const sent = { id: requestId, clientRequestId: nextId, amountCoins: 911, status: "queued", stripeMode: "live", reversalStatus: "none" };
    apiJson.mockResolvedValueOnce(sent);
    expect(await DocumentPayoutService.redeemLive("vault", 911, nextId)).toEqual({ ...sent, status: "unknown" });
    for (const [patch, field] of [[{ amountCoins: 50001 }, "amountCoins"], [{ amountCoins: 1.5 }, "amountCoins"],
      [{ id: "tr_private" }, "id"], [{ clientRequestId: "retry" }, "clientRequestId"]] as const) {
      apiJson.mockResolvedValueOnce({ ...sent, ...patch });
      await expect(DocumentPayoutService.redeemLive("vault", 911, nextId)).rejects.toMatchObject({ ...contractFailure, field });
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
    await expect(DocumentPayoutService.redeemTest("vault", 911, nextId)).rejects.toMatchObject({ ...contractFailure, field: "stripeMode" });
    await expect(DocumentPayoutService.redeemTest("vault", 0.5, nextId)).rejects.toThrow("Invalid redemption");
    await expect(DocumentPayoutService.redeemTest("", 911, nextId)).rejects.toThrow(/Unlock/);
  });

  it("accepts only an explicit live wallet source and mode-matched redemption", async () => {
    const live = { ...wallet(), payoutMode: "live", testPayouts: false, liveRedemptionEnabled: true,
      live: { ...wallet().live, nextRedeemCoins: 911 }, sandbox: { ...wallet().sandbox, reservedCoins: 0, availableCoins: 911 } };
    apiJson.mockResolvedValueOnce(live);
    expect(await DocumentPayoutService.hashcoins("vault")).toEqual(live);
    for (const invalid of [
      { ...live, live: { ...live.live, nextRedeemCoins: 912 } },
      { ...live, live: { ...live.live, nextRedeemCoins: 0.5 } },
    ]) {
      apiJson.mockResolvedValueOnce(invalid);
      await expect(DocumentPayoutService.hashcoins("vault")).rejects.toMatchObject({ ...contractFailure, field: "live.nextRedeemCoins" });
    }
    const result = { id: requestId, clientRequestId: nextId, amountCoins: 911, status: "succeeded", stripeMode: "live", reversalStatus: "none" };
    apiJson.mockResolvedValueOnce(result);
    expect(await DocumentPayoutService.redeemLive("vault", 911, nextId)).toEqual(result);
    expect(apiJson).toHaveBeenLastCalledWith("/api/one/payouts/hashcoins/redeem", expect.objectContaining({
      body: JSON.stringify({ amountCoins: 911, clientRequestId: nextId, mode: "live" }),
    }));
    apiJson.mockResolvedValueOnce({ ...result, stripeMode: "test" });
    await expect(DocumentPayoutService.redeemLive("vault", 911, nextId)).rejects.toMatchObject({ ...contractFailure, field: "stripeMode" });
    apiJson.mockResolvedValueOnce({ ...result, reversalStatus: "reversed" });
    expect((await DocumentPayoutService.redeemLive("vault", 911, nextId)).reversalStatus).toBe("reversed");
    apiJson.mockResolvedValueOnce({ ...result, reversalStatus: undefined });
    await expect(DocumentPayoutService.redeemLive("vault", 911, nextId)).rejects.toMatchObject({ ...contractFailure, field: "reversalStatus" });
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

  it("requests an uncached provider check only when explicitly refreshing bank status", async () => {
    apiJson.mockResolvedValue({ account: null });
    await DocumentPayoutService.account("vault", { fresh: true });
    expect(apiJson).toHaveBeenLastCalledWith("/api/one/payouts/account?fresh=true", {
      headers: { Authorization: "Bearer vault" }, cache: "no-store",
    });
    await DocumentPayoutService.account("vault");
    expect(apiJson).toHaveBeenLastCalledWith("/api/one/payouts/account", {
      headers: { Authorization: "Bearer vault" }, cache: "no-store",
    });
  });

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

describe("payouts v2 additive fields", () => {
  beforeEach(() => apiJson.mockReset());
  const ready = { detailsSubmitted: true, transfersEnabled: true, payoutsEnabled: true, ready: true, status: "ready" };
  const verification = { state: "due", deadline: "2026-10-30T12:00:00+00:00", items: ["identity", "bank_account"],
    eventuallyDue: true, hasErrors: false, disabledReason: null };

  it("reads verification and payout schedule tolerantly, never failing the account read", async () => {
    apiJson.mockResolvedValueOnce({ account: { ...ready, verification, payoutSchedule: { interval: "daily", delayDays: 2 } } });
    expect(await DocumentPayoutService.account("vault")).toEqual({ account: { ...ready, verification,
      payoutSchedule: { interval: "daily", delayDays: 2 } } });
    apiJson.mockResolvedValueOnce({ account: { ...ready, payoutSchedule: { interval: "hourly", delayDays: 2 },
      verification: { ...verification, deadline: "soon", items: ["identity", "ownership", 7, "identity"],
        disabledReason: "rejected.fraud", hasErrors: "yes", reason: "Private provider text" } } });
    const tolerant = (await DocumentPayoutService.account("vault")).account;
    expect(tolerant?.verification).toEqual({ ...verification, deadline: null, items: ["identity", "other"],
      hasErrors: false, disabledReason: "other" });
    expect(tolerant?.payoutSchedule).toBeNull();
    expect(JSON.stringify(tolerant)).not.toContain("Private provider text");
    // A state this build can't name is ignored, as an older server's absence would be.
    apiJson.mockResolvedValueOnce({ account: { ...ready, verification: { ...verification, state: "paused_forever" } } });
    expect(await DocumentPayoutService.account("vault")).toEqual({ account: ready });
  });

  const live = (patch: object = {}) => ({ ...wallet(), payoutMode: "live", testPayouts: false, liveRedemptionEnabled: true,
    sandbox: { ...wallet().sandbox, reservedCoins: 0, availableCoins: 911 },
    live: { balanceCoins: 1500, reservedCoins: 0, availableCoins: 1500, amountCents: 1500, held: false,
      nextRedeemCoins: 911, redeemableCoins: 1499, redeemableCount: 2, remainingAfterNextCoins: 589, notRedeemableCoins: 1,
      nextRedeemSource: { requestId, label: "October statements" }, holds: [], ...patch } });

  it("keeps redeemable totals only while next <= redeemable <= available holds", async () => {
    apiJson.mockResolvedValueOnce(live());
    expect((await DocumentPayoutService.hashcoins("vault")).live).toEqual(live().live);
    for (const [patch, field] of [
      [{ redeemableCoins: 900, notRedeemableCoins: 600 }, "live.redeemableCoins"],
      [{ redeemableCoins: 1501 }, "live.redeemableCoins"],
      [{ redeemableCoins: 1499.5 }, "live.redeemableCoins"],
      [{ redeemableCount: 0 }, "live.redeemableCount"],
      [{ remainingAfterNextCoins: 1500 }, "live.remainingAfterNextCoins"],
      [{ notRedeemableCoins: 0 }, "live.notRedeemableCoins"],
    ] as const) {
      apiJson.mockResolvedValueOnce(live(patch));
      await expect(DocumentPayoutService.hashcoins("vault")).rejects.toMatchObject({ ...contractFailure, field });
    }
  });

  it("reads holds as closed review codes and drops rows it can't read", async () => {
    const hold = { id: `earning:${requestId}`, reason: "payment_disputed", nextStep: "wait_for_bank", coins: 911,
      requestId, requestLabel: "October statements", since: "2026-10-10T12:00:00+00:00" };
    apiJson.mockResolvedValueOnce(live({ held: true, availableCoins: 0, nextRedeemCoins: 0, redeemableCoins: 0,
      redeemableCount: 0, remainingAfterNextCoins: 0, notRedeemableCoins: 0,
      nextRedeemSource: { requestId, label: null },
      holds: [hold, hold, { ...hold, id: `redemption:${nextId}`, reason: "chargeback_text", nextStep: "call_bank",
        requestId: "acct_private", requestLabel: "", since: "never" },
      { ...hold, id: "tr_private" }, { ...hold, id: "balance", coins: -5 }] }));
    const parsed = (await DocumentPayoutService.hashcoins("vault")).live;
    expect(parsed.holds).toEqual([hold, { ...hold, id: `redemption:${nextId}`, reason: "under_review", nextStep: "none",
      requestId: null, requestLabel: null, since: null }]);
    // Nothing is next while held, so no source is named.
    expect(parsed.nextRedeemSource).toBeNull();
  });

  it("words every hold in Hussh's name and the Redeem action", () => {
    for (const reason of HOLD_REASONS) expect(holdReasonCopy(reason)).not.toMatch(/Hushh|cash(ed)? out/i);
    expect(holdReasonCopy("refund_recovery")).toBe("This payment was refunded after you redeemed it.");
  });

  it("asks for one earnings mode and refuses another mode's page", async () => {
    apiJson.mockResolvedValueOnce({ currency: "USD", stripeMode: "live", mode: "test", transactions: [earning()], nextCursor: null });
    expect(await DocumentPayoutService.earnings("vault", nextId, "test")).toEqual({ currency: "USD", stripeMode: "live",
      mode: "test", transactions: [earning()], nextCursor: null });
    expect(apiJson).toHaveBeenLastCalledWith(`/api/one/payouts/account/earnings?cursor=${nextId}&mode=test`, {
      headers: { Authorization: "Bearer vault" }, cache: "no-store",
    });
    apiJson.mockResolvedValueOnce({ currency: "USD", mode: "live", transactions: [earning()], nextCursor: null });
    await expect(DocumentPayoutService.earnings("vault", undefined, "test")).rejects.toThrow("Invalid earnings response");
    apiJson.mockResolvedValueOnce({ currency: "USD", mode: "all", transactions: [], nextCursor: null });
    await expect(DocumentPayoutService.earnings("vault")).rejects.toThrow("Invalid earnings response");
    await expect(DocumentPayoutService.earnings("vault", undefined, "legacy" as "test")).rejects.toThrow("Invalid earnings mode");
  });

  it("pages bank deposits by an opaque cursor and reads each deposit's own bank and times", async () => {
    const paid = { id: "po_1", amountCents: 911, status: "paid", expectedArrivalAt: "2026-10-12T00:00:00Z", failureCode: null,
      createdAt: "2026-10-10T00:00:00Z", paidAt: "2026-10-12T09:00:00Z", failedAt: null,
      bank: { name: "Example Bank", last4: "6789" }, bankReference: "TRACE123" };
    apiJson.mockResolvedValueOnce({ currency: "USD", stripeMode: "live", payouts: [paid,
      { ...paid, id: "po_2", createdAt: "yesterday", bank: { name: "", last4: "123456789" }, bankReference: "x".repeat(129) }],
      nextCursor: "page+2/=" });
    expect(await DocumentPayoutService.bankPayouts("vault", "page_1")).toEqual({ currency: "USD", stripeMode: "live",
      payouts: [paid, { ...paid, id: "po_2", createdAt: null, bank: null, bankReference: null }], nextCursor: "page+2/=" });
    expect(apiJson).toHaveBeenLastCalledWith("/api/one/payouts/account/bank-payouts?cursor=page_1", {
      headers: { Authorization: "Bearer vault" }, cache: "no-store",
    });
    // A repeated or unusable cursor ends the list instead of looping.
    for (const nextCursor of ["page_1", "has space", 7]) {
      apiJson.mockResolvedValueOnce({ currency: "USD", payouts: [], nextCursor });
      expect((await DocumentPayoutService.bankPayouts("vault", "page_1")).nextCursor).toBeNull();
    }
    await expect(DocumentPayoutService.bankPayouts("vault", "x".repeat(257))).rejects.toThrow("Invalid bank payout cursor");
  });

  it("reads the In Stripe balance and never shows money for an unlinked account", async () => {
    const balance = { stripeMode: "live", currency: "USD", accountLinked: true, inStripeCents: 1155, availableCents: 0,
      pendingCents: 1155, nextAvailableOn: "2026-10-14T00:00:00+00:00", nextAvailableCents: 1155,
      asOf: "2026-10-11T10:00:00+00:00", stale: false };
    apiJson.mockResolvedValueOnce({ ...balance, stripeAccountId: "acct_private" });
    expect(await DocumentPayoutService.balance("vault")).toEqual(balance);
    expect(apiJson).toHaveBeenLastCalledWith("/api/one/payouts/account/balance", {
      headers: { Authorization: "Bearer vault" }, cache: "no-store",
    });
    for (const invalid of [{ ...balance, accountLinked: false }, { ...balance, pendingCents: 1.5 },
      { ...balance, asOf: "now" }, { ...balance, currency: "EUR" }, { ...balance, stale: "no" }]) {
      apiJson.mockResolvedValueOnce(invalid);
      await expect(DocumentPayoutService.balance("vault")).rejects.toThrow("Invalid payout balance response");
    }
  });

  it("asks Stripe to collect upcoming details only for verify", async () => {
    apiJson.mockResolvedValue({ url: "https://connect.stripe.com/setup/safe_link" });
    await DocumentPayoutService.onboard("vault", "verify");
    expect(apiJson).toHaveBeenLastCalledWith("/api/one/payouts/account/onboard", {
      method: "POST", headers: { Authorization: "Bearer vault", "Content-Type": "application/json" },
      body: JSON.stringify({ purpose: "verify" }), cache: "no-store",
    });
    await DocumentPayoutService.onboard("vault");
    expect(apiJson).toHaveBeenLastCalledWith("/api/one/payouts/account/onboard", {
      method: "POST", headers: { Authorization: "Bearer vault" }, cache: "no-store",
    });
    await expect(DocumentPayoutService.onboard("vault", "update" as "verify")).rejects.toThrow("Invalid payout setup purpose");
  });
});
