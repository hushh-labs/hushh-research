import { describe, expect, it } from "vitest";

import {
  applyConnectionLink,
  applySnapshot,
  amountBand,
  recomputeDerived,
  removeConnection,
  toPortfolioData,
} from "@/lib/kai/plaid-vault/projection";
import { scanSummaryForLeaks, scorePlaidVaultQuality } from "@/lib/kai/plaid-vault/quality";
import type { FinancialDomain, PlaidVaultSnapshot } from "@/lib/kai/plaid-vault/types";

import {
  FIRST_PLATYPUS,
  FIRST_PLATYPUS_TOTALS,
  GINGHAM,
  GINGHAM_ACCOUNTS,
  HOUNDSTOOTH,
  HOUNDSTOOTH_ACCOUNTS,
  NOW,
  PLATYPUS_OAUTH,
  TARTAN,
  TARTAN_ACCOUNTS,
  firstPlatypusSecondPage,
  firstPlatypusSnapshot,
  platypusOauthSnapshot,
  smallInstitutionSnapshot,
} from "./fixtures";

const EARLIER = "2026-09-23T11:00:00.000Z";

function link(
  financial: FinancialDomain | null,
  itemId: string,
  institution: { id: string; name: string },
  now = EARLIER
): FinancialDomain {
  return applyConnectionLink(
    financial,
    {
      item_id: itemId,
      access_token: `access-sandbox-${itemId}-secret`,
      institution,
      products: ["transactions", "investments"],
    },
    now
  );
}

function linkedFirstPlatypus(itemId = "item_fp_a", prefix = "fpa", base: FinancialDomain | null = null) {
  const snapshot = firstPlatypusSnapshot(itemId, prefix);
  const linked = link(base, itemId, FIRST_PLATYPUS);
  return { snapshot, financial: applySnapshot(linked, itemId, snapshot, NOW) };
}

describe("applyConnectionLink", () => {
  it("writes the connection with the sealed token and an empty cursor", () => {
    const financial = link({ other_key: 1 }, "item_fp_a", FIRST_PLATYPUS);
    expect(financial.other_key).toBe(1);
    expect(financial.connections_v1?.item_fp_a).toEqual({
      access_token: "access-sandbox-item_fp_a-secret",
      institution_id: "ins_109508",
      institution_name: "First Platypus Bank",
      products: ["investments", "transactions"],
      linked_at: EARLIER,
      transactions_cursor: null,
      last_refreshed_at: null,
      status: "active",
    });
  });

  it("does not mutate its input", () => {
    const input: FinancialDomain = { connections_v1: {} };
    const frozen = JSON.stringify(input);
    link(input, "item_fp_a", FIRST_PLATYPUS);
    expect(JSON.stringify(input)).toBe(frozen);
  });
});

