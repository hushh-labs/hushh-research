export type HoldingInstrumentKind =
  | "equity"
  | "fixed_income"
  | "real_asset"
  | "cash_equivalent"
  | "other";

const INSTRUMENT_KINDS = new Set<string>([
  "equity", "fixed_income", "real_asset", "cash_equivalent", "other",
]);

const ASSET_TYPE_KINDS: Readonly<Record<string, HoldingInstrumentKind>> = {
  equity: "equity", equities: "equity", stock: "equity", stocks: "equity",
  common_stock: "equity", preferred: "equity", preferred_stock: "equity", adr: "equity",
  fixed_income: "fixed_income", bond: "fixed_income", bonds: "fixed_income",
  treasury: "fixed_income", treasury_bill: "fixed_income", treasury_note: "fixed_income",
  treasury_bond: "fixed_income", municipal_bond: "fixed_income",
  certificate_of_deposit: "fixed_income", cd: "fixed_income",
  real_asset: "real_asset", real_assets: "real_asset", real_estate: "real_asset",
  reit: "real_asset", commodity: "real_asset", commodities: "real_asset", gold: "real_asset",
  cash: "cash_equivalent", cash_equivalent: "cash_equivalent",
  cash_equivalents: "cash_equivalent", money_market: "cash_equivalent",
  money_market_fund: "cash_equivalent", sweep: "cash_equivalent",
};

/** Normalize declared metadata without interpreting ticker or issuer-name fragments. */
export function normalizeHoldingInstrumentKind(
  instrumentKind: unknown,
  assetType: unknown,
): HoldingInstrumentKind | null {
  const kind = String(instrumentKind || "").trim().toLowerCase();
  if (INSTRUMENT_KINDS.has(kind)) return kind as HoldingInstrumentKind;
  if (kind) return "other";
  const assetKey = String(assetType || "").trim().toLowerCase().replace(/[- ]/g, "_");
  // A generic ETF/fund label does not declare its underlying asset category.
  return ASSET_TYPE_KINDS[assetKey] ?? null;
}
