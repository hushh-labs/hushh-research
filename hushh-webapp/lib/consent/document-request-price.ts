/**
 * Owner-set price for a document request, in whole US dollars stored as cents.
 * The server enforces the same bounds (consent-protocol drive_owner_allowed.py).
 */
export const MIN_DOCUMENT_REQUEST_PRICE_CENTS = 100;
export const MAX_DOCUMENT_REQUEST_PRICE_CENTS = 50_000;
export const DEFAULT_DOCUMENT_REQUEST_PRICE_CENTS = 1000;
export const DOCUMENT_REQUEST_PRICE_PRESETS_CENTS = [1000, 2000, 3000] as const;

export function isValidDocumentRequestPriceCents(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_DOCUMENT_REQUEST_PRICE_CENTS &&
    value <= MAX_DOCUMENT_REQUEST_PRICE_CENTS &&
    value % 100 === 0
  );
}

/** "20" or "$20" to 2000; anything else, including cents or out-of-range values, to null. */
export function parseWholeDollarPrice(input: string): number | null {
  const digits = input.trim().replace(/^\$\s*/, "");
  if (!/^\d{1,3}$/.test(digits)) return null;
  const cents = Number(digits) * 100;
  return isValidDocumentRequestPriceCents(cents) ? cents : null;
}

/** 2000 to "$20". Callers pass validated whole-dollar cents. */
export function formatDocumentRequestPrice(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}
