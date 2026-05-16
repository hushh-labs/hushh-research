'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { TrendingDown, TrendingUp } from 'lucide-react';

import { formatINR, getIndianIndices, type IndianIndex } from '@/lib/services/indian-market-service';

const REFRESH_INTERVAL_MS = 60_000; // refresh every 60 s

export function IndianIndexBar({ className = '' }: { className?: string }) {
  const [indices, setIndices] = useState<IndianIndex[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const { indices: data } = await getIndianIndices();
      setIndices(data);
      setError(null);
    } catch (_err) {
      setError('Index data unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    timerRef.current = setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [load]);

  if (loading) {
    return (
      <div
        className={`flex items-center gap-4 px-4 py-2 rounded-lg bg-zinc-900/40 animate-pulse ${className}`}
      >
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-4 w-28 rounded bg-zinc-800" />
        ))}
      </div>
    );
  }

  if (error || indices.length === 0) {
    return null; // fail silently — don't break the page
  }

  return (
    <div
      role="region"
      aria-label="Indian market indices"
      className={`flex items-center gap-1 overflow-x-auto scrollbar-none
        rounded-xl border border-zinc-800/70 bg-zinc-900/50 backdrop-blur-sm
        px-3 py-2 ${className}`}
    >
      {indices.map((idx, i) => {
        const isPositive = (idx.change_pct ?? 0) >= 0;
        return (
          <React.Fragment key={idx.symbol}>
            {i > 0 && <span className="text-zinc-700 select-none mx-1">·</span>}
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-xs font-medium text-zinc-300 whitespace-nowrap">
                {idx.display_name ?? idx.symbol}
              </span>
              <span className="text-xs font-semibold text-white tabular-nums">
                {idx.price != null ? formatINR(idx.price, 0) : '—'}
              </span>
              {idx.change_pct != null && (
                <span
                  className={`flex items-center gap-0.5 text-[11px] font-medium tabular-nums
                    ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}
                >
                  {isPositive ? (
                    <TrendingUp className="w-3 h-3 shrink-0" />
                  ) : (
                    <TrendingDown className="w-3 h-3 shrink-0" />
                  )}
                  {isPositive ? '+' : ''}
                  {idx.change_pct.toFixed(2)}%
                </span>
              )}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}
