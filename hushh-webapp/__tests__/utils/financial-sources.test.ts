import { describe, expect, it } from "vitest";

import {
  getActiveStatementSnapshotId,
  getStatementPortfolio,
  getStatementSnapshotOptions,
  isPlaidMirrorStale,
  removePlaidSource,
  removeStatementSnapshot,
  setActiveStatementSnapshot,
} from "@/lib/kai/brokerage/financial-sources";
import { resolvePreferredPortfolioSource } from "@/lib/kai/brokerage/portfolio-sources";

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

  it("removes Plaid source data and restores the active statement snapshot", () => {
    const withPlaid = {
      ...financial,
      portfolio: {
        holdings: [{ symbol: "PLAID", name: "Plaid Holding", quantity: 1, market_value: 50 }],
      },
      sources: {
        ...financial.sources,
        active_source: "plaid",
        plaid: {
          signature: "old",
          items: [{ item_id: "item_1", status: "active" }],
          aggregate: {
            portfolio_data: {
              holdings: [
                { symbol: "PLAID", name: "Plaid Holding", quantity: 1, market_value: 50 },
              ],
            },
          },
        },
      },
    };

    const removed = removePlaidSource(withPlaid, "2026-04-20T02:00:00.000Z", {
      clearActivePortfolio: true,
    });

    expect((removed.sources as Record<string, unknown>).plaid).toBeUndefined();
    expect(getActiveStatementSnapshotId(removed)).toBe("stmt_b");
    expect(getStatementPortfolio(removed)?.holdings?.[0]?.symbol).toBe("BETA");
  });

  it("does not persist an empty Plaid mirror when no local Plaid source exists", () => {
    expect(
      isPlaidMirrorStale(financial, {
        configured: true,
        user_id: "user_1",
        source_preference: "statement",
        items: [],
        aggregate: {
          item_count: 0,
          account_count: 0,
          holdings_count: 0,
          institution_names: [],
          sync_status: "idle",
          portfolio_data: null,
        },
      })
    ).toBe(false);
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
});
