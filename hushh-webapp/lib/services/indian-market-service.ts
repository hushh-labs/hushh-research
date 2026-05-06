/**
 * Indian market data service — client-side wrapper around the backend
 * /kai/indian-market/* endpoints.
 *
 * All monetary values are in INR (Indian Rupee, ₹).
 */

export interface IndianQuote {
  symbol: string;
  name?: string;
  price?: number;
  previous_close?: number;
  change?: number;
  change_pct?: number;
  currency: string;
  exchange?: string;
  high_52w?: number;
  low_52w?: number;
  volume?: number;
  market_cap?: number;
  source: string;
  fetched_at?: number;
  error?: string;
  display_name?: string;
}

export interface IndianSearchResult {
  symbol: string;
  name: string;
  exchange: 'NSE' | 'BSE';
  sector?: string;
}

export interface IndianIndex extends IndianQuote {
  display_name: string;
}

export interface IndianPortfolioHolding {
  symbol: string;
  tradingsymbol?: string;
  exchange?: string;
  isin?: string;
  quantity?: number;
  average_price?: number;
  last_price?: number;
  pnl?: number;
  day_change?: number;
  day_change_pct?: number;
  currency: string;
  source: string;
}

export interface IndianMarketStatus {
  enabled: boolean;
  data_provider: string;
  broker_providers: {
    zerodha: { configured: boolean; missing: string[] };
    upstox: { configured: boolean; missing: string[] };
  };
}

// ---------------------------------------------------------------------------
// INR formatting utilities
// ---------------------------------------------------------------------------

/**
 * Format a number as Indian Rupees with lakh/crore notation.
 *
 * Examples:
 *   formatINR(1234567)     → "₹12,34,567.00"
 *   formatINR(150000000)   → "₹15,00,00,000.00"
 *   formatINR(null)        → "₹—"
 */
export function formatINR(amount: number | null | undefined, decimals = 2): string {
  if (amount === null || amount === undefined || isNaN(amount)) return '₹—';
  const formatted = amount.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `₹${formatted}`;
}

/**
 * Format large INR amounts with suffix (L = lakh, Cr = crore).
 *
 * Examples:
 *   formatINRCompact(1500000)   → "₹15L"
 *   formatINRCompact(15000000000) → "₹1,500Cr"
 */
export function formatINRCompact(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || isNaN(amount)) return '₹—';
  if (Math.abs(amount) >= 1e7) {
    return `₹${(amount / 1e7).toLocaleString('en-IN', { maximumFractionDigits: 1 })}Cr`;
  }
  if (Math.abs(amount) >= 1e5) {
    return `₹${(amount / 1e5).toLocaleString('en-IN', { maximumFractionDigits: 1 })}L`;
  }
  return formatINR(amount);
}

// ---------------------------------------------------------------------------
// Exchange badge helper
// ---------------------------------------------------------------------------

export type ExchangeLabel = 'NSE' | 'BSE' | 'US' | 'UNKNOWN';

export function getExchangeLabel(symbol: string): ExchangeLabel {
  const s = (symbol || '').toUpperCase();
  if (s.endsWith('.NS')) return 'NSE';
  if (s.endsWith('.BO')) return 'BSE';
  if (/^[\^]/.test(s)) return 'NSE'; // Index
  if (/^[A-Z]{1,5}$/.test(s)) return 'US';
  return 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

const BASE_PATH = '/api/kai/indian-market';

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_PATH}${path}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`[IndianMarket] ${res.status} ${path}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function getIndianMarketStatus(): Promise<IndianMarketStatus> {
  return apiFetch<IndianMarketStatus>('/status');
}

export async function getIndianQuote(symbol: string): Promise<IndianQuote> {
  return apiFetch<IndianQuote>(`/quote/${encodeURIComponent(symbol)}`);
}

export async function searchIndianSymbols(
  query: string,
  limit = 10,
): Promise<{ results: IndianSearchResult[]; count: number; query: string }> {
  return apiFetch(`/search?q=${encodeURIComponent(query)}&limit=${limit}`);
}

export async function getIndianIndices(): Promise<{
  indices: IndianIndex[];
  count: number;
}> {
  return apiFetch('/indices');
}

export async function getIndianPortfolio(
  broker: 'zerodha' | 'upstox' = 'zerodha',
): Promise<{ holdings: IndianPortfolioHolding[]; count: number; broker: string }> {
  return apiFetch(`/portfolio?broker=${broker}`);
}
