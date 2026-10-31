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
    expect(screen.getByRole("heading", { name: "Company summary", level: 3 })).toBeTruthy();
    expect(screen.getByRole("listitem").textContent).toBe("Nvidia designs graphics processors.");
    expect(screen.queryByText(/Constructive signal|Caution signal/)).toBeNull();
  });

  it("bounds verbatim excerpts while retaining the full provider profile", () => {
    const first = "A".repeat(300) + ".";
    const summary = `${first} The company supplies processors. Its full profile remains accessible.`;
    const { container } = render(<RenaissanceVerdictCard row={makeRow({ company_facts: { symbol: "NVDA", summary } })} />);
    const excerpts = container.querySelectorAll("li");
    expect(excerpts).toHaveLength(2);
    expect(excerpts[0].textContent).toBe(`${"A".repeat(220)}…`);
    expect(excerpts[1].textContent).toBe("The company supplies processors.");
    expect(container.querySelector("details p")?.textContent).toBe(summary);
  });

  it("uses the authored list summary when the provider summary is unavailable", () => {
    render(<RenaissanceVerdictCard row={makeRow({ recommendation_bias: "SELL" })} />);
    expect(screen.getByText("Accelerated compute demand remains durable.")).toBeTruthy();
    expect(screen.getByText("Summary from the selected list.")).toBeTruthy();
    expect(screen.queryByText(/Caution signal/)).toBeNull();
  });
});
