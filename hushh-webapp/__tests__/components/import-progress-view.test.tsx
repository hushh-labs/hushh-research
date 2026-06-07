import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ImportProgressView } from "@/components/kai/views/import-progress-view";
import { replaceLiveHoldingPreviewRows } from "@/lib/kai/import/live-holdings-preview";

describe("ImportProgressView", () => {
  it("keeps a visible AI stream panel during parsing", () => {
    render(
      <ImportProgressView
        stage="extracting"
        isStreaming
        progressPct={42}
        statusMessage="Extracting portfolio statement data..."
        rawStreamLines={[
          "[STAGE/EXTRACTING] Extracting portfolio statement data...",
          "[THINKING] Locating the holdings table before parsing quantities.",
          "{\"holdings_preview\":[]}",
        ]}
      />
    );

    expect(screen.getByText("AI stream")).toBeTruthy();
    expect(screen.getAllByText(/Extracting portfolio statement data/i).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/Locating the holdings table before parsing quantities/i).length
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Reviewing your statement...")).toBeNull();
  });

  it("does not add repeated live holding snapshots into impossible totals", () => {
    render(
      <ImportProgressView
        stage="normalizing"
        isStreaming
        progressPct={85}
        statusMessage="Confirmed 2 of 4 holdings"
        liveHoldings={[
          { symbol: "AAPL", name: "Apple Inc.", quantity: 10, market_value: 100 },
          { symbol: "AAPL", name: "Apple Inc.", quantity: 20, market_value: 200 },
        ]}
        holdingsExtracted={2}
        holdingsTotal={4}
      />
    );

    expect(screen.getByText("AAPL")).toBeTruthy();
    expect(screen.getByText("Qty: 20")).toBeTruthy();
    expect(
      screen.getByText((_, node) => node?.textContent?.replace(/\s+/g, " ").trim() === "Value: $200")
    ).toBeTruthy();
    expect(screen.queryByText("Qty: 30")).toBeNull();
    expect(screen.queryByText("$300")).toBeNull();
  });

  it("hides implausible interim quantity and value values", () => {
    render(
      <ImportProgressView
        stage="extracting"
        isStreaming
        progressPct={55}
        statusMessage="Confirming live holdings"
        liveHoldings={[
          {
            symbol: "AAPL",
            name: "Apple Inc.",
            quantity: 9_999_999_999_999,
            market_value: 900_000_000_000_000,
          },
        ]}
        holdingsExtracted={1}
      />
    );

    expect(screen.getByText("AAPL")).toBeTruthy();
    expect(screen.getByText("Qty: —")).toBeTruthy();
    expect(
      screen.getByText((_, node) => node?.textContent?.replace(/\s+/g, " ").trim() === "Value: —")
    ).toBeTruthy();
    expect(screen.queryByText(/9,999,999,999,999/)).toBeNull();
    expect(screen.queryByText(/\$900,000,000,000,000/)).toBeNull();
  });
});

describe("replaceLiveHoldingPreviewRows", () => {
  it("treats incoming preview rows as the latest snapshot instead of a delta", () => {
    const next = replaceLiveHoldingPreviewRows(
      [
        { symbol: "AAPL", name: "Apple Inc.", quantity: 10, market_value: 100 },
        { symbol: "MSFT", name: "Microsoft", quantity: 5, market_value: 50 },
      ],
      [{ symbol: "AAPL", name: "Apple Inc.", quantity: 12, market_value: 120 }]
    );

    expect(next).toEqual([
      {
        symbol: "AAPL",
        name: "Apple Inc.",
        quantity: 12,
        market_value: 120,
        asset_type: undefined,
        position_side: "long",
        is_short_position: false,
        is_liability_position: false,
      },
    ]);
  });
});
