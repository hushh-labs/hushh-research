// components/kai/charts/sector-allocation-chart.tsx

/**
 * Sector Allocation Chart
 * 
 * Features:
 * - Horizontal bar chart showing portfolio allocation by sector
 * - Interactive bars with hover effects
 * - Responsive design with shadcn ChartContainer
 * - Theme-aware colors from design system
 * - Shows both value and percentage
 */

"use client";

import { memo, useMemo, useState, useEffect } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Cell,
  LabelList,
} from "recharts";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ChartSurfaceCard,
  SurfaceInset,
} from "@/components/app-ui/surfaces";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

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
}

interface SectorHoldingItem {
  symbol: string;
  name: string;
  marketValue: number;
}

interface SectorDatum {
  name: string;
  value: number;
  count: number;
  percent: number;
  color: string;
  holdings: SectorHoldingItem[];
}

type SectorBarChartProps = {
  chartConfig: ChartConfig;
  chartHeight: number;
  leftMargin: number;
  rightMargin: number;
  yAxisWidth: number;
  showInlineValueLabels: boolean;
  sectorData: { data: SectorDatum[]; total: number };
};

// Distinct palette so neighboring sectors are easy to scan.
const CHART_COLORS = [
  "#2563eb",
  "#0ea5e9",
  "#14b8a6",
  "#22c55e",
  "#f59e0b",
  "#f97316",
  "#8b5cf6",
  "#ec4899",
];

