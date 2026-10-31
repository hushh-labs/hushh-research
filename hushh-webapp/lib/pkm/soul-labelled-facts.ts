/**
 * The `Label: value` facts inside Soul.md, addressed one at a time.
 *
 * Soul.md is free Markdown and most of it is prose, so there is no field model
 * to read. But the facts this product writes itself -- the ones the identity
 * intake stores -- are written as labelled bullets (`- Date of birth: ...`),
 * and a label is a stable address. This reads exactly those, so a narrow
 * question can be answered from one labelled fact instead of handing over the
 * whole personal document.
 *
 * Deliberately conservative:
 *   * only `- Label: value` bullets, so ordinary prose is never mistaken for a
 *     recorded fact;
 *   * fenced code is skipped, so a pasted sample is not read as the person;
 *   * the LAST bullet with a label wins, because corrections are appended
 *     rather than rewritten in place (`insertSoulFacts`).
 *
 * Pure and import-safe: callers supply the already-decrypted Markdown.
 */

export interface SoulLabelledFact {
  /** The label exactly as written, for display and for source references. */
  label: string;
  value: string;
}

/** Lower-case, collapsed, punctuation-free: `Date of Birth` and `date of birth` are one address. */
export function soulFactKey(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ").replace(/[\s.:]+$/, "");
}

const LABELLED_BULLET = /^\s{0,3}[-*]\s+([^:\n]{1,64}?)\s*:\s*(.+?)\s*$/;

export function readLabelledSoulFacts(
  markdown: string | null | undefined,
): Map<string, SoulLabelledFact> {
  const facts = new Map<string, SoulLabelledFact>();
  if (!markdown) return facts;
  let fence: { marker: string; size: number } | null = null;
  for (const line of markdown.split("\n")) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      const marker = delimiter[1]![0]!;
      if (!fence) fence = { marker, size: delimiter[1]!.length };
      else if (marker === fence.marker && delimiter[1]!.length >= fence.size && !delimiter[2]!.trim())
        fence = null;
      continue;
    }
    if (fence) continue;
    const match = LABELLED_BULLET.exec(line);
    if (!match) continue;
    const label = match[1]!.trim();
    const value = match[2]!.trim();
    if (!label || !value) continue;
    facts.set(soulFactKey(label), { label, value });
  }
  return facts;
}

/**
 * Whole years between a recorded birth date and today.
 *
 * Returns null for anything that is not a real past date, because a wrong age
 * is a wrong answer rather than a missing one. The birth date itself is the
 * caller's to withhold: this returns only the number of years.
 */
export function ageFromDateOfBirth(
  dateOfBirth: string | null | undefined,
  now: Date = new Date(),
): number | null {
  const value = String(dateOfBirth || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const born = new Date(Date.UTC(year, month - 1, day));
  if (
    born.getUTCFullYear() !== year ||
    born.getUTCMonth() !== month - 1 ||
    born.getUTCDate() !== day
  )
    return null;
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  if (born.getTime() > today.getTime()) return null;
  let age = today.getUTCFullYear() - year;
  // The birthday has not happened yet this year.
  const hadBirthday =
    today.getUTCMonth() > month - 1 ||
    (today.getUTCMonth() === month - 1 && today.getUTCDate() >= day);
  if (!hadBirthday) age -= 1;
  return age >= 0 && age < 150 ? age : null;
}

/** Replace/delete a labelled owner fact without altering prose or fenced samples. */
export function setLabelledSoulFact(markdown: string, label: string, value: string): string {
  const key = soulFactKey(label);
  let fence: { marker: string; size: number } | null = null;
  const retained = markdown.split("\n").filter(line => {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      const marker = delimiter[1]![0]!;
      if (!fence) fence = { marker, size: delimiter[1]!.length };
      else if (marker === fence.marker && delimiter[1]!.length >= fence.size && !delimiter[2]!.trim()) fence = null;
      return true;
    }
    const match = !fence && LABELLED_BULLET.exec(line);
    return !match || soulFactKey(match[1]!) !== key;
  }).join("\n").trimEnd();
  const supplied = value.replace(/[\r\n]+/g, " ").trim();
  return `${retained}${supplied ? `\n- ${label}: ${supplied}` : ""}\n`;
}
