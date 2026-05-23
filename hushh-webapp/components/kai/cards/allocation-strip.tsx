"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils"; // Assuming you have this utility

interface AllocationStripProps {
  cashPct?: number;
  equitiesPct?: number;
  bondsPct?: number;
  className?: string;
}

type Segment = {
  label: string;
  value: number;
  className: string;
};

const clamp = (value: number) => Math.max(0, Math.min(100, value));

export function AllocationStrip({ cashPct, equitiesPct, bondsPct, className }: AllocationStripProps) {
  const segments = useMemo(() => {
    const raw = [
      { label: "Equities", value: clamp(equitiesPct ?? 0), className: "bg-foreground" },
      { label: "Bonds", value: clamp(bondsPct ?? 0), className: "bg-[var(--brand-500)]" },
      { label: "Cash", value: clamp(cashPct ?? 0), className: "bg-muted-foreground/30" },
    ];

    const total = raw.reduce((sum, s) => sum + s.value, 0);
    
    // Normalize if total > 0, otherwise use balanced defaults
    return total > 0 
      ? raw.map(s => ({ ...s, value: (s.value / total) * 100 }))
      : [
          { label: "Equities", value: 42, className: "bg-foreground" },
          { label: "Bonds", value: 28, className: "bg-[var(--brand-500)]" },
          { label: "Cash", value: 30, className: "bg-muted-foreground/30" },
        ];
  }, [bondsPct, cashPct, equitiesPct]);

  return (
    <div className={cn("space-y-3 rounded-xl border border-border/60 bg-card/70 p-4", className)}>
      <h3 className="text-[11px] font-black uppercase tracking-[0.16em] text-muted-foreground">Allocation</h3>
      
      {/* Progress Strip with Animation */}
      <div 
        className="h-3 w-full overflow-hidden rounded-full bg-muted flex"
        role="progressbar"
        aria-label="Portfolio Allocation"
      >
        {segments.map((s) => (
          <div
            key={s.label}
            className={cn(s.className, "transition-all duration-500 ease-out")}
            style={{ width: `${s.value}%` }}
            title={`${s.label}: ${s.value.toFixed(1)}%`}
          />
        ))}
      </div>

      {/* Legend */}
      <div className="grid grid-cols-3 gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {segments.map((s) => (
          <div key={s.label} className="flex items-center gap-1.5 truncate">
            <span className={cn("h-2 w-2 rounded-full", s.className)} />
            <span className="truncate">
              {s.label} {s.value.toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}