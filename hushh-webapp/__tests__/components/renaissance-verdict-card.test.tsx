import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RenaissanceVerdictCard } from "@/components/kai/cards/renaissance-verdict-card";
import type { KaiHomeRenaissanceItem } from "@/lib/services/api-service";

function makeRow(
  overrides: Partial<KaiHomeRenaissanceItem> = {},
): KaiHomeRenaissanceItem {
  return {
    symbol: "NVDA",
    company_name: "Nvidia",
    sector: "Semiconductors",
    tier: "ACE",
    tier_rank: 1,
    conviction_weight: 0.9,
    recommendation_bias: "BUY",
    investment_thesis: "Accelerated compute demand remains durable.",
    fcf_billions: 27.4,
    price: 900,
    change_pct: 1.2,
    volume: 1000000,
    market_cap: 2000,
    source_tags: ["renaissance"],
    degraded: false,
    as_of: "2026-04-30T00:00:00Z",
    ...overrides,
  };
}

describe("RenaissanceVerdictCard", () => {
  it("shows the provider summary without manufacturing a conviction signal", () => {
    render(<RenaissanceVerdictCard row={makeRow({ company_facts: {
      symbol: "NVDA", summary: "Nvidia designs graphics processors.",
    } })} />);
    expect(screen.getByRole("heading", { name: "Summary" })).toBeTruthy();
    expect(screen.getByText("Nvidia designs graphics processors.")).toBeTruthy();
    expect(screen.queryByText(/Constructive signal|Caution signal/)).toBeNull();
  });

  it("uses the authored list summary when the provider summary is unavailable", () => {
    render(<RenaissanceVerdictCard row={makeRow({ recommendation_bias: "SELL" })} />);
    expect(screen.getByText("Accelerated compute demand remains durable.")).toBeTruthy();
    expect(screen.getByText("Summary from the selected list.")).toBeTruthy();
    expect(screen.queryByText(/Caution signal/)).toBeNull();
  });
});
