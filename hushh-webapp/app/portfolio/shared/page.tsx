"use client";

import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import {
  sanitizePortfolioSharePayload,
  type PortfolioSharePayload,
  type PortfolioSharePerformancePoint,
} from "@/lib/portfolio-share/contract";

// =============================================================================
// CRYPTOGRAPHIC DECODING UTILITIES
// =============================================================================

function fromBase64Url(input: string): string | null {
  try {
    const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return decodeURIComponent(escape(window.atob(padded)));
  } catch {
    return null;
  }
}

function decodeRawPayloadToken(token: string): PortfolioSharePayload | null {
  if (!token.startsWith("raw.")) return null;
  const encodedPayload = token.slice(4);
  if (!encodedPayload) return null;

  const decoded = fromBase64Url(encodedPayload);
  if (!decoded) return null;

  try {
    const parsed = JSON.parse(decoded) as unknown;
    return sanitizePortfolioSharePayload(parsed);
  } catch {
    return null;
  }
}

function decodeSignedTokenPayload(token: string): PortfolioSharePayload | null {
  const segments = token.split(".");
  if (segments.length < 2) return null;

  const payloadSegment = segments[1] || "";
  if (!payloadSegment) return null;

  const decoded = fromBase64Url(payloadSegment);
  if (!decoded) return null;

  try {
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    if (!parsed || !("p" in parsed)) return null;
    return sanitizePortfolioSharePayload(parsed.p);
  } catch {
    return null;
  }
}

function resolvePayloadFromToken(token: string): PortfolioSharePayload | null {
  if (!token) return null;
  if (token.startsWith("raw.")) return decodeRawPayloadToken(token);
  return decodeSignedTokenPayload(token);
}

// =============================================================================
// FORMATTING ENGINE UTILITIES
// =============================================================================

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatSignedCurrency(value: number): string {
  return `${value >= 0 ? "+" : "-"}${formatCurrency(Math.abs(value))}`;
}

function formatSignedPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatDateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value.slice(0, 20);
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

// =============================================================================
// GEOMETRIC SVG GRAPH MATRIX ENGINE
// =============================================================================

function buildPerformanceChartData(performance: PortfolioSharePerformancePoint[]) {
  const chartWidth = 640;
  const chartHeight = 220;
  const paddingX = 32;
  const paddingY = 24;

  if (performance.length < 2) {
    return {
      points: [] as Array<{ x: number; y: number; label: string; value: number }>,
      linePath: "",
      areaPath: "",
      chartWidth,
      chartHeight,
      baselineY: chartHeight - paddingY,
      minValue: 0,
      maxValue: 0,
      stride: 1,
    };
  }

  const values = performance.map((point) => point.value);
  const maxValue = Math.max(...values, 1);
  const minValue = Math.min(...values, 0);
  const valueRange = Math.max(maxValue - minValue, 1);
  const usableWidth = chartWidth - paddingX * 2;
  const usableHeight = chartHeight - paddingY * 2;
  const xStep = performance.length > 1 ? usableWidth / (performance.length - 1) : 0;

  const points = performance.map((point, index) => ({
    x: paddingX + xStep * index,
    y: chartHeight - paddingY - ((point.value - minValue) / valueRange) * usableHeight,
    label: point.label,
    value: point.value,
  }));

  const linePath = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");

  const first = points[0];
  const last = points[points.length - 1];

  const areaPath =
    first && last
      ? `${linePath} L ${last.x} ${chartHeight - paddingY} L ${first.x} ${chartHeight - paddingY} Z`
      : "";

  return {
    points,
    linePath,
    areaPath,
    chartWidth,
    chartHeight,
    baselineY: chartHeight - paddingY,
    minValue,
    maxValue,
    stride: Math.max(1, Math.ceil(points.length / 5)),
  };
}

// =============================================================================
// SUB-LAYOUT RENDER NODES
// =============================================================================

