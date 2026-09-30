/**
 * Field-level sensitivity: one field can be an identifier inside a standard item.
 *
 * The TypeScript half of `consent-protocol/hushh_mcp/consent/field_sensitivity.py`,
 * reading the same truth table, `contracts/consent/field-sensitivity.v1.json`
 * (mirrored under `hushh-webapp/contracts/consent/`). Localhost acceptance run 4
 * (2026-09-29, S3) found an EIN standard as "Fein" under "Legal entity", so a
 * Legal entity follow-up would have sent it to the model. The server strips it
 * again at continuation admission; this side keeps it off the wire at all.
 *
 * - An identifier-class KEY (SSN, EIN, passport, account number, date of
 *   birth, anything secret-shaped) is sensitive in any domain.
 * - An identifier-shaped VALUE (an SSN, an EIN, a Luhn-valid card number, an
 *   IBAN, a credential string) is sensitive under any key.
 * - Everything else in a standard item stays standard.
 *
 * Pure and dependency-free apart from the contract, so `lib/consent` and the
 * secure card can both import it.
 */

import contract from "@/contracts/consent/field-sensitivity.v1.json";
import { isSecretShapedKey } from "@/lib/pkm/internal-path-keys";

export type FieldSensitivity = "sensitive" | "standard";

/** A field's own C7 reading, as shares and card items carry it (`fields[]`). */
export type SharedFieldSensitivity = { name: string; sensitivity: FieldSensitivity };

const FILLER_WORDS: ReadonlySet<string> = new Set(contract.filler_words.map((word) => word.toLowerCase()));
const KEY_WORDS: ReadonlySet<string> = new Set(contract.identifier_key_words.map((word) => word.toLowerCase()));
const KEY_PHRASES: ReadonlySet<string> = new Set(
  contract.identifier_key_phrases.map(([left, right]) => `${left!.toLowerCase()} ${right!.toLowerCase()}`),
);
const VALUE_PATTERNS: ReadonlyArray<{ pattern: RegExp; luhn: boolean }> = contract.identifier_value_patterns.map(
  (entry) => ({ pattern: new RegExp(entry.pattern, "g"), luhn: "luhn" in entry && entry.luhn === true }),
);

/**
 * Whole words of one key: the same splits as `humanize_segment` (array
 * indices, separators, acronym and camelCase boundaries, letter-to-digit
 * runs), lower-cased, a trailing plural folded, filler words removed.
 */
function keyWords(segment: string): string[] {
  const spaced = String(segment ?? "")
    .replace(/\[\d+\]/g, " ")
    .replace(/[_-]+/g, " ")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([a-z]{3,})(\d+)/gi, "$1 $2")
    .toLowerCase();
  return (spaced.match(/[a-z0-9]+/g) ?? [])
    .map((word) => word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word)
    .filter((word) => !FILLER_WORDS.has(word));
}

function luhnOk(digits: string): boolean {
  let total = 0;
  [...digits].reverse().forEach((char, index) => {
    let value = Number(char);
    if (index % 2 === 1) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    total += value;
  });
  return total % 10 === 0;
}

/**
 * Whether a field key, or any key on its path from the item down, is
 * identifier-class. A phrase may straddle two keys (`national > id`).
 */
export function fieldKeyIsSensitive(keyPath: string | readonly string[]): boolean {
  const keys = typeof keyPath === "string" ? [keyPath] : keyPath;
  const joined: string[] = [];
  for (const key of keys) {
    const text = String(key ?? "").trim();
    if (!text) continue;
    if (isSecretShapedKey(text)) return true;
    const words = keyWords(text);
    if (words.some((word) => KEY_WORDS.has(word))) return true;
    joined.push(...words);
  }
  return joined.some((word, index) => index > 0 && KEY_PHRASES.has(`${joined[index - 1]} ${word}`));
}

