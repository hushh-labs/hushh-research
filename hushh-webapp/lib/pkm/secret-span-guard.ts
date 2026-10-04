/**
 * The device guard that keeps secrets away from every model. Pure module.
 *
 * Generalizes the card-number paste guard. Runs on the device BEFORE any text
 * reaches chat, a memory proposal, history or telemetry: the chat composer's
 * send path, an explicit save, automatic memory capture and pasted
 * attachments all go through it. For each secret span it finds
 * (`secret-patterns.ts`, from `contracts/pkm/secret-patterns.v1.json`):
 *
 * 1. the value is captured in device memory only, to be saved into the
 *    reserved `secrets` domain by `secrets-vault-service.ts`;
 * 2. the span is replaced with `⟦secret:<id> <label>⟧`, where the label is
 *    built here from the surrounding words with the value masked
 *    ("GitHub token ending 4f2a").
 *
 * The text is rendered only after the save has settled, so a placeholder
 * always names a stored item, and an item saved earlier with the same value is
 * reused instead of duplicated. If nothing can be saved, nothing is sent.
 *
 * `assertNoUnguardedSecrets` is the last line in the transport clients: a text
 * that still carries a raw secret is refused before any request is built.
 */

import {
  findSecretSpans,
  SECRET_PLACEHOLDER,
  type SecretFileTo,
  type SecretKind,
  type SecretSpan,
} from "@/lib/pkm/secret-patterns";
import { detectBrand } from "@/lib/wallet/card-validation";

/** A secret found in outgoing text. `value` lives in device memory only. */
export type SecretCapture = {
  /** Provisional id; the vault may resolve it to an existing item. */
  id: string;
  label: string;
  kind: SecretKind;
  patternId: string;
  fileTo: SecretFileTo;
  offerNoun: string | null;
  value: string;
};

export type ResolvedSecret = { id: string; label: string };

export type SecretCapturePlan = {
  captures: SecretCapture[];
  /** The texts with every span replaced by its placeholder. */
  render: (resolve?: (capture: SecretCapture) => ResolvedSecret) => string[];
};

export type SecretOffer = {
  fileTo: Exclude<SecretFileTo, "none">;
  actionLabel: string;
};

export class UnguardedSecretError extends Error {
  readonly code = "SECRET_SPAN_UNGUARDED";
  readonly kinds: SecretKind[];

  constructor(kinds: SecretKind[]) {
    super("This text holds a secret, so it was kept on this device and not sent.");
    this.name = "UnguardedSecretError";
    this.kinds = kinds;
  }
}

const VALUE_ID_KINDS: ReadonlySet<SecretKind> = new Set(["card_number", "government_id", "bank_account"]);
const CONTEXT_WINDOW_CHARS = 48;
const CONTEXT_WORDS = 2;
const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "api", "are", "as", "at", "be", "by", "code", "current", "for", "here", "i", "in",
  "is", "it", "its", "key", "keys", "me", "my", "new", "no", "number", "of", "old", "on", "or", "our",
  "passcode", "passphrase", "password", "passwords", "please", "remember", "save", "secret", "secrets",
  "that", "the", "their", "these", "this", "those", "to", "token", "tokens", "use", "using", "value",
  "was", "with", "your",
]);
const BRAND_LABELS: Readonly<Record<string, string>> = {
  visa: "Visa", mastercard: "Mastercard", amex: "Amex", discover: "Discover", diners: "Diners Club",
  jcb: "JCB", unionpay: "UnionPay", rupay: "RuPay", mir: "Mir", elo: "Elo", verve: "Verve",
};

