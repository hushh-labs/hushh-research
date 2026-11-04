import { describe, expect, it } from "vitest";
import { computePlaidNwsV1, type NwsAccount, type NwsTransaction } from "@/lib/kai/plaid-vault/nws-score";

const checking: NwsAccount = {
  key: "a",
  currency: "USD",
  type: "depository",
  current: 15_000,
  available: null,
  limit: null,
  holdings: null,
  apr: null,
};
const asOfTimestamp = "2026-11-04T12:00:00Z";
const score = (accounts: NwsAccount[], transactions: NwsTransaction[] = [], historyComplete = false) =>
  computePlaidNwsV1({ accounts, transactions, historyComplete, asOfTimestamp });

describe("plaid-nws-v1", () => {
  it("separates verified zero from missing balances and unsupported currencies", () => {
    expect(score([{ ...checking, current: 0 }]).score).toBe(448);
    expect(score([{ ...checking, current: null }]).score).toBeNull();
    expect(score([{ ...checking, currency: undefined }]).score).toBeNull();
    expect(score([{ ...checking, currency: "EUR" }, { ...checking, key: "b" }]).netWorth).toBe(15_000);
  });

  it("uses holdings by account, including zero, and falls back only on a completed empty result", () => {
    const holding = { ...checking, type: "investment", current: 100, holdings: [{ value: 0, currency: undefined }] };
    expect(score([holding]).netWorth).toBe(0);
    expect(score([{ ...holding, holdings: null }]).score).toBeNull();
    expect(score([{ ...holding, holdings: [] }]).netWorth).toBe(100);
    expect(score([holding, { ...holding, key: "b", holdings: [{ value: 50, currency: "USD" }] }]).netWorth).toBe(50);
  });

  it("opens provisional cash flow at 21 posted calendar days and honors the mature calendar window", () => {
    const row: NwsTransaction = { accountKey: "a", date: "2026-11-02", amount: 20, currency: null,
      pending: false, primary: "FOOD_AND_DRINK", detailed: null };
    expect(score([checking], [row, { ...row, date: "2026-10-14" }]).history).toBe("unavailable");
    expect(score([checking], [row, { ...row, date: "2026-10-13" }]).history).toBe("provisional");
    const complete = score([checking], [], true);
    expect(complete.history).toBe("historical");
    expect(score([checking], [
      { ...row, date: "2026-07-01", currency: "EUR" },
      { ...row, detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", amount: 9_000 },
      { ...row, pending: true },
    ], true)).toEqual(complete);
  });

  it("applies the approved cash threshold and caps a mortgage even with an unused card", () => {
    expect(score([checking]).score).toBe(895);
    expect(score([{ ...checking, current: 15_000.01 }]).score).toBe(717);
    const mortgage = { ...checking, key: "m", current: 400_000, type: "loan" };
    const card = { ...checking, key: "c", current: 0, limit: 20_000, type: "credit", apr: 40 };
    const debt = score([checking, mortgage, card]).factors.find(factor => factor.factor === "debt_and_credit");
    expect(debt?.normalizedScore).toBeCloseTo((1 + 15_000 / 415_000) / 2);
    expect(score([{ ...checking, current: -250 }]).netWorth).toBe(-250);
  });

  it("applies one APR penalty only for an indebted card above 20 percent", () => {
    const card = { ...checking, key: "c", current: 1_000, limit: 20_000, type: "credit", apr: 20 };
    const factor = (accounts: NwsAccount[]) => score(accounts).factors.find(row => row.factor === "debt_and_credit")?.normalizedScore;
    expect(factor([checking, card, { ...card, key: "d", current: 0, apr: 40 }]))
      .toBeCloseTo(factor([checking, { ...card, limit: 40_000 }])!);
    expect(factor([checking, card])! - factor([checking, { ...card, apr: 20.1 }])!).toBeCloseTo(0.10);
  });
});
