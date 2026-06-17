"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { Plus } from "lucide-react";

import { SurfaceInset } from "@/components/app-ui/surfaces";
import { Button } from "@/lib/morphy-ux/button";
import { Icon } from "@/lib/morphy-ux/ui";
import { ApiService, type KaiDashboardProfilePick } from "@/lib/services/api-service";
import { CacheService, CACHE_KEYS, CACHE_TTL } from "@/lib/services/cache-service";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface ProfileBasedPicksListProps {
  userId: string;
  vaultOwnerToken: string;
  symbols: string[];
  onAdd: (symbol: string) => void;
  limit?: number;
}

// =============================================================================
// HELPERS
// =============================================================================

const toSymbolsKey = (symbols: string[]) =>
  [...new Set(symbols)].sort().join("-") || "default";

const formatPrice = (value: number | null | undefined): string => {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Price unavailable";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
};

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

function PicksSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 3 }).map((_, idx) => (
        <SurfaceInset key={idx} className="flex items-center justify-between gap-3 p-3">
          <div className="flex items-center gap-3">
            <Skeleton className="h-9 w-9 rounded-full" />
            <div className="space-y-1">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-2 w-28" />
            </div>
          </div>
          <Skeleton className="h-8 w-8 rounded-full" />
        </SurfaceInset>
      ))}
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function ProfileBasedPicksList({
  userId,
  vaultOwnerToken,
  symbols,
  onAdd,
  limit = 3,
}: ProfileBasedPicksListProps) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<{ picks: KaiDashboardProfilePick[]; riskProfile: string }>({ picks: [], riskProfile: "balanced" });
  const [error, setError] = useState<string | null>(null);

  const normalizedSymbols = useMemo(() =>
    [...new Set(symbols.map((s) => s.trim().toUpperCase()))].filter(Boolean).slice(0, 16),
    [symbols]);

  const handleAdd = useCallback((symbol: string) => onAdd(symbol), [onAdd]);

  useEffect(() => {
    if (!userId || !vaultOwnerToken || normalizedSymbols.length === 0) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const cache = CacheService.getInstance();
    const cacheKey = CACHE_KEYS.KAI_DASHBOARD_PROFILE_PICKS(userId, toSymbolsKey(normalizedSymbols), limit);

    const cached = cache.get<{ picks: KaiDashboardProfilePick[]; risk_profile: string }>(cacheKey);

    if (cached) {
      setData({ picks: cached.picks, riskProfile: cached.risk_profile });
      setLoading(false);
      return;
    }

    async function fetchPicks() {
      try {
        setLoading(true);
        const response = await ApiService.getDashboardProfilePicks({
          userId,
          vaultOwnerToken,
          symbols: normalizedSymbols,
          limit,
          signal: controller.signal,
        });

        const validPicks = (response.picks || []).filter((p) => p?.symbol);
        setData({ picks: validPicks, riskProfile: response.risk_profile || "balanced" });
        cache.set(cacheKey, { picks: validPicks, risk_profile: response.risk_profile }, CACHE_TTL.MEDIUM);
      } catch {
        if (!controller.signal.aborted) setError("Unable to load picks");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void fetchPicks();
    return () => controller.abort();
  }, [limit, normalizedSymbols, userId, vaultOwnerToken]);

  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold">Personalized picks</h3>
        <p className="text-[11px] text-muted-foreground">
          Source: Kai risk profile ({data.riskProfile}) + current holdings context.
        </p>
      </div>

      {loading ? <PicksSkeleton /> : null}

      {!loading && data.picks.length === 0 && (
        <SurfaceInset className="p-3 text-xs text-muted-foreground">
          {error || "No profile picks available from current market context."}
        </SurfaceInset>
      )}

      {!loading && data.picks.length > 0 && (
        <div className="space-y-2">
          {data.picks.map((pick) => (
            <SurfaceInset key={pick.symbol} className="flex items-center justify-between gap-3 p-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="grid h-9 w-9 place-items-center rounded-full border border-border/70 bg-muted text-[11px] font-semibold">
                  {pick.symbol}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold leading-tight">{pick.company_name}</p>
                  <p className="truncate text-xs font-medium text-muted-foreground">
                    {(pick.tier || "Tier N/A").toUpperCase()} {pick.sector ? `• ${pick.sector}` : ""}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {formatPrice(pick.price)}
                    {typeof pick.change_percent === "number" && (
                      <span className={cn("ml-1 font-semibold", pick.change_percent >= 0 ? "text-emerald-600" : "text-rose-600")}>
                        {pick.change_percent >= 0 ? "+" : ""}{pick.change_percent.toFixed(2)}%
                      </span>
                    )}
                  </p>
                </div>
              </div>

              <Button variant="none" effect="fade" size="icon-sm" onClick={() => handleAdd(pick.symbol)}>
                <Icon icon={Plus} size="sm" />
              </Button>
            </SurfaceInset>
          ))}
        </div>
      )}
    </div>
  );
}