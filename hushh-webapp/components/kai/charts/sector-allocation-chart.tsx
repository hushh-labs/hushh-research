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

import { allocationColor } from "@/lib/kai/allocation-colors";

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
import { ChevronDown, ChevronUp } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChartSurfaceCard } from "@/components/app-ui/surfaces";
import styles from "@/components/kai/shared/finance-workspace.module.css";
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
  CHART_ANIMATION_ACTIVE,
  CHART_TOOLTIP_TRIGGER,
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
    <>
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
            tick={{ fontSize: 12, fill: "hsl(var(--foreground) / 0.72)" }}
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
            tick={{ fontSize: 12, fill: "hsl(var(--foreground) / 0.72)" }}
          />
          <ChartTooltip trigger={CHART_TOOLTIP_TRIGGER}
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
                      <span className="text-xs text-muted-foreground">
                        Sector Allocation
                      </span>
                      <span className="text-sm font-semibold">
                        {payload.name}
                      </span>
                      <span className="text-sm font-semibold text-foreground">
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
          <Bar isAnimationActive={CHART_ANIMATION_ACTIVE}
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
                fontSize={12}
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
    </>
  );
});

export function SectorAllocationChart({
  holdings,
  className,
  responsive = true,
  title = "Sector Allocation",
  subtitle,
}: SectorAllocationChartProps) {
  const [windowWidth, setWindowWidth] = useState<number>(1024);
  const [sectorHoldingPages, setSectorHoldingPages] = useState<
    Record<string, number>
  >({});
  const [openSectors, setOpenSectors] = useState<Record<string, boolean>>({});
  const holdingsPageSize = windowWidth < 640 ? 4 : 8;

  useEffect(() => {
    if (!responsive) return;

    setWindowWidth(window.innerWidth);

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
      const normalizedSector =
        String(holding.sector || "").trim() || "Unclassified";

      const existing = sectorMap.get(normalizedSector) || {
        value: 0,
        count: 0,
        holdings: [],
      };
      sectorMap.set(normalizedSector, {
        value: existing.value + (holding.market_value || 0),
        count: existing.count + 1,
        holdings: [
          ...existing.holdings,
          {
            symbol:
              String(holding.symbol || "")
                .trim()
                .toUpperCase() || "—",
            name: String(holding.name || "").trim() || "Unnamed security",
            marketValue: Number(holding.market_value || 0),
          },
        ],
      });
    });

    const totalValue = Array.from(sectorMap.values()).reduce(
      (sum, s) => sum + s.value,
      0,
    );

    // Sort by value while retaining each category's color.
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
      .map((item) => ({
        ...item,
        color: allocationColor(item.name),
      }));

    return { data, total: totalValue };
  }, [holdings]);

  useEffect(() => {
    setSectorHoldingPages((prev) => {
      const next: Record<string, number> = {};
      for (const sector of sectorData.data) {
        const totalPages = Math.max(
          1,
          Math.ceil(sector.holdings.length / holdingsPageSize),
        );
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
  // Height follows the bar count so a short list is not stretched into a tall, empty card.
  const barCount = sectorData.data.length;
  const chartHeight = useMemo(
    () => Math.min(280, Math.max(112, barCount * 36 + 32)),
    [barCount],
  );

  const leftMargin = 0;

  const rightMargin = useMemo(() => {
    if (!responsive) return 18;
    // Reserve right space for inline value labels while keeping usable plot width.
    if (windowWidth < 640) return 12;
    return 18;
  }, [responsive, windowWidth]);

  const yAxisWidth = useMemo(() => {
    if (!responsive) return 104;
    if (windowWidth < 640) return 76;
    if (windowWidth < 1024) return 92;
    return 104;
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
      className={cn("min-w-0", className)}
      headerClassName={styles.allocationHeader}
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

      <div className={styles.allocationRows}>
          {sectorData.data.map((sector) => {
            const totalPages = Math.max(
              1,
              Math.ceil(sector.holdings.length / holdingsPageSize),
            );
            const currentPage = sectorHoldingPages[sector.name] ?? 0;
            const clampedPage = Math.min(
              Math.max(currentPage, 0),
              totalPages - 1,
            );
            const start = clampedPage * holdingsPageSize;
            const end = start + holdingsPageSize;
            const visibleHoldings = sector.holdings.slice(start, end);
            const isOpen = openSectors[sector.name] ?? false;

            return (
              <Collapsible
                key={sector.name}
                open={isOpen}
                onOpenChange={(nextOpen) =>
                  setOpenSectors((prev) => ({
                    ...prev,
                    [sector.name]: nextOpen,
                  }))
                }
              >
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      styles.allocationRow,
                      styles.interactiveRow,
                      "relative isolate focus-visible:outline-none",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={styles.allocationDot}
                      style={{ backgroundColor: sector.color }}
                    />
                    <span className={styles.allocationText}>
                      <span className={styles.allocationName}>{sector.name}</span>
                      <span className={styles.allocationMeta}>
                        {sector.count} holding{sector.count !== 1 ? "s" : ""}
                      </span>
                    </span>
                    <span className={styles.allocationAmount}>
                      <span>{formatCurrency(sector.value)}</span>
                      <span className={styles.allocationMeta}>{sector.percent.toFixed(1)}%</span>
                    </span>
                    {isOpen ? (
                      <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className={styles.allocationDetail}>
                    <div className={styles.allocationChips}>
                      {visibleHoldings.map((holding) => (
                        <span
                          key={`${sector.name}-${holding.symbol}-${holding.name}`}
                          className={styles.allocationChip}
                          title={`${holding.symbol} · ${holding.name} · ${formatCurrency(holding.marketValue)}`}
                        >
                          <span className="font-semibold">
                            {holding.symbol}
                          </span>
                          <span className="truncate text-muted-foreground">
                            {holding.name}
                          </span>
                        </span>
                      ))}
                    </div>

                    {totalPages > 1 ? (
                      <div className={styles.allocationPager}>
                        <span>
                          Showing {start + 1}-
                          {Math.min(end, sector.holdings.length)} of{" "}
                          {sector.holdings.length}
                        </span>
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 px-3 text-xs"
                            disabled={clampedPage === 0}
                            onClick={() =>
                              setSectorHoldingPages((prev) => ({
                                ...prev,
                                [sector.name]: Math.max(
                                  0,
                                  (prev[sector.name] ?? 0) - 1,
                                ),
                              }))
                            }
                          >
                            Prev
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 px-3 text-xs"
                            disabled={clampedPage >= totalPages - 1}
                            onClick={() =>
                              setSectorHoldingPages((prev) => ({
                                ...prev,
                                [sector.name]: Math.min(
                                  totalPages - 1,
                                  (prev[sector.name] ?? 0) + 1,
                                ),
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
    </ChartSurfaceCard>
  );
}

export default SectorAllocationChart;
