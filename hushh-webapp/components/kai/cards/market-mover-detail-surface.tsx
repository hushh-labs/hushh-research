"use client";

import { useCallback, type ReactNode } from "react";
import { KaiControlSurface } from "@/components/app-ui/kai-control-surface";
import { StockDetailContent, type StockHistoryLoader } from "@/components/kai/cards/stock-detail-content";
import financeStyles from "@/components/kai/shared/finance-workspace.module.css";
import { toMoverQuoteRow, type OneMarketDisplayRow } from "@/lib/kai/market-mover-rows";
import { useKaiCompanyNews } from "@/lib/kai/use-kai-company-news";
import { ApiService } from "@/lib/services/api-service";
import { loadPublicStockQuote } from "@/lib/services/public-stock-quote";
import { useVault } from "@/lib/vault/vault-context";

export type MarketMoverSelection = { row: OneMarketDisplayRow; market: "US" | "IN" };

export function MarketMoverDetailSurface({ selection, userId, onClose, footer }: {
  selection: MarketMoverSelection | null;
  userId: string | null | undefined;
  onClose: () => void;
  footer?: ReactNode;
}) {
  const { vaultOwnerToken } = useVault();
  const market = selection?.market ?? "US";
  const loadData = useKaiCompanyNews(userId, vaultOwnerToken);
  const loadCompanyNews = useCallback((symbol: string, signal: AbortSignal) =>
    loadData(symbol, signal, market), [loadData, market]);
  const loadHistory = useCallback<StockHistoryLoader>((symbol, signal) => {
    if (!userId) return Promise.reject(new Error("Sign in to read price history"));
    return ApiService.getKaiStockPriceHistory(userId, symbol, signal, market);
  }, [userId, market]);

  return (
    <KaiControlSurface
      open={Boolean(selection)}
      onOpenChange={open => { if (!open) onClose(); }}
      title={selection?.row.companyName || "Stock detail"}
      description={selection ? selection.row.symbol + (market === "IN" ? " · NSE" : " · US market") : undefined}
      surfaceClassName={financeStyles.detail}
      headerTextOverflow="wrap"
      footer={footer}
    >
      {selection ? (
        <StockDetailContent
          key={market + ":" + selection.row.symbol}
          market={market}
          marketMover
          row={toMoverQuoteRow(selection.row)}
          loadHistory={loadHistory}
          loadQuote={market === "US" ? loadPublicStockQuote : undefined}
          loadCompanyNews={loadCompanyNews}
        />
      ) : null}
    </KaiControlSurface>
  );
}