describe("applySnapshot", () => {
  it("projects all 14 First Platypus accounts, 13 holdings and securities", () => {
    const { financial } = linkedFirstPlatypus();
    expect(Object.keys(financial.accounts_v1 ?? {})).toHaveLength(14);
    expect(Object.keys(financial.holdings_v1 ?? {})).toHaveLength(13);
    expect(Object.keys(financial.securities_v1 ?? {})).toHaveLength(13);
    const checking = financial.accounts_v1?.["item_fp_a:fpa_chk"];
    expect(checking).toMatchObject({
      account_id: "fpa_chk",
      item_id: "item_fp_a",
      institution_id: "ins_109508",
      institution_name: "First Platypus Bank",
      mask: "0000",
      type: "depository",
      subtype: "checking",
      balances: { available: 100, current: 110, limit: null, iso_currency_code: "USD" },
      duplicate_of: null,
    });
    expect(checking).not.toHaveProperty("official_name");
    expect(financial.holdings_v1?.["fpa_401k:sec_voo"]?.institution_value).toBe(4101.2);
    expect(financial.securities_v1?.sec_camyx).toMatchObject({ ticker: "CAMYX", cusip: "74316P207" });
  });

  it("derives net worth, liquid cash and investable assets from Tier A", () => {
    const { financial } = linkedFirstPlatypus();
    const derived = financial.derived_v1!;
    expect(derived.total_assets.value).toBe(FIRST_PLATYPUS_TOTALS.assets);
    expect(derived.total_liabilities.value).toBe(FIRST_PLATYPUS_TOTALS.liabilities);
    expect(derived.net_worth.value).toBe(FIRST_PLATYPUS_TOTALS.netWorth);
    expect(derived.liquid_cash.value).toBe(FIRST_PLATYPUS_TOTALS.liquid);
    expect(derived.investable_assets.value).toBe(FIRST_PLATYPUS_TOTALS.investable);
    expect(derived.net_worth_band.value).toBe("negative $50k-$100k");
    expect(derived.net_worth.source_item_ids).toEqual(["item_fp_a"]);
    expect(derived.net_worth.computed_at).toBe(NOW);
    expect(derived.debt_to_asset_ratio.value).toBeCloseTo(163705.89 / 86541.74, 4);
    const allocationSum = Object.values(derived.allocation_pct.value).reduce((a, b) => a + b, 0);
    expect(allocationSum).toBeCloseTo(100, 1);
    expect(derived.allocation_pct.value.cash).toBeGreaterThan(0);
  });

  it("derives monthly cash flow, stable income and the two recurring bills", () => {
    const { financial } = linkedFirstPlatypus();
    const derived = financial.derived_v1!;
    const months = derived.monthly_cash_flow.value;
    expect(months).toHaveLength(12);
    expect(months[months.length - 1]!.month).toBe("2026-09");
    const august = months.find((row) => row.month === "2026-08")!;
    expect(august.income).toBe(5000);
    // Mortgage 1200 + streaming 15.49 + four groceries (147.25..150.25 = 595).
    // Card payments (500 out, 500 in) and the 300 savings transfer are excluded.
    expect(august.spend).toBe(1810.49);
    expect(august.net).toBe(3189.51);
    expect(derived.income_stability.value).toMatchObject({ label: "stable", coefficient_of_variation: 0 });
    expect(derived.cash_flow_trend.value).toBe("positive");
    const bills = derived.recurring_bills.value;
    expect(bills.map((bill) => [bill.category, bill.cadence, bill.typical_amount])).toEqual(
      expect.arrayContaining([
        ["ENTERTAINMENT_TV_AND_MOVIES", "monthly", 15.49],
        ["LOAN_PAYMENTS_MORTGAGE_PAYMENT", "monthly", 1200],
      ])
    );
    expect(bills).toHaveLength(2);
  });

  it("saves the cursor with the records it describes and replays as a no-op", () => {
    const { financial, snapshot } = linkedFirstPlatypus();
    expect(financial.connections_v1?.item_fp_a).toMatchObject({
      transactions_cursor: "fpa-cursor-page-1",
      last_refreshed_at: NOW,
      status: "active",
    });
    const replayed = applySnapshot(financial, "item_fp_a", snapshot, NOW);
    expect(replayed).toEqual(financial);
    expect(recomputeDerived(financial, NOW)).toEqual(financial);
  });

  it("applies modified and removed transactions idempotently", () => {
    const { financial } = linkedFirstPlatypus();
    const page2 = firstPlatypusSecondPage("item_fp_a", "fpa");
    const next = applySnapshot(financial, "item_fp_a", page2, NOW);
    const txs = next.transactions_v1!;
    expect(txs.fpa_tx_groc_0_12).toBeUndefined();
    expect(txs.fpa_tx_groc_0_18?.amount).toBe(99.99);
    expect(txs.fpa_tx_new_coffee?.merchant_name).toBe("Blue Bottle Coffee");
    expect(next.connections_v1?.item_fp_a?.transactions_cursor).toBe("fpa-cursor-page-2");
    expect(applySnapshot(next, "item_fp_a", page2, NOW)).toEqual(next);
  });

  it("keeps 24 months of detail and reduces merchant detail after 90 days", () => {
    const { financial } = linkedFirstPlatypus();
    const txs = Object.values(financial.transactions_v1 ?? {});
    const oldest = txs.map((row) => row.date).sort()[0]!;
    expect(oldest >= "2024-09-23").toBe(true);
    // 2024-08 and early 2024-09 activity was delivered and dropped.
    expect(financial.transactions_v1?.fpa_tx_pay1_25).toBeUndefined();
    expect(financial.transactions_v1?.fpa_tx_pay1_24).toBeUndefined();

    const recentGrocery = financial.transactions_v1?.fpa_tx_groc_1_8;
    expect(recentGrocery).toMatchObject({ merchant_name: "Whole Foods", reduced: false });
    expect(recentGrocery?.location).toMatchObject({ city: "San Francisco" });
    expect(recentGrocery?.location).not.toHaveProperty("lat");

    const oldGrocery = financial.transactions_v1?.fpa_tx_groc_6_8;
    expect(oldGrocery).toMatchObject({
      name: "Food and drink groceries",
      merchant_name: "Food and drink groceries",
      location: null,
      counterparties: null,
      reduced: true,
    });
    for (const row of txs) {
      if (row.date < "2026-06-25") expect(row.reduced).toBe(true);
      else expect(row.reduced).toBe(false);
    }
  });

  it("ages records on a later recompute without new Plaid results", () => {
    const { financial } = linkedFirstPlatypus();
    const later = recomputeDerived(financial, "2026-12-31T12:00:00.000Z");
    expect(later.transactions_v1?.fpa_tx_groc_1_8?.reduced).toBe(true);
    expect(later.transactions_v1?.fpa_tx_pay1_23).toBeUndefined();
  });

  it("marks needs_relink on an item error and preserves every prior record", () => {
    const { financial } = linkedFirstPlatypus();
    const errored: PlaidVaultSnapshot = {
      item: {
        item_id: "item_fp_a",
        institution_id: FIRST_PLATYPUS.id,
        products: [],
        consented_products: [],
        error: { code: "ITEM_LOGIN_REQUIRED", message: "the login details of this item have changed" },
      },
      accounts: [],
      investments: { unavailable: "ITEM_LOGIN_REQUIRED" },
      transactions: { unavailable: "ITEM_LOGIN_REQUIRED" },
    };
    const next = applySnapshot(financial, "item_fp_a", errored, NOW);
    expect(next.connections_v1?.item_fp_a?.status).toBe("needs_relink");
    expect(next.connections_v1?.item_fp_a?.transactions_cursor).toBe("fpa-cursor-page-1");
    expect(next.accounts_v1).toEqual(financial.accounts_v1);
    expect(next.holdings_v1).toEqual(financial.holdings_v1);
    expect(next.transactions_v1).toEqual(financial.transactions_v1);
    expect(next.summary?.needs_relink_count).toBe(1);
    expect(JSON.stringify(next)).not.toContain("login details");
  });

  it("keeps prior holdings when investments are unavailable", () => {
    const { financial, snapshot } = linkedFirstPlatypus();
    const partial: PlaidVaultSnapshot = {
      ...snapshot,
      investments: { unavailable: "PRODUCT_NOT_READY" },
      transactions: { ...snapshot.transactions, added: [], next_cursor: "fpa-cursor-page-1" } as PlaidVaultSnapshot["transactions"],
    };
    const next = applySnapshot(financial, "item_fp_a", partial, NOW);
    expect(next.holdings_v1).toEqual(financial.holdings_v1);
  });

  it("rejects a snapshot for an unknown connection", () => {
    expect(() => applySnapshot({}, "missing", firstPlatypusSnapshot("missing", "x"), NOW)).toThrow();
  });
});

