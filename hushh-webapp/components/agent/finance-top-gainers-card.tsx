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

const marketViews = {
  gainers: { title: "Top Gainers", direction: "gain" },
  losers: { title: "Top Losers", direction: "lose" },
  movers: { title: "Market Movers", direction: undefined },
} as const;
type MarketView = keyof typeof marketViews;

function MarketMoversList({ userId, view }: { userId: string; view: MarketView }) {
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
  const { direction, title } = marketViews[view];
  const availableDirection = direction ?? (!groups.gain.length ? "lose" : !groups.lose.length ? "gain" : undefined);
  const hasResults = availableDirection ? groups[availableDirection].length > 0 : true;
  if (!data?.movers || !hasResults) {
    const pending = loading || refreshing;
    return (
      <div className="space-y-2">
        <p role="status">{pending ? `Loading ${title.toLowerCase()}…` : `${title} are unavailable right now.`}</p>
        <Button variant="muted" size="sm" disabled={pending} onClick={() => void refresh({ force: true })}>
          Retry
        </Button>
      </div>
    );
  }

  const saved = data.stale || data.movers.stale || snapshot?.isFresh === false;
  return (
    <>
      <OneMarketMovers groups={groups} direction={availableDirection} balanced={!availableDirection}
        note={saved ? "Saved prices" : undefined}
        onSelect={row => setSelection({ row, market: "US" })}
      />
      <MarketMoverDetailSurface selection={selection} userId={userId} onClose={() => setSelection(null)} />
    </>
  );
}

export function FinanceMarketMoversCard({ view, historical }: { view: MarketView; historical?: boolean }) {
  const { title } = marketViews[view];
  const { userId } = useAuth();
  return (
    <SurfaceCard>
      <SurfaceCardContent className="space-y-3 p-4">
        <div>
          <h2 className="ui-text-section-label">{title}</h2>
          <p className="ui-text-row-description text-muted-foreground">U.S. market</p>
        </div>
        {historical ? <p className="ui-text-row-description text-muted-foreground">This message requested {title.toLowerCase()}.</p>
          : userId ? <MarketMoversList key={JSON.stringify([userId, view])} userId={userId} view={view} />
          : <p>Sign in to see {title.toLowerCase()}.</p>}
      </SurfaceCardContent>
    </SurfaceCard>
  );
}

export function FinanceTopGainersCard({ historical }: { historical?: boolean }) {
  return <FinanceMarketMoversCard view="gainers" historical={historical} />;
}
