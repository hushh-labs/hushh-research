export function formatCurrency(value: number | null | undefined, currency = "USD"): string {
  if (typeof value !== "number" || !Number.isFinite(value))
    return "Price unavailable";
  const code = /^[a-z]{3}$/i.test(currency) ? currency.toUpperCase() : "USD";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: code,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatCompactNumber(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "N/A";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

