import { beforeEach, describe, expect, it, vi } from "vitest";

const apiJson = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/api-client", () => ({ apiJson }));

import { PayoutActivityService } from "@/lib/services/payout-activity-service";

const requestId = "11111111-1111-4111-8111-111111111111";
const redemptionId = "22222222-2222-4222-8222-222222222222";
const PROVIDER_IDS = /(acct|ch|pi|tr|trr|py)_[A-Za-z0-9]/;
const at = "2026-10-10T12:00:00.123456+00:00";
const contractFailure = (field: string) => ({ name: "PayoutContractError", field });

const page = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1, mode: "live", kind: "all", asOf: at, currency: "USD", coinsPerDollar: 100,
  balanceCoins: 911, items, sourceItemCount: items.length, nextCursor: null, reset: false, ...extra,
});
const earning = (extra: Record<string, unknown> = {}) => ({
  id: `earning:${requestId}`, kind: "earning", type: "earning", status: "credited", reversalStatus: null, review: null,
  occurredAt: at, updatedAt: at, coinsDelta: 911, amountCents: 911, balanceAfterCoins: 911,
  request: { id: requestId, label: "March statements" }, test: false, expectedArrivalAt: null, bank: null, ...extra,
});
const redemption = (extra: Record<string, unknown> = {}) => ({
  id: `redemption:${redemptionId}`, kind: "redemption", type: "cash_out", status: "succeeded", reversalStatus: "none",
  review: null, occurredAt: at, updatedAt: at, coinsDelta: -911, amountCents: 911, balanceAfterCoins: 0,
  request: { id: requestId, label: "March statements" }, test: false, expectedArrivalAt: null, bank: null, ...extra,
});
const deposit = (extra: Record<string, unknown> = {}) => ({
  id: "deposit:po_1Abc", kind: "deposit", type: "bank_deposit", status: "in_transit", reversalStatus: null, review: null,
  occurredAt: at, updatedAt: at, coinsDelta: null, amountCents: 1550, balanceAfterCoins: null, request: null,
  test: false, expectedArrivalAt: "2026-10-12T00:00:00+00:00", bank: { name: "Example Bank", last4: "6789" }, ...extra,
});

