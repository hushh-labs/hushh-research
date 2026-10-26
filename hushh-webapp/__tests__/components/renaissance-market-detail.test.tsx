import { act, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RiaPicksList, mergeMarketCompanyFacts } from "@/components/kai/cards/renaissance-market-list";
import type { KaiHomeRenaissanceItem } from "@/lib/services/api-service";
import type { PublicStockQuote } from "@/lib/services/public-stock-quote";

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
  it("recovers an unavailable quote only for the selected stock and accepts later list updates", async () => {
    const loadQuote = vi.fn(async (symbol: string, _signal: AbortSignal): Promise<PublicStockQuote> => ({
      symbol, price: 273, changePct: null, quotedAt: "2026-10-26T14:00:00Z", source: "Fixture", stale: true, delayed: false,
    }));
    const unavailable = { ...row, price: null, change_pct: null, as_of: null, degraded: true };
    const { rerender } = render(<RiaPicksList rows={[unavailable, { ...unavailable, symbol: "ADBE", quote_symbol: "ADBE", company_name: "Adobe" }]} loadQuote={loadQuote} />);
    expect(loadQuote).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Nvidia/i }));
    const detail = within(await screen.findByRole("dialog", { name: "Nvidia" }));
    const quote = within(detail.getByRole("region", { name: "Stock quote" }));
    await waitFor(() => expect(quote.getByText("$273.00")).toBeTruthy());
    expect(quote.getByText(/Cached quote/)).toBeTruthy();
    expect(quote.queryByText("+0.00%")).toBeNull();
    expect(loadQuote).toHaveBeenCalledExactlyOnceWith("NVDA", expect.any(AbortSignal));
    rerender(<RiaPicksList rows={[{ ...row, price: 280, as_of: "2026-10-26T14:30:00Z", quoted_at: "2026-10-26T14:30:00Z" }]} loadQuote={loadQuote} />);
    await waitFor(() => expect(quote.getByText("$280.00")).toBeTruthy());
  });

  it("cancels quote recovery when switching stocks and ignores the late result", async () => {
    let finishFirst!: (value: PublicStockQuote) => void;
    const loadQuote = vi.fn((symbol: string, _signal: AbortSignal): Promise<PublicStockQuote> => symbol === "NVDA"
      ? new Promise(resolve => { finishFirst = resolve; })
      : Promise.resolve({ symbol, price: 260, changePct: 0, quotedAt: null, source: "Fixture", stale: false, delayed: false }));
    const missing = { ...row, price: null, as_of: null };
    render(<RiaPicksList rows={[missing, { ...missing, symbol: "ADBE", quote_symbol: "ADBE", company_name: "Adobe" }]} loadQuote={loadQuote} />);
    fireEvent.click(screen.getByRole("button", { name: /Nvidia/i }));
    const first = within(await screen.findByRole("dialog", { name: "Nvidia" }));
    await waitFor(() => expect(loadQuote).toHaveBeenCalledTimes(1));
    const signal = loadQuote.mock.calls[0]![1];
    fireEvent.click(first.getByRole("button", { name: "Close detail panel" }));
    expect(signal.aborted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Adobe/i }));
    const second = within(await screen.findByRole("dialog", { name: "Adobe" }));
    await waitFor(() => expect(second.getByText("$260.00")).toBeTruthy());
    await act(async () => { finishFirst({ symbol: "NVDA", price: 999, changePct: 1, quotedAt: null, source: "Fixture", stale: false, delayed: false }); });
    expect(second.queryByText("$999.00")).toBeNull();
    expect(second.getByText(/Quote time unavailable/)).toBeTruthy();
    expect(second.getByText("+0.00%")).toBeTruthy();
  });

  it("uses observed quote time rather than a legacy list retrieval timestamp and cancels an inactive read", async () => {
    let finish!: (value: PublicStockQuote) => void;
    const loadQuote = vi.fn((_symbol: string, _signal: AbortSignal): Promise<PublicStockQuote> => new Promise(resolve => { finish = resolve; }));
    const legacy = { ...row, price: 250, as_of: "2026-10-26T14:30:00Z" };
    const { rerender } = render(<RiaPicksList rows={[legacy]} loadQuote={loadQuote} />);
    fireEvent.click(screen.getByRole("button", { name: /Nvidia/i }));
    const detail = within(await screen.findByRole("dialog", { name: "Nvidia" }));
    await act(async () => { finish({ symbol: "NVDA", price: 260, changePct: 1, quotedAt: "2026-10-26T14:20:00Z", source: "Fixture", stale: false, delayed: false }); });
    expect(detail.getByText("$260.00")).toBeTruthy();
    const pending = vi.fn((_symbol: string, _signal: AbortSignal): Promise<PublicStockQuote> => new Promise(resolve => { finish = resolve; }));
    rerender(<RiaPicksList rows={[legacy]} loadQuote={pending} />);
    await waitFor(() => expect(pending).toHaveBeenCalledOnce());
    const signal = pending.mock.calls[0]![1];
    rerender(<RiaPicksList rows={[legacy]} />);
    expect(signal.aborted).toBe(true);
    await act(async () => { finish({ symbol: "NVDA", price: 999, changePct: 1, quotedAt: "2026-10-26T15:00:00Z", source: "Fixture", stale: false, delayed: false }); });
    expect(detail.queryByText("$999.00")).toBeNull();
  });

  it.each([null, 900])("offers a bounded quote retry while preserving available price %s", async price => {
    const loadQuote = vi.fn(async (_symbol: string, _signal: AbortSignal): Promise<PublicStockQuote | null> => null);
    render(<RiaPicksList rows={[{ ...row, price, as_of: price ? row.as_of : null }]} loadQuote={loadQuote}
      loadHistory={async () => ({ points: [{ date: "2026-10-01", value: 111 }, { date: "2026-10-02", value: 112 }], stale: false, retrievedAt: null })} />);
    fireEvent.click(screen.getByRole("button", { name: /Nvidia/i }));
    const detail = within(await screen.findByRole("dialog", { name: "Nvidia" }));
    const quote = within(detail.getByRole("region", { name: "Stock quote" }));
    const retry = await quote.findByRole("button", { name: "Retry quote" });
    expect(quote.getByText(price ? "$900.00" : "Unavailable", { exact: true })).toBeTruthy();
    expect(quote.queryByText("$112.00")).toBeNull();
    expect(quote.queryByText(/Quoted Unavailable/)).toBeNull();
    fireEvent.click(retry);
    await waitFor(() => expect(loadQuote).toHaveBeenCalledTimes(2));
  });
  it("retains known facts through refresh failure and accepts newer successful facts", () => {
    const current = { NVDA: row.company_facts! };
    const cached = mergeMarketCompanyFacts(current, { NVDA: { symbol: "NVDA", unavailable: true } }, [row]);
    expect(cached.NVDA).toMatchObject({ pe_ratio: 28.5, stale: true });
    expect(mergeMarketCompanyFacts(cached, { NVDA: { symbol: "NVDA", pe_ratio: 30 } }, [row]).NVDA?.pe_ratio).toBe(30);
  });
  it("leads with the company logo and keeps identity copy singular", async () => {
    const analyze = vi.fn();
    const selection = vi.fn();
    const { rerender } = render(<RiaPicksList rows={[row]} onAnalyze={analyze} onSelectedSymbolChange={selection} news={[
      { symbol: "NVDA", title: "Nvidia company headline", url: "https://publisher.test/nvda", source_name: "Publisher", published_at: "2026-10-20T20:00:00Z", provider: "fixture", degraded: false },
      { symbol: "MSFT", title: "Unrelated company headline", url: "https://publisher.test/msft", source_name: "Publisher", published_at: "2026-10-20T20:00:00Z", provider: "fixture", degraded: false },
    ]} />);

    fireEvent.click(screen.getByRole("button", { name: /Nvidia/i }));

    const dialog = await screen.findByRole("dialog", { name: "Nvidia" });
    const detail = within(dialog);

    expect(dialog.querySelector('[data-symbol-avatar="true"]')).toBeTruthy();
    expect(detail.getByText(/NVDA • Semiconductors/i)).toBeTruthy();
    expect(detail.getByText("USD · Quoted", { exact: false })).toBeTruthy();
    expect(detail.queryByText(/Advisor list detail/i)).toBeNull();
    expect(detail.queryByText(/Symbol repaired/i)).toBeNull();
    expect(detail.queryByText("Investment thesis")).toBeNull();
    expect(detail.getByRole("heading", { name: "Company summary" })).toBeTruthy();
    expect(detail.getByText("Nvidia company headline")).toBeTruthy();
    expect(detail.queryByText("Unrelated company headline")).toBeNull();
    expect(detail.getByText("28.50×")).toBeTruthy();
    expect(detail.getByText("9.20×")).toBeTruthy();
    expect(detail.getByText("0.42×")).toBeTruthy();
    expect(detail.getByText("P/E (TTM)")).toBeTruthy();
    expect(detail.getByRole("listitem").textContent).toBe("Nvidia designs graphics processors.");
    expect(selection).toHaveBeenLastCalledWith("NVDA");
    expect(analyze).not.toHaveBeenCalled();
    fireEvent.click(detail.getByRole("button", { name: "Analyze NVDA" }));
    expect(analyze).toHaveBeenCalledExactlyOnceWith("NVDA");
    expect(selection).toHaveBeenLastCalledWith(null);
    rerender(<RiaPicksList rows={[row]} />);
    fireEvent.click(screen.getByRole("button", { name: /Nvidia/i }));
    const publicDetail = await screen.findByRole("dialog", { name: "Nvidia" });
    expect(within(publicDetail).queryByRole("button", { name: "Analyze NVDA" })).toBeNull();
  });

  it("loads observed history only after selection and cancels it when details close", async () => {
    const loadHistory = vi.fn(async (_symbol: string, _signal: AbortSignal) => ({ points: [], stale: true, retrievedAt: null }));
    render(<RiaPicksList rows={[row]} loadHistory={loadHistory} />);
    expect(loadHistory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Nvidia/i }));
    const dialog = await screen.findByRole("dialog", { name: "Nvidia" });
    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(1));
    const signal = loadHistory.mock.calls[0][1];
    expect(loadHistory.mock.calls[0][0]).toBe("NVDA");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Retry price history" })).toBeTruthy());
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry price history" }));
    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(2));
    expect(signal.aborted).toBe(true);
    const retrySignal = loadHistory.mock.calls[1][1];
    fireEvent.click(within(dialog).getByRole("button", { name: "Close detail panel" }));
    await waitFor(() => expect(retrySignal.aborted).toBe(true));
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
