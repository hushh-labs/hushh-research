import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ImportProgressView } from "@/components/kai/views/import-progress-view";
import { replaceLiveHoldingPreviewRows } from "@/lib/kai/import/live-holdings-preview";

describe("ImportProgressView", () => {
  it("reports the current step with a forward-only progress bar and no stream", () => {
    const { rerender } = render(<ImportProgressView stage="extracting" onCancel={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Finding holdings");
    const first = Number(screen.getByRole("progressbar").getAttribute("aria-valuenow"));
    expect(first).toBeGreaterThan(0);
    expect(screen.queryByText("AI stream")).toBeNull();
    rerender(<ImportProgressView stage="validating" onCancel={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Checking holdings");
    expect(Number(screen.getByRole("progressbar").getAttribute("aria-valuenow"))).toBeGreaterThan(first);
    expect(screen.queryByRole("button", { name: "Review holdings" })).toBeNull();
  });

  it("keeps moving and says it is still working when extraction runs long", () => {
    vi.useFakeTimers();
    try {
      render(<ImportProgressView stage="extracting" onCancel={vi.fn()} />);
      const at = () => Number(screen.getByRole("progressbar").getAttribute("aria-valuenow"));
      const start = at();
      expect(screen.queryByText(/still working/i)).toBeNull();
      act(() => { vi.advanceTimersByTime(20_000); });
      expect(at()).toBeGreaterThan(start);
      expect(at()).toBeLessThan(89);
      expect(screen.getByText(/still working/i)).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers a single back action and retry after a failed import", () => {
    const back = vi.fn();
    const retry = vi.fn();
    render(<ImportProgressView stage="error" onCancel={back} onRetry={retry} />);
    expect(screen.getByRole("status")).toHaveTextContent("Try again or choose a different statement.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(back).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});

describe("ImportProgressView placeholders", () => {
  it("shows the review layout as placeholders with the file name while the statement is read", () => {
    render(<ImportProgressView stage="extracting" fileName="statement.pdf" fileSize={1_258_291} onCancel={vi.fn()} />);
    expect(screen.getByText("statement.pdf · 1.2 MB")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Review holdings" })).toBeVisible();
    expect(screen.getByText("Portfolio value")).toBeVisible();
    // Nothing is known yet, so no holding is shown and the rows are placeholders.
    expect(screen.queryByRole("list", { name: "Holdings found so far" })).toBeNull();
  });

  it("streams confirmed holdings without inventing final totals or enabling edits", () => {
    const { rerender } = render(
      <ImportProgressView
        stage="normalizing"
        holdingsTotal={40}
        liveHoldings={[
          { symbol: "AAPL", name: "Apple Inc.", quantity: 10, market_value: 24310 },
          { symbol: "MSFT", name: "Microsoft Corp.", quantity: null, market_value: 18942.5 },
        ]}
        onCancel={vi.fn()}
      />,
    );
    const found = screen.getByRole("region", { name: "Holdings found so far" });
    expect(found).toHaveTextContent("AAPL");
    expect(found).toHaveTextContent("Microsoft Corp.");
    expect(found).not.toHaveTextContent("$24,310.00");
    expect(screen.getByText("Positions").nextElementSibling).not.toHaveTextContent("40");
    expect(screen.queryByRole("button", { name: /manage|save|start over/i })).toBeNull();
    rerender(<ImportProgressView stage="complete" liveHoldings={[{ symbol: "AAPL", name: "Apple Inc." }]} onCancel={vi.fn()} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    // 100% is presentation, not terminal-success authority to edit or save.
    expect(screen.queryByRole("button", { name: /manage|save|start over/i })).toBeNull();
  });

  it("shows no placeholder after a failed import", () => {
    render(<ImportProgressView stage="error" fileName="statement.pdf" onCancel={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.queryByText("Portfolio value")).toBeNull();
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
