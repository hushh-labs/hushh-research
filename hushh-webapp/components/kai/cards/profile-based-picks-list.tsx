"use client";

import { useEffect, useMemo, useState } from "react";
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
  className?: string;
}

const formatPrice = (value: number | null | undefined): string => {
  if (typeof value !== "number" || !Number.isFinite(value)) return "N/A";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
};

export function ProfileBasedPicksList({
  userId,
  vaultOwnerToken,
  symbols,
  onAdd,
  limit = 3,
  className,
}: ProfileBasedPicksListProps) {
  const [state, setState] = useState({
    picks: [] as KaiDashboardProfilePick[],
    riskProfile: "balanced",
    loading: true,
    error: null as string | null,
  });

  const normalizedSymbols = useMemo(() =>
    [...new Set(symbols.map((s) => s.trim().toUpperCase()))].filter(Boolean),
    [symbols]);

  useEffect(() => {
    if (!userId || !vaultOwnerToken || normalizedSymbols.length === 0) {
      setState(prev => ({ ...prev, loading: false }));
      return;
    }

    const controller = new AbortController();
    const cache = CacheService.getInstance();
    const cacheKey = CACHE_KEYS.KAI_DASHBOARD_PROFILE_PICKS(userId, normalizedSymbols.join("-"), limit);

    const cached = cache.get<{ picks: KaiDashboardProfilePick[]; risk_profile: string }>(cacheKey);

    if (cached) {
      setState({ picks: cached.picks, riskProfile: cached.risk_profile, loading: false, error: null });
      return;
    }

    async function fetchPicks() {
      try {
        const response = await ApiService.getDashboardProfilePicks({
          userId,
          vaultOwnerToken,
          symbols: normalizedSymbols,
          limit,
          signal: controller.signal,
        });

        const picks = (response.picks || []).filter((p) => p?.symbol);
        setState({ picks, riskProfile: response.risk_profile || "balanced", loading: false, error: null });
        cache.set(cacheKey, { picks, risk_profile: response.risk_profile }, CACHE_TTL.MEDIUM);
      } catch (_err) {
        if (!controller.signal.aborted) {
          setState(prev => ({ ...prev, loading: false, error: "Unable to load picks" }));
        }
      }
    }

    void fetchPicks();
    return () => controller.abort();
  }, [limit, normalizedSymbols, userId, vaultOwnerToken]);

  if (state.loading) return <PicksSkeleton />;

  return (
    <div className={cn("space-y-3", className)}>
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold tracking-tight">Personalized picks</h3>
        <p className="text-[11px] text-muted-foreground">Source: Kai risk profile ({state.riskProfile})</p>
      </div>

      {state.error ? (
        <SurfaceInset className="p-3 text-xs text-rose-500">{state.error}</SurfaceInset>
      ) : state.picks.length === 0 ? (
        <SurfaceInset className="p-3 text-xs text-muted-foreground italic">No picks available.</SurfaceInset>
      ) : (
        <div className="space-y-2">
          {state.picks.map((pick) => (
            <SurfaceInset key={pick.symbol} className="flex items-center justify-between gap-3 p-3 transition-colors hover:bg-muted/30">
              <div className="flex min-w-0 items-center gap-3">
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-border bg-background text-[10px] font-bold">
                  {pick.symbol}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold leading-tight">{pick.company_name}</p>
                  <p className="truncate text-[11px] text-muted-foreground">{formatPrice(pick.price)}</p>
                </div>
              </div>

              <Button
                variant="none"
                size="sm"
                className="h-8 w-8 rounded-full p-0"
                onClick={() => onAdd(pick.symbol)}
              >
                <Icon icon={Plus} size="sm" />
              </Button>
            </SurfaceInset>
          ))}
        </div>
      )}
    </div>
  );
}

function PicksSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 2 }).map((_, i) => (
        <Skeleton key={i} className="h-14 w-full rounded-lg" />
      ))}
    </div>
  );
}