"use client";

import { useState } from "react";
import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import { OneMarketMovers } from "@/components/kai/cards/one-market-movers";
import { MarketMoverDetailSurface, type MarketMoverSelection } from "@/components/kai/cards/market-mover-detail-surface";
import { useAuth } from "@/hooks/use-auth";
import { CACHE_KEYS } from "@/lib/services/cache-service";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { KaiMarketHomeResourceService } from "@/lib/kai/kai-market-home-resource";
import { toMoverGroups } from "@/lib/kai/market-mover-rows";
import { usMarketRefreshSession } from "@/lib/kai/use-market-live-refresh";
import { Button } from "@/lib/morphy-ux/button";

function TopGainersList({ userId }: { userId: string }) {
  const [selection, setSelection] = useState<MarketMoverSelection | null>(null);
  const { data, snapshot, loading, refreshing, refresh } = useStaleResource({
    cacheKey: CACHE_KEYS.KAI_MARKET_HOME_BASELINE(userId, 7),
    resourceLabel: "kai_market_home_baseline",
    getRequestVersion: () => usMarketRefreshSession() ?? "closed",
    load: (options) => KaiMarketHomeResourceService.getBaselineStaleFirst({
      userId,
      daysBack: 7,
      forceRefresh: Boolean(options?.force),
      backgroundRefresh: !options?.force,
    }),
  });

  const groups = toMoverGroups(data);
  if (!data?.movers || groups.gain.length === 0) {
    const pending = loading || refreshing;
    return (
      <div className="space-y-2">
        <p role="status">{pending ? "Loading market gainers…" : "Market gainers are unavailable right now."}</p>
        <Button variant="muted" size="sm" disabled={pending} onClick={() => void refresh({ force: true })}>
          Retry market gainers
        </Button>
      </div>
    );
  }

  const saved = data.stale || data.movers.stale || snapshot?.isFresh === false;
  return (
    <>
      <OneMarketMovers groups={groups} gainersOnly
        note={saved ? "Saved prices" : undefined}
        onSelect={row => setSelection({ row, market: "US" })}
      />
      <MarketMoverDetailSurface selection={selection} userId={userId} onClose={() => setSelection(null)} />
    </>
  );
}

export function FinanceTopGainersCard({ historical }: { historical?: boolean }) {
  const { userId } = useAuth();
  return (
    <SurfaceCard>
      <SurfaceCardContent className="space-y-3 p-4">
        <div>
          <h2 className="ui-text-section-label">Top Gainers</h2>
          <p className="ui-text-row-description text-muted-foreground">U.S. market</p>
        </div>
        {historical ? <p className="ui-text-row-description text-muted-foreground">Top Gainers was requested in this message.</p>
          : userId ? <TopGainersList key={userId} userId={userId} />
          : <p>Sign in to see the latest market gainers.</p>}
      </SurfaceCardContent>
    </SurfaceCard>
  );
}
