/**
 * Which spans of text are secrets: the TypeScript half of
 * `contracts/pkm/secret-patterns.v1.json`.
 *
 * The Python half, `consent-protocol/hushh_mcp/consent/secret_patterns.py`, is
 * the server's second net; this one runs first, on the device, inside
 * `secret-span-guard.ts`. Both read one contract and run its shared cases, so
 * a pattern cannot match on one side and miss on the other.
 *
 * Pure and dependency-free apart from the contract, like `reserved-branches.ts`,
 * so the chat composer, the memory proposal client and tests can import it
 * without a client module graph.
 */

import contract from "@/contracts/pkm/secret-patterns.v1.json";

export type SecretKind = "credential" | "card_number" | "card_security_code" | "government_id" | "bank_account";
export type SecretFileTo = "wallet" | "kyc_identity_documents" | "none";

export type SecretPattern = {
  id: string;
  kind: SecretKind;
  label: string;
  fileTo: SecretFileTo;
  offerNoun: string | null;
  mask: "last4" | "none";
  labelContext: boolean;
  labelFromPrefix: boolean;
  regex: RegExp;
  valueGroup: number;
  validator: string | null;
};

/** One secret in a text: where it is and what it is. The caller holds the text. */
export type SecretSpan = {
  start: number;
  end: number;
  /** Start of the whole match (the words that introduced the value, for a label). */
  matchStart: number;
  pattern: SecretPattern;
};

type RawPattern = {
  id: string;
  kind: string;
  label: string;
  file_to: string;
  offer_noun?: string;
  mask: string;
  label_context: boolean;
  label_from_prefix: boolean;
  pattern: string;
  ignore_case: boolean;
  value_group: number;
  validator: string | null;
};

const ENV_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const MASK_RUN = /^(.)\1*$/;
const PLACEHOLDER_WORDS: ReadonlySet<string> = new Set(contract.placeholder_words.map((word) => word.toLowerCase()));

export const SECRET_PLACEHOLDER = {
  open: contract.placeholder.open,
  close: contract.placeholder.close,
  idPattern: new RegExp(contract.placeholder.id_pattern),
  labelMaxChars: contract.placeholder.label_max_chars,
  /** A fresh global regex over every placeholder token in a text. */
  tokens: (): RegExp => new RegExp(contract.placeholder.token_pattern, "g"),
} as const;

export const SECRET_PATTERNS: readonly SecretPattern[] = (contract.patterns as RawPattern[]).map((raw) => ({
  id: raw.id,
  kind: raw.kind as SecretKind,
  label: raw.label,
  fileTo: raw.file_to as SecretFileTo,
  offerNoun: raw.offer_noun ?? null,
  mask: raw.mask === "last4" ? "last4" : "none",
  labelContext: raw.label_context,
  labelFromPrefix: raw.label_from_prefix,
  // `d` gives the value group's own offsets; `g` walks every match.
  regex: new RegExp(raw.pattern, `gd${raw.ignore_case ? "i" : ""}`),
  valueGroup: raw.value_group,
  validator: raw.validator,
}));

// Verhoeff checksum tables (dihedral group D5).
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
] as const;
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
] as const;

export function luhnValid(digits: string): boolean {
  let total = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let value = digits.charCodeAt(digits.length - 1 - index) - 48;
    if (index % 2 === 1) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    total += value;
  }
  return total % 10 === 0;
}

function verhoeffValid(digits: string): boolean {
  let check = 0;
  for (let index = 0; index < digits.length; index += 1) {
    const digit = digits.charCodeAt(digits.length - 1 - index) - 48;
    check = VERHOEFF_D[check]![VERHOEFF_P[index % 8]![digit]!]!;
  }
  return check === 0;
}

function ibanValid(value: string): boolean {
  const rearranged = value.slice(4) + value.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const chunk = String(parseInt(char, 36));
    for (const digit of chunk) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** True for a NAME of a secret or a stand-in, never a secret itself. */
function isReference(value: string): boolean {
  const lowered = value.toLowerCase();
  return (
    ENV_NAME.test(value) ||
    ["$", "%", "<", "{"].includes(value.charAt(0)) ||
    value.includes("://") ||
    lowered.startsWith("projects/") ||
    lowered.includes("/secrets/") ||
    ["/", "./", "../", "~/"].some((prefix) => value.startsWith(prefix)) ||
    MASK_RUN.test(value) ||
    ["your_", "your-", "my_", "my-"].some((prefix) => lowered.startsWith(prefix)) ||
    PLACEHOLDER_WORDS.has(lowered)
  );
}

function isValid(validator: string | null, value: string): boolean {
  if (validator === null) return true;
  if (validator === "luhn_run") {
    const digits = value.replace(/[\s-]/g, "");
    return /^\d+$/.test(digits) && digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
  }
  if (validator === "verhoeff") {
    const digits = value.replace(/[\s-]/g, "");
    return /^[2-9]\d{11}$/.test(digits) && verhoeffValid(digits);
  }
  if (validator === "iban_mod97") return ibanValid(value);
  if (isReference(value)) return false;
  if (validator === "password_value") return value.length >= 4;
  if (validator === "token_value") {
    const mixedCase = /[a-z]/.test(value) && /[A-Z]/.test(value);
    return value.length >= 8 && (/\d/.test(value) || mixedCase);
  }
  if (validator === "phrase_value") return value.length >= 4 && /[\d]|[^A-Za-z0-9]/.test(value);
  throw new Error(`secret_patterns_validator_unknown:${validator}`);
}

/**
 * Every secret span in `text`, earliest first, never overlapping. Overlaps
 * resolve to the earliest start, then the longest span, then the pattern the
 * contract lists first. A span inside an existing placeholder is never found.
 */
export function findSecretSpans(text: string | null | undefined): SecretSpan[] {
  const source = String(text ?? "");
  if (!source.trim()) return [];
  const protectedRanges = [...source.matchAll(SECRET_PLACEHOLDER.tokens())].map((match) => [
    match.index ?? 0,
    (match.index ?? 0) + match[0].length,
  ]);
  const candidates: Array<SecretSpan & { order: number }> = [];
  SECRET_PATTERNS.forEach((pattern, order) => {
    pattern.regex.lastIndex = 0;
    for (const match of source.matchAll(pattern.regex)) {
      const range = match.indices?.[pattern.valueGroup];
      if (!range) continue;
      const [start, end] = range;
      if (end <= start) continue;
      if (protectedRanges.some(([from, to]) => start < to! && end > from!)) continue;
      if (!isValid(pattern.validator, source.slice(start, end))) continue;
      candidates.push({ start, end, matchStart: match.index ?? start, pattern, order });
    }
  });
  candidates.sort((left, right) => left.start - right.start || (right.end - right.start) - (left.end - left.start) || left.order - right.order);
  const spans: SecretSpan[] = [];
  let coveredUntil = -1;
  for (const { order: _order, ...candidate } of candidates) {
    if (candidate.start < coveredUntil) continue;
    spans.push(candidate);
    coveredUntil = candidate.end;
  }
  return spans;
}

export function containsSecretSpan(text: string | null | undefined): boolean {
  return findSecretSpans(text).length > 0;
}
