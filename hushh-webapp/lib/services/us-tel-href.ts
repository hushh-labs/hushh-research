/**
 * US directory feeds (BrokerCheck advisers, Nationwide agencies) serve phones
 * as bare ten-digit strings, so a raw `tel:` link dials as a local number and
 * misroutes from any non-US region. Emit E.164 (`tel:+1…`); a number already
 * carrying a `+` passes through as-is; any other shape stays bare digits
 * rather than guessing a country.
 */
export function usTelHref(phone: string): string {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return `tel:+${digits}`;
  if (digits.length === 10) return `tel:+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `tel:+${digits}`;
  return `tel:${digits}`;
}
