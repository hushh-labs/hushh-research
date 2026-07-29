import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RiaPicksList } from "@/components/kai/cards/renaissance-market-list";
import type { KaiHomeRenaissanceItem } from "@/lib/services/api-service";

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

const row: KaiHomeRenaissanceItem = {
  symbol: "NVDA",
  quote_symbol: "NVDA",
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
  volume: 1_000_000,
  market_cap: 2_000,
  source_tags: ["renaissance"],
  degraded: false,
  alias_repaired: true,
  as_of: "2026-04-30T00:00:00Z",
};

describe("RiaPicksList detail", () => {
  it("leads with the company logo and keeps identity copy singular", async () => {
    render(<RiaPicksList rows={[row]} />);

    fireEvent.click(screen.getByRole("button", { name: /Nvidia/i }));

    const dialog = await screen.findByRole("dialog", { name: "Nvidia" });
    const detail = within(dialog);

    expect(dialog.querySelector('[data-symbol-avatar="true"]')).toBeTruthy();
    expect(detail.getAllByText("Nvidia")).toHaveLength(1);
    expect(detail.getByText(/NVDA • Semiconductors/i)).toBeTruthy();
    expect(detail.queryByText(/Advisor list detail/i)).toBeNull();
    expect(detail.queryByText(/Symbol repaired/i)).toBeNull();
    expect(detail.queryByText("Investment thesis")).toBeNull();
    expect(detail.getByRole("heading", { name: "Thesis" })).toBeTruthy();
  });
});
