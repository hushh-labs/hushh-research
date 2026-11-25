/** Minor-unit money helpers for the Receipts screens. Amounts never sum as floats. */

const EXPONENT: Readonly<Record<string, number>> = {
  INR: 2, USD: 2, EUR: 2, GBP: 2, AED: 2, SGD: 2, AUD: 2, CAD: 2, JPY: 0,
};

export function currencyExponent(currency: string | null | undefined): number | null {
  const code = String(currency || "").trim().toUpperCase();
  return Object.hasOwn(EXPONENT, code) ? EXPONENT[code]! : null;
}

/** Whole minor units, or null when the amount or currency is unknown. Unknown stays unknown. */
export function toMinor(amount: number | null | undefined, currency: string | null | undefined): number | null {
  const exponent = currencyExponent(currency);
  if (exponent === null || typeof amount !== "number" || !Number.isFinite(amount)) return null;
  return Math.round(amount * 10 ** exponent);
}

export function formatMinor(minor: number, currency: string): string {
  const code = currency.trim().toUpperCase();
  const exponent = currencyExponent(code) ?? 2;
  const major = minor / 10 ** exponent;
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: code,
      minimumFractionDigits: Number.isInteger(major) ? 0 : exponent,
      maximumFractionDigits: exponent,
    }).format(major);
  } catch {
    return `${major.toFixed(exponent)} ${code}`;
  }
}

export function formatMajorCompact(amount: number | null | undefined, currency: string | null | undefined): string | null {
  const minor = toMinor(amount, currency);
  return minor === null ? null : formatMinor(minor, String(currency));
}
