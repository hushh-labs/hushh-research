import { describe, expect, it } from "vitest";

import {
  getActiveStatementSnapshotId,
  getStatementPortfolio,
  getStatementSnapshotOptions,
  removeStatementSnapshot,
  setActivePlaidSource,
  setActiveStatementSnapshot,
} from "@/lib/kai/brokerage/financial-sources";
import { resolvePreferredPortfolioSource } from "@/lib/kai/brokerage/portfolio-sources";
import { applyStatementHoldingsEdit } from "@/lib/kai/brokerage/statement-holdings-edit";
import {
  computeStatementImportId,
  upsertStatementSnapshot,
} from "@/lib/kai/brokerage/statement-import-identity";
import { applyConnectionLink, applySnapshot } from "@/lib/kai/plaid-vault/projection";

import { FIRST_PLATYPUS, NOW, firstPlatypusSnapshot } from "../lib/plaid-vault/fixtures";

function withVaultBank(base: Record<string, unknown>): Record<string, unknown> {
  const linked = applyConnectionLink(
    base,
    { item_id: "item_fp", access_token: "access-sandbox-item-fp", institution: FIRST_PLATYPUS, products: ["investments"] },
    NOW,
  );
  return applySnapshot(linked, "item_fp", firstPlatypusSnapshot("item_fp", "fp"), NOW);
}

