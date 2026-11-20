"use client";

import { useId } from "react";
import { TrendingDown, TrendingUp } from "@/components/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { SymbolAvatar } from "@/components/kai/shared/symbol-avatar";
import financeStyles from "@/components/kai/shared/finance-workspace.module.css";
import marketBriefingStyles from "@/components/kai/shared/market-briefing.module.css";
import type { OneMarketDisplayRow, OneMarketMoverTab } from "@/lib/kai/market-mover-rows";
import { formatMarketQuoteTime, formatOverviewAsOf } from "@/lib/kai/market-quote-time";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { buildKaiMarketRoute } from "@/lib/navigation/routes";
import { openExternalUrl, requestInternalAppNavigation } from "@/lib/utils/browser-navigation";
import { cn } from "@/lib/utils";

export function openOneMarketHref(href: string) {
  if (/^https?:\/\//i.test(href)) {
    openExternalUrl(href);
    return;
  }
  requestInternalAppNavigation({ href, scroll: false });
}

function formatOneMarketPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "N/A";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function balancedMoverCount(groups: Record<OneMarketMoverTab, readonly unknown[]>): number {
  return Math.min(3, groups.gain.length, groups.lose.length);
}

export function OneMarketMovers({ groups, linkable = true, note, onSelect, balanced = false, gainersOnly = false }: {
  groups: Record<OneMarketMoverTab, OneMarketDisplayRow[]>;
  /** False for markets whose stocks have no analysis screen (India). */
  linkable?: boolean;
  note?: string;
  onSelect?: (row: OneMarketDisplayRow) => void;
  /** Show 1x1, 2x2 or 3x3 and never a placeholder row: both columns always match. */
  balanced?: boolean;
  gainersOnly?: boolean;
}) {
  const id = useId();
  const slots = gainersOnly ? Math.min(3, groups.gain.length) : balanced ? balancedMoverCount(groups) : 3;
  const moverColumns = [
    { key: "gain", title: "Gainers", rows: groups.gain.slice(0, slots) },
    { key: "lose", title: "Losers", rows: groups.lose.slice(0, slots) },
  ] as const;
  const columns = gainersOnly ? moverColumns.slice(0, 1) : moverColumns;
  const shown = columns.flatMap((column) => column.rows);
  const commonAsOf = shown[0]?.asOf ?? null;
  const sharedTime = commonAsOf && Number.isFinite(Date.parse(commonAsOf))
    && shown.every((row) => row.asOf === commonAsOf);
  if ((balanced || gainersOnly) && slots === 0) {
    return <p data-market-mover-none className="ui-text-row-description px-2 py-3 text-muted-foreground">{gainersOnly ? "Gainers are not available right now." : "Movers are not available right now."}</p>;
  }
  return (
    <div>
      <div className={gainersOnly ? undefined : marketBriefingStyles.moverGroups}>
        {columns.map(({ key, title, rows }) => {
          const Direction = key === "gain" ? TrendingUp : TrendingDown;
          return (
            <section key={key} className={marketBriefingStyles.moverGroup} data-market-mover-group={key} aria-labelledby={id + "-" + key}>
              <h3 id={id + "-" + key} className={cn("ui-text-section-label flex items-center gap-2 px-2 py-1.5", marketBriefingStyles.moverHeading)}>
                <Direction className={cn("size-4 shrink-0", marketBriefingStyles.moverAccent)} aria-hidden="true" />
                <span className={marketBriefingStyles.moverAccent}>{title}</span>
              </h3>
              {Array.from({ length: slots }, (_, rank) => {
                const row = rows[rank];
                // A slot with no row yet is a placeholder shaped like a mover, not text.
                if (!row) return <div key={rank} data-market-mover-empty aria-busy="true"
                  aria-label={title + " " + (rank + 1) + ": loading"}
                  className="flex min-h-12 min-w-0 flex-col justify-center gap-1.5 border-t border-border/50 px-2 py-2">
                  <span className="flex justify-between gap-6"><Skeleton className="h-3.5 w-16" /><Skeleton className="h-3.5 w-12" /></span>
                  <Skeleton className="h-3 w-28" />
                </div>;
                const body = (
                  <>
                    <span className="flex min-w-0 items-baseline justify-between gap-2">
                      <span className="ui-text-row-label-emphasized min-w-0 truncate text-foreground">{row.symbol}</span>
                      <span className={cn("ui-text-row-label-emphasized shrink-0 text-right tabular-nums", marketBriefingStyles.moverAccent)}>{formatOneMarketPercent(row.changePct)}</span>
                    </span>
                    <span className={cn("ui-text-row-description flex min-w-0 items-center gap-1", marketBriefingStyles.moverCompany)}>
                      <SymbolAvatar symbol={row.symbol} name={row.companyName} size="md" logo={linkable} className="size-4 shrink-0 rounded-full [&_img]:size-4" />
                      <span className="truncate" title={row.companyName}>{row.companyName}</span>
                    </span>
                    {!sharedTime && row.asOf && Number.isFinite(Date.parse(row.asOf)) ? <time dateTime={row.asOf} className="ui-text-row-description text-muted-foreground" title={formatOverviewAsOf(row.asOf)}>{gainersOnly ? formatOverviewAsOf(row.asOf) : formatMarketQuoteTime(row.asOf)}</time> : null}
                  </>
                );
                return linkable || onSelect ? (
                  <button key={rank} type="button" data-market-mover-rank={rank} aria-describedby={id + "-" + key}
                    aria-haspopup={onSelect ? "dialog" : undefined}
                    onClick={() => onSelect ? onSelect(row) : openOneMarketHref(buildKaiMarketRoute("analysis", { ticker: row.symbol }))}
                    className={cn(financeStyles.interactiveRow, "relative isolate flex min-h-12 min-w-0 w-full flex-col items-stretch gap-0.5 overflow-hidden rounded-lg border-t border-border/50 px-2 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary")}>
                    {body}
                    <MaterialRipple variant="none" effect="fade" disableHover className="z-10" />
                  </button>
                ) : (
                  <div key={rank} data-market-mover-rank={rank} aria-describedby={id + "-" + key}
                    className="relative isolate flex min-h-12 min-w-0 w-full flex-col items-stretch gap-0.5 overflow-hidden rounded-lg border-t border-border/50 px-2 py-2 text-left">
                    {body}
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>
      {note || sharedTime ? (
        <p className="mt-1 border-t border-border/50 pt-3 text-xs leading-[18px] text-muted-foreground" data-market-mover-freshness>
          {note}
          {note && sharedTime ? " · " : null}
          {sharedTime ? <time dateTime={commonAsOf ?? undefined}>{formatOverviewAsOf(commonAsOf)}</time> : null}
        </p>
      ) : null}
    </div>
  );
}
