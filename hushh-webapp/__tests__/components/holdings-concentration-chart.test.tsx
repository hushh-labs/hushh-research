import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { HoldingsConcentrationChart } from "@/components/kai/charts/holdings-concentration-chart";

describe("HoldingsConcentrationChart", () => {
  beforeAll(() => {
    globalThis.ResizeObserver = class ResizeObserver {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    };
  });

  it("covers concentration label rendering", () => {
    render(
      <HoldingsConcentrationChart
        data={[
          {
            symbol: "AAPL",
            name: "Apple Inc.",
            marketValue: 12000,
            weightPct: 12.34,
          },
        ]}
      />,
    );

    expect(screen.getByRole("img", { name: "AAPL: 12.3%" })).toBeTruthy();
  });
});
