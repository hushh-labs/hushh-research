import type {
  KaiStreamEnvelope, PortfolioImportExtractionFacts, PortfolioImportExtractionRow,
  PortfolioImportExtractionUpdate,
} from "@/lib/streaming/kai-stream-types";

const MAX_PREVIEW_ROWS = 1000;
const MAX_UNITS = 2048;

export interface ImportExtractionProgress {
  ownerId: string;
  streamId: string;
  resetSeq: number;
  units: Record<string, { index: number; rows: PortfolioImportExtractionRow[] }>;
  facts: PortfolioImportExtractionFacts;
  foundCount: number;
  retainedCount: number;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const integer = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value) && value > 0;
const text = (value: unknown) => typeof value === "string" ? value.slice(0, 512) : undefined;

function readFacts(value: unknown): PortfolioImportExtractionFacts | null {
  if (!object(value)) return null;
  const result: PortfolioImportExtractionFacts = {};
  if (object(value.statement_details)) {
    result.statement_details = {};
    for (const key of ["institution_name", "account_name", "account_number", "account_type", "statement_period_start", "statement_period_end", "currency"]) {
      const cell = text(value.statement_details[key]);
      if (cell !== undefined) result.statement_details[key] = cell;
    }
  }
  if (object(value.portfolio_summary)) {
    result.portfolio_summary = {};
    for (const key of ["beginning_value", "ending_value", "change_in_value", "net_deposits_withdrawals", "income", "fees", "declared_security_count"]) {
      const cell = value.portfolio_summary[key];
      if (finite(cell)) result.portfolio_summary[key] = cell;
    }
  }
  if (finite(value.cash_balance)) result.cash_balance = value.cash_balance;
  if (finite(value.total_value)) result.total_value = value.total_value;
  if (typeof value.currency === "string" && /^[A-Z]{3}$/.test(value.currency)) result.currency = value.currency;
  return result;
}

function readUpdate(value: unknown): PortfolioImportExtractionUpdate | null {
  if (!object(value) || value.version !== 1 || value.revision !== 1 ||
      typeof value.unit_id !== "string" || value.unit_id.length > 32 || !/^(csv|pdf):[1-9]\d*$/.test(value.unit_id) ||
      !integer(value.unit_index) || !integer(value.units_total) || value.unit_index > value.units_total ||
      !["csv", "pdf"].includes(String(value.source_kind)) ||
      !Array.isArray(value.rows) || value.rows.length > 2000) return null;
  const facts = readFacts(value.facts);
  if (!facts) return null;
  const rows: PortfolioImportExtractionRow[] = [];
  const ids = new Set<string>();
  for (const raw of value.rows) {
    if (!object(raw) || typeof raw.source_id !== "string" || raw.source_id.length > 64 || !/^(csv|pdf):\d+:[1-9]\d*$/.test(raw.source_id) || ids.has(raw.source_id)) return null;
    ids.add(raw.source_id);
    const row: PortfolioImportExtractionRow = { source_id: raw.source_id };
    for (const key of ["symbol", "ticker", "symbol_cusip", "cusip", "security_id", "name", "description", "currency"] as const) {
      const cell = text(raw[key]);
      if (cell !== undefined) row[key] = cell;
    }
    for (const key of ["quantity", "price", "market_value", "cost_basis", "unrealized_gain_loss"] as const) {
      if (raw[key] === null) row[key] = null;
      else if (finite(raw[key])) row[key] = raw[key];
      else if (raw[key] !== undefined) return null;
    }
    if (integer(raw.source_page)) row.source_page = raw.source_page;
    rows.push(row);
  }
  return { version: 1, revision: 1, unit_id: value.unit_id, unit_index: value.unit_index,
    units_total: value.units_total, source_kind: value.source_kind as "csv" | "pdf", rows, facts };
}

/** Memory-only state: deliberately excluded from StreamingState/session snapshots. */
export function applyExtractionProgress(
  previous: ImportExtractionProgress | null, envelope: KaiStreamEnvelope, ownerId: string,
): ImportExtractionProgress | null {
  if (!integer(envelope.seq)) return previous;
  if (envelope.stream_kind !== "portfolio_import" || envelope.event !== "progress" || envelope.terminal) return previous;
  if (previous && (previous.ownerId !== ownerId || previous.streamId !== envelope.stream_id)) return previous;
  const initial: ImportExtractionProgress = previous ?? {
    ownerId, streamId: envelope.stream_id, resetSeq: 0, units: {}, facts: {}, foundCount: 0, retainedCount: 0,
  };
  if (envelope.seq <= initial.resetSeq) return previous;
  if (envelope.payload.extraction_reset === true) return { ...initial, resetSeq: envelope.seq, units: {}, facts: {}, foundCount: 0, retainedCount: 0 };
  const update = readUpdate(envelope.payload.extraction_update);
  if (!update || Object.hasOwn(initial.units, update.unit_id) || Object.keys(initial.units).length >= MAX_UNITS) return previous;
  // Unit records commute; a ticker is never a source identity. Replay is a no-op.
  const remaining = Math.max(0, MAX_PREVIEW_ROWS - initial.retainedCount);
  const rows = update.rows.slice(0, remaining);
  const facts = {
    ...initial.facts, ...update.facts,
    statement_details: { ...initial.facts.statement_details, ...update.facts.statement_details },
    portfolio_summary: { ...initial.facts.portfolio_summary, ...update.facts.portfolio_summary },
  };
  return { ...initial, units: { ...initial.units, [update.unit_id]: { index: update.unit_index, rows } },
    facts, foundCount: initial.foundCount + update.rows.length, retainedCount: initial.retainedCount + rows.length };
}

export function extractionPreviewRows(state: ImportExtractionProgress): PortfolioImportExtractionRow[] {
  return Object.values(state.units).sort((a, b) => a.index - b.index).flatMap(unit => unit.rows);
}

export function formatImportNumber(value: number | null | undefined, currency?: string | null): string | null {
  if (!finite(value)) return null;
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    return value.toLocaleString("en-US", { style: "currency", currency, maximumFractionDigits: 2 });
  }
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}
