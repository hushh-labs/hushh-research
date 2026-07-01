import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WatchlistStrip } from "@/components/kai/home/watchlist-strip";

describe("WatchlistStrip", () => {
  it("covers empty watchlist fallback", () => {
    render(<WatchlistStrip items={[]} />);

    expect(
      screen.getByText("No watchlist/holdings data available yet."),
    ).toBeTruthy();
  });
});
