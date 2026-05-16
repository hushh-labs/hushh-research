/**
 * Voice intent definitions for Indian stock market.
 *
 * These patterns are checked locally (no API call) before routing
 * a voice utterance to the indian_market command.
 */

// ---------------------------------------------------------------------------
// Spoken-name → NSE symbol map
// ---------------------------------------------------------------------------

export const SPOKEN_TO_SYMBOL: Record<string, string> = {
  reliance: 'RELIANCE.NS',
  ril: 'RELIANCE.NS',
  tcs: 'TCS.NS',
  'tata consultancy': 'TCS.NS',
  infosys: 'INFY.NS',
  infy: 'INFY.NS',
  'hdfc bank': 'HDFCBANK.NS',
  hdfcbank: 'HDFCBANK.NS',
  'icici bank': 'ICICIBANK.NS',
  icicibank: 'ICICIBANK.NS',
  sbi: 'SBIN.NS',
  'state bank': 'SBIN.NS',
  wipro: 'WIPRO.NS',
  itc: 'ITC.NS',
  'tata motors': 'TATAMOTORS.NS',
  tatamotors: 'TATAMOTORS.NS',
  'tata steel': 'TATASTEEL.NS',
  hcl: 'HCLTECH.NS',
  'hcl tech': 'HCLTECH.NS',
  'bajaj finance': 'BAJFINANCE.NS',
  'bajaj finserv': 'BAJAJFINSV.NS',
  airtel: 'BHARTIARTL.NS',
  'bharti airtel': 'BHARTIARTL.NS',
  kotak: 'KOTAKBANK.NS',
  'kotak bank': 'KOTAKBANK.NS',
  'l&t': 'LT.NS',
  larsen: 'LT.NS',
  'asian paints': 'ASIANPAINT.NS',
  'axis bank': 'AXISBANK.NS',
  maruti: 'MARUTI.NS',
  titan: 'TITAN.NS',
  'sun pharma': 'SUNPHARMA.NS',
  zomato: 'ZOMATO.NS',
  paytm: 'PAYTM.NS',
  nykaa: 'NYKAA.NS',
  ongc: 'ONGC.NS',
  ntpc: 'NTPC.NS',
  'power grid': 'POWERGRID.NS',
  'coal india': 'COALINDIA.NS',
  bpcl: 'BPCL.NS',
  'dr reddy': 'DRREDDY.NS',
  cipla: 'CIPLA.NS',
  'hero motocorp': 'HEROMOTOCO.NS',
  eicher: 'EICHERMOT.NS',
  'royal enfield': 'EICHERMOT.NS',
  mahindra: 'M&M.NS',
  irctc: 'IRCTC.NS',
  hal: 'HAL.NS',
  bel: 'BEL.NS',
  adani: 'ADANIENT.NS',
  'adani ports': 'ADANIPORTS.NS',
  lic: 'LICI.NS',
};

// ---------------------------------------------------------------------------
// Index name → display label
// ---------------------------------------------------------------------------

export const INDEX_DISPLAY_NAMES: Record<string, string> = {
  '^NSEI': 'Nifty 50',
  '^BSESN': 'Sensex',
  '^NSEBANK': 'Bank Nifty',
  '^NSEMDCP50': 'Nifty Midcap 50',
};

// ---------------------------------------------------------------------------
// Intent pattern phrases (for Kai planner context)
// ---------------------------------------------------------------------------

export const INDIAN_MARKET_INTENT_PATTERNS = [
  // Index queries
  /\bnifty\b/i,
  /\bsensex\b/i,
  /\bbank\s*nifty\b/i,
  // Exchange keywords
  /\bNSE\b/,
  /\bBSE\b/,
  /\bnse\s+stock/i,
  /\bbse\s+stock/i,
  // Common stock queries in Hinglish / English
  /\b(reliance|tcs|infosys|hdfc|sbi|wipro|itc|zomato)\b/i,
  /\bindian\s+(stock|market|equity|share)/i,
  /\b(share|stock)\s+price\s+india/i,
  // .NS/.BO symbol patterns
  /\.[Nn][Ss]\b/,
  /\.[Bb][Oo]\b/,
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a spoken stock name to its canonical NSE symbol.
 * Returns null if unrecognised (caller should pass the text through as-is).
 */
export function resolveIndianSymbol(utterance: string): string | null {
  const key = utterance.trim().toLowerCase();
  return SPOKEN_TO_SYMBOL[key] ?? null;
}

/**
 * Returns true if the utterance looks like an Indian market query
 * (fast local check, no API call).
 */
export function isIndianMarketIntent(utterance: string): boolean {
  return INDIAN_MARKET_INTENT_PATTERNS.some((pattern) => pattern.test(utterance));
}