describe("dedupe across connections", () => {
  it("leaves totals unchanged when the same bank is linked twice", () => {
    const once = linkedFirstPlatypus().financial;
    const twiceLinked = link(once, "item_fp_b", FIRST_PLATYPUS, "2026-09-23T11:30:00.000Z");
    const twice = applySnapshot(twiceLinked, "item_fp_b", firstPlatypusSnapshot("item_fp_b", "fpb"), NOW);

    expect(Object.keys(twice.accounts_v1 ?? {})).toHaveLength(28);
    expect(twice.accounts_v1?.["item_fp_b:fpb_chk"]?.duplicate_of).toBe("item_fp_a:fpa_chk");
    expect(twice.accounts_v1?.["item_fp_a:fpa_chk"]?.duplicate_of).toBeNull();

    for (const field of [
      "total_assets",
      "total_liabilities",
      "net_worth",
      "liquid_cash",
      "investable_assets",
      "allocation_pct",
      "monthly_cash_flow",
      "recurring_bills",
      "account_type_counts",
    ] as const) {
      expect(twice.derived_v1?.[field].value).toEqual(once.derived_v1?.[field].value);
    }
    expect(toPortfolioData(twice)?.total_value).toBe(toPortfolioData(once)?.total_value);
    expect(twice.summary?.account_count).toBe(14);
    expect(twice.summary?.institution_count).toBe(1);
    expect(twice.summary?.connection_count).toBe(2);
  });

  it("dedupes by persistent_account_id across different masks", () => {
    const base = link(null, "item_a", FIRST_PLATYPUS);
    const snapA = firstPlatypusSnapshot("item_a", "a");
    snapA.accounts = snapA.accounts.slice(0, 1).map((a) => ({ ...a, persistent_account_id: "pa_1" }));
    const withA = applySnapshot(base, "item_a", { ...snapA, investments: { unavailable: "x" }, transactions: { unavailable: "x" } }, NOW);
    const withB0 = link(withA, "item_b", { id: "ins_other", name: "Other" }, "2026-09-23T11:30:00.000Z");
    const snapB = firstPlatypusSnapshot("item_b", "b");
    snapB.item.institution_id = "ins_other";
    snapB.accounts = snapB.accounts.slice(0, 1).map((a) => ({ ...a, mask: "5678", persistent_account_id: "pa_1" }));
    const withB = applySnapshot(withB0, "item_b", { ...snapB, investments: { unavailable: "x" }, transactions: { unavailable: "x" } }, NOW);
    expect(withB.accounts_v1?.["item_b:b_chk"]?.duplicate_of).toBe("item_a:a_chk");
    expect(withB.derived_v1?.total_assets.value).toBe(110);
  });
});

