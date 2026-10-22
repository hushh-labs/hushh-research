import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RiaPicksList, mergeMarketCompanyFacts } from "@/components/kai/cards/renaissance-market-list";
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
  company_facts: { symbol: "NVDA", market_cap: 2_000, pe_ratio: 28.5, pb_ratio: 9.2, debt_to_equity: 0.42, summary: "Nvidia designs graphics processors." },
  source_tags: ["renaissance"],
  degraded: false,
  alias_repaired: true,
  as_of: "2026-04-30T00:00:00Z",
};

describe("RiaPicksList detail", () => {
  it("retains known facts through refresh failure and accepts newer successful facts", () => {
    const current = { NVDA: row.company_facts! };
    const cached = mergeMarketCompanyFacts(current, { NVDA: { symbol: "NVDA", unavailable: true } }, [row]);
    expect(cached.NVDA).toMatchObject({ pe_ratio: 28.5, stale: true });
    expect(mergeMarketCompanyFacts(cached, { NVDA: { symbol: "NVDA", pe_ratio: 30 } }, [row]).NVDA?.pe_ratio).toBe(30);
  });
  it("leads with the company logo and keeps identity copy singular", async () => {
    const analyze = vi.fn();
    const selection = vi.fn();
    const { rerender } = render(<RiaPicksList rows={[row]} onAnalyze={analyze} onSelectedSymbolChange={selection} />);

    fireEvent.click(screen.getByRole("button", { name: /Nvidia/i }));

    const dialog = await screen.findByRole("dialog", { name: "NVDA" });
    const detail = within(dialog);

    expect(dialog.querySelector('[data-symbol-avatar="true"]')).toBeTruthy();
    expect(detail.getByText(/Nvidia • Semiconductors/i)).toBeTruthy();
    expect(detail.getByText("USD · Quoted", { exact: false })).toBeTruthy();
    expect(detail.queryByText(/Advisor list detail/i)).toBeNull();
    expect(detail.queryByText(/Symbol repaired/i)).toBeNull();
    expect(detail.queryByText("Investment thesis")).toBeNull();
    expect(detail.getByRole("heading", { name: "Summary" })).toBeTruthy();
    expect(detail.getByText("28.50×")).toBeTruthy();
    expect(detail.getByText("9.20×")).toBeTruthy();
    expect(detail.getByText("0.42×")).toBeTruthy();
    expect(detail.getByText("P/E (TTM)")).toBeTruthy();
    expect(detail.getByText("Nvidia designs graphics processors.")).toBeTruthy();
    expect(selection).toHaveBeenLastCalledWith("NVDA");
    expect(analyze).not.toHaveBeenCalled();
    fireEvent.click(detail.getByRole("button", { name: "Analyze NVDA" }));
    expect(analyze).toHaveBeenCalledExactlyOnceWith("NVDA");
    expect(selection).toHaveBeenLastCalledWith(null);
    rerender(<RiaPicksList rows={[row]} />);
    fireEvent.click(screen.getByRole("button", { name: /Nvidia/i }));
    const publicDetail = await screen.findByRole("dialog", { name: "NVDA" });
    expect(within(publicDetail).queryByRole("button", { name: "Analyze NVDA" })).toBeNull();
  });

  it("loads observed history only after selection and cancels it when details close", async () => {
    const loadHistory = vi.fn(async (_symbol: string, _signal: AbortSignal) => ({ points: [], stale: true, retrievedAt: null }));
    render(<RiaPicksList rows={[row]} loadHistory={loadHistory} />);
    expect(loadHistory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Nvidia/i }));
    const dialog = await screen.findByRole("dialog", { name: "NVDA" });
    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(1));
    const signal = loadHistory.mock.calls[0][1];
    expect(loadHistory.mock.calls[0][0]).toBe("NVDA");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close detail panel" }));
    await waitFor(() => expect(signal.aborted).toBe(true));
  });

  it("hides a source control that has no alternative and keeps empty-source recovery available", () => {
    const { rerender } = render(<RiaPicksList rows={[]} />);
    expect(screen.queryByText("List source")).toBeNull();
    rerender(<RiaPicksList rows={[]} activeSourceId="ria:one" sources={[
      { id: "default", label: "Curated stocks", kind: "default", state: "ready", is_default: true },
      { id: "ria:one", label: "Advisor list", kind: "ria", state: "ready", is_default: false },
    ]} />);
    expect(screen.getByRole("combobox", { name: "List source" })).toBeTruthy();
    expect(screen.getAllByRole("combobox").length).toBeGreaterThan(0);
  });
});
