"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";

interface AllocationStripProps {
  readonly cashPct?: number;
  readonly equitiesPct?: number;
  readonly bondsPct?: number;
  readonly className?: string;
}

type Segment = {
  readonly label: string;
  readonly value: number;
  readonly className: string;
};

const clamp = (value: number) => Math.max(0, Math.min(100, value));

export function AllocationStrip({ cashPct, equitiesPct, bondsPct, className }: AllocationStripProps) {
  const { segments, totalValue } = useMemo(() => {
    const raw: Segment[] = [
      { label: "Equities", value: clamp(equitiesPct ?? 0), className: "bg-foreground" },
      { label: "Bonds", value: clamp(bondsPct ?? 0), className: "bg-[var(--brand-500)]" },
      { label: "Cash", value: clamp(cashPct ?? 0), className: "bg-muted-foreground/30" },
    ];

    const total = raw.reduce((sum, s) => sum + s.value, 0);
    
    return {
      segments: total > 0 
        ? raw.map(s => ({ ...s, value: (s.value / total) * 100 }))
        : [{ label: "Equities", value: 33.3, className: "bg-foreground" }, { label: "Bonds", value: 33.3, className: "bg-[var(--brand-500)]" }, { label: "Cash", value: 33.4, className: "bg-muted-foreground/30" }],
      totalValue: total
    };
  }, [bondsPct, cashPct, equitiesPct]);

  return (
    <div className={cn("space-y-3 rounded-xl border border-border/60 bg-card/70 p-4 shadow-sm", className)}>
      <div className="flex justify-between items-center">
        <h3 className="text-[11px] font-black uppercase tracking-[0.16em] text-muted-foreground">Allocation</h3>
        {totalValue === 0 && <span className="text-[10px] text-amber-500 italic">No data available</span>}
      </div>
      
      <div 
        className="h-3 w-full overflow-hidden rounded-full bg-muted flex border border-border/20"
        role="progressbar"
        aria-label="Portfolio Allocation"
        aria-valuemin={0}
        aria-valuemax={100}
      >
        {segments.map((s) => (
          <div
            key={s.label}
            className={cn(s.className, "transition-all duration-700 ease-in-out hover:opacity-80 cursor-pointer")}
            style={{ width: `${s.value}%` }}
            aria-valuenow={s.value}
            title={`${s.label}: ${s.value.toFixed(1)}%`}
          />
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {segments.map((s) => (
          <div key={s.label} className="flex items-center gap-1.5 truncate">
            <span className={cn("h-2 w-2 rounded-full ring-1 ring-background/20", s.className)} />
            <span className="truncate">
              {s.label} {s.value.toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}