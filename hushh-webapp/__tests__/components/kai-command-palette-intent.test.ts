import { describe, expect, it } from "vitest";

import {
  deriveFinanceTickerQuery,
  isFinanceAnalysisQuery,
} from "@/components/kai/kai-command-palette";

describe("Finance Analysis command intent", () => {
  it("keeps Analyze as the authored prefix and searches only the trailing ticker text", () => {
    expect(deriveFinanceTickerQuery("Analyze ", "finance_stock_analysis")).toBe("");
    expect(deriveFinanceTickerQuery("Analyze AAPL", "finance_stock_analysis")).toBe("AAPL");
    expect(deriveFinanceTickerQuery("Analyze Apple", "finance_stock_analysis")).toBe("Apple");
  });

  it("does not rewrite ordinary global search queries", () => {
    expect(deriveFinanceTickerQuery("analysis cash flow")).toBe("analysis cash flow");
  });

  it("treats the exact global Analyze command as Finance analysis", () => {
    expect(isFinanceAnalysisQuery("Analyze nvda")).toBe(true);
    expect(isFinanceAnalysisQuery("  analyze Apple")).toBe(true);
    expect(isFinanceAnalysisQuery("AnalyzeThis")).toBe(false);
    expect(deriveFinanceTickerQuery("Analyze nvda")).toBe("nvda");
  });
});
