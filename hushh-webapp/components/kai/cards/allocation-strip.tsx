"use client";

import { useMemo } from "react";

interface AllocationStripProps {
  cashPct?: number;
  equitiesPct?: number;
  bondsPct?: number;
}

type Segment = {
  label: string;
  value: number;
  className: string;
};

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function normalizeSegments(raw: Segment[]): Segment[] {
  const total = raw.reduce((sum, segment) => sum + segment.value, 0);
  if (total <= 0) return [];
  return raw.map((segment) => ({
    ...segment,
    value: (segment.value / total) * 100,
  }));
}

export function AllocationStrip({ cashPct, equitiesPct, bondsPct }: AllocationStripProps) {
  const segments = useMemo(() => {
    const raw: Segment[] = [
      {
        label: "Equities",
        value: clamp(equitiesPct ?? 0),
        className: "bg-foreground",
      },
      {
        label: "Bonds",
        value: clamp(bondsPct ?? 0),
        className: "bg-[var(--brand-500)]",
      },
      {
        label: "Cash",
        value: clamp(cashPct ?? 0),
        className: "bg-muted-foreground/30",
      },
    ];

    const normalized = normalizeSegments(raw);
    if (normalized.length > 0) return normalized;

    return [
      { label: "Equities", value: 42, className: "bg-foreground" },
      { label: "Bonds", value: 28, className: "bg-[var(--brand-500)]" },
      { label: "Cash", value: 30, className: "bg-muted-foreground/30" },
    ];
  }, [bondsPct, cashPct, equitiesPct]);

  return (
    <div className="space-y-2 rounded-xl border border-border/60 bg-card/70 p-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Allocation</h3>
      <div className="h-3 w-full overflow-hidden rounded-full bg-muted">
        <div className="flex h-full w-full">
          {segments.map((segment) => (
            <div
              key={segment.label}
              className={segment.className}
              style={{ width: `${segment.value}%` }}
            />
          ))}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {segments.map((segment) => (
          <div key={segment.label} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${segment.className}`} />
            <span>
              {segment.label} {segment.value.toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
