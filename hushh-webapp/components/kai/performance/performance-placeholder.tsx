"use client";

import { SurfaceCard, SurfaceCardContent } from "@/components/app-ui/surfaces";
import financeStyles from "@/components/kai/shared/finance-workspace.module.css";
import { cn } from "@/lib/utils";
import styles from "./portfolio-performance.module.css";

/** The same shapes as pulsing placeholders, for the moment the detail cards load. */
export function PortfolioDetailPlaceholder() {
  const bar = (className: string) => <span aria-hidden="true" className={cn("block rounded bg-muted motion-safe:animate-pulse", className)} />;
  return (
    <div aria-busy="true" className="space-y-3">
      <div className={styles.grid}>
        <SurfaceCard className="min-w-0"><SurfaceCardContent className={financeStyles.insightCard}>
          <p className="ui-text-section-label">Concentration</p>
          {bar("h-4 w-28")}
          {[0, 1, 2, 3, 4].map((slot) => <div key={slot} className={styles.row}>{bar("h-3.5 w-10")}{bar("h-1.5 w-full")}{bar("h-3.5 w-12 justify-self-end")}</div>)}
        </SurfaceCardContent></SurfaceCard>
        <div className={styles.column}>
          <SurfaceCard className="min-w-0"><SurfaceCardContent className={financeStyles.insightCard}>
            <p className="ui-text-section-label">Winners and losers</p>
            {bar("h-4 w-40")}{bar("h-2.5 w-full")}{bar("h-3 w-3/4")}{bar("h-3 w-2/3")}
          </SurfaceCardContent></SurfaceCard>
          <SurfaceCard className={cn("min-w-0", styles.grow)}><SurfaceCardContent className={financeStyles.insightCard}>
            <p className="ui-text-section-label">Biggest gain and loss</p>
            {[0, 1].map((slot) => <div key={slot} className={styles.mover}>{bar("size-8 rounded-lg")}{bar("h-3.5 w-16")}{bar("h-3.5 w-14 justify-self-end")}</div>)}
          </SurfaceCardContent></SurfaceCard>
        </div>
      </div>
    </div>
  );
}
