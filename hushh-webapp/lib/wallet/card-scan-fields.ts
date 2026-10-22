import { luhnValid } from "./card-validation";

export type ScannedCardFields = { pan?: string; expiry?: string; cardholderName?: string };
export type ScanFieldState = "recognized" | "needs_review" | "missing";
export interface CardScanReading {
  fields: ScannedCardFields;
  states: Record<keyof ScannedCardFields, ScanFieldState>;
  ambiguousFields?: (keyof ScannedCardFields)[];
}
const DATE = /\b(0[1-9]|1[0-2])\s*\/\s*((?:20)?\d{2})\b/g;
const NAME = /^[\p{L}][\p{L}\p{M} .'’-]{2,79}$/u;
const MARKETING = /\b(?:bank|card|credit|debit|visa|mastercard|american|express|discover|rupay|platinum|gold|signature|world|valid|thru|through|from|until|expiry|expires|member|since|customer|service|authorized|not|transferable|issue|date|demo|lounge|access|rewards|cashback|contact|support)\b/i;

/** Local, conservative projection. Never repairs characters or emits security codes. */
export function parseCardScanReading(text: string): CardScanReading {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const numbers = new Set<string>(), reviewNumbers = new Set<string>();
  let numberSeen = false;
  const inspect = (value: string) => {
    // A same-line date is a separate field, never extra PAN digits.
    const numeric = value.replace(DATE, "/");
    for (const match of numeric.matchAll(/\d(?:[ \t\u00a0-]*\d)*/g)) {
      const pan = match[0].replace(/\D/g, "");
      if (pan.length < 12 || pan.length > 19) continue;
      numberSeen = true;
      if (/[\p{L}\p{N}]/u.test(numeric[match.index - 1] ?? "") || /[\p{L}\p{N}]/u.test(numeric[match.index + match[0].length] ?? "")) continue;
      if (/^(\d)\1+$/.test(pan)) continue;
      reviewNumbers.add(pan); if (luhnValid(pan)) numbers.add(pan);
    }
  };
  lines.forEach(inspect);
  const dateLines = lines.filter(line => !/\b(?:issue[d]?|valid\s+from|member\s+since)\b/i.test(line));
  const labelled = dateLines.filter(line => /\b(?:valid\s*(?:thru|through|until)|exp(?:iry|ires|iration)?(?:\s*date)?)\b/i.test(line));
  const dates = new Set<string>();
  const readDates = (values: string[]) => values.forEach(line => {
    for (const match of line.matchAll(DATE)) dates.add(`${match[1]}/${match[2]!.slice(-2)}`);
  });
  const inlineExpiry = /(?:valid\s*(?:thru|through|until)|exp(?:iry|ires|iration)?(?:\s*date)?)\s*[:.-]?\s*((?:0[1-9]|1[0-2])\s*\/\s*(?:20)?\d{2})\b/gi;
  for (const line of lines) for (const match of line.matchAll(inlineExpiry)) readDates([match[1]!]);
  if (!dates.size) readDates(labelled.length ? labelled : dateLines);
  if (labelled.length && !dates.size) {
    for (const line of labelled) { const next = lines[lines.indexOf(line) + 1]; if (next) readDates([next]); }
  }
  const explicitNames = lines.flatMap((line, index) => {
    if (!/^(?:cardholder|card holder|name on card)(?: name)?\s*:?[ \t]*/i.test(line)) return [];
    const name = line.replace(/^(?:cardholder|card holder|name on card)(?: name)?\s*:?[ \t]*/i, "") || lines[index + 1] || "";
    return NAME.test(name) && !MARKETING.test(name) ? [name] : [];
  });
  const names = new Set(explicitNames.length ? explicitNames : lines.filter(line => NAME.test(line) && line.trim().split(/\s+/).length >= 2 && !MARKETING.test(line)));
  const fields: ScannedCardFields = {};
  if (numbers.size === 1) fields.pan = [...numbers][0];
  else if (!numbers.size && reviewNumbers.size === 1) fields.pan = [...reviewNumbers][0];
  if (dates.size === 1) fields.expiry = [...dates][0];
  if (names.size === 1 && (explicitNames.length || numbers.size || reviewNumbers.size || dates.size)) fields.cardholderName = [...names][0];
  return { fields, ambiguousFields: [numbers.size > 1 ? "pan" : null, dates.size > 1 ? "expiry" : null, names.size > 1 ? "cardholderName" : null].filter((key): key is keyof ScannedCardFields => key !== null), states: {
    pan: fields.pan ? numbers.size === 1 ? "recognized" : "needs_review" : numbers.size || numberSeen ? "needs_review" : "missing",
    expiry: fields.expiry ? (Date.UTC(2000 + Number(fields.expiry.slice(-2)), Number(fields.expiry.slice(0, 2)), 1) <= Date.now() ? "needs_review" : "recognized") : dates.size ? "needs_review" : "missing",
    cardholderName: fields.cardholderName ? explicitNames.length ? "recognized" : "needs_review" : names.size ? "needs_review" : "missing",
  } };
}

/** Disagreement cannot erase another independently reliable field. */
export function mergeCardScanReadings(readings: CardScanReading[]): CardScanReading {
  const result: CardScanReading = { fields: {}, states: { pan: "missing", expiry: "missing", cardholderName: "missing" } };
  for (const key of ["pan", "expiry", "cardholderName"] as const) {
    // A checksum-invalid draft is useful for owner correction, but cannot veto
    // an independently checksum-valid PAN. Competing valid PANs remain ambiguous.
    const validPanReadings = key === "pan" ? readings.filter(reading => reading.fields.pan && luhnValid(reading.fields.pan)) : [];
    const candidates = validPanReadings.length ? validPanReadings : readings;
    const values = new Set(candidates.flatMap(reading => reading.fields[key] ? [reading.fields[key]!] : []));
    const ambiguous = readings.some(reading => reading.states[key] === "needs_review");
    const conflicting = readings.some(reading => reading.ambiguousFields?.includes(key));
    if (values.size === 1 && !conflicting) { result.fields[key] = [...values][0]; result.states[key] = readings.some(reading => reading.fields[key] === result.fields[key] && reading.states[key] === "recognized") ? "recognized" : "needs_review"; }
    else if (values.size || ambiguous) result.states[key] = "needs_review";
    if (conflicting || (values.size > 1 && (key !== "pan" || validPanReadings.length > 0))) (result.ambiguousFields ??= []).push(key);
  }
  return result;
}

export function parseCardScan(text: string): ScannedCardFields | null {
  const reading = parseCardScanReading(text);
  return Object.keys(reading.fields).length ? reading.fields : null;
}
