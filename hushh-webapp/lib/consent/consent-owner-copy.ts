/**
 * The words an owner reads about a request for their information.
 *
 * One module, so the Feed row, the decision sheet, the Active row and the
 * owner's own chat card say the same thing the same way. Measured on UAT
 * (2026-09-28): the request read "Preferences" and the access it became read
 * "Food Preferences"; the sheet said "1 items", "Requested: Unavailable" and
 * "Decision due 10/5/2026, 1:51:08 PM"; the requester's side said "1 week"
 * while the owner's said "7 days". Each was a separate formatter on a separate
 * screen. These helpers are pure so every surface can share them and a test can
 * pin them without rendering anything.
 */

import { humanizeConsentScope } from "@/lib/consent/consent-display";
import { requestDurationLabel } from "@/lib/agent/action-directive-summary";

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * An instant from the wire, or `null` when there is none.
 *
 * The pending list serialises `issued_at` as a numeric STRING of epoch
 * milliseconds ("1790000000000"). `new Date("1790000000000")` is Invalid Date,
 * which is exactly how the sheet came to print "Requested: Unavailable" for a
 * request that plainly had a time. Numbers and numeric strings are read as
 * epoch seconds or milliseconds by magnitude; anything else goes through the
 * ISO parser.
 */
export function parseConsentInstant(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  const text = typeof value === "number" ? String(value) : String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    const numeric = Number(text);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    // Ten digits of seconds covers every date until 2286.
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = new Date(text).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function isSameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function monthDay(date: Date, now: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(date);
}

function clockTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/** "Today, 1:51 PM", "Yesterday, 9:02 AM" or "Sep 26, 1:51 PM". */
export function formatRequestedAt(
  value: unknown,
  nowMs: number = Date.now(),
): string | null {
  const at = parseConsentInstant(value);
  if (at === null) return null;
  const date = new Date(at);
  const now = new Date(nowMs);
  const yesterday = new Date(nowMs - 24 * MS_PER_HOUR);
  if (isSameLocalDay(date, now)) return `Today, ${clockTime(date)}`;
  if (isSameLocalDay(date, yesterday)) return `Yesterday, ${clockTime(date)}`;
  return `${monthDay(date, now)}, ${clockTime(date)}`;
}

/**
 * The deadline a person reads: "Oct 5", or "Today, 3:05 PM" when it is today.
 * Rendered after "Decide by", so the sentence reads "Decide by Oct 5".
 */
export function formatDecideBy(
  value: unknown,
  nowMs: number = Date.now(),
): string | null {
  const at = parseConsentInstant(value);
  if (at === null) return null;
  const date = new Date(at);
  const now = new Date(nowMs);
  if (isSameLocalDay(date, now)) return `Today, ${clockTime(date)}`;
  return monthDay(date, now);
}

/**
 * How long access lasts, worded one way on every surface.
 *
 * Whole hours go through the one shared formatter (`requestDurationLabel`),
 * which is also the rule the server writes into Chat history, so the owner's
 * sheet says "7 days" exactly where the requester's card does. Only a
 * sub-hour duration (location sharing) reads in minutes.
 */
export function formatConsentDuration(hours: unknown): string | null {
  const numeric = typeof hours === "number" ? hours : Number(hours);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  if (numeric < 1) {
    const minutes = Math.round(numeric * 60);
    return `${minutes} min`;
  }
  return requestDurationLabel(numeric);
}

/** "1 item", "3 items". */
export function countItems(count: number): string {
  const safe = Math.max(0, Math.round(count));
  return `${safe} item${safe === 1 ? "" : "s"}`;
}

/**
 * Sentence case that leaves acronyms alone: "Food Preferences" becomes
 * "Food preferences", "KYC Status" stays "KYC status".
 */
export function toSentenceCase(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  return words
    .map((word, index) => {
      if (index === 0) return word.charAt(0).toUpperCase() + word.slice(1);
      if (word.length > 1 && word === word.toUpperCase()) return word;
      return word.toLowerCase();
    })
    .join(" ");
}

/**
 * The one human name for a piece of information.
 *
 * Derived from the key itself whenever there is one, because the key is the
 * only thing every surface carries: a request row has a stored description,
 * the access it becomes has none, so a description-first rule named the same
 * thing twice ("Preferences", then "Food Preferences"). The stored label is the
 * fallback for rows that have no key at all.
 */
export function consentInformationLabel(input: {
  scope?: string | null;
  label?: string | null;
}): string {
  const scope = String(input.scope || "").trim();
  if (scope === "pkm.read") return "Everything in your memory";
  if (scope === "pkm.write") return "Updates to your memory";
  if (scope) return toSentenceCase(humanizeConsentScope(scope));
  // Every sentence that uses a label already says "your", so a stored name
  // that opens with it would read "your Your work email".
  const label = String(input.label || "")
    .trim()
    .replace(/^your\s+/i, "");
  return label ? toSentenceCase(label) : "Information";
}

/**
 * The human name for one consent entry's information.
 *
 * A request a person made from their Profile or One's ask card carries the
 * server's human label (`human_scope_label`) as its description on every
 * list: the request, the access it becomes, and its history. That label wins
 * for those entries; deriving it from a leaf key read "Food preferences kind"
 * where the person had asked for "Food preferences". Every other entry keeps
 * the key-first rule above.
 */
export function consentEntryInformationLabel(entry: {
  scope?: string | null;
  scope_description?: string | null;
  metadata?: unknown;
}): string {
  const metadata = entry.metadata && typeof entry.metadata === "object"
    ? (entry.metadata as Record<string, unknown>)
    : {};
  const described = String(entry.scope_description || "").trim();
  if (metadata.request_source === "one_person_profile" && described) {
    return consentInformationLabel({ label: described });
  }
  return consentInformationLabel({ scope: entry.scope, label: entry.scope_description });
}

/**
 * Names in a sentence: "a", "a and b", "a, b and c", and past three,
 * "a, b and 3 more", so a headline never runs to a paragraph.
 */
export function joinInformationLabels(labels: string[], max = 3): string {
  const unique = Array.from(
    new Set(labels.map((label) => label.trim()).filter(Boolean)),
  );
  if (unique.length === 0) return "information";
  if (unique.length === 1) return unique[0]!;
  if (unique.length <= max) {
    return `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
  }
  const shown = unique.slice(0, max - 1);
  return `${shown.join(", ")} and ${unique.length - shown.length} more`;
}

/**
 * The name a headline opens with. A person's first name ("Kushal"), or the
 * whole label for an app, an advisor or an email address, which have no first
 * name to take.
 */
export function requesterShortName(label: string, isPerson: boolean): string {
  const trimmed = label.trim();
  if (!trimmed) return "Someone";
  if (!isPerson || trimmed.includes("@")) return trimmed;
  return trimmed.split(/\s+/)[0] || trimmed;
}

/**
 * A reason sits after a middle dot, so a leading capital reads as a typo. Only
 * the first letter moves, and only when the next is lower case, so an acronym
 * keeps its shape.
 */
export function reasonMidSentence(reason: string | null | undefined): string {
  const text = String(reason || "").trim().replace(/[.]+$/, "");
  if (text.length < 2) return text;
  const second = text[1]!;
  if (second !== second.toLowerCase()) return text;
  return `${text[0]!.toLowerCase()}${text.slice(1)}`;
}

/**
 * "Kushal wants your Food preferences", or past two items
 * "Kushal wants your Food preferences and 2 more": a headline stays a
 * headline, and Details names everything.
 */
export function consentRequestHeadline(input: {
  requesterShortName: string;
  labels: string[];
}): string {
  return `${input.requesterShortName} wants your ${joinInformationLabels(input.labels, 2)}`;
}
