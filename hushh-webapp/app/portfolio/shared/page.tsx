"use client";

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";

import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import {
  sanitizePortfolioSharePayload,
  type PortfolioSharePayload,
  type PortfolioSharePerformancePoint,
} from "@/lib/portfolio-share/contract";

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

function buildPerformanceChartData(performance: PortfolioSharePerformancePoint[]) {
  const chartWidth = 640;
  const chartHeight = 220;
  const paddingX = 24;
  const paddingY = 20;

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
    y:
      chartHeight -
      paddingY -
      ((point.value - minValue) / valueRange) * usableHeight,
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
    stride: Math.max(1, Math.ceil(points.length / 4)),
  };
}

function EmptySnapshot() {
  return (
    <main className="min-h-screen bg-slate-950 px-4 py-10 text-slate-100">
      <NativeTestBeacon
        routeId="/portfolio/shared"
        marker="native-route-portfolio-shared"
        authState="public"
        dataState="empty-valid"
      />
      <div className="mx-auto max-w-2xl space-y-4 rounded-3xl border border-slate-800 bg-slate-900/80 p-8 text-center">
        <h1 className="text-2xl font-semibold">This share link is not available</h1>
        <p className="text-sm text-slate-300">
          The link may be invalid. Ask the portfolio owner to generate a new share link.
        </p>
      </div>
    </main>
  );
}

function SnapshotView({ payload }: { payload: PortfolioSharePayload }) {
  const safePayload = sanitizePortfolioSharePayload(payload);
  const chartData = buildPerformanceChartData(safePayload.performance.slice(-24));
  const generatedAtText = formatDateLabel(safePayload.generatedAt);

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-8 text-slate-100 sm:py-10">
      <NativeTestBeacon
        routeId="/portfolio/shared"
        marker="native-route-portfolio-shared"
        authState="public"
        dataState="loaded"
      />
      <div className="mx-auto max-w-3xl space-y-5">
        <section className="rounded-3xl border border-slate-800 bg-slate-900/85 p-6 shadow-[0_20px_45px_rgba(2,6,23,0.6)]">
          <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Portfolio Snapshot</p>
          <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-sm text-slate-400">Portfolio Value</p>
              <p className="text-3xl font-semibold sm:text-4xl">
                {formatCurrency(safePayload.portfolioValue)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-sm text-slate-400">Daily Change</p>
              <p
                className={`text-lg font-semibold ${
                  safePayload.dailyChangeValue >= 0 ? "text-emerald-400" : "text-rose-400"
                }`}
              >
                {formatSignedCurrency(safePayload.dailyChangeValue)} (
                {formatSignedPercent(safePayload.dailyChangePct)})
              </p>
            </div>
          </div>
          <div className="mt-4 rounded-xl border border-slate-800/80 bg-slate-900/60 px-3 py-2 text-xs text-slate-400">
            <p>Generated {generatedAtText}</p>
            <p className="mt-1">Read-only share. Account numbers and personal identifiers are excluded.</p>
          </div>
        </section>

        <section className="grid gap-5 md:grid-cols-2">
          <article className="rounded-3xl border border-slate-800 bg-slate-900/85 p-5">
            <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-300">
              Top Holdings
            </h2>
            {safePayload.topHoldings.length === 0 ? (
              <p className="mt-4 text-sm text-slate-400">No holdings available.</p>
            ) : (
              <ul className="mt-4 space-y-2">
                {safePayload.topHoldings.slice(0, 8).map((holding) => (
                  <li
                    key={`${holding.symbol}-${holding.name}`}
                    className="rounded-xl border border-slate-800/70 bg-slate-900/60 p-3"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{holding.symbol}</p>
                        <p className="truncate text-xs text-slate-400">{holding.name}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-medium">{formatCurrency(holding.value)}</p>
                        <p className="text-xs text-slate-400">{holding.weightPct.toFixed(1)}%</p>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </article>

          <article className="rounded-3xl border border-slate-800 bg-slate-900/85 p-5">
            <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-300">
              Sector Allocation
            </h2>
            {safePayload.sectorAllocation.length === 0 ? (
              <p className="mt-4 text-sm text-slate-400">No sector allocation available.</p>
            ) : (
              <ul className="mt-4 space-y-2">
                {safePayload.sectorAllocation.slice(0, 8).map((sector) => {
                  const barWidth = Math.max(2, Math.min(100, sector.pct));
                  return (
                    <li key={sector.label} className="rounded-xl border border-slate-800/70 bg-slate-900/60 p-3">
                      <div className="flex items-center justify-between gap-3 text-xs text-slate-300">
                        <span className="truncate">{sector.label}</span>
                        <span>{sector.pct.toFixed(1)}%</span>
                      </div>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800">
                        <div
                          className="h-full rounded-full bg-cyan-400"
                          style={{ width: `${barWidth}%` }}
                        />
                      </div>
                      <p className="mt-2 text-right text-xs text-slate-400">{formatCurrency(sector.value)}</p>
                    </li>
                  );
                })}
              </ul>
            )}
          </article>
        </section>

        <article className="rounded-3xl border border-slate-800 bg-slate-900/85 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-300">
            Performance
          </h2>
          {chartData.points.length < 2 ? (
            <p className="mt-4 text-sm text-slate-400">No performance chart data available.</p>
          ) : (
            <div className="mt-4 overflow-hidden rounded-2xl border border-slate-800/70 bg-slate-950/70 p-3">
              <svg
                viewBox={`0 0 ${chartData.chartWidth} ${chartData.chartHeight}`}
                role="img"
                aria-label="Portfolio performance chart"
                className="h-56 w-full"
              >
                <line
                  x1={20}
                  y1={chartData.baselineY}
                  x2={chartData.chartWidth - 20}
                  y2={chartData.baselineY}
                  stroke="#334155"
                  strokeWidth={1}
                />
                <path d={chartData.areaPath} fill="url(#performanceArea)" opacity={0.8} />
                <path d={chartData.linePath} fill="none" stroke="#38bdf8" strokeWidth={3} />
                <defs>
                  <linearGradient id="performanceArea" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.35" />
                    <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.02" />
                  </linearGradient>
                </defs>
                {chartData.points.map((point, index) => {
                  if (index % chartData.stride !== 0 && index !== chartData.points.length - 1) {
                    return null;
                  }
                  return (
                    <g key={`${point.x}-${point.label}`}>
                      <circle cx={point.x} cy={point.y} r={3} fill="#e2e8f0" />
                      <text x={point.x} y={chartData.chartHeight - 2} fill="#94a3b8" fontSize="11" textAnchor="middle">
                        {formatDateLabel(point.label)}
                      </text>
                    </g>
                  );
                })}
              </svg>
              <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
                <span>Min {formatCurrency(chartData.minValue)}</span>
                <span>Max {formatCurrency(chartData.maxValue)}</span>
              </div>
            </div>
          )}
        </article>
      </div>
    </main>
  );
}

function SharedPortfolioPageContent() {
  const searchParams = useSearchParams();
  const token = String(searchParams.get("token") || "").trim();

  const payload = useMemo(() => resolvePayloadFromToken(token), [token]);

  if (!payload) {
    return <EmptySnapshot />;
  }

  return <SnapshotView payload={payload} />;
}

export default function SharedPortfolioPage() {
  return (
    <Suspense fallback={null}>
      <SharedPortfolioPageContent />
    </Suspense>
  );
}
