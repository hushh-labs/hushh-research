import { describe, expect, it } from "vitest";

import { normalizeTrackedSymbols } from "@/components/kai/views/kai-market-preview-view";

describe("Kai market preview symbol normalization", () => {
  it("normalizes, dedupes, and caps tracked symbols", () => {
    expect(
      normalizeTrackedSymbols([
        " aapl ",
        "AAPL",
        "msft",
        " MSFT ",
        "goog",
        "amzn",
        "nvda",
        "meta",
        "tsla",
        "nflx",
      ]),
    ).toEqual(["AAPL", "MSFT", "GOOG", "AMZN", "NVDA", "META", "TSLA", "NFLX"]);
  });

  it("returns an empty list for invalid symbol input", () => {
    expect(normalizeTrackedSymbols(null)).toEqual([]);
    expect(normalizeTrackedSymbols(undefined)).toEqual([]);
  });
});