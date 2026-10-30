/** Owner-set Drive request prices, stored as integer US cents. */
export const MIN_DOCUMENT_REQUEST_PRICE_CENTS = 50;
export const MAX_DOCUMENT_REQUEST_PRICE_CENTS = 50_000;
export const DEFAULT_DOCUMENT_REQUEST_PRICE_CENTS = 1000;
export const DOCUMENT_REQUEST_PRICE_PRESETS_CENTS = [1000, 2000, 3000] as const;

export function isValidDocumentRequestPriceCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= MIN_DOCUMENT_REQUEST_PRICE_CENTS && value <= MAX_DOCUMENT_REQUEST_PRICE_CENTS;
}

/** Shared answer requests retain their existing whole-dollar policy. */
export function isValidWholeDollarRequestPriceCents(value: unknown): value is number {
  return isValidDocumentRequestPriceCents(value) && value >= 100 && value % 100 === 0;
}

/** Parse decimal USD without floating point rounding or accepting sub-cent amounts. */
export function parseDocumentRequestPrice(input: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(input.trim().replace(/^\$\s*/, ""));
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return isValidDocumentRequestPriceCents(cents) ? cents : null;
}

export function parseWholeDollarPrice(input: string): number | null {
  const digits = input.trim().replace(/^\$\s*/, "");
  if (!/^\d{1,3}$/.test(digits)) return null;
  const cents = Number(digits) * 100;
  return isValidWholeDollarRequestPriceCents(cents) ? cents : null;
}

export function formatDocumentRequestPrice(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}
