import { createElement } from "react";
import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { balancedMoverCount, OneMarketMovers } from "@/components/kai/views/kai-market-preview-view";

const row = (symbol: string, changePct: number) => ({
  symbol, companyName: `${symbol} Limited`, price: 100, changePct, volume: 1, sparkline: null, degraded: false, asOf: "2026-11-12T10:01:00Z",
});
const names = (prefix: string, count: number, sign: 1 | -1) =>
  Array.from({ length: count }, (_, index) => row(`${prefix}${index}`, sign * (index + 1)));

function renderIndia(gain: number, lose: number) {
  return render(createElement(OneMarketMovers, {
    groups: { gain: names("G", gain, 1), lose: names("L", lose, -1), active: [] },
    linkable: false,
    balanced: true,
  }));
}

describe("India movers are always balanced", () => {
  it.each([
    [5, 5, 3], [3, 3, 3], [4, 2, 2], [1, 4, 1], [2, 2, 2],
  ])("%i gainers and %i losers show %i by %i with no empty entry", (gain, lose, shown) => {
    expect(balancedMoverCount({ gain: names("G", gain, 1), lose: names("L", lose, -1), active: [] })).toBe(shown);
    const { container } = renderIndia(gain, lose);
    expect(container.querySelectorAll("[data-market-mover-empty]")).toHaveLength(0);
    for (const title of ["Gainers", "Losers"]) {
      const region = container.querySelector(`[data-market-mover-group="${title === "Gainers" ? "gain" : "lose"}"]`) as HTMLElement;
      expect(region.querySelectorAll("[data-market-mover-rank]")).toHaveLength(shown);
    }
  });

  it("says so once instead of showing empty entries when a side has no names", () => {
    const { container } = renderIndia(0, 4);
    expect(container.querySelectorAll("[data-market-mover-empty]")).toHaveLength(0);
    expect(container.querySelectorAll("[data-market-mover-rank]")).toHaveLength(0);
    expect(within(container).getByText("Movers are not available right now.")).toBeInTheDocument();
  });

  it("leaves the US screen on three ranks with its existing placeholders", () => {
    const { container } = render(createElement(OneMarketMovers, {
      groups: { gain: names("G", 1, 1), lose: names("L", 3, -1), active: [] },
    }));
    expect(container.querySelectorAll("[data-market-mover-empty]")).toHaveLength(2);
  });
});