describe("removeConnection", () => {
  it("clears every record from the item and recomputes", () => {
    const fp = linkedFirstPlatypus().financial;
    const withOauth = applySnapshot(
      link(fp, "item_oauth", PLATYPUS_OAUTH),
      "item_oauth",
      platypusOauthSnapshot("item_oauth"),
      NOW
    );
    const removed = removeConnection(withOauth, "item_fp_a", NOW);
    expect(Object.keys(removed.connections_v1 ?? {})).toEqual(["item_oauth"]);
    const leftovers = [
      ...Object.values(removed.accounts_v1 ?? {}),
      ...Object.values(removed.holdings_v1 ?? {}),
      ...Object.values(removed.transactions_v1 ?? {}),
    ].filter((record) => record.item_id === "item_fp_a");
    expect(leftovers).toEqual([]);
    expect(removed.securities_v1).toEqual({});
    expect(removed.derived_v1?.total_assets.value).toBe(320);
    expect(removed.derived_v1?.net_worth.source_item_ids).toEqual(["item_oauth"]);
    expect(removed.summary?.connection_count).toBe(1);
    expect(toPortfolioData(removed)).toBeNull();
  });

  it("promotes the duplicate when the canonical connection is removed", () => {
    const once = linkedFirstPlatypus().financial;
    const twice = applySnapshot(
      link(once, "item_fp_b", FIRST_PLATYPUS, "2026-09-23T11:30:00.000Z"),
      "item_fp_b",
      firstPlatypusSnapshot("item_fp_b", "fpb"),
      NOW
    );
    const removed = removeConnection(twice, "item_fp_a", NOW);
    expect(removed.accounts_v1?.["item_fp_b:fpb_chk"]?.duplicate_of).toBeNull();
    expect(removed.derived_v1?.net_worth.value).toBe(FIRST_PLATYPUS_TOTALS.netWorth);
  });

  it("drops derived facts and the summary when the last connection goes", () => {
    const removed = removeConnection(linkedFirstPlatypus().financial, "item_fp_a", NOW);
    expect(removed.connections_v1).toEqual({});
    expect(removed.accounts_v1).toEqual({});
    expect(removed.transactions_v1).toEqual({});
    expect(removed.derived_v1).toBeUndefined();
    expect(removed.summary).toBeUndefined();
  });
});

