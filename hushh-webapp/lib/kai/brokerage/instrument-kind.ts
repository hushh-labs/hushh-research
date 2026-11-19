import type { Holding } from "@/components/kai/types/portfolio";

export type HoldingInstrumentKind =
  | "equity"
  | "fixed_income"
  | "real_asset"
  | "cash_equivalent"
  | "other";

const INSTRUMENT_KINDS = new Set<string>([
  "equity", "fixed_income", "real_asset", "cash_equivalent",
]);

const CASH_IDENTIFIERS = new Set(["CASH", "SWEEP", "MMF", "QACDS"]);

const ASSET_TYPE_KINDS: Readonly<Partial<Record<string, HoldingInstrumentKind>>> = {
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
export function normalizeHoldingInstrumentKind(holding: Pick<
  Holding,
  "instrument_kind" | "asset_type" | "asset_class" | "symbol" | "is_cash_equivalent"
  | "security_listing_status" | "symbol_kind" | "is_sec_common_equity_ticker"
>): HoldingInstrumentKind {
  if (holding.is_cash_equivalent === true) return "cash_equivalent";
  const kind = String(holding.instrument_kind || "").trim().toLowerCase();
  if (INSTRUMENT_KINDS.has(kind)) return kind as HoldingInstrumentKind;

  // A generic ETF/fund label does not declare its underlying asset category.
  const assetKey = String(holding.asset_type || holding.asset_class || "").trim().toLowerCase().replace(/[- ]/g, "_");
  const assetKind = Object.hasOwn(ASSET_TYPE_KINDS, assetKey) ? ASSET_TYPE_KINDS[assetKey] : undefined;
  if (assetKind) return assetKind;

  const status = String(holding.security_listing_status || "").trim().toLowerCase();
  const symbolKind = String(holding.symbol_kind || "").trim().toLowerCase();
  if (status === "cash_or_sweep" || CASH_IDENTIFIERS.has(String(holding.symbol || "").trim().toUpperCase())) return "cash_equivalent";
  if (status === "fixed_income") return "fixed_income";
  if (status === "non_sec_common_equity" || symbolKind === "fund_or_etf_ticker") return "other";
  if (status === "sec_common_equity" || symbolKind === "us_common_equity_ticker" || holding.is_sec_common_equity_ticker === true) return "equity";
  return "other";
}
