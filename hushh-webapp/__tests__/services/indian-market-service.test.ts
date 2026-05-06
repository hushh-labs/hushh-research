import { describe, expect, it } from 'vitest';

import {
  formatINR,
  formatINRCompact,
  getExchangeLabel,
} from '@/lib/services/indian-market-service';
import { isIndianMarketIntent, resolveIndianSymbol } from '@/lib/voice/indian-market-intents';

// ---------------------------------------------------------------------------
// INR formatting
// ---------------------------------------------------------------------------

describe('formatINR', () => {
  it('formats integer with Indian lakh notation', () => {
    expect(formatINR(1234567)).toBe('₹12,34,567.00');
  });

  it('formats small amount', () => {
    expect(formatINR(1000)).toBe('₹1,000.00');
  });

  it('returns ₹— for null', () => {
    expect(formatINR(null)).toBe('₹—');
  });

  it('returns ₹— for undefined', () => {
    expect(formatINR(undefined)).toBe('₹—');
  });

  it('returns ₹— for NaN', () => {
    expect(formatINR(NaN)).toBe('₹—');
  });

  it('respects decimals param', () => {
    expect(formatINR(100, 0)).toBe('₹100');
  });
});

describe('formatINRCompact', () => {
  it('formats crore amounts', () => {
    const result = formatINRCompact(150000000); // 15 Cr
    expect(result).toContain('Cr');
  });

  it('formats lakh amounts', () => {
    const result = formatINRCompact(1500000); // 15 L
    expect(result).toContain('L');
  });

  it('formats small amounts without suffix', () => {
    const result = formatINRCompact(5000);
    expect(result).toMatch(/^₹/);
    expect(result).not.toContain('Cr');
    expect(result).not.toContain('L');
  });
});

// ---------------------------------------------------------------------------
// Exchange label
// ---------------------------------------------------------------------------

describe('getExchangeLabel', () => {
  it('returns NSE for .NS symbol', () => {
    expect(getExchangeLabel('RELIANCE.NS')).toBe('NSE');
  });

  it('returns BSE for .BO symbol', () => {
    expect(getExchangeLabel('RELIANCE.BO')).toBe('BSE');
  });

  it('returns US for plain US-style ticker', () => {
    expect(getExchangeLabel('AAPL')).toBe('US');
  });

  it('returns NSE for index symbol', () => {
    expect(getExchangeLabel('^NSEI')).toBe('NSE');
  });

  it('is case-insensitive', () => {
    expect(getExchangeLabel('tcs.ns')).toBe('NSE');
  });
});

// ---------------------------------------------------------------------------
// Voice intent — resolveIndianSymbol
// ---------------------------------------------------------------------------

describe('resolveIndianSymbol', () => {
  it('resolves reliance to RELIANCE.NS', () => {
    expect(resolveIndianSymbol('reliance')).toBe('RELIANCE.NS');
  });

  it('resolves ril to RELIANCE.NS', () => {
    expect(resolveIndianSymbol('ril')).toBe('RELIANCE.NS');
  });

  it('resolves tcs to TCS.NS', () => {
    expect(resolveIndianSymbol('tcs')).toBe('TCS.NS');
  });

  it('resolves hdfc bank to HDFCBANK.NS', () => {
    expect(resolveIndianSymbol('hdfc bank')).toBe('HDFCBANK.NS');
  });

  it('returns null for unknown name', () => {
    expect(resolveIndianSymbol('microsoft')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Voice intent — isIndianMarketIntent
// ---------------------------------------------------------------------------

describe('isIndianMarketIntent', () => {
  it('detects nifty', () => {
    expect(isIndianMarketIntent('show me nifty')).toBe(true);
  });

  it('detects sensex', () => {
    expect(isIndianMarketIntent('how is sensex today')).toBe(true);
  });

  it('detects .NS ticker pattern', () => {
    expect(isIndianMarketIntent('RELIANCE.NS')).toBe(true);
  });

  it('detects indian stock keywords', () => {
    expect(isIndianMarketIntent('Indian stock market update')).toBe(true);
  });

  it('does not match unrelated query', () => {
    expect(isIndianMarketIntent('show my portfolio balance')).toBe(false);
  });
});
