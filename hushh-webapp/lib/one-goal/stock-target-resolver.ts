"use client";

import {
  getTickerUniverseSnapshot,
  searchTickerUniverse,
  type TickerUniverseRow,
} from "@/lib/kai/ticker-universe-cache";

const TICKER_PATTERN = /\b([A-Z]{1,5}(?:\.[A-Z])?)(?:\b|$)/g;

const STOCK_ALIAS_TO_TICKER: Record<string, string> = {
  "advanced micro devices": "AMD",
  alphabet: "GOOGL",
  amazon: "AMZN",
  amd: "AMD",
  apple: "AAPL",
  berkshire: "BRK.B",
  "berkshire hathaway": "BRK.B",
  facebook: "META",
  google: "GOOGL",
  meta: "META",
  microsoft: "MSFT",
  netflix: "NFLX",
  nvidia: "NVDA",
  tesla: "TSLA",
  uber: "UBER",
  visa: "V",
};

const ANALYZE_TARGET_PATTERNS = [
  /\b(?:analyze|analyse|research|evaluate|analyzing)\s+(?<target>[A-Za-z0-9 .&()/-]{1,90})/i,
  /\b(?:start|run|begin|launch|open|kick\s+off|do)\s+(?:a\s+|an\s+|the\s+)?(?:stock\s+)?(?:analysis|debate|deep\s+dive)\s+(?:of|for|on|about)?\s*(?<target>[A-Za-z0-9 .&()/-]{1,90})/i,
  /\b(?:analysis|debate|deep\s+dive)\s+(?:of|for|on|about)\s+(?<target>[A-Za-z0-9 .&()/-]{1,90})/i,
];

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeTicker(value: unknown): string | null {
  const raw = readString(value);
  if (!raw) return null;
  const match = raw.toUpperCase().match(/\b([A-Z]{1,5}(?:\.[A-Z])?)(?:\b|$)/);
  return match?.[1] ?? null;
}

function normalizeCompanyLookupKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[&/,+()]/g, " ")
    .replace(/[^a-z0-9.\- ]+/g, " ")
    .replace(
      /\b(?:incorporated|inc|corp|corporation|co|company|holdings|holding|limited|ltd|plc|class a|class b|common stock)\b/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeStockTarget(raw: string): string {
  const withoutPossessive = raw.replace(/[’']s\b/gi, "");
  const beforeTrailingInstructions = withoutPossessive.split(
    /\b(?:and then|then|using|with|for me|please|right now|now|today|thanks|thank you)\b/i,
    1
  )[0] ?? withoutPossessive;
  return beforeTrailingInstructions
    .replace(/\(([^)]+)\)/g, " $1 ")
    .replace(
      /\b(?:stock|stocks|ticker|symbol|company|share|shares|analysis|debate|report|deep dive)\b/gi,
      " "
    )
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.,:;!?-]+|[.,:;!?-]+$/g, "");
}

function extractStockTarget(transcript: string): string {
  const normalized = transcript.replace(/^\s*please\b[\s,!?-]*/i, "");
  for (const pattern of ANALYZE_TARGET_PATTERNS) {
    const match = pattern.exec(normalized);
    const target = match?.groups?.target;
    if (target) return sanitizeStockTarget(target);
  }
  return sanitizeStockTarget(normalized);
}

/**
 * True when the transcript contains an explicit analyze/research/debate verb
 * pattern ("analyze Nvidia", "run a debate on TSLA"). This is INTENT
 * evidence. A ticker resolved without such a pattern (bare-transcript
 * fallback) is only a slot value: "Hi" uppercases into "HI", a real listed
 * ticker, and must never rank an analysis action by itself.
 */
export function hasExplicitAnalyzeIntent(transcript: string): boolean {
  const normalized = transcript.replace(/^\s*please\b[\s,!?-]*/i, "");
  return ANALYZE_TARGET_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Bare uppercase tokens are only trusted as ticker symbols when they exist in
 * the cached ticker universe. STT output like "YOUR" matches the 1-5 letter
 * ticker pattern but is not a listed security; without this membership gate a
 * misheard word starts a full analysis run against a nonexistent company.
 * When the universe has not loaded yet (null snapshot) we fall back to
 * accepting the token: the backend symbol-master gate rejects unknown tickers
 * before any run starts, so the failure mode is a clean refusal, not a fake
 * debate.
 */
function isKnownUniverseTicker(candidate: string): boolean {
  const rows = getTickerUniverseSnapshot();
  if (!rows?.length) return true;
  return rows.some((row) => row.ticker === candidate);
}

function tickerFromText(value: string, ignoredTokens: ReadonlySet<string>): string | null {
  for (const match of value.toUpperCase().matchAll(TICKER_PATTERN)) {
    const candidate = match[1];
    if (!candidate || ignoredTokens.has(candidate)) continue;
    if (!isKnownUniverseTicker(candidate)) continue;
    return candidate;
  }
  return null;
}

function titleKey(row: TickerUniverseRow): string {
  return normalizeCompanyLookupKey(String(row.title || ""));
}

function tickerFromUniverse(target: string): string | null {
  const rows = getTickerUniverseSnapshot();
  if (!rows?.length) return null;

  const key = normalizeCompanyLookupKey(target);
  const exactTicker = normalizeTicker(target);
  if (exactTicker && rows.some((row) => row.ticker === exactTicker)) {
    return exactTicker;
  }

  const exactTitleMatches = rows.filter((row) => titleKey(row) === key);
  const exactTitleTickers = Array.from(
    new Set(exactTitleMatches.map((row) => row.ticker).filter(Boolean))
  );
  if (exactTitleTickers.length === 1) return exactTitleTickers[0] ?? null;

  const matches = searchTickerUniverse(rows, target, 5);
  const titleMatches = matches.filter((row) => {
    const rowTitle = titleKey(row);
    return rowTitle === key || (key.length >= 4 && rowTitle.includes(key));
  });
  const tickers = Array.from(new Set(titleMatches.map((row) => row.ticker).filter(Boolean)));
  return tickers.length === 1 ? tickers[0] ?? null : null;
}

export function resolveStockTargetSymbol(input: {
  transcript: string;
  slots?: Record<string, unknown>;
  slot?: string;
  ignoredTokens?: ReadonlySet<string>;
}): string | null {
  const slot = input.slot || "symbol";
  const existing =
    normalizeTicker(input.slots?.[slot]) ||
    normalizeTicker(input.slots?.symbol) ||
    normalizeTicker(input.slots?.ticker);
  if (existing) return existing;

  const ignoredTokens = input.ignoredTokens ?? new Set<string>();
  const target = extractStockTarget(input.transcript);
  if (!target) return null;

  // Alias resolution runs BEFORE bare-token extraction: a spoken company name
  // like "Tesla" uppercases into a pattern-valid token ("TESLA") that is not
  // the real symbol. The alias map is the authoritative mapping for common
  // company names, so it must win over the raw-token heuristic.
  const key = normalizeCompanyLookupKey(target);
  const alias = STOCK_ALIAS_TO_TICKER[key] || STOCK_ALIAS_TO_TICKER[target.toLowerCase()];
  if (alias) return alias;

  const targetTicker = tickerFromText(target, ignoredTokens);
  if (targetTicker) return targetTicker;

  return tickerFromUniverse(target);
}
