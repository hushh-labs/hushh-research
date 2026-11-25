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

export function withHoldingValues(holding: Holding, observedMarketValue?: number): Holding {
  if (holding.market_value_unavailable && (observedMarketValue !== undefined || !holding.quantity || !holding.price)) {
    return holding;
  }
  const market_value = observedMarketValue ?? (isCashEquivalentHolding(holding)
    ? Number(holding.market_value) : Number(holding.quantity) * Number(holding.price));
  const cost = holding.cost_basis;
  const unrealized_gain_loss = cost !== undefined && Number.isFinite(cost) && cost >= 0 ? market_value - cost : undefined;
  return { ...holding, market_value, market_value_unavailable: undefined, unrealized_gain_loss,
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

/** Accept the editor’s displayed date and the ISO value returned by a native picker. */
export function normalizeHoldingAcquisitionDate(
  value: string | undefined,
  slashOrder: "day-first" | "month-first" = "day-first",
): string | undefined {
  const input = value?.trim() ?? "";
  const local = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(input);
  let iso = input;
  if (local) {
    const [, first, second, year] = local;
    const [day, month] = slashOrder === "day-first" ? [first!, second!] : [second!, first!];
    iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return undefined;
  const parsed = new Date(iso + "T00:00:00Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : undefined;
}

export function holdingEditorErrors(
  holding: Holding,
  maxDate: string,
  previouslySigned = false,
): Partial<Record<HoldingValidationField, string>> {
  const errors: Partial<Record<HoldingValidationField, string>> = {};
  if (!holding.symbol.trim()) errors.symbol = "Enter a stock symbol.";
  else if (!/^[A-Z0-9]{1,5}(?:[.-][A-Z0-9]{1,3})?$/.test(holding.symbol.toUpperCase())) errors.symbol = "Enter a valid stock symbol.";
  if (!holding.name.trim()) errors.name = "Enter the company name.";
  if (isCashEquivalentHolding(holding)) {
    const issue = holdingValueIssue(holding);
    if (issue) errors[issue.field] = issue.message;
  } else {
    const quantity = Number(holding.quantity);
    const price = Number(holding.price);
    const signedPosition = previouslySigned || holding.position_side === "short" || holding.position_side === "liability"
      || holding.is_short || holding.is_short_position || holding.is_liability_position;
    if (!Number.isFinite(quantity) || (signedPosition ? quantity === 0 : quantity <= 0)) {
      errors.quantity = signedPosition ? "Enter a quantity other than 0." : "Enter a quantity above 0.";
    }
    if (!Number.isFinite(price) || price <= 0) errors.price = "Enter a price above $0.";
    if (!errors.quantity && !errors.price) {
      const issue = holdingValueIssue(holding);
      if (issue) errors[issue.field] = issue.message;
    }
  }
  if (holding.cost_basis !== undefined && (!Number.isFinite(Number(holding.cost_basis)) || Number(holding.cost_basis) < 0)) errors.cost_basis = "Cost basis cannot be negative.";
  const date = normalizeHoldingAcquisitionDate(holding.acquisition_date);
  if (holding.acquisition_date?.trim() && !date) errors.acquisition_date = "Enter a valid date in DD/MM/YYYY format.";
  else if (date && date > maxDate) errors.acquisition_date = "Acquisition date cannot be in the future";
  return errors;
}
