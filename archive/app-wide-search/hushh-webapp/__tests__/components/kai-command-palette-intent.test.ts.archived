import { describe, expect, it } from "vitest";

import { deriveFinanceTickerQuery } from "@/components/kai/kai-command-palette";

describe("Finance Analysis command intent", () => {
  it("keeps Analyze as the authored prefix and searches only the trailing ticker text", () => {
    expect(deriveFinanceTickerQuery("Analyze ", "finance_stock_analysis")).toBe(
      "",
    );
    expect(
      deriveFinanceTickerQuery("Analyze AAPL", "finance_stock_analysis"),
    ).toBe("AAPL");
    expect(
      deriveFinanceTickerQuery("Analyze Apple", "finance_stock_analysis"),
    ).toBe("Apple");
  });

  it("does not rewrite ordinary global search queries", () => {
    expect(deriveFinanceTickerQuery("analysis cash flow")).toBe(
      "analysis cash flow",
    );
  });

  it("does not infer Finance authority from global query text", () => {
    expect(deriveFinanceTickerQuery("Analyze my goals")).toBe(
      "Analyze my goals",
    );
    expect(deriveFinanceTickerQuery("Analyze nvda")).toBe("Analyze nvda");
  });
});