describe("financial statement snapshots", () => {
  const financial = {
    portfolio: {
      holdings: [{ symbol: "LATEST", name: "Latest Portfolio", quantity: 1, market_value: 10 }],
    },
    sources: {
      active_source: "statement",
      statement: {
        active_snapshot_id: "stmt_b",
        snapshots: [
          {
            id: "stmt_b",
            imported_at: "2026-04-20T00:00:00.000Z",
            source: {
              brokerage: "Broker B",
              statement_period_end: "2026-04-20",
            },
            canonical_v2: {
              historical_values: [{ date: "2026-04-01", value: 180 }, { date: "2026-04-20", value: 200 }],
              holdings: [
                { symbol: "BETA", name: "Beta", quantity: 2, market_value: 200 },
              ],
            },
          },
          {
            id: "stmt_a",
            imported_at: "2026-04-18T00:00:00.000Z",
            source: {
              brokerage: "Broker A",
              statement_period_end: "2026-04-18",
            },
            canonical_v2: {
              holdings: [
                { symbol: "ALPHA", name: "Alpha", quantity: 1, market_value: 100 },
              ],
            },
          },
        ],
      },
    },
  };

  it("lists statement snapshots as selectable uploads", () => {
    const options = getStatementSnapshotOptions(financial);
    expect(options).toHaveLength(2);
    expect(options.map((option) => option.id)).toEqual(["stmt_b", "stmt_a"]);
    expect(options[0].label).toContain("Broker B");
  });

  it("returns the active statement portfolio from the selected snapshot", () => {
    const portfolio = getStatementPortfolio(financial);
    expect(portfolio?.holdings).toHaveLength(1);
    expect(portfolio?.holdings?.[0]?.symbol).toBe("BETA");
    expect(portfolio?.account_info?.statement_period_end).toBe("2026-04-20");
    expect(portfolio?.historical_values).toEqual(financial.sources.statement.snapshots[0].canonical_v2.historical_values);
  });

  it("recovers observations retained in the selected statement extraction only", () => {
    const points = [{ date: "2026-04-01", value: 150 }, { date: "2026-04-20", value: 200 }];
    const selected = { id: "observed", canonical_v2: { holdings: financial.sources.statement.snapshots[0].canonical_v2.holdings }, raw_extract_v2: { historical_values: points } };
    expect(getStatementPortfolio({ sources: { statement: { active_snapshot_id: "observed", snapshots: [selected] } } })?.historical_values).toEqual(points);
  });

  it("switches between statement uploads without merging holdings", () => {
    const switched = setActiveStatementSnapshot(
      financial,
      "stmt_a",
      "2026-04-20T01:00:00.000Z"
    );

    expect(getActiveStatementSnapshotId(switched)).toBe("stmt_a");
    const portfolio = getStatementPortfolio(switched);
    expect(portfolio?.holdings).toHaveLength(1);
    expect(portfolio?.holdings?.[0]?.symbol).toBe("ALPHA");
    expect(portfolio?.historical_values).toBeUndefined();
  });

  it("deletes a saved statement snapshot and keeps the remaining statement active", () => {
    const updated = removeStatementSnapshot(
      financial,
      "stmt_b",
      "2026-04-20T03:00:00.000Z"
    );

    expect(getActiveStatementSnapshotId(updated)).toBe("stmt_a");
    expect(getStatementSnapshotOptions(updated).map((option) => option.id)).toEqual(["stmt_a"]);
    expect(getStatementPortfolio(updated)?.holdings?.[0]?.symbol).toBe("ALPHA");
  });

  it("deletes the last saved statement without leaving stale active holdings", () => {
    const singleStatementFinancial = {
      ...financial,
      sources: {
        active_source: "statement",
        statement: {
          active_snapshot_id: "stmt_a",
          snapshots: [financial.sources.statement.snapshots[1]],
        },
      },
      documents: {
        statements: [financial.sources.statement.snapshots[1]],
      },
    };

    const updated = removeStatementSnapshot(
      singleStatementFinancial,
      "stmt_a",
      "2026-04-20T03:00:00.000Z"
    );

    expect(getStatementSnapshotOptions(updated)).toEqual([]);
    expect(getStatementPortfolio(updated)).toBeNull();
    expect((updated?.sources as Record<string, unknown>).active_source).toBe("statement");
  });

  it("makes the vault's holdings active and drops the retired Plaid copy", () => {
    const withOldCopy = {
      ...withVaultBank(financial),
      sources: { ...financial.sources, plaid: { signature: "old", items: [{ item_id: "legacy" }] } },
    };
    const next = setActivePlaidSource(withOldCopy, "2026-04-20T02:00:00.000Z");

    expect(next).not.toBeNull();
    const sources = next!.sources as Record<string, unknown>;
    expect(sources.plaid).toBeUndefined();
    expect(sources.active_source).toBe("plaid");
    expect(((next!.portfolio as { holdings?: unknown[] }).holdings ?? []).length).toBeGreaterThan(0);
  });

  it("has nothing to activate without sealed Plaid holdings", () => {
    expect(setActivePlaidSource(financial, "2026-04-20T02:00:00.000Z")).toBeNull();
  });

  it("falls back to the vault's holdings when the last statement is deleted", () => {
    const statement = financial.sources.statement;
    const single = withVaultBank({
      ...financial,
      sources: {
        active_source: "statement",
        plaid: { signature: "old" },
        statement: { ...statement, snapshots: [statement.snapshots[0]] },
      },
    });
    const next = removeStatementSnapshot(single, "stmt_b", "2026-04-20T02:00:00.000Z");

    expect(next).not.toBeNull();
    const sources = next!.sources as Record<string, unknown>;
    expect(getStatementSnapshotOptions(next)).toHaveLength(0);
    expect(sources.active_source).toBe("plaid");
    expect(sources.plaid).toBeUndefined();
    expect(((next!.portfolio as { holdings?: unknown[] }).holdings ?? []).length).toBeGreaterThan(0);
  });

  it("keeps a saved statement source active when backend preference is stale", () => {
    expect(
      resolvePreferredPortfolioSource({
        storedActiveSource: "statement",
        backendPreferredSource: "plaid",
        hasStatementPortfolio: true,
        hasPlaidPortfolio: true,
      })
    ).toBe("statement");
  });

  it("falls back to Plaid preference only when no statement portfolio is available", () => {
    expect(
      resolvePreferredPortfolioSource({
        storedActiveSource: "statement",
        backendPreferredSource: "plaid",
        hasStatementPortfolio: false,
        hasPlaidPortfolio: true,
      })
    ).toBe("plaid");
  });

  it("gives a re-saved statement the same id and replaces its snapshot", async () => {
    const statement = {
      account_info: {
        brokerage: "Charles Schwab",
        account_number: "XXXX-1234",
        statement_period_end: "2026-08-31",
      },
      holdings: [{ symbol: "AAPL", quantity: 10, market_value: 2000 }],
    };
    const id = await computeStatementImportId(statement);
    // An edited review of the same statement is still that statement.
    const edited = await computeStatementImportId({ ...statement, holdings: [] });
    expect(edited).toBe(id);

    const once = upsertStatementSnapshot([], { id, imported_at: "a" });
    const twice = upsertStatementSnapshot(once, { id, imported_at: "b" });
    expect(twice).toEqual([{ id, imported_at: "b" }]);

    // Negative control: without an account number or period, holdings decide,
    // so two unlabeled statements never collapse into one.
    const unlabeledA = await computeStatementImportId({ holdings: statement.holdings });
    const unlabeledB = await computeStatementImportId({
      holdings: [{ symbol: "MSFT", quantity: 1, market_value: 400 }],
    });
    expect(unlabeledA).not.toBe(unlabeledB);
    expect(upsertStatementSnapshot(twice, { id: unlabeledA })).toHaveLength(2);
  });
});

