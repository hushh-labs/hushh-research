export const PORTFOLIO_SHARE_SCHEMA_VERSION = 1;

export interface PortfolioShareHolding {
  symbol: string;
  name: string;
  value: number;
  weightPct: number;
  changeValue: number;
  changePct: number;
}

export interface PortfolioShareAllocationItem {
  label: string;
  value: number;
  pct: number;
}

export interface PortfolioSharePerformancePoint {
  label: string;
  value: number;
}

export interface PortfolioSharePayload {
  schemaVersion: number;
  generatedAt: string;
  portfolioValue: number;
  dailyChangeValue: number;
  dailyChangePct: number;
  topHoldings: PortfolioShareHolding[];
  allocationMix: PortfolioShareAllocationItem[];
  sectorAllocation: PortfolioShareAllocationItem[];
  performance: PortfolioSharePerformancePoint[];
}

function toFiniteNumber(value: unknown, fallback: number = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toShortText(value: unknown, fallback: string, maxLength: number): string {
  const normalized = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return fallback;
  return normalized.slice(0, maxLength);
}

function sanitizeHoldings(value: unknown): PortfolioShareHolding[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((item, index) => {
    const record = (item || {}) as Record<string, unknown>;
    return {
      symbol: toShortText(record.symbol, `H${index + 1}`, 12).toUpperCase(),
      name: toShortText(record.name, "Unnamed holding", 40),
      value: Math.max(0, toFiniteNumber(record.value)),
      weightPct: clamp(toFiniteNumber(record.weightPct), 0, 100),
      changeValue: toFiniteNumber(record.changeValue),
      changePct: clamp(toFiniteNumber(record.changePct), -100, 100),
    };
  });
}

function sanitizeAllocation(value: unknown): PortfolioShareAllocationItem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).map((item, index) => {
    const record = (item || {}) as Record<string, unknown>;
    return {
      label: toShortText(record.label, `Segment ${index + 1}`, 36),
      value: Math.max(0, toFiniteNumber(record.value)),
      pct: clamp(toFiniteNumber(record.pct), 0, 100),
    };
  });
}

function sanitizePerformance(value: unknown): PortfolioSharePerformancePoint[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).map((item, index) => {
    const record = (item || {}) as Record<string, unknown>;
    return {
      label: toShortText(record.label, `P${index + 1}`, 20),
      value: Math.max(0, toFiniteNumber(record.value)),
    };
  });
}

export function sanitizePortfolioSharePayload(input: unknown): PortfolioSharePayload {
  const record = (input || {}) as Record<string, unknown>;
  const generatedAtRaw = toShortText(record.generatedAt, "", 40);
  const generatedAt = generatedAtRaw || new Date().toISOString();

  return {
    schemaVersion: PORTFOLIO_SHARE_SCHEMA_VERSION,
    generatedAt,
    portfolioValue: Math.max(0, toFiniteNumber(record.portfolioValue)),
    dailyChangeValue: toFiniteNumber(record.dailyChangeValue),
    dailyChangePct: clamp(toFiniteNumber(record.dailyChangePct), -100, 100),
    topHoldings: sanitizeHoldings(record.topHoldings),
    allocationMix: sanitizeAllocation(record.allocationMix),
    sectorAllocation: sanitizeAllocation(record.sectorAllocation),
    performance: sanitizePerformance(record.performance),
  };
}
