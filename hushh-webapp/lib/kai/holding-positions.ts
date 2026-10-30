import type { Holding } from "@/components/kai/types/portfolio";

export type HoldingPosition<T extends Holding = Holding> = T & {
  client_id: string;
  entries: T[];
  pending_delete: boolean;
  price_unavailable: boolean;
};

function number(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const text = (value: unknown) => String(value ?? "").trim().toUpperCase();

/** Identity fences belong to the position; acquisition dates belong to entries. */
function identity(row: Holding, index: number): string {
  const symbol = text(row.symbol);
  const security = row.symbol_cusip || row.security_id ||
    (symbol && row.identifier_type !== "derived" ? symbol : `unknown:${row.entry_id ?? index}`);
  const kind = text(row.instrument_kind || row.asset_type || row.asset_class);
  const instrument = ["", "STOCK", "STOCKS", "EQUITY", "EQUITIES", "COMMON STOCK"].includes(kind) ? "EQUITY" : kind;
  return JSON.stringify([security, text(row.source_type) || "STATEMENT", row.source_id ?? "", row.account_id ?? row.persistent_account_id ?? "",
    text(row.currency || row.iso_currency_code) || "USD", instrument,
    row.position_side || (row.is_short || row.is_short_position ? "short" : row.is_liability_position ? "liability" : "long"),
    Boolean(row.is_cash_equivalent)]);
}

/** An unambiguous existing position supplies identity, never quantity or cost. */
export function inheritHoldingIdentity(entry: Holding, rows: readonly Holding[]): Holding {
  const fences = ["account_id", "persistent_account_id", "source_id", "source_type", "currency", "iso_currency_code", "position_side", "instrument_kind"] as const;
  const matches = groupHoldingPositions(rows.filter(row => text(row.symbol) === text(entry.symbol) &&
    fences.every(field => entry[field] === undefined || text(row[field]) === text(entry[field]))));
  if (matches.length !== 1) return entry;
  const source = matches[0]!;
  const result = { ...entry };
  for (const key of ["security_id", "symbol_cusip", "account_id", "persistent_account_id", "source_id", "source_type",
    "currency", "iso_currency_code", "instrument_kind", "asset_type", "position_side"] as const) {
    if (result[key] === undefined && source[key] !== undefined) Object.assign(result, { [key]: source[key] });
  }
  return result;
}

/** The editor changes amounts; the selected entry still owns account/source identity. */
export function prepareHoldingEntryEdit(updated: Holding, seed: Holding | null | undefined, rows: readonly Holding[]): Holding {
  const changedSymbol = seed && text(seed.symbol) !== text(updated.symbol);
  return inheritHoldingIdentity({ ...seed, ...updated,
    ...(changedSymbol ? { security_id: undefined, symbol_cusip: undefined, identifier_type: "ticker" as const } : {}),
  }, rows);
}

/** Derived only: persisted holdings remain the original, independently editable entries. */
export function groupHoldingPositions<T extends Holding>(rows: readonly T[]): HoldingPosition<T>[] {
  const groups = new Map<string, T[]>();
  rows.forEach((row, index) => {
    const key = identity(row, index);
    const entries = groups.get(key) ?? [];
    entries.push(row);
    groups.set(key, entries);
  });
  return [...groups].map(([key, entries]) => {
    const active = entries.filter(row => !(row as T & { pending_delete?: boolean }).pending_delete);
    const first = active[0] ?? entries[0]!;
    const sum = (field: keyof Holding, complete: boolean) => {
      const values = active.map(row => number(row[field]));
      if (!active.length || (complete && values.some(value => value === undefined))) return undefined;
      return values.reduce<number>((total, value) => total + (value ?? 0), 0);
    };
    const quantity = sum("quantity", false) ?? 0;
    const marketValue = sum("market_value", false) ?? 0;
    const costBasis = sum("cost_basis", true);
    const gains = active.map(row => number(row.unrealized_gain_loss) ??
      (number(row.cost_basis) !== undefined && number(row.market_value) !== undefined
        ? Number(row.market_value) - Number(row.cost_basis) : undefined));
    const gain = active.length && gains.every(value => value !== undefined)
      ? gains.reduce<number>((total, value) => total + value!, 0) : undefined;
    const price = number(first.price);
    const sameQuote = active.length > 0 && price !== undefined && active.every(row =>
      number(row.price) === price && row.institution_price_as_of === first.institution_price_as_of);
    const income = sum("estimated_annual_income", true);
    return { ...first, client_id: `position:${key}`, entries, pending_delete: active.length === 0,
      quantity, market_value: marketValue, cost_basis: costBasis,
      unrealized_gain_loss: gain,
      unrealized_gain_loss_pct: gain !== undefined && costBasis !== undefined && costBasis !== 0 ? gain / costBasis * 100 : undefined,
      price: sameQuote ? price! : 0, price_unavailable: !sameQuote,
      estimated_annual_income: income, est_annual_income: income,
      est_yield: income !== undefined && marketValue > 0 ? income / marketValue * 100 : undefined,
    };
  });
}