function EmptySnapshot() {
  return (
    <main className="min-h-screen bg-slate-950 flex items-center justify-center px-4 py-10 text-slate-100">
      <NativeTestBeacon
        routeId="/portfolio/shared"
        marker="native-route-portfolio-shared"
        authState="public"
        dataState="empty-valid"
      />
      <div className="w-full max-w-md space-y-5 rounded-3xl border border-slate-900 bg-slate-900/40 p-8 text-center backdrop-blur-xl">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-rose-500/20 bg-rose-500/10 text-rose-400">
          ⚠️
        </div>
        <div className="space-y-2">
          <h1 className="text-xl font-semibold tracking-tight">Portfolio Snapshot Unreachable</h1>
          <p className="text-sm text-slate-400 leading-relaxed">
            This verification string payload has passed active duration bounds or holds structural faults. Request a new share token link.
          </p>
        </div>
      </div>
    </main>
  );
}

function SnapshotView({ payload }: { payload: PortfolioSharePayload }) {
  const safePayload = sanitizePortfolioSharePayload(payload);
  
  // Interactive Feature State Handles
  const [timeframe, setTimeframe] = useState<"1W" | "1M" | "3M" | "ALL">("ALL");
  const [activePoint, setActivePoint] = useState<typeof chartData.points[0] | null>(null);

  // Compute segmented portfolio view sets matching interactive bounds
  const filteredPerformance = useMemo(() => {
    const historicalPoints = safePayload.performance || [];
    if (timeframe === "1W") return historicalPoints.slice(-7);
    if (timeframe === "1M") return historicalPoints.slice(-30);
    if (timeframe === "3M") return historicalPoints.slice(-90);
    return historicalPoints;
  }, [safePayload.performance, timeframe]);

  const chartData = useMemo(() => buildPerformanceChartData(filteredPerformance), [filteredPerformance]);
  const generatedAtText = formatDateLabel(safePayload.generatedAt);

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-8 text-slate-100 sm:py-12 selection:bg-cyan-500/20">
      <NativeTestBeacon
        routeId="/portfolio/shared"
        marker="native-route-portfolio-shared"
        authState="public"
        dataState="loaded"
      />
      
      <div className="mx-auto max-w-3xl space-y-6">
        {/* HEADER BRANDING CARD SECTION */}
        <header className="rounded-3xl border border-slate-800/80 bg-gradient-to-b from-slate-900 to-slate-900/60 p-6 shadow-xl backdrop-blur-sm">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-400">Secure Live Access</p>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" /> Read Only
            </span>
          </div>
          
          <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">Total Value Asset Volume</p>
              <p className="mt-1 text-3xl font-bold tracking-tight sm:text-4xl text-slate-50">
                {formatCurrency(safePayload.portfolioValue)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">Daily Margin Swing</p>
              <p className={`mt-1 text-base font-semibold sm:text-lg ${safePayload.dailyChangeValue >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                {formatSignedCurrency(safePayload.dailyChangeValue)} ({formatSignedPercent(safePayload.dailyChangePct)})
              </p>
            </div>
          </div>
          
          <div className="mt-5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-xl border border-slate-800/60 bg-slate-950/40 px-4 py-3 text-xs text-slate-400">
            <span>Generated timestamp verification: <strong>{generatedAtText}</strong></span>
            <span className="text-slate-500">Excludes personal client account identifier nodes.</span>
          </div>
        </header>

        {/* DETAILS GRID LAYOUT PANEL */}
        <section className="grid gap-6 md:grid-cols-2">
          {/* TOP ASSET HOLDINGS DATA CARD */}
          <article className="rounded-3xl border border-slate-800/80 bg-slate-900/50 p-6 backdrop-blur-sm flex flex-col">
            <h2 className="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">Top Strategic Holdings</h2>
            {safePayload.topHoldings.length === 0 ? (
              <p className="mt-6 text-sm text-slate-500 text-center my-auto">No current allocation nodes found.</p>
            ) : (
              <ul className="mt-4 space-y-2.5 flex-1 overflow-auto max-h-[340px] pr-1">
                {safePayload.topHoldings.slice(0, 8).map((holding) => (
                  <li key={`${holding.symbol}-${holding.name}`} className="group rounded-2xl border border-slate-800/40 bg-slate-900/30 p-3.5 hover:border-slate-700/60 transition-all duration-150">
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-200 group-hover:text-cyan-400 transition-colors">{holding.symbol}</p>
                        <p className="truncate text-xs text-slate-400 mt-0.5">{holding.name}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-semibold text-slate-200">{formatCurrency(holding.value)}</p>
                        <p className="text-xs font-medium text-slate-400 mt-0.5">{holding.weightPct.toFixed(1)}%</p>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </article>

          {/* SECTOR ALLOCATION BALANCING PANEL */}
          <article className="rounded-3xl border border-slate-800/80 bg-slate-900/50 p-6 backdrop-blur-sm">
            <h2 className="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">Market Sector Weight Distribution</h2>
            {safePayload.sectorAllocation.length === 0 ? (
              <p className="mt-6 text-sm text-slate-500 text-center">No structural segment tracks found.</p>
            ) : (
              <ul className="mt-4 space-y-3">
                {safePayload.sectorAllocation.slice(0, 8).map((sector) => {
                  const barWidth = Math.max(2, Math.min(100, sector.pct));
                  return (
                    <li key={sector.label} className="rounded-2xl border border-slate-800/40 bg-slate-900/30 p-3.5">
                      <div className="flex items-center justify-between gap-3 text-xs font-medium text-slate-300">
                        <span className="truncate text-slate-200">{sector.label}</span>
                        <span className="text-cyan-400 font-semibold">{sector.pct.toFixed(1)}%</span>
                      </div>
                      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-slate-950">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-blue-400 transition-all duration-500"
                          style={{ width: `${barWidth}%` }}
                        />
                      </div>
                      <p className="mt-2 text-right text-[10px] font-medium text-slate-400">{formatCurrency(sector.value)}</p>
                    </li>
                  );
                })}
              </ul>
            )}
          </article>
        </section>

        {/* INTERACTIVE COMPREHENSIVE PERFORMANCE SVG GRAPH SECTION */}
        <article className="rounded-3xl border border-slate-800/80 bg-slate-900/50 p-6 backdrop-blur-sm">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">Historical Yield Evaluation Matrix</h2>
              <p className="text-xs text-slate-500 mt-0.5">Hover or trace path nodes to isolate historical asset values.</p>
            </div>
            
            {/* INTERACTIVE TIMEFRAME SELECTION BUTTON CONTROLS */}
            <div className="flex items-center gap-1 self-start rounded-xl border border-slate-800 bg-slate-950 p-1 text-xs font-medium shadow-inner">
              {(["1W", "1M", "3M", "ALL"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => { setTimeframe(t); setActivePoint(null); }}
                  className={`rounded-lg px-3 py-1.5 transition-all ${timeframe === t ? "bg-cyan-500 text-slate-950 font-bold shadow-md" : "text-slate-400 hover:text-slate-200"}`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {chartData.points.length < 2 ? (
            <p className="mt-8 text-sm text-slate-500 text-center py-10">Inadequate coordinates data mapping found.</p>
          ) : (
            <div className="mt-6 space-y-3">
              {/* INTERACTIVE REAL-TIME FLOATING DATA TOOLTIP ANCHOR DISPLAY PANEL */}
              <div className="h-11 flex items-center justify-between rounded-xl bg-slate-950/60 px-4 py-2 border border-slate-800/50">
                <div>
                  <span className="text-xs text-slate-400 font-medium uppercase tracking-wider">Timeline Target Check:</span>
                  <span className="ml-2 text-sm font-semibold text-slate-200">
                    {activePoint ? formatDateLabel(activePoint.label) : "Live Aggregated View"}
                  </span>
                </div>
                <div>
                  <span className="text-xs text-slate-400 font-medium uppercase tracking-wider">Value Node:</span>
                  <span className="ml-2 text-sm font-bold text-cyan-400">
                    {activePoint ? formatCurrency(activePoint.value) : formatCurrency(safePayload.portfolioValue)}
                  </span>
                </div>
              </div>

              <div className="overflow-hidden rounded-2xl border border-slate-800/50 bg-slate-950/80 p-4">
                <svg
                  viewBox={`0 0 ${chartData.chartWidth} ${chartData.chartHeight}`}
                  role="img"
                  aria-label="Interactive interactive yield asset calculation map grid"
                  className="h-60 w-full overflow-visible"
                  onMouseLeave={() => setActivePoint(null)}
                >
                  {/* CHART GRADIENT MASKS SCHEMAS */}
                  <defs>
                    <linearGradient id="performanceArea" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.25" />
                      <stop offset="100%" stopColor="#06b6d4" stopOpacity="0.00" />
                    </linearGradient>
                  </defs>

                  {/* MATRIX DATA TRACK LINES */}
                  <line
                    x1={20}
                    y1={chartData.baselineY}
                    x2={chartData.chartWidth - 20}
                    y2={chartData.baselineY}
                    stroke="#1e293b"
                    strokeWidth={1.5}
                    strokeDasharray="4 4"
                  />
                  
                  {/* HISTORICAL GRAPH CURVE SHAPES PATH COMPILATION LAYOUT */}
                  <path d={chartData.areaPath} fill="url(#performanceArea)" className="transition-all duration-300" />
                  <path d={chartData.linePath} fill="none" stroke="#06b6d4" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="transition-all duration-300" />
                  
                  {/* DATA PATH VERTICAL TRACER LINE INTERACTION INTERACTION GUIDE */}
                  {activePoint && (
                    <line
                      x1={activePoint.x}
                      y1={10}
                      x2={activePoint.x}
                      y2={chartData.baselineY}
                      stroke="#06b6d4"
                      strokeWidth={1}
                      strokeDasharray="3 3"
                      className="pointer-events-none animate-fade-in"
                    />
                  )}

                  {/* DATA GRID PIN COORDINATES & HOVER BOUND INTERACTIVE PATH REGIONS */}
                  {chartData.points.map((point, index) => {
                    const showAxisText = index % chartData.stride === 0 || index === chartData.points.length - 1;
                    const isPointHovered = activePoint?.x === point.x;

                    return (
                      <g key={`${point.x}-${point.label}-${index}`}>
                        {showAxisText && (
                          <>
                            <line x1={point.x} y1={chartData.baselineY} x2={point.x} y2={chartData.baselineY + 4} stroke="#334155" strokeWidth={1} />
                            <text x={point.x} y={chartData.chartHeight - 4} fill="#64748b" fontSize="10" fontWeight="500" textAnchor="middle">
                              {formatDateLabel(point.label).split(",")[0]}
                            </text>
                          </>
                        )}
                        
                        {/* Hidden ultra-wide target slice layers optimized for high precision touch and cursor hovers */}
                        <rect
                          x={point.x - 12}
                          y={0}
                          width={24}
                          height={chartData.baselineY}
                          fill="transparent"
                          className="cursor-crosshair pointer-events-auto"
                          onMouseEnter={() => setActivePoint(point)}
                        />

                        {isPointHovered && (
                          <circle cx={point.x} cy={point.y} r={5} fill="#06b6d4" stroke="#ffffff" strokeWidth={1.5} className="pointer-events-none shadow" />
                        )}
                      </g>
                    );
                  })}
                </svg>
                
                <div className="mt-3 flex items-center justify-between text-[11px] font-medium text-slate-400 border-t border-slate-900 pt-3 px-1">
                  <span className="inline-flex items-center gap-1">📉 Minimum Base: <strong className="text-slate-300">{formatCurrency(chartData.minValue)}</strong></span>
                  <span className="inline-flex items-center gap-1">📈 Historical Peak: <strong className="text-slate-300">{formatCurrency(chartData.maxValue)}</strong></span>
                </div>
              </div>
            </div>
          )}
        </article>
      </div>
    </main>
  );
}

// =============================================================================
// MAIN COMPONENT EXPORTS & PROVIDERS ENGINES
// =============================================================================

function SharedPortfolioPageContent() {
  const searchParams = useSearchParams();
  const token = String(searchParams.get("token") || "").trim();

  // Parse target credentials block payload structure cleanly
  const payload = useMemo(() => resolvePayloadFromToken(token), [token]);

  if (!payload) {
    return <EmptySnapshot />;
  }

  return <SnapshotView payload={payload} />;
}

export default function SharedPortfolioPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-cyan-500 border-t-transparent" />
      </div>
    }>
      <SharedPortfolioPageContent />
    </Suspense>
  );
}