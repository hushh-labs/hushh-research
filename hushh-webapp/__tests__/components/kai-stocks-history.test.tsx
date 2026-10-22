import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { unwindBackLayer } from "@/lib/navigation/back-layers";
import { KaiStocksView } from "@/components/kai/views/kai-stocks-view";

const state = vi.hoisted(() => ({ params: new URLSearchParams("tab=analysis") }));
vi.mock("next/navigation", () => ({ useSearchParams: () => state.params }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: {} }));
vi.mock("@/components/kai/shared/kai-market-home-context", () => ({
  useKaiMarketHome: () => ({ payload: null, loading: false, error: null }),
}));
vi.mock("@/components/kai/cards/renaissance-market-list", () => ({ RiaPicksList: () => null }));
vi.mock("@/components/app-ui/kai-control-surface", () => ({
  KaiControlSurface: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div role="dialog">{children}</div> : null,
}));

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
