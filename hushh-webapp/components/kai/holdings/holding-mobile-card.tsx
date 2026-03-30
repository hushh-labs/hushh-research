"use client";

import { useEffect, useState, type CSSProperties } from "react";

import { cn } from "@/lib/utils";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatShares(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function formatSignedPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "N/A";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

function formatSignedCurrency(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "N/A";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${formatCurrency(Math.abs(value))}`;
}

function hashText(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function getHoldingMarkerGlyph(symbol: string, isCash: boolean): string {
  if (isCash) return "$";
  const cleaned = symbol.replace(/[^a-z0-9]/gi, "").toUpperCase();
  return cleaned.length > 0 ? cleaned.charAt(0) : "•";
}

function getHoldingLogoUrl({
  symbol,
  name,
  isCash,
}: {
  symbol: string;
  name: string;
  isCash: boolean;
}): string | null {
  if (isCash) {
    if (/chase/i.test(name)) return "https://financialmodelingprep.com/image-stock/JPM.png";
    return null;
  }
  const normalized = symbol.trim().toUpperCase();
  if (!normalized) return null;
  return `https://financialmodelingprep.com/image-stock/${encodeURIComponent(normalized)}.png`;
}

function getHoldingIconStyle(key: string, isCash: boolean): CSSProperties {
  const baseHue = isCash ? 145 : hashText(key || "holding") % 360;
  const accentHue = (baseHue + 38) % 360;
  return {
    background: `linear-gradient(140deg, hsla(${baseHue}, 60%, 30%, 0.95), hsla(${accentHue}, 66%, 22%, 0.95))`,
    borderColor: `hsla(${baseHue}, 68%, 60%, 0.28)`,
  };
}

export interface HoldingMobileCardViewModel {
  id: string;
  symbol: string;
  name: string;
  marketValue: number;
  shares: number;
  gainLossValue: number | null;
  gainLossPct: number | null;
  averagePrice: number | null;
  currentPrice: number | null;
  portfolioWeightPct: number;
  sector: string | null;
  isCash: boolean;
  pendingDelete: boolean;
}

interface HoldingMobileCardProps {
  holding: HoldingMobileCardViewModel;
  onOpen: () => void;
}

export function HoldingMobileCard({
  holding,
  onOpen,
}: HoldingMobileCardProps) {
  const gainLossTone =
    holding.gainLossPct === null
      ? "text-muted-foreground"
      : holding.gainLossPct > 0
      ? "text-emerald-600 dark:text-emerald-400"
      : holding.gainLossPct < 0
      ? "text-rose-600 dark:text-rose-400"
      : "text-muted-foreground";

  const averagePriceText =
    holding.averagePrice !== null ? formatCurrency(holding.averagePrice) : "N/A";
  const logoUrl = getHoldingLogoUrl({
    symbol: holding.symbol,
    name: holding.name,
    isCash: holding.isCash,
  });
  const [logoFailed, setLogoFailed] = useState(false);
  useEffect(() => {
    setLogoFailed(false);
  }, [logoUrl]);

  const iconStyle = getHoldingIconStyle(holding.symbol || holding.name, holding.isCash);
  const markerGlyph = getHoldingMarkerGlyph(holding.symbol, holding.isCash);

  return (
    <div
      className={cn(
        "rounded-xl border border-border/60 bg-background/70 px-2 py-1.5 shadow-[0_8px_24px_rgba(15,23,42,0.08)] sm:px-3 sm:py-2",
        holding.pendingDelete && "opacity-60"
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="min-h-0 w-full text-left outline-none transition-opacity hover:opacity-95 focus-visible:ring-2 focus-visible:ring-ring/60 rounded-lg p-0.5"
        aria-label={`Open holding details for ${holding.symbol}`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "inline-flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full border",
                logoUrl && !logoFailed
                  ? "border-white/25 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.35)]"
                  : "text-[9px] font-bold uppercase text-white/85 shadow-[inset_0_1px_1px_rgba(255,255,255,0.18)]",
                holding.pendingDelete && "line-through"
              )}
              style={logoUrl && !logoFailed ? undefined : iconStyle}
              aria-hidden="true"
            >
              {logoUrl && !logoFailed ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={logoUrl}
                  alt=""
                  className="h-3.5 w-3.5 object-contain"
                  loading="lazy"
                  decoding="async"
                  referrerPolicy="no-referrer"
                  onError={() => setLogoFailed(true)}
                />
              ) : (
                markerGlyph
              )}
            </span>

            <div className="min-w-0">
              <p
                className={cn(
                  "app-card-title truncate uppercase text-foreground",
                  holding.pendingDelete && "line-through"
                )}
                title={holding.symbol || "—"}
              >
                {holding.symbol || "—"}
              </p>
              <p
                className={cn(
                  "app-body-text truncate text-muted-foreground",
                  holding.pendingDelete && "line-through"
                )}
                title={holding.name || "Unnamed security"}
              >
                {holding.name || "Unnamed security"}
              </p>
              <p
                className={cn(
                  "app-label-text mt-0.5 truncate text-muted-foreground",
                  holding.pendingDelete && "line-through"
                )}
              >
                {formatShares(holding.shares)} shares · avg {averagePriceText}
              </p>
            </div>
          </div>

          <div className="w-[8.9rem] shrink-0 text-right tabular-nums sm:w-[9.25rem]">
            <p
              className={cn(
                "app-card-title text-foreground",
                holding.pendingDelete && "line-through"
              )}
            >
              {formatCurrency(holding.marketValue)}
            </p>
            <p className={cn("app-feature-point", gainLossTone, holding.pendingDelete && "line-through")}>
              {formatSignedCurrency(holding.gainLossValue)}
              {holding.gainLossPct !== null ? ` · ${formatSignedPercent(holding.gainLossPct)}` : ""}
            </p>
          </div>
        </div>
      </button>
    </div>
  );
}