describe("payout activity list", () => {
  beforeEach(() => apiJson.mockReset());

  it("reads an owner page with vault auth and keeps only known fields", async () => {
    apiJson.mockResolvedValueOnce(page([
      earning({ stripeTransferId: "tr_1Private", chargeId: "ch_1Private", account: "acct_1Private" }),
      redemption({ transfer: { reference: "tr_1Private", reversal: "trr_1Private" }, paymentIntent: "pi_1Private" }),
      deposit({ destination: "ba_1Private", references: { payout: "po_1Abc", bankTrace: "py_1Private" } }),
    ], { nextCursor: "eyJ2IjoxfQ", stripeAccount: "acct_1Private" }));
    const result = await PayoutActivityService.list("vault", { kind: "all", mode: "live", limit: 20 });
    expect(apiJson).toHaveBeenCalledWith("/api/one/payouts/activity?kind=all&mode=live&limit=20", {
      headers: { Authorization: "Bearer vault" }, cache: "no-store",
    });
    expect(result.items.map((item) => item.id)).toEqual([`earning:${requestId}`, `redemption:${redemptionId}`, "deposit:po_1Abc"]);
    expect(result).toMatchObject({ balanceCoins: 911, nextCursor: "eyJ2IjoxfQ", reset: false });
    expect(result.items[2]).toMatchObject({ kind: "deposit", bank: { name: "Example Bank", last4: "6789" }, amountCents: 1550 });
    expect(JSON.stringify(result)).not.toMatch(PROVIDER_IDS);
  });

  it("leaves out rows that break money, ids or mode, and reads new states as unrecognized", async () => {
    apiJson.mockResolvedValueOnce(page([
      earning({ id: "earning:not-a-request" }),
      earning({ kind: "redemption" }),
      earning({ test: true }),
      redemption({ coinsDelta: 911 }),
      redemption({ id: `redemption:${requestId}`, coinsDelta: -911, amountCents: 900 }),
      { ...deposit(), kind: "packet_payout" },
      deposit({ id: "deposit:po_2Abc", coinsDelta: 1550 }),
      earning({ id: `earning:${redemptionId}`, status: "settling", newField: { nested: true } }),
      deposit({ id: "deposit:po_3Abc", status: "paid", bank: { name: "Example Bank", last4: "000123456789" } }),
    ]));
    const result = await PayoutActivityService.list("vault", { kind: "all", mode: "live", limit: 20 });
    expect(result.items.map((item) => item.id)).toEqual([`earning:${redemptionId}`, "deposit:po_3Abc"]);
    expect(result.items[0]).toMatchObject({ kind: "earning", status: "unrecognized" });
    expect(result.items[1]).toMatchObject({ kind: "deposit", status: "paid", bank: null });
    expect(JSON.stringify(result)).not.toContain("000123456789");

    apiJson.mockResolvedValueOnce(page([earning(), deposit()], { kind: "coins" }));
    const coins = await PayoutActivityService.list("vault", { kind: "coins", mode: "live", limit: 20 });
    expect(coins.items.map((item) => item.kind)).toEqual(["earning"]);
  });

  it("refuses lossy or incomplete source reads while preserving the tolerant activity UI", async () => {
    const query = { kind: "all" as const, mode: "live" as const, limit: 20 };
    for (const body of [
      page([earning({ id: "earning:invalid" })]),
      page([redemption(), redemption()]),
      page([redemption({ test: true })]),
      page([redemption({ updatedAt: "invalid" })]),
      page([redemption({ amountCents: null, coinsDelta: null })]),
      page([redemption({ status: "future_state" })]),
      page([deposit({ amountCents: null })]),
      page([redemption({ id: `reversal:${redemptionId}`, kind: "adjustment",
        amountCents: null, coinsDelta: -911 })]),
      page([deposit({ expectedArrivalAt: "invalid" })]),
    ]) {
      apiJson.mockResolvedValueOnce(body);
      await expect(PayoutActivityService.list("vault", query, { sourceRead: true }))
        .rejects.toMatchObject(contractFailure("sourceRead.items"));
    }
    apiJson.mockResolvedValueOnce(page([], { nextCursor: "more" }));
    await expect(PayoutActivityService.list("vault", query, { sourceRead: true }))
      .rejects.toMatchObject(contractFailure("sourceRead.completeness"));
    apiJson.mockResolvedValueOnce(page([], { reset: true }));
    await expect(PayoutActivityService.list("vault", query, { sourceRead: true }))
      .rejects.toMatchObject(contractFailure("sourceRead.completeness"));
    apiJson.mockResolvedValueOnce(page([redemption()], { sourceItemCount: 2 }));
    await expect(PayoutActivityService.list("vault", query, { sourceRead: true }))
      .rejects.toMatchObject(contractFailure("sourceRead.completeness"));
    apiJson.mockResolvedValueOnce(page([earning({ id: "earning:invalid" })]));
    expect((await PayoutActivityService.list("vault", query)).items).toEqual([]);
  });

  it("refuses pages it cannot trust and never sends an invalid query", async () => {
    for (const [body, field] of [
      [page([], { schemaVersion: 2 }), "schemaVersion"],
      [page([], { mode: "test" }), "mode"],
      [page([], { coinsPerDollar: 1 }), "coinsPerDollar"],
      [page([], { balanceCoins: 9.5 }), "balanceCoins"],
      [page([earning(), redemption()]), "items"],
      [page([], { nextCursor: "c1" }), "nextCursor"],
    ] as const) {
      apiJson.mockResolvedValueOnce(body);
      const limit = field === "items" ? 1 : 20;
      const cursor = field === "nextCursor" ? "c1" : undefined;
      await expect(PayoutActivityService.list("vault", { kind: "all", mode: "live", limit, cursor }))
        .rejects.toMatchObject(contractFailure(field));
    }
    apiJson.mockClear();
    await expect(PayoutActivityService.list("vault", { kind: "all", mode: "live", limit: 20, cursor: "c1", since: at }))
      .rejects.toThrow("Invalid activity query");
    await expect(PayoutActivityService.list("vault", { kind: "all", mode: "live", limit: 51 })).rejects.toThrow("Invalid activity query");
    expect(apiJson).not.toHaveBeenCalled();
  });
});

