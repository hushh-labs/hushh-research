import { useCallback } from "react";
import { ApiService } from "@/lib/services/api-service";

export function useKaiCompanyNews(userId: string | null | undefined, vaultOwnerToken: string | null | undefined) {
  return useCallback(async (symbol: string, signal: AbortSignal, market: "US" | "IN" = "US") => {
    if (!userId || !vaultOwnerToken) throw new Error("Unlock your vault to load company news");
    const page = await ApiService.getKaiMarketNews({
      userId, vaultOwnerToken, symbols: [symbol], limit: 15, market, signal,
    });
    return page.items;
  }, [userId, vaultOwnerToken]);
}