describe("statement holding entries survive saves", () => {
  const holdings = [
    { symbol: "AAPL", name: "Apple", quantity: 10, price: 130, market_value: 1300, cost_basis: 1000, acquisition_date: "2026-01-10" },
    { symbol: "AAPL", name: "Apple", quantity: 5, price: 130, market_value: 650, cost_basis: 600, acquisition_date: "2026-05-10" },
  ];
  const portfolio = { holdings, total_value: 1950, cash_balance: 0,
    account_summary: { ending_value: 1950, cash_balance: 0, equities_value: 1950 } };
  function fixture(kind: "snapshot" | "legacy" | "v7"): Record<string, unknown> {
    if (kind === "v7") return {
      pkm_contract_version: "7.0.0", profile: { sentinel: true },
      financial_core_v7: { active_source: "statement", accounts: { account: { account_id: "account" } },
        securities: { apple: { symbol: "AAPL", name: "Apple" } },
        positions: Object.fromEntries(holdings.map((entry, index) => ["position-" + index, { ...entry, account_id: "account", security_id: "apple" }])),
        account_summary: portfolio.account_summary, total_value: 1950, cash_balance: 0 },
      source_artifacts_v7: { statement_snapshots: [{ id: "current", artifact_ref: "sha256:retained" }] },
    };
    const snapshots = [{ id: "current", canonical_v2: portfolio }, { id: "other", canonical_v2: { holdings: [{ symbol: "OTHER" }] } }];
    return { profile: { sentinel: true }, portfolio,
      sources: { active_source: "statement", statement: kind === "snapshot" ? { active_snapshot_id: "current", snapshots } : {} },
      ...(kind === "legacy" ? { documents: { statements: snapshots } } : {}),
    };
  }
  it.each(["snapshot", "legacy", "v7"] as const)("preserves and independently edits/removes two %s entries after reload", kind => {
    let stored = fixture(kind);
    const original = getStatementPortfolio(stored)!;
    const first = { ...original, holdings: original.holdings!.map((entry, index) => ({ ...entry, entry_id: entry.position_id || "entry-" + index })) };
    const save = (before: typeof original, after: typeof original) => {
      stored = JSON.parse(JSON.stringify(applyStatementHoldingsEdit(stored, after, before, "current", NOW)));
      expect(stored.profile).toEqual({ sentinel: true });
      return getStatementPortfolio(stored)!;
    };
    let reloaded = save(original, first);
    expect(reloaded.holdings).toHaveLength(2);
    expect(reloaded.holdings!.map(entry => entry.acquisition_date)).toEqual(["2026-01-10", "2026-05-10"]);
    const edited = reloaded.holdings!.map((entry, index) => index ? { ...entry, quantity: 7, market_value: 910, cost_basis: 840 } : entry);
    reloaded = save(reloaded, { ...reloaded, holdings: edited, total_value: 2210,
      account_summary: { ending_value: 2210, cash_balance: 0, equities_value: 2210 } });
    expect(reloaded.holdings!.map(entry => entry.quantity)).toEqual([10, 7]);
    reloaded = save(reloaded, { ...reloaded, holdings: reloaded.holdings!.slice(1), total_value: 910,
      account_summary: { ending_value: 910, cash_balance: 0, equities_value: 910 } });
    expect(reloaded.holdings).toHaveLength(1);
    expect(reloaded.holdings![0]).toMatchObject({ quantity: 7, cost_basis: 840, acquisition_date: "2026-05-10" });
    if (kind === "v7") expect(stored.source_artifacts_v7).toEqual({ statement_snapshots: [{ id: "current", artifact_ref: "sha256:retained" }] });
    else expect(getStatementSnapshotOptions(stored)).toHaveLength(2);
  });
  it("refuses a stale edit instead of undoing concurrent changes", () => {
    const stored = fixture("snapshot");
    const previous = getStatementPortfolio(stored)!;
    const changed = fixture("snapshot");
    const sources = changed.sources as { statement: { snapshots: { canonical_v2: { holdings: typeof holdings } }[] } };
    sources.statement.snapshots[0]!.canonical_v2 = { holdings: [{ ...holdings[0]!, quantity: 99 }, holdings[1]!] };
    expect(() => applyStatementHoldingsEdit(changed, previous, previous, "current", NOW)).toThrow(/changed while/);
    expect(() => applyStatementHoldingsEdit(stored, previous, previous, "missing", NOW)).toThrow();
  });
  it("keeps repeated V7 ticker edits and refuses an orphan account", () => {
    let stored = fixture("v7");
    for (const symbol of ["MSFT", "TSLA"]) {
      const before = getStatementPortfolio(stored)!;
      const next = { ...before, holdings: before.holdings!.map((entry, i) => i ? entry : { ...entry, symbol }) };
      stored = applyStatementHoldingsEdit(stored, next, before, "current", NOW);
      expect(getStatementPortfolio(stored)!.holdings![0]!.symbol).toBe(symbol);
    }
    const before = getStatementPortfolio(stored)!;
    expect(() => applyStatementHoldingsEdit(stored, { ...before, holdings: before.holdings!.map(entry => ({ ...entry, account_id: "missing" })) }, before, "current", NOW)).toThrow(/account/);
  });
});