describe("shareable summary", () => {
  it("holds only bands, percentages and counts", () => {
    const { financial } = linkedFirstPlatypus();
    const summary = financial.summary!;
    expect(summary).toMatchObject({
      schema: "plaid-summary-v1",
      net_worth_band: "negative $50k-$100k",
      liquid_cash_band: "$50k-$100k",
      investable_assets_band: "$10k-$50k",
      cash_flow_trend: "positive",
      income_stability: "stable",
      account_count: 14,
      institution_count: 1,
      recurring_bill_count: 2,
      account_type_counts: { credit: 2, depository: 6, investment: 2, loan: 4 },
    });
    expect(scanSummaryForLeaks(summary, financial)).toEqual([]);
    const text = JSON.stringify(summary);
    for (const forbidden of ["fpa_", "item_fp_a", "0000", "74316P207", "Whole Foods", "Netflix", "access-sandbox", "110", "43200"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("the leak scan catches a planted mask, id, merchant and raw amount", () => {
    const { financial } = linkedFirstPlatypus();
    const planted = {
      ...financial.summary!,
      top_account_mask: "0000",
      note: "Netflix",
      account_ref: "fpa_chk",
      largest: 43200,
    };
    const reasons = scanSummaryForLeaks(planted, financial).map((f) => f.path);
    expect(reasons).toEqual(
      expect.arrayContaining([
        "summary.top_account_mask",
        "summary.note",
        "summary.account_ref",
        "summary.largest",
      ])
    );
  });

  it("formats bands", () => {
    expect(amountBand(0)).toBe("$0-$10k");
    expect(amountBand(150_000)).toBe("$100k-$250k");
    expect(amountBand(7_500_000)).toBe("$5M+");
    expect(amountBand(-77_164.15)).toBe("negative $50k-$100k");
  });
});

describe("toPortfolioData", () => {
  it("renders Tier A holdings in the PortfolioData shape the finance screens use", () => {
    const { financial } = linkedFirstPlatypus();
    const portfolio = toPortfolioData(financial)!;
    expect(portfolio.holdings?.length).toBe(13);
    const voo = portfolio.holdings?.find((h) => h.symbol === "VOO");
    expect(voo).toMatchObject({
      name: "Vanguard S&P 500 ETF",
      quantity: 10,
      market_value: 4101.2,
      cost_basis: 3500,
      unrealized_gain_loss: 601.2,
      source_type: "plaid",
      institution_name: "First Platypus Bank",
      account_name: "Plaid 401k",
      is_investable: true,
    });
    const cash = portfolio.holdings?.find((h) => h.symbol === "CASH");
    expect(cash?.is_cash_equivalent).toBe(true);
    expect(portfolio.total_value).toBeCloseTo(23879.46, 2);
    expect(portfolio.cash_balance).toBe(299.76);
    expect(portfolio.source_metadata).toMatchObject({ source_type: "plaid", item_count: 1, account_count: 2 });
  });
});

describe("quality report", () => {
  it("scores full marks for a six-connection scenario", () => {
    const replays: Array<{ item_id: string; snapshot: PlaidVaultSnapshot }> = [];
    let financial: FinancialDomain | null = null;
    const connect = (itemId: string, institution: { id: string; name: string }, snapshot: PlaidVaultSnapshot, linkedAt: string) => {
      financial = applySnapshot(link(financial, itemId, institution, linkedAt), itemId, snapshot, NOW);
      replays.push({ item_id: itemId, snapshot });
    };
    connect("item_fp_a", FIRST_PLATYPUS, firstPlatypusSnapshot("item_fp_a", "fpa"), "2026-09-23T10:00:00.000Z");
    connect("item_fp_b", FIRST_PLATYPUS, firstPlatypusSnapshot("item_fp_b", "fpb"), "2026-09-23T10:10:00.000Z");
    connect("item_oauth", PLATYPUS_OAUTH, platypusOauthSnapshot("item_oauth"), "2026-09-23T10:20:00.000Z");
    connect("item_tartan", TARTAN, smallInstitutionSnapshot("item_tartan", TARTAN.id, "tartan", TARTAN_ACCOUNTS), "2026-09-23T10:30:00.000Z");
    connect("item_hound", HOUNDSTOOTH, smallInstitutionSnapshot("item_hound", HOUNDSTOOTH.id, "hound", HOUNDSTOOTH_ACCOUNTS), "2026-09-23T10:40:00.000Z");
    connect("item_gingham", GINGHAM, smallInstitutionSnapshot("item_gingham", GINGHAM.id, "gingham", GINGHAM_ACCOUNTS), "2026-09-23T10:50:00.000Z");

    const final = financial as unknown as FinancialDomain;
    const report = scorePlaidVaultQuality(final, { now: "2026-09-23T18:00:00.000Z", replays });
    expect(report.checks.leak_scan.details).toEqual({ findings: [] });
    expect(report.checks.dedupe.details.problems).toEqual([]);
    expect(report.score).toBe(report.max_score);
    expect(report.max_score).toBe(6);
    expect(report.passed).toBe(true);
    expect(final.summary?.connection_count).toBe(6);
    expect(final.summary?.institution_count).toBe(5);
    expect(final.summary?.account_count).toBe(14 + 2 + 2 + 1 + 1);
  });

  it("marks stale, relinked and tampered memory down", () => {
    const { financial } = linkedFirstPlatypus();
    const stale = scorePlaidVaultQuality(financial, { now: "2026-09-25T12:00:00.000Z" });
    expect(stale.checks.freshness.passed).toBe(false);

    const tampered: FinancialDomain = {
      ...financial,
      derived_v1: {
        ...financial.derived_v1!,
        net_worth: { ...financial.derived_v1!.net_worth, value: 1 },
      },
    };
    const report = scorePlaidVaultQuality(tampered, { now: NOW });
    expect(report.checks.totals.passed).toBe(false);
    expect(report.checks.replay.passed).toBe(false);
    expect(report.passed).toBe(false);
  });
});
