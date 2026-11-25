import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { KaiHomeNewsItem, KaiHomeSectorItem } from "@/lib/services/api-service";
import { SectorRotationChart } from "@/components/kai/cards/sector-rotation-chart";
import { OneMarketNewsBriefing } from "@/components/kai/cards/market-news-briefing";

afterEach(cleanup);

const sector = (name: string, changePct: number) =>
  ({ sector: name, change_pct: changePct, change_1w_pct: changePct, period_end: "2026-11-11", period_start_1d: "2026-11-10", period_start_1w: "2026-11-04" }) as unknown as KaiHomeSectorItem;

it("draws a visible bar for every non-zero sector move, even beside a much larger one", () => {
  const { container } = render(<SectorRotationChart rows={[sector("Technology", 3.23), sector("Real Estate", -0.04), sector("Utilities", 0)]} />);
  const bars = Array.from(container.querySelectorAll<HTMLElement>("span.absolute.rounded-full")).map((bar) => Number.parseFloat(bar.style.width));
  // Sorted by return: Technology, Utilities (flat), Real Estate. Scaled strictly, the
  // -0.04% move would be 0.6% wide and effectively invisible.
  expect(bars).toHaveLength(3);
  expect(bars[0]).toBeGreaterThan(40);
  expect(bars[1]).toBe(0);
  expect(bars[2]).toBeGreaterThanOrEqual(3);
});

it("shows placeholder rows while the news loads and real headlines once they arrive", () => {
  const story = { title: "Markets rally", url: "https://example.com/a", source_name: "Yahoo", published_at: "2026-11-12T09:00:00Z" } as unknown as KaiHomeNewsItem;
  const { rerender } = render(<OneMarketNewsBriefing rows={[]} loading />);
  expect(screen.getByRole("status", { name: "Loading market news" })).toBeInTheDocument();
  expect(screen.queryByText(/Headlines will appear/)).toBeNull();
  rerender(<OneMarketNewsBriefing rows={[story]} loading={false} />);
  expect(screen.queryByRole("status", { name: "Loading market news" })).toBeNull();
  expect(screen.getByText("Markets rally")).toBeInTheDocument();
});