describe("payout receipts", () => {
  beforeEach(() => apiJson.mockReset());

  it("reads a receipt by a validated id and never shows another item's receipt", async () => {
    await expect(PayoutActivityService.item("vault", "earning:../../debug/consent-listener")).rejects.toThrow("Invalid activity item");
    await expect(PayoutActivityService.item("vault", "deposit:tr_1Private")).rejects.toThrow("Invalid activity item");
    expect(apiJson).not.toHaveBeenCalled();

    const itemId = `redemption:${redemptionId}`;
    const receipt = {
      id: itemId, kind: "redemption", status: "succeeded", mode: "live", coins: 911, amountCents: 911,
      reference: "HC-22222222", request: { id: requestId, label: "March statements", confirmedFiles: 3, expectedFiles: 3 },
      earning: { grossCents: 1000, refundCents: 0, platformFeeCents: 30, processingFeeCents: 59, netCents: 911, creditedAt: at },
      transfer: { status: "sent", requestedAt: at, sentAt: at, completedAt: at, reference: "tr_1Private" },
      reversal: { status: "none", at: null, reference: "trr_1Private" },
      funds: { status: "pending", availableOn: "2026-10-14T00:00:00+00:00" },
      bankDeposit: { id: "deposit:po_1Abc", status: "in_transit", arrivalAt: "2026-10-15T00:00:00+00:00", bank: { name: "Example Bank", last4: "6789" } },
      review: null, stripeTransferId: "tr_1Private",
    };
    apiJson.mockResolvedValueOnce(receipt);
    const parsed = await PayoutActivityService.item("vault", itemId);
    expect(apiJson).toHaveBeenCalledWith(`/api/one/payouts/activity/${encodeURIComponent(itemId)}`, {
      headers: { Authorization: "Bearer vault" }, cache: "no-store",
    });
    expect(parsed).toMatchObject({ kind: "redemption", coins: 911, reference: "HC-22222222",
      bankDeposit: { id: "deposit:po_1Abc", status: "in_transit" }, funds: { status: "pending" } });
    expect(JSON.stringify(parsed)).not.toMatch(PROVIDER_IDS);

    for (const [body, field] of [
      [{ ...receipt, id: `redemption:${requestId}` }, "id"],
      [{ ...receipt, amountCents: 912 }, "amountCents"],
      [{ ...receipt, mode: "sandbox" }, "mode"],
    ] as const) {
      apiJson.mockResolvedValueOnce(body);
      await expect(PayoutActivityService.item("vault", itemId)).rejects.toMatchObject(contractFailure(field));
    }
  });

  it("keeps a deposit's own masked bank and references, and only links valid items", async () => {
    apiJson.mockResolvedValueOnce({
      id: "deposit:po_1Abc", kind: "deposit", status: "paid", amountCents: 1550, createdAt: at,
      expectedArrivalAt: "2026-10-12T00:00:00+00:00", paidAt: at, failedAt: null, failureCode: "account_closed_private",
      method: "standard", automatic: true, bank: { name: "Example Bank", last4: "6789" }, bankReference: "py_1Private",
      contents: { status: "complete", otherCents: 0, items: [
        { itemId: `redemption:${redemptionId}`, type: "cash_out", requestLabel: "March statements", amountCents: 911 },
        { itemId: "redemption:../../x", type: "cash_out", requestLabel: null, amountCents: 639 },
      ] },
      actionRequired: null,
    });
    const parsed = await PayoutActivityService.item("vault", "deposit:po_1Abc");
    expect(parsed).toMatchObject({ kind: "deposit", bank: { name: "Example Bank", last4: "6789" }, bankReference: null,
      contents: { status: "complete", items: [{ itemId: `redemption:${redemptionId}` }, { itemId: null }] } });
    expect(JSON.stringify(parsed)).not.toMatch(/account_closed_private|py_1Private/);

    apiJson.mockResolvedValueOnce({ id: "deposit:po_1Abc", kind: "deposit", status: "paid", amountCents: 1550,
      bank: null, bankReference: "091000019876543", contents: null });
    expect(await PayoutActivityService.item("vault", "deposit:po_1Abc"))
      .toMatchObject({ bank: null, bankReference: "091000019876543", contents: null });
  });
});
