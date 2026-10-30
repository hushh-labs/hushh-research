import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { mapPortfolioToDashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
import { committedFinanceConfig, committedFinanceProjection, financeContext, financeDigest, projectFinance, projectAdvisorFinance, readFinanceProjection, type FinancePolicy, type FinanceSelection } from "@/lib/finance-sharing/contract";
import { financePolicySchema } from "@/lib/finance-sharing/contract";
import { resolveFinancePortfolio } from "@/lib/finance-sharing/saved-source";

import { applyConnectionLink, applySnapshot, toPortfolioData } from "@/lib/kai/plaid-vault/projection";
import { firstPlatypusSnapshot, FIRST_PLATYPUS, NOW } from "./plaid-vault/fixtures";

const source = { kind: "statement" as const, snapshotId: "selected" };
const selection: FinanceSelection = { sections: ["allocation", "performance", "holdings"], holdingSymbols: ["AAPL"], showAmounts: false, note: "unselected-note-sentinel" };
const policy: FinancePolicy = { version: 1, mode: "ongoing", sections: selection.sections, selectionHash: "a".repeat(64), showAmounts: false, model_processing: { version: 1, allowed: false }, durationSeconds: 86400 };
const portfolio = {
  account_info: { account_number: "ACCOUNT-SENTINEL", account_holder: "PRIVATE-NAME", statement_period: "January 2026" },
  total_value: 10000, account_summary: { ending_value: 10000 },
  holdings: [
    { symbol: "AAPL", name: "Apple", quantity: 10, price: 600, market_value: 6000, cost_basis: 5000, account_id: "PRIVATE-ACCOUNT", sector: "Technology" },
    { symbol: "MSFT", name: "Microsoft", quantity: 10, price: 400, market_value: 4000, sector: "Technology" },
  ],
  historical_values: [{ date: "2026-01-01", value: 8000 }, { date: "2026-01-02", value: 10000 }],
  transactions: [{ access_token: "PRIVATE-TOKEN", amount: 999 }],
};

describe("curated Finance sharing projection", () => {
  it("includes cash and non-ticker positions in the advisor snapshot without account records", () => {
    const full = { ...portfolio, cash_balance: 200, holdings: [
      ...portfolio.holdings,
      { symbol: "", name: "Sweep cash", quantity: 0, price: 0, market_value: 200, is_cash_equivalent: true },
      { symbol: "", name: "Private bond", quantity: 1, price: 300, market_value: 300, identifier_type: "cusip" as const },
    ] };
    const model = mapPortfolioToDashboardViewModel(full);
    const projection = projectAdvisorFinance(model, full, source);
    expect(projection.schema).toBe("finance-share-v2");
    expect(projection.holdings?.map(row => row.name)).toEqual(expect.arrayContaining(["Sweep cash", "Private bond"]));
    expect(JSON.stringify(projection)).not.toContain("PRIVATE-ACCOUNT");
    expect(JSON.stringify(projection)).not.toContain("PRIVATE-TOKEN");
    const advisorPolicy = { version: 2 as const, purpose: "verified_ria_review" as const, mode: "snapshot" as const,
      sections: ["allocation", "performance", "holdings"] as FinanceSelection["sections"], selectionHash: "a".repeat(64), showAmounts: true as const,
      model_processing: { version: 1 as const, allowed: false as const }, durationSeconds: 3600 as const };
    expect(readFinanceProjection(projection, advisorPolicy)).toEqual(projection);
    expect(() => readFinanceProjection(projection, policy)).toThrow();
    expect(financeContext({ requestId: "r", id: "g", ownerUserId: "o", recipientUserId: "r", policy: advisorPolicy, revision: 1 }))
      .toContain("finance-share-v2:verified_ria_review");
  });

  it("shares a cash-only source only when its total matches the reported cash", () => {
    const cash = { total_value: 200, cash_balance: 200, holdings: [] };
    const projection = projectAdvisorFinance(mapPortfolioToDashboardViewModel(cash), cash, source);
    expect(projection.schema === "finance-share-v2" && projection.cashBalance?.value).toBe(200);
    expect(projection.holdings).toEqual([]);
    const inconsistent = { ...cash, total_value: 300 };
    expect(() => projectAdvisorFinance(mapPortfolioToDashboardViewModel(inconsistent), inconsistent, source)).toThrow(/complete, shareable cash/);
  });
  it("refuses unsupported or unidentified positions instead of silently omitting them", () => {
    for (const changed of [
      { ...portfolio.holdings[0]!, market_value: -10, position_side: "short" as const },
      { ...portfolio.holdings[0]!, position_side: " SHORT " as "short" },
      { ...portfolio.holdings[0]!, position_side: "unknown" as "long" },
      { ...portfolio.holdings[0]!, symbol: "", name: "" },
    ]) {
      const invalid = { ...portfolio, holdings: [changed] };
      expect(() => projectAdvisorFinance(mapPortfolioToDashboardViewModel(invalid), invalid, source)).toThrow(/cannot be shared accurately/);
    }
  });
  it("preserves provider currency so sharing cannot relabel a foreign holding as USD", () => {
    const linked = applyConnectionLink(null, { item_id: "sample", access_token: "fixture-only", institution: FIRST_PLATYPUS, products: ["investments"] }, NOW);
    const financial = applySnapshot(linked, "sample", firstPlatypusSnapshot("sample", "sample"), NOW);
    for (const holding of Object.values(financial.holdings_v1 ?? {})) holding.iso_currency_code = "EUR";
    expect(toPortfolioData(financial)?.holdings?.every(holding => holding.iso_currency_code === "EUR")).toBe(true);
  });
  it("salts both encrypted content and owner selections so metadata cannot test guessed figures or notes", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const projection = projectFinance(mapPortfolioToDashboardViewModel(portfolio), selection, source);
    const first = committedFinanceProjection(projection, policy);
    const second = committedFinanceProjection(projection, policy);
    expect(first.commitmentNonce).toMatch(/^[a-f0-9]{64}$/);
    expect(await financeDigest(JSON.stringify(first))).not.toBe(await financeDigest(JSON.stringify(second)));
    const draft = { source, sourceFence: "a".repeat(64), selection: { ...selection, sections: ["allocation" as const] } };
    const config = committedFinanceConfig(draft);
    expect(config.selection.note).toBe("");
    expect(config.selection.holdingSymbols).toEqual([]);
    expect(await financeDigest(JSON.stringify(config))).not.toBe(await financeDigest(JSON.stringify(committedFinanceConfig(draft))));
    vi.unstubAllGlobals();
  });
  it("amounts off excludes structured balances, amounts, quantities, private records and unselected stocks/notes", () => {
    const projection = projectFinance(mapPortfolioToDashboardViewModel(portfolio), selection, source);
    expect(projection.holdings?.map(h => h.symbol)).toEqual(["AAPL"]);
    expect(projection.performance?.history.map(h => h.value)).toEqual([0, 25]);
    expect(projection.performance?.balanceChangePct).toBe(25);
    const text = JSON.stringify(projection);
    for (const secret of ["ACCOUNT-SENTINEL", "PRIVATE-NAME", "PRIVATE-ACCOUNT", "PRIVATE-TOKEN", "unselected-note-sentinel", "MSFT", "10000", "6000", "quantity", "cost_basis"]) expect(text).not.toContain(secret);
    expect(readFinanceProjection(projection, policy)).toEqual(projection);
    // Negative controls: view-time checks reject an overbroad producer.
    expect(() => readFinanceProjection({ ...projection, note: "unapproved" }, policy)).toThrow();
    expect(() => readFinanceProjection({ ...projection, performance: { ...projection.performance, unit: "USD" } }, policy)).toThrow();
    expect(() => readFinanceProjection({ ...projection, holdings: [{ ...projection.holdings![0], quantity: 10 }] }, policy)).toThrow();
    expect(() => readFinanceProjection({ ...projection, account_number: "secret" }, policy)).toThrow();
  });
  it("explicit dollars uses the saved value without inventing history or missing gains", () => {
    const model = mapPortfolioToDashboardViewModel({ ...portfolio, historical_values: [] });
    const projection = projectFinance(model, { ...selection, showAmounts: true }, source);
    expect(projection.performance).toEqual({ balanceChangePct: null, history: [], unit: "USD", total: { value: 10000, currency: "USD" } });
    expect(projection.holdings![0]?.amount?.value).toBe(6000);
    expect(projection.holdings![0]?.price).toBeUndefined();
  });
  it("selects by stock symbol across row reorder and refuses a removed selection", () => {
    const before = projectFinance(mapPortfolioToDashboardViewModel(portfolio), selection, source);
    const after = projectFinance(mapPortfolioToDashboardViewModel({ ...portfolio, holdings: [...portfolio.holdings].reverse() }), selection, source);
    expect(after.holdings).toEqual(before.holdings);
    expect(() => projectFinance(mapPortfolioToDashboardViewModel({ ...portfolio, holdings: portfolio.holdings.slice(1) }), selection, source)).toThrow(/no longer/);
  });
  it("aggregates the selected company across approved accounts without duplicate recipient rows", () => {
    const split = { ...portfolio, holdings: [portfolio.holdings[0]!, { ...portfolio.holdings[0]!, account_id: "ANOTHER-APPROVED-ACCOUNT", market_value: 2000, cost_basis: undefined }, portfolio.holdings[1]!] };
    const projection = projectFinance(mapPortfolioToDashboardViewModel(split), { ...selection, showAmounts: true }, source);
    expect(projection.holdings).toHaveLength(1);
    expect(projection.holdings![0]?.amount?.value).toBe(8000);
    expect(projection.holdings![0]?.gainLoss).toBeNull();
    expect(projection.holdings![0]?.gainLossPct).toBeNull();
  });
  it("pins exact snapshots and never substitutes the current V7 projection for an unavailable historical artifact", () => {
    const financial = { sources: { statement: { snapshots: [{ id: "selected", canonical_v2: portfolio }, { id: "other", canonical_v2: { holdings: [portfolio.holdings[1]] } }] } } };
    expect(resolveFinancePortfolio(financial, source)?.holdings).toHaveLength(2);
    expect(resolveFinancePortfolio(financial, { ...source, snapshotId: "missing" })).toBeNull();
    const v7 = { pkm_contract_version: "7.0.0", financial_core_v7: { active_source: "statement", positions: {}, accounts: {} }, source_artifacts_v7: { statement_snapshots: [{ id: "selected", artifact_ref: "sha256:example" }] } };
    expect(resolveFinancePortfolio(v7, source)).toBeNull();
  });
  it("authenticates recipient, selection, revision, lifetime and model permission in the envelope context", () => {
    const grant = { requestId: "request", id: "grant", ownerUserId: "owner", recipientUserId: "recipient", policy, revision: 1 };
    const aad = financeContext(grant);
    for (const changed of [{ ...grant, recipientUserId: "other" }, { ...grant, revision: 2 }, { ...grant, policy: { ...policy, showAmounts: true } }, { ...grant, policy: { ...policy, model_processing: { version: 1 as const, allowed: true } } }, { ...grant, policy: { ...policy, durationSeconds: null } }]) expect(financeContext(changed)).not.toBe(aad);
  });
});

describe("advisor policy access modes", () => {
  const advisor = { version: 2, purpose: "verified_ria_review", mode: "ongoing", sections: ["allocation", "performance", "holdings"], selectionHash: "a".repeat(64), showAmounts: true, model_processing: { version: 1, allowed: false }, durationSeconds: null };
  it("allows real-time advisor access until stopped but never an open-ended snapshot", () => {
    expect(financePolicySchema.safeParse(advisor).success).toBe(true);
    expect(financePolicySchema.safeParse({ ...advisor, mode: "snapshot" }).success).toBe(false);
    expect(financePolicySchema.safeParse({ ...advisor, mode: "snapshot", durationSeconds: 604800 }).success).toBe(true);
  });
});
