import { luhnValid } from "./card-validation";

export type ScannedCardFields = { pan: string; expiry?: string; cardholderName?: string };

/** A conservative parser of local OCR output, never a saved card or authority. */
export function parseCardScan(text: string): ScannedCardFields | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const candidates = new Set(lines.flatMap((line) =>
    (line.match(/\d(?:[ -]?\d)*/g) ?? []).map((value) => value.replace(/\D/g, ""))
  ).filter((pan) => pan.length >= 13 && pan.length <= 19 && luhnValid(pan)));
  // Never guess between multiple card numbers.
  if (candidates.size !== 1) return null;
  const pan = [...candidates][0]!;
  const dates = [...new Set(text.match(/\b(?:0[1-9]|1[0-2])\s*\/\s*(?:20)?\d{2}\b/g) ?? [])];
  const nameLabel = lines.findIndex((line) => /^(?:cardholder|card holder|name on card)(?: name)?[: ]*$/i.test(line));
  const name = nameLabel >= 0 ? lines[nameLabel + 1] : undefined;
  return {
    pan,
    ...(dates.length === 1 ? { expiry: dates[0]!.replace(/\s/g, "") } : {}),
    ...(name && /^[\p{L} .'-]{3,80}$/u.test(name) ? { cardholderName: name } : {}),
  };
}
