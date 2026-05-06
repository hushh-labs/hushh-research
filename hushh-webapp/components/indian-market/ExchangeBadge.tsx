'use client';

import React from 'react';

export type ExchangeType = 'NSE' | 'BSE' | 'US' | 'UNKNOWN';

interface ExchangeBadgeProps {
  exchange: ExchangeType | string;
  className?: string;
  size?: 'xs' | 'sm' | 'md';
}

const EXCHANGE_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  NSE: { bg: 'bg-blue-600/20', text: 'text-blue-400', label: 'NSE' },
  BSE: { bg: 'bg-orange-500/20', text: 'text-orange-400', label: 'BSE' },
  US: { bg: 'bg-emerald-600/20', text: 'text-emerald-400', label: 'US' },
  UNKNOWN: { bg: 'bg-zinc-700/30', text: 'text-zinc-400', label: '—' },
};

const SIZE_STYLES = {
  xs: 'text-[9px] px-1 py-0.5 rounded',
  sm: 'text-[10px] px-1.5 py-0.5 rounded',
  md: 'text-xs px-2 py-0.5 rounded-md',
};

export function ExchangeBadge({ exchange, className = '', size = 'sm' }: ExchangeBadgeProps) {
  const key = (exchange || 'UNKNOWN').toUpperCase();
  const style = EXCHANGE_STYLES[key] ?? EXCHANGE_STYLES['UNKNOWN']!;

  return (
    <span
      className={`inline-flex items-center font-semibold tracking-wide border border-transparent
        ${style.bg} ${style.text} ${SIZE_STYLES[size]} ${className}`}
      aria-label={`Exchange: ${style.label}`}
    >
      {style.label}
    </span>
  );
}
