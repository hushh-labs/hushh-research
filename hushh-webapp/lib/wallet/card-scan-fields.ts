import { luhnValid } from "./card-validation";

export type ScannedCardFields = { pan: string; expiry?: string; cardholderName?: string };

/** A conservative parser of local OCR output, never a saved card or authority. */
export function parseCardScan(text: string): ScannedCardFields | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // OCR may split the printed groups across lines or emit repeated whitespace.
  const groupedLines = text.replace(/(?:^|\n)((?:[ \t]*\d{4}[ \t]*\r?\n){3}[ \t]*\d{4})(?=\s|$)/g, (_, groups: string) => "\n" + groups.replace(/\s+/g, " "));
  const candidates = new Set([...lines, ...groupedLines.split(/\r?\n/)].flatMap((line) =>
    (line.match(/\d(?:[ \t\u00a0-]*\d)*/g) ?? []).map((value) => value.replace(/\D/g, ""))
  ).filter((pan) => pan.length >= 13 && pan.length <= 19 && luhnValid(pan)));
  // Never guess between multiple card numbers.
  if (candidates.size !== 1) return null;
  const pan = [...candidates][0]!;
  const dates = [...new Set(text.match(/\b(?:0[1-9]|1[0-2])\s*\/\s*(?:20)?\d{2}\b/g) ?? [])];
  const labelledExpiry = text.match(/(?:valid\s*(?:thru|through|until)|exp(?:iry|ires|iration)?(?:\s*date)?)\s*[:.-]?\s*((?:0[1-9]|1[0-2])\s*\/\s*(?:20)?\d{2})\b/i)?.[1];
  const expiry = labelledExpiry ?? (dates.length === 1 ? dates[0] : undefined);
  const nameLabel = lines.findIndex((line) => /^(?:cardholder|card holder|name on card)(?: name)?\s*:?\s*/i.test(line));
  const explicitName = nameLabel >= 0
    ? lines[nameLabel]!.replace(/^(?:cardholder|card holder|name on card)(?: name)?\s*:?\s*/i, "") || lines[nameLabel + 1]
    : undefined;
  // Many physical cards print the name without a label. Offer a single clear
  // candidate as a draft, never infer a name when competing text is present.
  const numberLine = lines.findIndex(line => line.replace(/\D/g, "").includes(pan));
  const names = lines.slice(numberLine >= 0 ? numberLine + 1 : lines.length).filter(line =>
    /^[\p{L}][\p{L}.'-]*(?: +[\p{L}][\p{L}.'-]*){1,4}$/u.test(line) &&
    !/\b(?:bank|card|credit|debit|visa|mastercard|american|express|discover|rupay|platinum|gold|signature|world|valid|thru|through|from|until|expiry|expires|member|since|customer|service|authorized|signature|not|transferable)\b/i.test(line));
  const name = explicitName ?? (expiry && names.length === 1 ? names[0] : undefined);
  return {
    pan,
    ...(expiry ? { expiry: expiry.replace(/\s/g, "") } : {}),
    ...(name && /^[\p{L} .'-]{3,80}$/u.test(name) ? { cardholderName: name } : {}),
  };
}
