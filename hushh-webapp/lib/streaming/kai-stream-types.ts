// `pod_lifecycle` is not a Kai stream, but it speaks this envelope on purpose:
// one canonical SSE contract product-wide. The literal is added HERE, not just
// tolerated at runtime, because `isKaiStreamEnvelope`'s guard is lenient
// (`typeof stream_kind === "string"`), so a frame the type forbids would pass
// the guard and then be typed as something it is not -- a type system that
// lies is worse than none.
export type KaiStreamKind =
  | "portfolio_import"
  | "portfolio_optimize"
  | "stock_analyze"
  | "pod_lifecycle";

export interface KaiStreamEnvelope<TPayload = Record<string, unknown>> {
  schema_version: "1.0";
  stream_id: string;
  stream_kind: KaiStreamKind;
  seq: number;
  event: string;
  terminal: boolean;
  payload: TPayload;
}

export interface ParsedSSEFrame {
  event: string;
  data: string;
  id?: string;
}

/** Optional v1 portfolio-import progress. A unit is immutable within a stream. */
export interface PortfolioImportExtractionRow {
  source_id: string;
  source_page?: number | null;
  symbol?: string | null;
  ticker?: string | null;
  symbol_cusip?: string | null;
  cusip?: string | null;
  security_id?: string | null;
  name?: string | null;
  description?: string | null;
  quantity?: number | null;
  price?: number | null;
  market_value?: number | null;
  cost_basis?: number | null;
  unrealized_gain_loss?: number | null;
  currency?: string | null;
}

export interface PortfolioImportExtractionFacts {
  statement_details?: Record<string, string | null>;
  portfolio_summary?: Record<string, number | null>;
  cash_balance?: number | null;
  total_value?: number | null;
  currency?: string | null;
}

export interface PortfolioImportExtractionUpdate {
  version: 1;
  revision: 1;
  unit_id: string;
  unit_index: number;
  units_total: number;
  source_kind: "csv" | "pdf";
  rows: PortfolioImportExtractionRow[];
  facts: PortfolioImportExtractionFacts;
}

export function isKaiStreamEnvelope(value: unknown): value is KaiStreamEnvelope {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.schema_version === "1.0" &&
    typeof record.stream_id === "string" &&
    typeof record.stream_kind === "string" &&
    typeof record.seq === "number" &&
    typeof record.event === "string" &&
    typeof record.terminal === "boolean" &&
    typeof record.payload === "object" &&
    record.payload !== null
  );
}
