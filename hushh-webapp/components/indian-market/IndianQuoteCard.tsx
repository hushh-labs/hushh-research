'use client';

import React from 'react';
import { TrendingDown, TrendingUp } from 'lucide-react';

import { formatINR, formatINRCompact, getExchangeLabel, type IndianQuote } from '@/lib/services/indian-market-service';
import { ExchangeBadge } from './ExchangeBadge';

interface IndianQuoteCardProps {
  quote: IndianQuote;
  compact?: boolean;
  className?: string;
}

export function IndianQuoteCard({ quote, compact = false, className = '' }: IndianQuoteCardProps) {
  const isPositive = (quote.change_pct ?? 0) >= 0;
  const exchangeLabel = getExchangeLabel(quote.symbol);

  return (
    <div
      className={`rounded-xl border border-zinc-800 bg-zinc-900/60 backdrop-blur-sm
        p-4 flex flex-col gap-2 hover:border-zinc-700 transition-colors ${className}`}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-mono text-sm font-semibold text-white truncate">
              {quote.symbol}
            </span>
            <ExchangeBadge exchange={exchangeLabel} size="xs" />
          </div>
          {quote.name && (
            <span className="text-xs text-zinc-400 truncate max-w-[180px]">{quote.name}</span>
          )}
        </div>

        {/* Price */}
        <div className="text-right shrink-0">
          <p className="text-base font-bold text-white tabular-nums">
            {quote.price != null ? formatINR(quote.price) : '₹—'}
          </p>
          {quote.change_pct != null && (
            <span
              className={`flex items-center justify-end gap-0.5 text-xs font-medium tabular-nums
                ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}
            >
              {isPositive ? (
                <TrendingUp className="w-3 h-3 shrink-0" />
              ) : (
                <TrendingDown className="w-3 h-3 shrink-0" />
              )}
              {isPositive ? '+' : ''}
              {quote.change_pct.toFixed(2)}%
            </span>
          )}
        </div>
      </div>

      {/* Detail row — hidden in compact mode */}
      {!compact && (
        <div className="grid grid-cols-3 gap-2 pt-1 border-t border-zinc-800/60 text-xs">
          <Stat label="Change" value={quote.change != null ? formatINR(quote.change) : '—'} />
          <Stat label="52W High" value={quote.high_52w != null ? formatINR(quote.high_52w) : '—'} />
          <Stat label="52W Low" value={quote.low_52w != null ? formatINR(quote.low_52w) : '—'} />
          {quote.volume != null && (
            <Stat label="Volume" value={quote.volume.toLocaleString('en-IN')} />
          )}
          {quote.market_cap != null && (
            <Stat label="Mkt Cap" value={formatINRCompact(quote.market_cap)} />
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-zinc-500 text-[10px] uppercase tracking-wide">{label}</span>
      <span className="text-zinc-200 font-medium tabular-nums">{value}</span>
    </div>
  );
}