function formatCurrency(value: number): string {
  if (value >= 1000000) {
    return `$${(value / 1000000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `$${(value / 1000).toFixed(0)}K`;
  }
  return `$${value.toFixed(0)}`;
}

function _formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

function compactSectorLabel(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 15)}…`;
}

const SectorBarChart = memo(function SectorBarChart({
  chartConfig,
  chartHeight,
  leftMargin,
  rightMargin,
  yAxisWidth,
  showInlineValueLabels,
  sectorData,
}: SectorBarChartProps) {
  return (
    <SurfaceInset className="p-3 sm:p-4">
      <ChartContainer
        config={chartConfig}
        className="w-full min-w-0"
        style={{ height: `${chartHeight}px` }}
      >
        <BarChart
          data={sectorData.data}
          layout="vertical"
          margin={{ top: 5, right: rightMargin, left: leftMargin, bottom: 5 }}
        >
          <XAxis
            type="number"
            tickFormatter={(value) => formatCurrency(value)}
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 10, fill: "hsl(var(--foreground) / 0.72)" }}
          />
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="hsl(var(--foreground) / 0.22)"
            strokeOpacity={0.55}
          />
          <YAxis
            type="category"
            dataKey="name"
            tickFormatter={(value) => compactSectorLabel(String(value))}
            axisLine={false}
            tickLine={false}
            width={yAxisWidth}
            tick={{ fontSize: 10, fill: "hsl(var(--foreground) / 0.72)" }}
          />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                hideLabel
                formatter={(value, name, item) => {
                  const payload = item.payload as {
                    name: string;
                    value: number;
                    count: number;
                  };
                  return (
                    <div className="flex flex-col gap-1">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Sector Allocation
                      </span>
                      <span className="text-sm font-semibold">{payload.name}</span>
                      <span className="text-base font-bold text-foreground">
                        {formatCurrency(payload.value)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {payload.count} holding{payload.count !== 1 ? "s" : ""}
                      </span>
                    </div>
                  );
                }}
              />
            }
          />
          <Bar
            dataKey="value"
            radius={[0, 4, 4, 0]}
            animationDuration={550}
            maxBarSize={24}
          >
            {showInlineValueLabels ? (
              <LabelList
                dataKey="value"
                position="right"
                className="fill-foreground"
                fontSize={10}
                formatter={(value: number) => formatCurrency(Number(value))}
              />
            ) : null}
            {sectorData.data.map((entry, index) => (
              <Cell
                key={`cell-${index}`}
                fill={entry.color}
                style={{ cursor: "pointer" }}
              />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>
    </SurfaceInset>
  );
});

export function SectorAllocationChart({
  holdings,
  className,
  responsive = true,
  title = "Sector Allocation",
  subtitle,
}: SectorAllocationChartProps) {
  const [windowWidth, setWindowWidth] = useState<number>(
    typeof window !== "undefined" ? window.innerWidth : 1024
  );
  const [sectorHoldingPages, setSectorHoldingPages] = useState<Record<string, number>>({});
  const [openSectors, setOpenSectors] = useState<Record<string, boolean>>({});
  const holdingsPageSize = windowWidth < 640 ? 4 : 8;

  useEffect(() => {
    if (!responsive) return;

    const handleResize = () => {
      setWindowWidth(window.innerWidth);
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [responsive]);
  // Aggregate holdings by sector
  const sectorData = useMemo(() => {
    const sectorMap = new Map<
      string,
      { value: number; count: number; holdings: SectorHoldingItem[] }
    >();
    
    holdings.forEach((holding) => {
      const normalizedSector = String(holding.sector || "").trim() || "Unclassified";
      
      const existing = sectorMap.get(normalizedSector) || { value: 0, count: 0, holdings: [] };
      sectorMap.set(normalizedSector, {
        value: existing.value + (holding.market_value || 0),
        count: existing.count + 1,
        holdings: [
          ...existing.holdings,
          {
            symbol: String(holding.symbol || "").trim().toUpperCase() || "—",
            name: String(holding.name || "").trim() || "Unnamed security",
            marketValue: Number(holding.market_value || 0),
          },
        ],
      });
    });

    const totalValue = Array.from(sectorMap.values()).reduce((sum, s) => sum + s.value, 0);
    
    // Convert to array and sort by value, assign colors by index
    const data: SectorDatum[] = Array.from(sectorMap.entries())
      .map(([name, { value, count, holdings }]) => ({
        name,
        value,
        count,
        percent: totalValue > 0 ? (value / totalValue) * 100 : 0,
        holdings: holdings
          .slice()
          .sort((a, b) => b.marketValue - a.marketValue),
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8) // Top 8 sectors
      .map((item, index) => ({
        ...item,
        color: CHART_COLORS[index % CHART_COLORS.length] ?? "#2563eb",
      }));

    return { data, total: totalValue };
  }, [holdings]);

  useEffect(() => {
    setSectorHoldingPages((prev) => {
      const next: Record<string, number> = {};
      for (const sector of sectorData.data) {
        const totalPages = Math.max(1, Math.ceil(sector.holdings.length / holdingsPageSize));
        const prevPage = prev[sector.name] ?? 0;
        next[sector.name] = Math.min(Math.max(prevPage, 0), totalPages - 1);
      }
      return next;
    });
  }, [holdingsPageSize, sectorData.data]);

  useEffect(() => {
    setOpenSectors(() => {
      const next: Record<string, boolean> = {};
      sectorData.data.forEach((sector) => {
        next[sector.name] = false;
      });
      return next;
    });
  }, [sectorData.data]);

  // Responsive dimensions
  const chartHeight = useMemo(() => {
    if (!responsive) return 184;
    // Give bars more breathing room while still fitting dashboard density.
    if (windowWidth < 640) return 168;
    if (windowWidth < 1024) return 196;
    return 224;
  }, [responsive, windowWidth]);

  const leftMargin = 0;

  const rightMargin = useMemo(() => {
    if (!responsive) return 18;
    // Reserve right space for inline value labels while keeping usable plot width.
    if (windowWidth < 640) return 12;
    return 18;
  }, [responsive, windowWidth]);

  const yAxisWidth = useMemo(() => {
    if (!responsive) return 96;
    if (windowWidth < 640) return 66;
    if (windowWidth < 1024) return 82;
    return 96;
  }, [responsive, windowWidth]);

  const showInlineValueLabels = windowWidth < 768;

  // Chart config for shadcn ChartContainer
  const chartConfig = useMemo<ChartConfig>(() => {
    const config: ChartConfig = {};
    sectorData.data.forEach((sector) => {
      config[sector.name] = {
        label: sector.name,
        color: sector.color,
      };
    });
    return config;
  }, [sectorData.data]);

  if (sectorData.data.length === 0) {
    return null;
  }

  return (
    <ChartSurfaceCard
      title={title}
      description={subtitle}
      className={cn("h-full min-w-0", className)}
      contentClassName="space-y-3"
    >
      <SectorBarChart
        chartConfig={chartConfig}
        chartHeight={chartHeight}
        leftMargin={leftMargin}
        rightMargin={rightMargin}
        yAxisWidth={yAxisWidth}
        showInlineValueLabels={showInlineValueLabels}
        sectorData={sectorData}
      />

      <SurfaceInset className="px-3 py-3 sm:px-4">
          <div className="space-y-2">
            {sectorData.data.map((sector) => {
              const totalPages = Math.max(1, Math.ceil(sector.holdings.length / holdingsPageSize));
              const currentPage = sectorHoldingPages[sector.name] ?? 0;
              const clampedPage = Math.min(Math.max(currentPage, 0), totalPages - 1);
              const start = clampedPage * holdingsPageSize;
              const end = start + holdingsPageSize;
              const visibleHoldings = sector.holdings.slice(start, end);
              const isOpen = openSectors[sector.name] ?? false;

              return (
                <Collapsible
                  key={sector.name}
                  open={isOpen}
                  onOpenChange={(nextOpen) =>
                    setOpenSectors((prev) => ({ ...prev, [sector.name]: nextOpen }))
                  }
                  className="rounded-lg border border-border/60 bg-background/80"
                >
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 p-2.5 text-left transition-colors hover:bg-background/60"
                    >
                      <div
                        className="h-3 w-3 shrink-0 rounded-full"
                        style={{ backgroundColor: sector.color }}
                      />
                      <span className="text-sm font-medium text-foreground">{sector.name}</span>
                      <span className="text-xs font-medium text-foreground/80">
                        {formatCurrency(sector.value)} ({sector.percent.toFixed(1)}%)
                      </span>
                      <span className="ml-auto text-[11px] text-muted-foreground">
                        {sector.count} holding{sector.count !== 1 ? "s" : ""}
                      </span>
                      {isOpen ? (
                        <ChevronUp className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      )}
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="border-t border-border/50">
                    <div className="space-y-2 p-2.5">
                      <div className="flex flex-wrap gap-1.5">
                        {visibleHoldings.map((holding) => (
                          <span
                            key={`${sector.name}-${holding.symbol}-${holding.name}`}
                            className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/60 bg-background/90 px-2 py-0.5 text-[11px]"
                            title={`${holding.symbol} · ${holding.name} · ${formatCurrency(holding.marketValue)}`}
                          >
                            <span className="font-semibold">{holding.symbol}</span>
                            <span className="truncate text-muted-foreground">{holding.name}</span>
                          </span>
                        ))}
                      </div>

                      {totalPages > 1 ? (
                        <div className="mt-2 flex items-center justify-between">
                          <span className="text-[11px] text-muted-foreground">
                            Showing {start + 1}-{Math.min(end, sector.holdings.length)} of {sector.holdings.length}
                          </span>
                          <div className="flex items-center gap-1">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-6 px-2 text-[11px]"
                              disabled={clampedPage === 0}
                              onClick={() =>
                                setSectorHoldingPages((prev) => ({
                                  ...prev,
                                  [sector.name]: Math.max(0, (prev[sector.name] ?? 0) - 1),
                                }))
                              }
                            >
                              Prev
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-6 px-2 text-[11px]"
                              disabled={clampedPage >= totalPages - 1}
                              onClick={() =>
                                setSectorHoldingPages((prev) => ({
                                  ...prev,
                                  [sector.name]: Math.min(totalPages - 1, (prev[sector.name] ?? 0) + 1),
                                }))
                              }
                            >
                              Next
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              );
            })}
          </div>
      </SurfaceInset>
    </ChartSurfaceCard>
  );
}

export default SectorAllocationChart;
