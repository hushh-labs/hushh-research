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
});
