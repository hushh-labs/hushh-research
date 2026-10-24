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

/** Stock browsing shares Finance's existing resource and source-selection owner. */
export function KaiStocksView({ onAnalyze, onSelectedSymbolChange, history, browseStocks = true, historyRequested = false, onHistoryClose }: {
  onAnalyze?: (symbol: string, pickSource: string) => void;
  onSelectedSymbolChange?: (symbol: string | null) => void;
  history?: ReactNode;
  browseStocks?: boolean;
  historyRequested?: boolean;
  onHistoryClose?: () => void;
}) {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const active = searchParams.get("tab") === "analysis";
  const [historyOpen, setHistoryOpen] = useState(false);
  const closeHistory = () => { setHistoryOpen(false); onHistoryClose?.(); };
  const isHistoryOpen = active && (historyOpen || historyRequested);
  useBackLayer("/one/kai", isHistoryOpen ? 1 : 0, () => {
    closeHistory();
    return true;
  }, { tab: "analysis" });
  const { payload, loading, error, activePickSource, handlePickSourceChange } = useKaiMarketHome();
  const rows = useMemo(() => (payload?.renaissance_list ?? payload?.pick_rows ?? []).filter(row => Boolean(row?.symbol)), [payload]);
  const loadCompanyFacts = useCallback((symbols: string[]) => {
    if (!user?.uid) return Promise.resolve({});
    return ApiService.getKaiMarketCompanyFacts({ userId: user.uid, symbols });
  }, [user]);
  const loadHistory = useCallback((symbol: string, signal: AbortSignal) => {
    if (!user?.uid) return Promise.reject(new Error("Sign in to read price history"));
    return ApiService.getKaiStockPriceHistory(user.uid, symbol, signal);
  }, [user]);
  const historyButton = history ? <ShellActionSurface variant="pill" className="h-12 text-xs sm:text-xs" onClick={() => setHistoryOpen(true)}><History className="h-4 w-4" />History</ShellActionSurface> : null;

  return <section aria-label="Stocks" className={marketSurfaceVariablesClassName} data-testid="kai-stocks-browser">
    {browseStocks && loading && !payload ? <p role="status" className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading stocks…</p> : null}
    {browseStocks && error && !payload ? <p role="status" className="py-4 text-sm text-muted-foreground">Stocks are temporarily unavailable.</p> : null}
    {browseStocks && payload ? <RiaPicksList rows={rows} sources={payload.pick_sources ?? []} news={payload.news_tape ?? []}
      activeSourceId={activePickSource} onSourceChange={handlePickSourceChange}
      controlMode="adaptive-surface" loadCompanyFacts={active ? loadCompanyFacts : undefined}
      loadHistory={active ? loadHistory : undefined} toolbarActions={historyButton}
      onSelectedSymbolChange={onSelectedSymbolChange}
      onAnalyze={onAnalyze ? symbol => onAnalyze(symbol, activePickSource) : undefined} /> : <div className="flex justify-end">{historyButton}</div>}
    <KaiControlSurface open={isHistoryOpen} onOpenChange={open => open ? setHistoryOpen(true) : closeHistory()} title="Saved analysis" surfaceClassName={financeStyles.detail}>
      {isHistoryOpen ? history : null}
    </KaiControlSurface>
  </section>;
}
