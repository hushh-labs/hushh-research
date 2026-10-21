"use client";

import { useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "@/components/icons";
import { RiaPicksList } from "@/components/kai/cards/renaissance-market-list";
import { useKaiMarketHome } from "@/components/kai/shared/kai-market-home-context";
import { marketSurfaceVariablesClassName } from "@/components/kai/shared/market-surface-theme";
import { useAuth } from "@/hooks/use-auth";
import { ApiService } from "@/lib/services/api-service";

/** Stock browsing shares Finance's existing resource and source-selection owner. */
export function KaiStocksView({ onAnalyze, onSelectedSymbolChange }: {
  onAnalyze?: (symbol: string, pickSource: string) => void;
  onSelectedSymbolChange?: (symbol: string | null) => void;
}) {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const active = searchParams.get("tab") === "analysis";
  const { payload, loading, error, activePickSource, handlePickSourceChange } = useKaiMarketHome();
  const rows = useMemo(() => (payload?.renaissance_list ?? payload?.pick_rows ?? []).filter((row) => Boolean(row?.symbol)), [payload]);
  const loadCompanyFacts = useCallback((symbols: string[]) => {
    if (!user?.uid) return Promise.resolve({});
    return ApiService.getKaiMarketCompanyFacts({ userId: user.uid, symbols });
  }, [user]);

  return (
    <section aria-label="Stocks" className={marketSurfaceVariablesClassName} data-testid="kai-stocks-browser">
      {loading && !payload ? <p role="status" className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading stocks…</p> : null}
      {error && !payload ? <p role="status" className="py-4 text-sm text-muted-foreground">Stocks are temporarily unavailable.</p> : null}
      {payload ? <RiaPicksList rows={rows} sources={payload.pick_sources ?? []}
        activeSourceId={activePickSource} onSourceChange={handlePickSourceChange}
        controlMode="adaptive-surface" loadCompanyFacts={active ? loadCompanyFacts : undefined}
        onSelectedSymbolChange={onSelectedSymbolChange}
        onAnalyze={onAnalyze ? (symbol) => onAnalyze(symbol, activePickSource) : undefined} /> : null}
    </section>
  );
}
