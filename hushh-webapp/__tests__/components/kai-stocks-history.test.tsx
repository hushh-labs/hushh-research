import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { unwindBackLayer } from "@/lib/navigation/back-layers";
import { PortfolioReportAction } from "@/components/kai/cards/portfolio-report-action";
import { mapPortfolioToDashboardViewModel } from "@/components/kai/views/dashboard-data-mapper";
import { AnalysisHistoryList } from "@/components/kai/views/analysis-history-list";
import { VersionOptions } from "@/components/kai/views/analysis-history-version-options";
import { KaiStocksView } from "@/components/kai/views/kai-stocks-view";

const state = vi.hoisted(() => ({
  params: new URLSearchParams("tab=analysis"),
  market: {
    payload: null as { pick_rows: { symbol: string }[] } | null,
    loading: false,
    refreshing: false,
    error: null as string | null,
    loadInsights: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => state.params, usePathname: () => "/one/kai" }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: {} }));
vi.mock("@/components/kai/shared/kai-market-home-context", () => ({
  useKaiMarketHome: () => state.market,
}));
vi.mock("@/components/kai/cards/renaissance-market-list", () => ({
  RiaPicksList: ({ rows }: { rows: { symbol: string }[] }) => <div aria-label="Stock results">{rows.map(row => <span key={row.symbol}>{row.symbol}</span>)}</div>,
}));
vi.mock("@/components/app-ui/kai-control-surface", () => ({
  KaiControlSurface: ({ open, children, footer }: { open: boolean; children: ReactNode; footer?: ReactNode }) => open ? <div role="dialog">{children}{footer}</div> : null,
}));

beforeEach(() => {
  state.params = new URLSearchParams("tab=analysis");
  state.market.payload = null;
  state.market.loading = false;
  state.market.refreshing = false;
  state.market.error = null;
  state.market.loadInsights.mockClear();
});

describe("Stocks loading recovery", () => {
  it("retries a failed first load through the shared resource and prevents duplicate retries", () => {
    state.market.error = "Request failed";
    const { rerender } = render(<KaiStocksView history={<p>Saved entries</p>} />);
    expect(screen.getByRole("status")).toHaveTextContent("Stocks are temporarily unavailable.");
    fireEvent.click(screen.getByRole("button", { name: "Retry loading stocks" }));
    expect(state.market.loadInsights).toHaveBeenCalledExactlyOnceWith({ manual: true });
    state.market.loading = true;
    state.market.refreshing = true;
    rerender(<KaiStocksView history={<p>Saved entries</p>} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading stocks…");
    const retry = screen.getByRole("button", { name: "Retry loading stocks" });
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(state.market.loadInsights).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Saved entries");
  });

  it("keeps saved stock rows visible across a failed refresh and clears the status after recovery", () => {
    state.market.payload = { pick_rows: [{ symbol: "MSFT" }] };
    state.market.error = "Request failed";
    const { rerender } = render(<KaiStocksView />);
    expect(screen.getByText("MSFT")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Some updates are temporarily unavailable.");
    fireEvent.click(screen.getByRole("button", { name: "Retry loading stocks" }));
    expect(state.market.loadInsights).toHaveBeenCalledExactlyOnceWith({ manual: true });
    state.market.error = null;
    state.market.refreshing = true;
    rerender(<KaiStocksView />);
    expect(screen.getByRole("status")).toHaveTextContent("Updating stocks…");
    expect(screen.getByText("MSFT")).toBeVisible();
    state.market.refreshing = false;
    rerender(<KaiStocksView />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry loading stocks" })).toBeNull();
    expect(screen.getByText("MSFT")).toBeVisible();
  });
});

describe("Stocks history intent", () => {
  it("opens requested history without the browser, unwinds Back, and releases the inactive pane", () => {
    const close = vi.fn();
    const props = { browseStocks: false, historyRequested: true, onHistoryClose: close, history: <p>Saved entries</p> };
    const { rerender } = render(<KaiStocksView {...props} />);
    expect(screen.getByRole("dialog")).toHaveTextContent("Saved entries");
    expect(unwindBackLayer("/one/kai", state.params)).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    state.params = new URLSearchParams("tab=market");
    rerender(<KaiStocksView {...props} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(unwindBackLayer("/one/kai", state.params)).toBe(false);
    state.params = new URLSearchParams("tab=analysis");
  });
  it("keeps the saved entries behind History even while public stocks are unavailable", () => {
    render(<KaiStocksView history={<p>Saved entries</p>} />);
    expect(screen.queryByText("Saved entries")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Saved entries");
  });
});


it("opens the latest saved analysis directly while Versions and delete keep their own actions", () => {
  const entry = { ticker: "TEST", timestamp: "2026-10-20T14:00:00Z", decision: "hold", confidence: 0.8, consensus_reached: true, agent_votes: {}, final_statement: "Saved analysis", raw_card: {}, version: 2, companyName: "Test Company" };
  const onOpen = vi.fn(), onVersions = vi.fn(), onDelete = vi.fn(), onDeleteTicker = vi.fn();
  const { unmount } = render(<AnalysisHistoryList entries={[entry]} onOpen={onOpen} onVersions={onVersions} onDelete={onDelete} onDeleteTicker={onDeleteTicker} />);
  fireEvent.click(screen.getByRole("button", { name: "Open TEST analysis" }));
  expect(onOpen).toHaveBeenCalledWith(entry);
  fireEvent.click(screen.getByRole("button", { name: "Versions for TEST" }));
  expect(onVersions).toHaveBeenCalledWith("TEST");
  expect(onOpen).toHaveBeenCalledTimes(1);
  unmount();
  render(<VersionOptions entries={[entry]} onOpen={onOpen} onDelete={onDelete} onDeleteAll={() => onDeleteTicker("TEST")} />);
  fireEvent.click(screen.getByRole("button", { name: "Delete this version" }));
  expect(onDelete).toHaveBeenCalledWith(entry);
  expect(onOpen).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Delete all versions" }));
  expect(onDeleteTicker).toHaveBeenCalledWith("TEST");
});


it("previews a report before export and closes its local layer before route Back", () => {
  state.params = new URLSearchParams("tab=portfolio");
  const onExport = vi.fn();
  const { unmount } = render(<PortfolioReportAction model={mapPortfolioToDashboardViewModel({ account_summary: { ending_value: 100 } })} source="Statement" period="October" onExport={onExport} />);
  fireEvent.click(screen.getByRole("button", { name: "Share portfolio PDF" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("No value history is available");
  expect(onExport).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Export PDF" }));
  expect(onExport).toHaveBeenCalledOnce();
  act(() => { expect(unwindBackLayer("/one/kai", state.params)).toBe(true); });
  expect(screen.queryByRole("dialog")).toBeNull();
  unmount();
  state.params = new URLSearchParams("tab=analysis");
});
