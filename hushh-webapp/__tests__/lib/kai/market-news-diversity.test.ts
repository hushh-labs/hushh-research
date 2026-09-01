import { describe, expect, it } from "vitest";

import { diversifyMarketNewsRows } from "@/lib/kai/market-news-diversity";
import type { KaiHomeNewsItem } from "@/lib/services/api-service";

function row(
  symbol: string,
  title: string,
  url: string,
  publishedAt = "2026-08-31T00:00:00Z",
): KaiHomeNewsItem {
  return {
    symbol,
    title,
    url,
    published_at: publishedAt,
    source_name: "Example",
    provider: "test",
    degraded: false,
  };
}

describe("diversifyMarketNewsRows", () => {
  it("round-robins symbols so AMZN cannot consume the visible tape", () => {
    const result = diversifyMarketNewsRows([
      row("AMZN", "Amazon one", "https://example.test/1"),
      row("AMZN", "Amazon two", "https://example.test/2"),
      row("AMZN", "Amazon three", "https://example.test/3"),
      row("MSFT", "Microsoft one", "https://example.test/4"),
      row("NVDA", "Nvidia one", "https://example.test/5"),
    ]);

    expect(result.slice(0, 4).map((item) => item.symbol)).toEqual([
      "AMZN",
      "MSFT",
      "NVDA",
      "AMZN",
    ]);
    expect(result.filter((item) => item.symbol === "AMZN")).toHaveLength(2);
  });

  it("deduplicates tracking variants of the same headline and URL", () => {
    const result = diversifyMarketNewsRows([
      row("AAPL", "Apple updates guidance", "https://example.test/apple?utm_source=x"),
      row("AAPL", "Apple updates guidance", "https://example.test/apple"),
      row("AAPL", "Rewritten Apple guidance", "https://example.test/apple"),
    ]);
    expect(result).toHaveLength(1);
  });

  it("starts with the freshest represented symbol instead of portfolio alphabetic order", () => {
    const result = diversifyMarketNewsRows([
      row("AMZN", "Amazon update", "https://example.test/amzn", "2026-08-29T00:00:00Z"),
      row("BUD", "Brewer update", "https://example.test/bud", "2026-08-30T00:00:00Z"),
      row("NVDA", "Nvidia update", "https://example.test/nvda", "2026-08-31T00:00:00Z"),
    ]);

    expect(result.map((item) => item.symbol)).toEqual(["NVDA", "BUD", "AMZN"]);
  });
});
