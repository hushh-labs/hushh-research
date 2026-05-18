import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RenaissanceVerdictCard } from "@/components/kai/cards/renaissance-verdict-card";
import type { KaiHomeRenaissanceItem } from "@/lib/services/api-service";

function makeRow(
  overrides: Partial<KaiHomeRenaissanceItem> = {}
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
  it("frames constructive bias as a market signal instead of a buy instruction", () => {
    const { container } = render(<RenaissanceVerdictCard row={makeRow()} />);

    expect(screen.getByText("Constructive signal")).toBeTruthy();
    expect(container.textContent).toContain(
      "Nvidia currently shows a constructive Renaissance bias."
    );
    expect(container.textContent).toContain(
      "Kai presents this as market context, not a personalized instruction."
    );
    expect(container.textContent).not.toMatch(/\bBuy\b|Do not buy|before adding/i);
  });

  it("uses caution language for reduce or sell bias without telling the user what to trade", () => {
    const { container } = render(
      <RenaissanceVerdictCard
        row={makeRow({
          recommendation_bias: "SELL",
          degraded: true,
        })}
      />
    );

    expect(screen.getByText("Caution signal")).toBeTruthy();
    expect(screen.getByText("Lower confidence")).toBeTruthy();
    expect(container.textContent).toContain(
      "Review the thesis and data quality before acting on the signal."
    );
    expect(container.textContent).not.toMatch(/Do not buy|before adding/i);
  });
});
