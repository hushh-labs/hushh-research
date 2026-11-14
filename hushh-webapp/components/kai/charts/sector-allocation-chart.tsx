"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { allocationColor } from "@/lib/kai/allocation-colors";
import { formatCurrencyAdaptive as formatCurrency } from "@/lib/kai/market-value-format";
import { useMarketCurrency } from "@/lib/kai/use-market-currency";
import styles from "@/components/kai/shared/finance-workspace.module.css";
import { cn } from "@/lib/utils";
import { AllocationSection } from "./allocation-section";

interface Holding {
  symbol: string;
  name: string;
  market_value: number;
  sector?: string;
  asset_type?: string;
}
interface SectorAllocationChartProps {
  holdings: Holding[];
  className?: string;
  responsive?: boolean;
  title?: string;
  subtitle?: string;
  embedded?: boolean;
}

export function SectorAllocationChart({ holdings, className, responsive = true, title = "Sector Allocation", subtitle, embedded }: SectorAllocationChartProps) {
  useMarketCurrency();
  const [windowWidth, setWindowWidth] = useState(1024);
  const [pages, setPages] = useState<Record<string, number>>({});
  const [openSectors, setOpenSectors] = useState<Record<string, boolean>>({});
  const pageSize = responsive && windowWidth < 640 ? 4 : 8;
  useEffect(() => {
    if (!responsive) return;
    const resize = () => setWindowWidth(window.innerWidth);
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [responsive]);
  useEffect(() => { setOpenSectors({}); setPages({}); }, [holdings]);
  const { sectors, total } = useMemo(() => {
    const groups = new Map<string, { value: number; holdings: Holding[] }>();
    for (const holding of holdings) {
      const name = String(holding.sector || "").trim() || "Unclassified";
      const group = groups.get(name) ?? { value: 0, holdings: [] };
      group.value += holding.market_value || 0;
      group.holdings.push(holding);
      groups.set(name, group);
    }
    const total = [...groups.values()].reduce((sum, group) => sum + group.value, 0);
    return { total, sectors: [...groups].map(([name, group]) => ({
      name, value: group.value, percent: total > 0 ? group.value / total * 100 : 0,
      color: allocationColor(name), holdings: [...group.holdings].sort((a, b) => b.market_value - a.market_value),
    })).sort((a, b) => b.value - a.value) };
  }, [holdings]);
  if (!sectors.length) return null;
  return <AllocationSection title={title} description={subtitle} className={className} embedded={embedded}>
    <div className={styles.allocationRows}>
      {sectors.map(sector => {
        const pageCount = Math.max(1, Math.ceil(sector.holdings.length / pageSize));
        const page = Math.min(Math.max(pages[sector.name] ?? 0, 0), pageCount - 1);
        const start = page * pageSize;
        const open = openSectors[sector.name] ?? false;
        return <Collapsible key={sector.name} open={open} onOpenChange={next => setOpenSectors(previous => ({ ...previous, [sector.name]: next }))}>
          <CollapsibleTrigger asChild>
            <button type="button" className={cn(styles.allocationRow, styles.interactiveRow, "relative isolate")}>
              <span aria-hidden="true" className={styles.allocationDot} style={{ background: sector.color }} />
              <span className={styles.allocationText}><span className={styles.allocationName}>{sector.name}</span><span className={styles.allocationMeta}>{sector.holdings.length} holding{sector.holdings.length === 1 ? "" : "s"}</span></span>
              <span className={styles.allocationMeter} aria-hidden="true"><span style={{ width: sector.percent + "%", background: sector.color }} /></span>
              <span className={styles.allocationAmount}><span>{formatCurrency(sector.value)}</span><span className={styles.allocationMeta}>{sector.percent.toFixed(1)}%</span></span>
              {open ? <ChevronUp className="size-4 shrink-0 text-muted-foreground" /> : <ChevronDown className="size-4 shrink-0 text-muted-foreground" />}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent><div className={styles.allocationDetail}>
            {sector.holdings.slice(start, start + pageSize).map((holding, index) => <div className={styles.portfolioListRow} key={holding.symbol + ":" + (start + index)}>
              <span className={styles.allocationText}><span className={styles.allocationName}>{holding.name || "Unnamed security"}</span><span className={styles.allocationMeta}>{holding.symbol || "—"}</span></span>
              <span className="shrink-0 text-right text-sm tabular-nums">{formatCurrency(holding.market_value || 0)}</span>
            </div>)}
            {pageCount > 1 ? <div className={styles.allocationPager}>
              <span>Showing {start + 1}–{Math.min(start + pageSize, sector.holdings.length)} of {sector.holdings.length}</span>
              <div className="flex gap-2">
                <Button type="button" variant="outline" className="min-h-11 px-3 text-xs" disabled={page === 0} onClick={() => setPages(previous => ({ ...previous, [sector.name]: page - 1 }))}>Prev</Button>
                <Button type="button" variant="outline" className="min-h-11 px-3 text-xs" disabled={page === pageCount - 1} onClick={() => setPages(previous => ({ ...previous, [sector.name]: page + 1 }))}>Next</Button>
              </div>
            </div> : null}
          </div></CollapsibleContent>
        </Collapsible>;
      })}
    </div>
    <p className={styles.allocationMeta}>Percentages use {formatCurrency(total)} in this group.</p>
  </AllocationSection>;
}

export default SectorAllocationChart;
