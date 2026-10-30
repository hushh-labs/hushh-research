export type LiveHoldingPositionSide = "long" | "short" | "liability";

export interface LiveHoldingPreview {
  symbol?: string;
  name?: string;
  market_value?: number | null;
  quantity?: number | null;
  asset_type?: string;
  position_side?: LiveHoldingPositionSide;
  is_short_position?: boolean;
  is_liability_position?: boolean;
}

const MAX_LIVE_PREVIEW_ABS_MARKET_VALUE = 1_000_000_000;
const MAX_LIVE_PREVIEW_ABS_QUANTITY = 1_000_000_000;

function cleanText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

function cleanBoundedFiniteNumber(value: unknown, maxAbs: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.abs(value) <= maxAbs ? value : null;
}

function normalizePreviewSymbol(value: unknown): string {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.\-]/g, "");
}

export function getLiveHoldingPositionSide(
  holding: LiveHoldingPreview
): LiveHoldingPositionSide {
  if (
    holding.position_side === "long" ||
    holding.position_side === "short" ||
    holding.position_side === "liability"
  ) {
    return holding.position_side;
  }
  if (holding.is_liability_position) return "liability";
  if (holding.is_short_position) return "short";
  if (
    typeof holding.quantity === "number" &&
    Number.isFinite(holding.quantity) &&
    holding.quantity < 0
  ) {
    return "short";
  }
  if (
    typeof holding.market_value === "number" &&
    Number.isFinite(holding.market_value) &&
    holding.market_value < 0
  ) {
    return "short";
  }
  return "long";
}

function normalizeLiveHoldingPreview(row: LiveHoldingPreview): LiveHoldingPreview | null {
  const symbol = normalizePreviewSymbol(row.symbol);
  if (!symbol) return null;
  const positionSide = getLiveHoldingPositionSide(row);
  return {
    symbol,
    name: cleanText(row.name),
    market_value: cleanBoundedFiniteNumber(
      row.market_value,
      MAX_LIVE_PREVIEW_ABS_MARKET_VALUE
    ),
    quantity: cleanBoundedFiniteNumber(row.quantity, MAX_LIVE_PREVIEW_ABS_QUANTITY),
    asset_type: cleanText(row.asset_type),
    position_side: positionSide,
    is_short_position: positionSide === "short",
    is_liability_position: positionSide === "liability",
  };
}

function preferLatestPreviewRow(
  existing: LiveHoldingPreview,
  incoming: LiveHoldingPreview
): LiveHoldingPreview {
  const side =
    incoming.position_side === "liability" || existing.position_side === "liability"
      ? "liability"
      : incoming.position_side === "short" || existing.position_side === "short"
        ? "short"
        : "long";
  return {
    symbol: incoming.symbol || existing.symbol,
    name: incoming.name || existing.name,
    market_value: incoming.market_value ?? existing.market_value ?? null,
    quantity: incoming.quantity ?? existing.quantity ?? null,
    asset_type: incoming.asset_type || existing.asset_type,
    position_side: side,
    is_short_position: side === "short",
    is_liability_position: side === "liability",
  };
}

export function normalizeLiveHoldingPreviewRows(
  rows: readonly LiveHoldingPreview[]
): LiveHoldingPreview[] {
  if (rows.length === 0) return [];
  const bySymbol = new Map<string, LiveHoldingPreview>();
  for (const row of rows) {
    const normalized = normalizeLiveHoldingPreview(row);
    if (!normalized?.symbol) continue;
    const existing = bySymbol.get(normalized.symbol);
    bySymbol.set(
      normalized.symbol,
      existing ? preferLatestPreviewRow(existing, normalized) : normalized
    );
  }
  return Array.from(bySymbol.values());
}

export function replaceLiveHoldingPreviewRows(
  current: LiveHoldingPreview[],
  incoming: readonly LiveHoldingPreview[]
): LiveHoldingPreview[] {
  if (incoming.length === 0) return current;
  const snapshot = normalizeLiveHoldingPreviewRows(incoming);
  return snapshot.length > 0 ? snapshot : current;
}
