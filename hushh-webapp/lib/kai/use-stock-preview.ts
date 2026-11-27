"use client";

import { useEffect, useMemo, useState } from "react";
import { ApiService, type KaiStockPreviewResponse } from "@/lib/services/api-service";

type StockPreviewResult = {
  requestId: symbol;
  preview: KaiStockPreviewResponse | null;
  error: string | null;
};

export function useStockPreview({
  userId,
  vaultOwnerToken,
  ticker,
  pickSource,
}: {
  userId: string | null | undefined;
  vaultOwnerToken: string | null | undefined;
  ticker: string;
  pickSource: string;
}) {
  const symbol = ticker.trim().toUpperCase();
  const request = useMemo(
    () => userId && vaultOwnerToken && symbol
      ? { id: Symbol("stock preview"), userId, vaultOwnerToken, symbol, pickSource }
      : null,
    [userId, vaultOwnerToken, symbol, pickSource],
  );
  const [result, setResult] = useState<StockPreviewResult | null>(null);

  useEffect(() => {
    setResult(null);
    if (!request) return;
    const { id, ...input } = request;
    const abort = new AbortController();
    void ApiService.getKaiStockPreview({ ...input, signal: abort.signal }).then(
      (preview) => {
        if (!abort.signal.aborted) setResult({ requestId: id, preview, error: null });
      },
      (error: unknown) => {
        if (abort.signal.aborted) return;
        setResult({
          requestId: id,
          preview: null,
          error: error instanceof Error ? error.message : "Failed to load stock preview",
        });
      },
    );
    return () => abort.abort();
  }, [request]);

  // Hide the previous response on the render where the selection or authority changes.
  const current = request && result?.requestId === request.id ? result : null;
  return {
    preview: current?.preview ?? null,
    loading: Boolean(request && !current),
    error: current?.error ?? null,
  };
}
