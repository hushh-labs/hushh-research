import { describe, expect, it } from "vitest";

import {
  getActiveStatementSnapshotId,
  getStatementPortfolio,
  getStatementSnapshotOptions,
  setActiveStatementSnapshot,
} from "@/lib/kai/brokerage/financial-sources";

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
});
