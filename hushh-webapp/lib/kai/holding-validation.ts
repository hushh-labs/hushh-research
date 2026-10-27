import type { Holding } from "@/components/kai/types/portfolio";

export type HoldingValidationField = "symbol" | "name" | "quantity" | "price" | "market_value" | "cost_basis" | "acquisition_date";
export type HoldingValidationIssue = { field: HoldingValidationField; message: string };

/** Preserve statement cash/sweep compatibility without inventing shares or a price. */
export function isCashEquivalentHolding(holding: Holding): boolean {
  if (holding.is_cash_equivalent === true) return true;
  if (["CASH", "MMF", "SWEEP", "QACDS"].includes(String(holding.symbol || "").trim().toUpperCase())) return true;
  const kind = String(holding.asset_type || "").toLowerCase();
  const name = String(holding.name || "").toLowerCase();
  return ["cash", "money market", "sweep"].some(value => kind.includes(value) || name.includes(value));
}

export function holdingValueIssue(holding: Holding): HoldingValidationIssue | null {
  const value = Number(holding.market_value);
  if (isCashEquivalentHolding(holding)) {
    return Number.isFinite(value) && value !== 0 ? null : { field: "market_value", message: "Enter a cash balance other than $0." };
  }
  const quantity = Number(holding.quantity);
  if (!Number.isFinite(quantity) || quantity === 0) return { field: "quantity", message: "Enter a quantity other than 0." };
  const price = Number(holding.price);
  if (!Number.isFinite(price) || price <= 0) return { field: "price", message: "Enter a price above $0." };
  // A stock's value is calculated in the editor; its price is the correction point.
  if (!Number.isFinite(value) || value === 0) return { field: "price", message: "Check the price to update this holding’s market value." };
  return null;
}

export function withHoldingValues(holding: Holding): Holding {
  const market_value = isCashEquivalentHolding(holding) ? Number(holding.market_value) : Number(holding.quantity) * Number(holding.price);
  const cost = holding.cost_basis;
  const unrealized_gain_loss = cost !== undefined && Number.isFinite(cost) && cost >= 0 ? market_value - cost : undefined;
  return { ...holding, market_value, unrealized_gain_loss,
    unrealized_gain_loss_pct: unrealized_gain_loss !== undefined && cost ? unrealized_gain_loss / cost * 100 : undefined };
}

export function findHoldingValidationIssue<T extends Holding & { pending_delete?: boolean }>(holdings: readonly T[]) {
  for (let index = 0; index < holdings.length; index++) {
    const holding = holdings[index]!;
    const issue = !holding.pending_delete && holdingValueIssue(holding);
    if (issue) return { holding, index, issue };
  }
  return null;
}

export function holdingEditorErrors(holding: Holding, maxDate: string): Partial<Record<HoldingValidationField, string>> {
  const errors: Partial<Record<HoldingValidationField, string>> = {};
  if (!holding.symbol.trim()) errors.symbol = "Enter a stock symbol.";
  else if (!/^[A-Z0-9]{1,5}(?:[.-][A-Z0-9]{1,3})?$/.test(holding.symbol.toUpperCase())) errors.symbol = "Enter a valid stock symbol.";
  if (!holding.name.trim()) errors.name = "Enter the company name.";
  const numeric = holdingValueIssue(holding);
  if (numeric) errors[numeric.field] = numeric.message;
  if (holding.cost_basis !== undefined && (!Number.isFinite(Number(holding.cost_basis)) || Number(holding.cost_basis) < 0)) errors.cost_basis = "Cost basis cannot be negative.";
  const date = String(holding.acquisition_date || "").trim();
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.acquisition_date = "Enter a valid date";
  else if (date && date > maxDate) errors.acquisition_date = "Acquisition date cannot be in the future";
  return errors;
}
