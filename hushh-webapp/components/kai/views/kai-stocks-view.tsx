"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { History, Loader2 } from "@/components/icons";
import { KaiControlSurface } from "@/components/app-ui/kai-control-surface";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { useBackLayer } from "@/lib/navigation/back-layers";
import financeStyles from "@/components/kai/shared/finance-workspace.module.css";
import { RiaPicksList } from "@/components/kai/cards/renaissance-market-list";
import { useKaiMarketHome } from "@/components/kai/shared/kai-market-home-context";
import { marketSurfaceVariablesClassName } from "@/components/kai/shared/market-surface-theme";
import { useAuth } from "@/hooks/use-auth";
import { ApiService } from "@/lib/services/api-service";
import { loadPublicStockQuote } from "@/lib/services/public-stock-quote";

/** Stock browsing shares Finance's existing resource and source-selection owner. */
export function KaiStocksView({ onAnalyze, onSelectedSymbolChange, history, browseStocks = true, historyRequested = false, onHistoryClose }: {
  onAnalyze?: (symbol: string, pickSource: string) => void;
  onSelectedSymbolChange?: (symbol: string | null) => void;
  history?: ReactNode;
  browseStocks?: boolean;
  historyRequested?: boolean;
  onHistoryClose?: () => void;
}) {
  const { userId } = useAuth();
  const searchParams = useSearchParams();
  const active = searchParams.get("tab") === "analysis";
  const [historyOpen, setHistoryOpen] = useState(false);
  const closeHistory = () => { setHistoryOpen(false); onHistoryClose?.(); };
  const isHistoryOpen = active && (historyOpen || historyRequested);
  useBackLayer("/one/kai", isHistoryOpen ? 1 : 0, () => {
    closeHistory();
    return true;
  }, { tab: "analysis" });
  const { payload, loading, refreshing, error, activePickSource, handlePickSourceChange, loadInsights } = useKaiMarketHome();
  const rows = useMemo(() => (payload?.renaissance_list ?? payload?.pick_rows ?? []).filter(row => Boolean(row?.symbol)), [payload]);
  const busy = loading || refreshing;
  const loadCompanyFacts = useCallback((symbols: string[]) => {
    if (!userId) return Promise.resolve({});
    return ApiService.getKaiMarketCompanyFacts({ userId, symbols });
  }, [userId]);
  const loadHistory = useCallback((symbol: string, signal: AbortSignal) => {
    if (!userId) return Promise.reject(new Error("Sign in to read price history"));
    return ApiService.getKaiStockPriceHistory(userId, symbol, signal);
  }, [userId]);
  const historyButton = history ? <ShellActionSurface variant="pill" className="h-12 text-xs sm:text-xs" onClick={() => setHistoryOpen(true)}><History className="h-4 w-4" />History</ShellActionSurface> : null;

  return <section aria-label="Stocks" className={marketSurfaceVariablesClassName} data-testid="kai-stocks-browser">
    {browseStocks && (busy || error) ? <div className="flex flex-wrap items-center justify-between gap-3 py-4 text-sm text-muted-foreground">
      <p role="status" className="flex min-w-0 flex-1 items-center gap-2">
        {busy ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" /> : null}
        {busy
          ? rows.length ? "Updating stocks…" : "Loading stocks…"
          : rows.length ? "Some updates are temporarily unavailable." : "Stocks are temporarily unavailable."}
      </p>
      {error ? <ShellActionSurface variant="pill" className="h-11 text-sm sm:text-sm"
        aria-label="Retry loading stocks" data-voice-control-id="kai_stocks_retry"
        disabled={busy} onClick={() => void loadInsights({ manual: true })}>
        {busy ? "Retrying…" : "Retry"}
      </ShellActionSurface> : null}
    </div> : null}
    {browseStocks && payload ? <RiaPicksList rows={rows} sources={payload.pick_sources ?? []} news={payload.news_tape ?? []}
      activeSourceId={activePickSource} onSourceChange={handlePickSourceChange}
      controlMode="adaptive-surface" loadCompanyFacts={active ? loadCompanyFacts : undefined}
      loadHistory={active ? loadHistory : undefined} toolbarActions={historyButton}
      loadQuote={active ? loadPublicStockQuote : undefined}
      onSelectedSymbolChange={onSelectedSymbolChange}
      onAnalyze={onAnalyze ? symbol => onAnalyze(symbol, activePickSource) : undefined} /> : <div className="flex justify-end">{historyButton}</div>}
    <KaiControlSurface open={isHistoryOpen} onOpenChange={open => open ? setHistoryOpen(true) : closeHistory()} title="Saved analysis" surfaceClassName={financeStyles.detail}>
      {isHistoryOpen ? history : null}
    </KaiControlSurface>
  </section>;
}