/** A fresh placeholder id: `sec_` and 16 hex characters from the platform CSPRNG. */
export function newSecretId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return `sec_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function cleanLabel(label: string): string {
  const flat = label.replace(/[⟦⟧\n\r\t]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length <= SECRET_PLACEHOLDER.labelMaxChars ? flat : flat.slice(0, SECRET_PLACEHOLDER.labelMaxChars).trimEnd();
}

export function formatSecretPlaceholder(id: string, label: string): string {
  if (!SECRET_PLACEHOLDER.idPattern.test(id)) throw new Error("secret_placeholder_id_invalid");
  return `${SECRET_PLACEHOLDER.open}${id} ${cleanLabel(label) || "Secret"}${SECRET_PLACEHOLDER.close}`;
}

/**
 * Whole words just before the match on the same line: never a token with a
 * digit in it, never from inside an earlier secret, never a stopword.
 */
function contextWords(source: string, matchStart: number, floor: number, baseLabel: string): string[] {
  const lineStart = source.lastIndexOf("\n", matchStart - 1) + 1;
  const window = source.slice(Math.max(lineStart, floor, matchStart - CONTEXT_WINDOW_CHARS), matchStart);
  const baseWords = new Set(baseLabel.toLowerCase().split(/\s+/));
  const words = window
    .split(/\s+/)
    .map((token) => token.replace(/^[("'[]+|[)"'\],.;:!?]+$/g, ""))
    .filter((word) => /^[A-Za-z][A-Za-z&'-]*$/.test(word) && word.length >= 2 && word.length <= 24)
    .filter((word) => !STOPWORDS.has(word.toLowerCase()) && !baseWords.has(word.toLowerCase()));
  return words.slice(-CONTEXT_WORDS);
}

function maskSuffix(span: SecretSpan, value: string): string {
  if (span.pattern.mask !== "last4") return "";
  if (VALUE_ID_KINDS.has(span.pattern.kind)) {
    const plain = value.replace(/[^0-9A-Za-z]/g, "");
    return plain.length >= 8 ? ` ending ${plain.slice(-4)}` : "";
  }
  return value.length >= 16 ? ` ending ${value.slice(-4)}` : "";
}

function baseLabelFor(source: string, span: SecretSpan, value: string): string {
  const pattern = span.pattern;
  if (pattern.labelFromPrefix) {
    const prefix = source.slice(span.matchStart, span.start).replace(/[\s=:"']+$/g, "").trim();
    if (prefix) return prefix;
  }
  if (pattern.kind === "card_number") {
    const brand = BRAND_LABELS[detectBrand(value) ?? ""];
    return brand ? `${brand} card` : pattern.label;
  }
  return pattern.label;
}

/**
 * A short label for one secret, made on this device: the words the owner put
 * before it, the kind of secret, and at most the last four characters.
 * "openai key sk-..." becomes "openai API key ending 9f2a". A label that would
 * itself read as a secret falls back to the plain kind.
 */
export function buildSecretLabel(source: string, span: SecretSpan, floor = 0): string {
  const value = source.slice(span.start, span.end);
  const base = baseLabelFor(source, span, value);
  const words = span.pattern.labelContext ? contextWords(source, span.matchStart, floor, base) : [];
  const lowerFirst = words.length > 0 && /^[A-Z][a-z]+$/.test(base.split(" ")[0] ?? "");
  const named = words.length ? `${words.join(" ")} ${lowerFirst ? base.charAt(0).toLowerCase() + base.slice(1) : base}` : base;
  const label = cleanLabel(`${named}${maskSuffix(span, value)}`);
  return findSecretSpans(label).length === 0 ? label : cleanLabel(`${span.pattern.label}${maskSuffix(span, value)}`);
}

/**
 * Find every secret across a turn's texts (typed text, then each attachment).
 * One value appearing twice is one capture. Nothing is replaced until
 * `render` runs, after the vault has resolved each capture's final id.
 */
export function planSecretCaptures(
  texts: readonly string[],
  options: { idFactory?: () => string } = {},
): SecretCapturePlan {
  const idFactory = options.idFactory ?? newSecretId;
  const captures: SecretCapture[] = [];
  const byValue = new Map<string, SecretCapture>();
  const perText = texts.map((text) =>
    findSecretSpans(text).map((span, index, spans) => {
      const value = text.slice(span.start, span.end);
      let capture = byValue.get(value);
      if (!capture) {
        capture = {
          id: idFactory(),
          label: buildSecretLabel(text, span, index > 0 ? spans[index - 1]!.end : 0),
          kind: span.pattern.kind,
          patternId: span.pattern.id,
          fileTo: span.pattern.fileTo,
          offerNoun: span.pattern.offerNoun,
          value,
        };
        byValue.set(value, capture);
        captures.push(capture);
      }
      return { span, capture };
    }),
  );
  const render = (resolve?: (capture: SecretCapture) => ResolvedSecret): string[] =>
    texts.map((text, index) => {
      let out = "";
      let cursor = 0;
      for (const { span, capture } of perText[index] ?? []) {
        const resolved = resolve ? resolve(capture) : { id: capture.id, label: capture.label };
        out += text.slice(cursor, span.start) + formatSecretPlaceholder(resolved.id, resolved.label);
        cursor = span.end;
      }
      return out + text.slice(cursor);
    });
  return { captures, render };
}

/** Throw before a request is built when any text still holds a raw secret. */
export function assertNoUnguardedSecrets(texts: ReadonlyArray<string | null | undefined>): void {
  const kinds = texts.flatMap((text) => findSecretSpans(text).map((span) => span.pattern.kind));
  if (kinds.length) throw new UnguardedSecretError([...new Set(kinds)]);
}

/** Replace every raw secret span with a neutral mark. For text that is never saved. */
export function maskSecretSpans(text: string): string {
  let out = "";
  let cursor = 0;
  for (const span of findSecretSpans(text)) {
    out += `${text.slice(cursor, span.start)}[hidden secret]`;
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

export type SecretTextPart = { kind: "text"; text: string } | { kind: "secret"; id: string; label: string };

/** Split a text on its placeholders, so a transcript can draw each as a chip. */
export function splitSecretPlaceholders(text: string): SecretTextPart[] {
  const parts: SecretTextPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(SECRET_PLACEHOLDER.tokens())) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push({ kind: "text", text: text.slice(cursor, start) });
    parts.push({ kind: "secret", id: match[1]!, label: match[2]! });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) parts.push({ kind: "text", text: text.slice(cursor) });
  return parts;
}

/** The filing offer for a captured card or government id, if it has one. */
export function secretOfferFor(capture: Pick<SecretCapture, "fileTo" | "offerNoun">): SecretOffer | null {
  if (capture.fileTo === "wallet") return { fileTo: "wallet", actionLabel: "Add this card to Wallet" };
  if (capture.fileTo === "kyc_identity_documents") {
    return { fileTo: "kyc_identity_documents", actionLabel: `Add ${capture.offerNoun ?? "this ID"} to Identity documents` };
  }
  return null;
}
