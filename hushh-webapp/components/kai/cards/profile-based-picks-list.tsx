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
}

function toSymbolsKey(symbols: string[]): string {
  if (!Array.isArray(symbols) || symbols.length === 0) return "default";
  return [...symbols].sort((a, b) => a.localeCompare(b)).join("-");
}

function formatPrice(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "Price unavailable";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function PicksSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 3 }).map((_, idx) => (
        <SurfaceInset key={idx} className="flex items-center justify-between gap-3 p-3">
          <div className="flex min-w-0 items-center gap-3">
            <Skeleton className="h-9 w-9 rounded-full" />
            <div className="min-w-0 space-y-1">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
          <Skeleton className="h-8 w-8 rounded-full" />
        </SurfaceInset>
      ))}
    </div>
  );
}

export function ProfileBasedPicksList({
  userId,
  vaultOwnerToken,
  symbols,
  onAdd,
  limit = 3,
}: ProfileBasedPicksListProps) {
  const [loading, setLoading] = useState(true);
  const [riskProfile, setRiskProfile] = useState("balanced");
  const [picks, setPicks] = useState<KaiDashboardProfilePick[]>([]);
  const [error, setError] = useState<string | null>(null);

  const normalizedSymbols = useMemo(
    () =>
      symbols
        .map((symbol) => symbol.trim().toUpperCase())
        .filter((symbol, idx, arr) => Boolean(symbol) && arr.indexOf(symbol) === idx)
        .slice(0, 16),
    [symbols]
  );

  useEffect(() => {
    const controller = new AbortController();
    let isMounted = true;
    const cache = CacheService.getInstance();
    const symbolsKey = toSymbolsKey(normalizedSymbols);
    const cacheKey = CACHE_KEYS.KAI_DASHBOARD_PROFILE_PICKS(userId, symbolsKey, limit);

    const cached = cache.get<{
      picks?: KaiDashboardProfilePick[];
      risk_profile?: string;
    }>(cacheKey);
    if (cached && isMounted) {
      setRiskProfile(cached.risk_profile || "balanced");
      setPicks((cached.picks || []).filter((pick) => Boolean(pick?.symbol)));
      setLoading(false);
      setError(null);
      return () => {
        isMounted = false;
        controller.abort();
      };
    }

    async function load() {
      if (!userId || !vaultOwnerToken) {
        if (isMounted) {
          setPicks([]);
          setLoading(false);
        }
        return;
      }
      if (normalizedSymbols.length === 0) {
        if (isMounted) {
          setPicks([]);
          setLoading(false);
          setError(null);
        }
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const response = await ApiService.getDashboardProfilePicks({
          userId,
          vaultOwnerToken,
          symbols: normalizedSymbols,
          limit,
          signal: controller.signal,
        });
        if (!isMounted) return;
        setRiskProfile(response.risk_profile || "balanced");
        setPicks((response.picks || []).filter((pick) => Boolean(pick?.symbol)));
        cache.set(cacheKey, response, CACHE_TTL.MEDIUM);
      } catch (loadError) {
        if (!isMounted) return;
        if (!cached) {
          setPicks([]);
          setError(loadError instanceof Error ? loadError.message : "Unable to load picks");
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [limit, normalizedSymbols, userId, vaultOwnerToken]);

  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <h3 className="text-sm font-black">Personalized picks</h3>
        <p className="text-[11px] text-muted-foreground">
          Source: Kai risk profile ({riskProfile}) + current holdings context.
        </p>
      </div>

      {loading ? <PicksSkeleton /> : null}

      {!loading && picks.length === 0 ? (
        <SurfaceInset className="p-3 text-xs text-muted-foreground">
          {error
            ? "Profile picks are temporarily unavailable."
            : "No profile picks available from current market context."}
        </SurfaceInset>
      ) : null}

      {!loading && picks.length > 0 ? (
        <div className="space-y-2">
          {picks.map((pick) => {
            const change = typeof pick.change_percent === "number" ? pick.change_percent : null;
            return (
              <SurfaceInset
                key={pick.symbol}
                className="flex items-center justify-between gap-3 p-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="grid h-9 w-9 place-items-center rounded-full border border-border/70 bg-muted text-[11px] font-black">
                    {pick.symbol}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold leading-tight">{pick.company_name}</p>
                    <p className="truncate text-xs font-medium text-muted-foreground">
                      {(pick.tier || "Tier N/A").toUpperCase()}
                      {pick.sector ? ` • ${pick.sector}` : ""}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {formatPrice(pick.price)}
                      {change !== null ? (
                        <span
                          className={cn(
                            "ml-1 font-semibold",
                            change >= 0
                              ? "text-emerald-600 dark:text-emerald-400"
                              : "text-rose-600 dark:text-rose-400"
                          )}
                        >
                          {change >= 0 ? "+" : ""}
                          {change.toFixed(2)}%
                        </span>
                      ) : null}
                    </p>
                  </div>
                </div>

                <Button
                  variant="none"
                  effect="fade"
                  size="icon-sm"
                  aria-label={`Add ${pick.symbol}`}
                  onClick={() => onAdd(pick.symbol)}
                >
                  <Icon icon={Plus} size="sm" />
                </Button>
              </SurfaceInset>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