/** Whether a value looks like an identifier (SSN, EIN, card, IBAN, credential). */
export function valueIsIdentifierShaped(value: unknown): boolean {
  if (value === null || value === undefined || typeof value === "boolean") return false;
  const text = String(value);
  if (!text.trim()) return false;
  return VALUE_PATTERNS.some(({ pattern, luhn }) =>
    [...text.matchAll(pattern)].some((match) => !luhn || luhnOk(match[0].replace(/\D+/g, ""))));
}

export type SensitiveTopicLabel = "restricted" | "confidential";

function strongerTopicLabel(
  left: SensitiveTopicLabel | null | undefined,
  right: SensitiveTopicLabel | null | undefined,
): SensitiveTopicLabel | null {
  if (left === "restricted" || right === "restricted") return "restricted";
  return left ?? right ?? null;
}

const TOPIC_WORDS = new Map<string, SensitiveTopicLabel>();
const TOPIC_PHRASES = new Map<string, SensitiveTopicLabel>();
for (const topic of Object.values(contract.sensitive_topics)) {
  const label = topic.label as SensitiveTopicLabel;
  for (const word of topic.words) {
    TOPIC_WORDS.set(word, strongerTopicLabel(TOPIC_WORDS.get(word), label)!);
  }
  for (const [left, right] of topic.phrases) {
    const key = `${left} ${right}`;
    TOPIC_PHRASES.set(key, strongerTopicLabel(TOPIC_PHRASES.get(key), label)!);
  }
}

/**
 * Whether a path or a stated value names a sensitive topic (pay, immigration,
 * identity, health, tax, credentials), from the same topic table the server's
 * `scope_sensitivity` reads. `restricted` outranks `confidential`. Used by the
 * manifest walk to label a path before encryption; only the label leaves the
 * device. A label only ever escalates what a person can share.
 */
export function sensitiveTopicLabel(text: unknown): SensitiveTopicLabel | null {
  if (typeof text !== "string" || !text.trim()) return null;
  const words = keyWords(text);
  let label: SensitiveTopicLabel | null = null;
  words.forEach((word, index) => {
    label = strongerTopicLabel(label, TOPIC_WORDS.get(word));
    if (index > 0) label = strongerTopicLabel(label, TOPIC_PHRASES.get(`${words[index - 1]} ${word}`));
  });
  return label;
}

/** `"sensitive"` or `"standard"` for one field of a shared item. */
export function fieldSensitivity(keyPath: string | readonly string[], value: unknown = null): FieldSensitivity {
  return fieldKeyIsSensitive(keyPath) || valueIsIdentifierShaped(value) ? "sensitive" : "standard";
}

/** Letters and digits only, lower-cased: "Federal EIN" and "federal_ein" are one name. */
function nameKey(name: string): string {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * The names an item's `fields[]` marks sensitive, for matching a field by
 * its key or its human label. Deny by default: only an explicit `standard`
 * is standard, the same reading the server's card applies.
 */
export function sensitiveFieldNameSet(fields: readonly SharedFieldSensitivity[] | null | undefined): ReadonlySet<string> {
  return new Set((fields ?? []).filter((field) => field.sensitivity !== "standard").map((field) => nameKey(field.name)).filter(Boolean));
}

/** Whether any of a field's names (its key, its human label) is one `fields[]` marks sensitive. */
export function isNamedSensitiveField(names: ReadonlySet<string>, ...candidates: Array<string | null | undefined>): boolean {
  if (!names.size) return false;
  return candidates.some((candidate) => Boolean(candidate) && names.has(nameKey(candidate!)));
}

/** Parse a payload's `fields[]` (untrusted); deny by default when unknown. */
export function parseSharedFieldSensitivities(value: unknown, max = 24): SharedFieldSensitivity[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max).flatMap((raw) => {
    const entry = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
    const name = typeof entry?.name === "string" ? entry.name.trim().slice(0, 80) : "";
    if (!name) return [];
    return [{ name, sensitivity: entry?.sensitivity === "standard" ? "standard" as const : "sensitive" as const }];
  });
}
