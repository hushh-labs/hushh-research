import { describe, expect, it } from "vitest";
import { applySnapshot, removeConnection } from "@/lib/kai/plaid-vault/projection";
import { readFinancialNws } from "@/lib/kai/plaid-vault/nws-financial-report";
import { FIRST_PLATYPUS, firstPlatypusSnapshot, NOW } from "./fixtures";
import { link, linkedFirstPlatypus } from "./projection-fixture";

describe("owner net worth score projection", () => {
  it("uses committed records for the score and drops it when the final Item is removed", () => {
    const { snapshot, financial } = linkedFirstPlatypus();
    const report = readFinancialNws(financial);
    expect(report?.score).toEqual(expect.any(Number));
    expect(JSON.stringify(report)).not.toContain("access-sandbox");
    expect(readFinancialNws(applySnapshot(financial, "item_fp_a", {
      ...snapshot, item: { ...snapshot.item, error: { code: "ITEM_LOGIN_REQUIRED", message: "Reconnect" } },
    }, NOW))).toEqual(report);
    expect(readFinancialNws(removeConnection(financial, "item_fp_a", NOW))).toBeNull();
  });

  it("counts a certificate of deposit toward net worth and excludes it from liquid cash", () => {
    const itemId = "item_fp_a";
    const snapshot = firstPlatypusSnapshot(itemId, "fpa");
    const linked = link(null, itemId, FIRST_PLATYPUS);
    const checking = snapshot.accounts.find(account => account.subtype === "checking")!;
    const cd = snapshot.accounts.find(account => account.subtype === "cd")!;
    const charge = snapshot.transactions?.added?.find(transaction =>
      transaction.date === "2026-09-03" && transaction.personal_finance_category?.primary === "LOAN_PAYMENTS",
    )!;
    const project = (accounts: typeof snapshot.accounts) => readFinancialNws(applySnapshot(linked, itemId, {
      ...snapshot,
      accounts,
      transactions: {
        added: [{ ...charge, account_id: checking.account_id }],
        modified: [],
        removed: [],
        next_cursor: "complete",
        pages: 1,
        has_more: false,
        transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
      },
    }, NOW));
    const checkingOnly = project([checking]);
    const withCd = project([checking, { ...cd, balances: { ...cd.balances, current: 100_000 } }]);
    const runway = checkingOnly?.factors.find(factor => factor.factor === "liquidity_runway");

    expect(runway?.normalizedScore).toBeGreaterThan(0);
    expect(runway?.normalizedScore).toBeLessThan(1);
    expect(withCd?.factors.find(factor => factor.factor === "liquidity_runway")).toEqual(runway);
    expect(withCd?.netWorth).toBe(100_110);
    expect(withCd?.coverageReasons).not.toContain("cash_only_coverage");
  });
});
