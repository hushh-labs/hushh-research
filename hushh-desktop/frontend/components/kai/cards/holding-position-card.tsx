"use client";

import { BarChart3, Pencil, Trash2 } from "lucide-react";

import { Button } from "@/lib/morphy-ux/button";
import { Card, CardContent } from "@/lib/morphy-ux/card";
import { Icon } from "@/lib/morphy-ux/ui";

export interface HoldingPosition {
  symbol: string;
  name: string;
  quantity: number;
  price: number;
  marketValue: number;
  gainLossValue: number;
  gainLossPct: number;
}

interface HoldingPositionCardProps {
  holding: HoldingPosition;
  onAnalyze: (symbol: string) => void;
  onManage: (symbol: string, action: "edit" | "delete") => void;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function tickerFallback(symbol: string): string {
  return symbol.trim().slice(0, 3).toUpperCase() || "KAI";
}

export function HoldingPositionCard({ holding, onAnalyze, onManage }: HoldingPositionCardProps) {
  const positive = holding.gainLossValue >= 0;

  return (
    <Card variant="none" effect="glass" preset="default" showRipple>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-muted text-xs font-semibold text-foreground">
              {tickerFallback(holding.symbol)}
            </div>
            <div>
              <h4 className="text-sm font-semibold leading-tight">{holding.name}</h4>
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                {holding.symbol}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="none"
              effect="fade"
              size="icon-sm"
              aria-label={`Edit ${holding.symbol}`}
              onClick={() => onManage(holding.symbol, "edit")}
            >
              <Icon icon={Pencil} size="sm" />
            </Button>
            <Button
              variant="none"
              effect="fade"
              size="icon-sm"
              aria-label={`Delete ${holding.symbol}`}
              onClick={() => onManage(holding.symbol, "delete")}
            >
              <Icon icon={Trash2} size="sm" className="text-red-500" />
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Shares @ Price</p>
            <p className="font-medium">
              {holding.quantity.toLocaleString()} @ {formatCurrency(holding.price)}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Market Value</p>
            <p className="font-semibold">{formatCurrency(holding.marketValue)}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Gain/Loss</p>
            <p className={positive ? "font-semibold text-emerald-600" : "font-semibold text-red-500"}>
              {positive ? "+" : "-"}
              {formatCurrency(Math.abs(holding.gainLossValue))} ({holding.gainLossPct >= 0 ? "+" : ""}
              {holding.gainLossPct.toFixed(2)}%)
            </p>
          </div>
          <div className="flex items-end justify-end">
            <Button
              variant="none"
              effect="fade"
              size="sm"
              onClick={() => onAnalyze(holding.symbol)}
            >
              <Icon icon={BarChart3} size="sm" className="mr-1.5" />
              Connect Kai
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
