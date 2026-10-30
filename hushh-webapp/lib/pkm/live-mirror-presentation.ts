import { consentInformationLabel, parseConsentInstant } from "@/lib/consent/consent-owner-copy";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { buildProfileRoute, connectorDetailTitle } from "@/lib/navigation/profile-routes";
import { ROUTES } from "@/lib/navigation/routes";
import {
  LIVE_MIRROR_KINDS,
  LIVE_MIRROR_PRESENCE_ONLY_PREDICATES,
  type LiveMirrorClaim,
  type LiveMirrorConflict,
  type LiveMirrorFact,
  type LiveMirrorFactState,
  type LiveMirrorFactValue,
  type LiveMirrorGap,
  type LiveMirrorHistoryEntry,
  type LiveMirrorKind,
  type LiveMirrorOverall,
  type LiveMirrorSource,
  type LiveMirrorSourceState,
  type LiveMirrorSourceRoute,
} from "@/lib/pkm/live-mirror-contract";
import { LIVING_SOURCE_FACT_FIELDS } from "@/lib/pkm/living-source-fact-index";

/**
 * The words an owner reads about the Live Mirror: status, source and fact
 * states, values, times and counts. Profile, the private agent's profile
 * sheet, the Memory workspace preview and the generated Markdown preview all
 * format through this one module, so the same fact and state read the same on
 * every surface. Pure: no React and no clock reads; callers pass `now`.
 */

const HEADLINES: Record<LiveMirrorOverall, string> = {
  locked: "Memory locked",
  loading: "Checking sources",
  current: "Up to date",
  updating: "Updating",
  stale: "May be out of date",
  partial: "Some sources unavailable",
  conflict: "Needs your review",
  empty: "Nothing yet",
};

const SOURCE_STATE_LABELS: Record<LiveMirrorSourceState, string> = {
  current: "Current",
  updating: "Updating",
  stale: "Out of date",
  unavailable: "Unavailable",
  withheld: "Withheld",
  conflict: "Needs review",
  not_checked: "Not checked yet",
};

const FACT_STATE_LABELS: Partial<Record<LiveMirrorFactState, string>> = {
  stale: "May be old",
  unavailable: "Can’t check now",
  conflicted: "Needs review",
};

/** History footer, matching the open-and-unlocked boundary. */
export const LIVE_MIRROR_HISTORY_FOOTER = "Only changes seen while open and unlocked";

type FieldFormat = "money" | "time" | "enum" | "scope" | "provider" | "currency";

/** Admitted fields that need more than their raw value to read well. */
const FIELD_FORMATS: Readonly<Record<string, FieldFormat>> = {
  grossCents: "money",
  refundCents: "money",
  netCents: "money",
  amountCents: "money",
  refundAmountCents: "money",
  expiresAt: "time",
  establishedAt: "time",
  connectedAt: "time",
  createdAt: "time",
  transferredAt: "time",
  occurredAt: "time",
  updatedAt: "time",
  expectedArrivalAt: "time",
  paidAt: "time",
  status: "enum",
  action: "enum",
  authStyle: "enum",
  stripeMode: "enum",
  mode: "enum",
  settlementMethod: "enum",
  kind: "enum",
  reversalStatus: "enum",
  refundStatus: "enum",
  type: "enum",
  scope: "scope",
  provider: "provider",
  currency: "currency",
};

const ENUM_LABELS: Readonly<Record<string, string>> = {
  succeeded: "Paid",
  paid: "Paid",
  active: "Active",
  revoked: "Revoked",
  pending: "Pending",
  live: "Live",
  test: "Test mode",
  oauth: "OAuth",
  api_key: "API key",
  connected: "Connected",
  disconnected: "Not connected",
  not_connected: "Not connected",
};

/** The fields a record's one-line summary leads with, most telling first. */
const SUMMARY_FIELDS: { readonly [K in LiveMirrorKind]: readonly string[] } = {
  profile: ["name", "email"],
  consent: ["scope", "status", "expiresAt"],
  connection: ["establishedAt", "connectedFromContacts"],
  curated_oauth_connector: ["provider", "status", "connectedAt"],
  document_earning: ["grossCents", "netCents", "status", "createdAt"],
  payout_activity: ["amountCents", "kind", "status", "type", "occurredAt"],
  document_request_payment: ["amountCents", "status", "paidAt"],
};
const SUMMARY_LIMIT = 3;
const PREVIEW_LIMIT = 3;
const PRESENCE_ONLY = new Set<string>(LIVE_MIRROR_PRESENCE_ONLY_PREDICATES);
const NUMBER = new Intl.NumberFormat("en-US");
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();
const moneyFormats = new Map<string, Intl.NumberFormat>();

function toMs(value: string | number): number {
  return typeof value === "number" ? value : Date.parse(value);
}

function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** "1 change", "3 changes". */
export function liveMirrorCount(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`;
}

/** "just now", "4 min ago", "2 hr ago", "3 days ago". A future time reads "just now". */
function liveMirrorAgo(at: string, now: string | number): string {
  const minutes = Math.floor(Math.max(0, toMs(now) - Date.parse(at)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${liveMirrorCount(Math.floor(hours / 24), "day")} ago`;
}

/** "42 sec", "3 min", "2 hr". */
function liveMirrorDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.round(ms / 3_600_000)} hr`;
}

/** "Oct 1, 2026, 8:30 AM" in the viewer's time zone unless one is given; null when unreadable. */
export function formatLiveMirrorDateTime(at: unknown, timeZone?: string): string | null {
  const ms = parseConsentInstant(at);
  if (ms === null) return null;
  const zone = timeZone ?? "";
  let format = dateTimeFormats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone });
    dateTimeFormats.set(zone, format);
  }
  return format.format(new Date(ms));
}

/** True for a field stored in minor units of money ("document_earning.netCents"). */
export function liveMirrorIsMoneyPredicate(predicate: string): boolean {
  const field = predicate.slice(predicate.indexOf(".") + 1);
  return Object.hasOwn(FIELD_FORMATS, field) && FIELD_FORMATS[field] === "money";
}

/** Minor units as money in the record's own currency, else US dollars. */
function formatMoney(minorUnits: number, currency: string | null | undefined): string {
  const code = typeof currency === "string" && /^[A-Za-z]{3}$/.test(currency.trim())
    ? currency.trim().toUpperCase()
    : "USD";
  let format = moneyFormats.get(code);
  if (!format) {
    format = new Intl.NumberFormat("en-US", { style: "currency", currency: code });
    moneyFormats.set(code, format);
  }
  return format.format(minorUnits / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
}

/** A known value's plain label, else the value with underscores as spaces in sentence case. */
function enumLabel(value: string): string {
  const known = value.trim().toLowerCase();
  if (Object.hasOwn(ENUM_LABELS, known)) return ENUM_LABELS[known]!;
  const words = value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : value;
}

function providerLabel(value: string): string {
  // The connector catalog's own title for a built-in app ("Google Drive").
  const title = connectorDetailTitle(`connector:${value}`);
  return title && title !== "Connector" ? title : enumLabel(value);
}

export interface LiveMirrorValueOptions {
  /** The record's own currency field; US dollars when absent. */
  currency?: string | null;
  /** A history entry's revision, so a replaced photo reads "Updated". */
  revision?: number;
  /** Defaults to the viewer's time zone. */
  timeZone?: string;
}

/** Owner-facing text for one fact or history value. */
export function formatLiveMirrorValue(
  predicate: string,
  value: LiveMirrorFactValue | null,
  options: LiveMirrorValueOptions = {},
): string {
  if (value === null) return "Sources disagree";
  if (PRESENCE_ONLY.has(predicate)) {
    if (value === false) return "Removed";
    return (options.revision ?? 1) > 1 ? "Updated" : "Added";
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  const format = FIELD_FORMATS[predicate.slice(predicate.indexOf(".") + 1)];
  if (format === "money" && typeof value === "number") return formatMoney(value, options.currency);
  if (format === "time") return formatLiveMirrorDateTime(value, options.timeZone) ?? String(value);
  if (typeof value === "number") return NUMBER.format(value);
  if (format === "scope") return consentInformationLabel({ scope: value });
  if (format === "enum") return enumLabel(value);
  if (format === "provider") return providerLabel(value);
  if (format === "currency") return value.trim().toUpperCase();
  return value;
}

/** The currency named by a record's own facts or changes, if any. */
export function liveMirrorRecordCurrency(
  items: readonly { predicate: string; value: LiveMirrorFactValue | null }[],
): string | null {
  const currency = items.find(item => item.predicate.endsWith(".currency"))?.value;
  return typeof currency === "string" ? currency : null;
}

/** Display order: source kind, record ref, admitted field order. */
export function compareLiveMirrorFacts(left: LiveMirrorFact, right: LiveMirrorFact): number {
  const rank = (ref: string) => Number(/(\d+)$/.exec(ref)?.[1] ?? 0);
  const fields = (fact: LiveMirrorFact) => LIVING_SOURCE_FACT_FIELDS[fact.kind].indexOf(fact.field);
  return LIVE_MIRROR_KINDS.indexOf(left.kind) - LIVE_MIRROR_KINDS.indexOf(right.kind) ||
    rank(left.ref) - rank(right.ref) ||
    fields(left) - fields(right) ||
    byCodeUnit(left.key, right.key);
}

export interface LiveMirrorStatusCopy {
  headline: string;
  sub: string | null;
}

/** One status line for every mirror surface. The time stays in `sub`, outside any live region. */
export function liveMirrorStatus(
  overall: LiveMirrorOverall,
  checked?: { lastVerifiedAt: string | null; evaluatedAt: string } | null,
): LiveMirrorStatusCopy {
  const ago = checked?.lastVerifiedAt ? liveMirrorAgo(checked.lastVerifiedAt, checked.evaluatedAt) : null;
  const sub: Record<LiveMirrorOverall, string | null> = {
    locked: "Unlock to see it",
    loading: null,
    current: ago ? `Checked ${ago}` : null,
    updating: "Checking your latest change",
    stale: ago ? `Last checked ${ago}` : null,
    partial: "Showing what we could check",
    conflict: "Some details disagree",
    empty: "New changes will show here",
  };
  return { headline: HEADLINES[overall], sub: sub[overall] };
}

export function liveMirrorSourceStateLabel(state: LiveMirrorSourceState): string {
  return SOURCE_STATE_LABELS[state];
}

/** A badge for a fact that is not plainly current; null when it is. */
export function liveMirrorFactStateLabel(state: LiveMirrorFactState): string | null {
  return FACT_STATE_LABELS[state] ?? null;
}

/** "3 changes waiting" for committed hints not yet verified; null when none. */
export function liveMirrorWaitingText(pending: number | null): string | null {
  if (pending === null) return "Changes waiting";
  return pending > 0 ? `${liveMirrorCount(pending, "change")} waiting` : null;
}

/** A source row's supporting line: when it was checked, what is waiting and how fast it updates. */
export function liveMirrorSourceDescription(source: LiveMirrorSource, now: string | number): string | undefined {
  const ago = source.verifiedAt ? liveMirrorAgo(source.verifiedAt, now) : null;
  const parts: string[] = [];
  if (source.state === "unavailable") parts.push(ago ? `Couldn’t check · last checked ${ago}` : "Couldn’t check");
  else if (source.state === "withheld") parts.push("Kept out of memory");
  else if (source.state === "stale") parts.push(ago ? `Last checked ${ago}` : "Not checked yet");
  else if (source.state !== "not_checked" && ago) parts.push(`Checked ${ago}`);
  if (source.state !== "withheld" && source.withheld.length > 0) parts.push("Some details kept out");
  const waiting = liveMirrorWaitingText(source.pendingChanges);
  if (waiting) parts.push(waiting);
  if (source.lastLagMs !== null && source.state !== "unavailable") {
    parts.push(`Updated ${liveMirrorDuration(source.lastLagMs)} after change`);
  }
  return parts.length ? parts.join(" · ") : undefined;
}

/** A gap in observed history, counted and never filled in. */
export function liveMirrorGapText(gap: LiveMirrorGap): string {
  if (gap.committedChanges === null) return "Some changes may be missing";
  const made = `${liveMirrorCount(gap.committedChanges, "change")} made`;
  return gap.verifiedChanges === 0 ? `${made}, nothing new seen` : `${made}, only the latest seen`;
}

export function liveMirrorHistoryAction(entry: LiveMirrorHistoryEntry): string {
  return entry.operation === "delete" ? "Removed" : entry.revision === 1 ? "Added" : "Changed";
}

/** "Name: Ankit, Photo: Updated", or "Details hidden" for a record that was later removed. */
export function liveMirrorHistoryDetail(entry: LiveMirrorHistoryEntry, facts: readonly LiveMirrorFact[] = []): string {
  if (entry.redacted) return "Details hidden";
  const currency = liveMirrorRecordCurrency(entry.changes) ??
    liveMirrorRecordCurrency(facts.filter(fact => fact.kind === entry.kind && fact.ref === entry.ref));
  return entry.changes
    .map(change => `${change.label}: ${formatLiveMirrorValue(change.predicate, change.value, { currency, revision: entry.revision })}`)
    .join(", ");
}

export interface LiveMirrorRecordRow {
  /** Owner-only lookup key. Never rendered. */
  key: string;
  kind: LiveMirrorKind;
  ref: string;
  /** "Label: value" for the record's leading fields, or "Sources disagree". */
  summary: string;
  /** Every admitted field, formatted, in admitted order. */
  fields: { key: string; label: string; value: string }[];
  state: LiveMirrorFactState;
  revision: number;
  sourceUpdatedAt: string | null;
  capturedAt: string;
  verifiedAt: string | null;
}

const STATE_SEVERITY: Record<LiveMirrorFactState, number> = { verified: 0, stale: 1, unavailable: 2, deleted: 3, conflicted: 4 };

/** One row per record, in display order, each with a one-line summary. */
export function liveMirrorRecordRows(facts: readonly LiveMirrorFact[]): LiveMirrorRecordRow[] {
  const records = new Map<string, LiveMirrorFact[]>();
  for (const fact of [...facts].sort(compareLiveMirrorFacts)) {
    const key = JSON.stringify([fact.kind, fact.sourceId]);
    records.set(key, [...(records.get(key) ?? []), fact]);
  }
  return [...records].map(([key, record]): LiveMirrorRecordRow => {
    const first = record[0]!;
    const currency = liveMirrorRecordCurrency(record);
    const state = record.reduce<LiveMirrorFactState>(
      (worst, fact) => (STATE_SEVERITY[fact.state] > STATE_SEVERITY[worst] ? fact.state : worst), "verified");
    const fields = record.map(fact => ({
      key: fact.key,
      label: fact.label,
      value: fact.state === "conflicted" ? "Sources disagree" : formatLiveMirrorValue(fact.predicate, fact.value, { currency }),
    }));
    const leading = SUMMARY_FIELDS[first.kind].flatMap(field => {
      const index = record.findIndex(fact => fact.field === field);
      return index < 0 ? [] : [fields[index]!];
    });
    return {
      key,
      kind: first.kind,
      ref: first.ref,
      summary: state === "conflicted" ? "Sources disagree"
        : (leading.length ? leading : fields).slice(0, SUMMARY_LIMIT).map(field => `${field.label}: ${field.value}`).join(" · "),
      fields,
      state,
      revision: first.revision,
      sourceUpdatedAt: first.sourceUpdatedAt,
      capturedAt: first.capturedAt,
      verifiedAt: first.verifiedAt,
    };
  });
}

export interface LiveMirrorPreviewRow {
  key: string;
  title: string;
  /** Null when there is no value to show, such as a disagreement. */
  description: string | null;
  state: LiveMirrorFactState;
}

function changedAt(row: LiveMirrorRecordRow): number {
  const at = Date.parse(row.sourceUpdatedAt ?? row.capturedAt);
  return Number.isFinite(at) ? at : 0;
}

/** The compact preview's rows: name, email, then the newest verified records' summaries. */
export function liveMirrorPreviewRows(facts: readonly LiveMirrorFact[]): LiveMirrorPreviewRow[] {
  const named = ["profile.name", "profile.email"].flatMap((predicate): LiveMirrorPreviewRow[] => {
    const fact = facts.find(each => each.predicate === predicate);
    if (!fact) return [];
    const description = fact.state === "conflicted" || fact.value === null ? null : formatLiveMirrorValue(fact.predicate, fact.value);
    return [{ key: fact.key, title: fact.label, description, state: fact.state }];
  });
  const newest = liveMirrorRecordRows(facts)
    .filter(row => row.kind !== "profile" && row.state === "verified")
    .sort((left, right) => changedAt(right) - changedAt(left))
    .map((row): LiveMirrorPreviewRow => ({ key: row.key, title: row.ref, description: row.summary, state: row.state }));
  return [...named, ...newest].slice(0, PREVIEW_LIMIT);
}

/**
 * Where each living source is changed, built only from existing route
 * helpers. Account edits the name (the photo editor is on the Profile page one
 * step back), consents and connections have their own workspaces, Connectors
 * is a Profile section, earnings and wallet activity are managed under
 * Payouts (/one/wallet holds payment cards, not earnings), and paid document
 * requests are the consent center's Sent documents. Every kind has a surface.
 */
const SOURCE_ROUTES: Readonly<Record<LiveMirrorKind, LiveMirrorSourceRoute>> = {
  profile: { href: buildProfileRoute({ panel: "account" }), label: "Edit profile" },
  consent: { href: ROUTES.CONSENTS, label: "Open consents" },
  connection: { href: ROUTES.CONNECT, label: "Open connections" },
  curated_oauth_connector: { href: buildProfileRoute({ panel: "connectors" }), label: "Open connectors" },
  document_earning: { href: buildProfileRoute({ panel: "payouts" }), label: "Open payouts" },
  payout_activity: { href: buildProfileRoute({ panel: "payouts" }), label: "Open payouts" },
  document_request_payment: { href: buildConsentCenterHref("pending", { requestView: "sent" }), label: "Open sent documents" },
};

/**
 * Where the owner corrects or removes a source's values, for source rows,
 * record details and each side's fix link, and the preview's section links;
 * null for an unknown kind. Never a mirror write path: the source changes
 * there and both mirrors refresh from it.
 */
export function liveMirrorSourceRoute(kind: LiveMirrorKind): LiveMirrorSourceRoute | null {
  return Object.hasOwn(SOURCE_ROUTES, kind) ? { ...SOURCE_ROUTES[kind] } : null;
}

/** One side of a disagreement, worded the same way on every surface. */
export interface LiveMirrorClaimText {
  /** Who says it: "Your memory", "Profile", "Earning 2". */
  label: string;
  value: string;
  /** "Checked 4 min ago · Version 3"; when it changed for a record's copy, or if never checked. */
  detail: string | null;
}

/** Stable presentation identity while values or source order elsewhere change. */
export function liveMirrorConflictKey(conflict: LiveMirrorConflict): string {
  return JSON.stringify([conflict.predicate, conflict.claims.map(claim => [claim.source, claim.label])]);
}

export function liveMirrorClaimText(
  claim: LiveMirrorClaim,
  predicate: string,
  now: string | number,
  timeZone?: string,
): LiveMirrorClaimText {
  const value = claim.value === null
    ? "Not set"
    : formatLiveMirrorValue(predicate, claim.value, {
      currency: claim.currency ?? null,
      revision: claim.revision ?? undefined,
      timeZone,
    });
  const changed = claim.sourceUpdatedAt ? formatLiveMirrorDateTime(claim.sourceUpdatedAt, timeZone) : null;
  // A record's copies share one check, so each copy is told apart by when it changed.
  const when = claim.origin === "record" && changed ? `Changed ${changed}`
    : claim.verifiedAt ? `Checked ${liveMirrorAgo(claim.verifiedAt, now)}`
      : changed ? `Changed ${changed}` : null;
  const detail = [when, claim.revision ? `Version ${claim.revision}` : null].filter(Boolean).join(" · ");
  return { label: claim.source === "soul" ? "Your memory" : claim.label, value, detail: detail || null };
}

/** Where to fix one side: memory.md for the owner's own words, else the screen that owns the source. */
export function liveMirrorClaimRoute(claim: LiveMirrorClaim, predicate: string): LiveMirrorSourceRoute | null {
  if (claim.source === "soul") return { href: ROUTES.PKM, label: "Edit memory.md" };
  const dot = predicate.indexOf(".");
  const kind = dot > 0 ? predicate.slice(0, dot) : "";
  return (LIVE_MIRROR_KINDS as readonly string[]).includes(kind) ? liveMirrorSourceRoute(kind as LiveMirrorKind) : null;
}

/**
 * Each distinct place a side of these disagreements is corrected, in claim
 * order: memory.md for what the owner wrote, else the screen that owns the
 * source. `includeMemory: false` leaves memory.md out where Memory is already
 * open or a tap away.
 */
export function liveMirrorFixRoutes(
  conflicts: readonly LiveMirrorConflict[],
  { includeMemory = true }: { includeMemory?: boolean } = {},
): LiveMirrorSourceRoute[] {
  const routes = new Map<string, LiveMirrorSourceRoute>();
  for (const conflict of conflicts) {
    for (const claim of conflict.claims) {
      if (claim.source === "soul" && !includeMemory) continue;
      const route = liveMirrorClaimRoute(claim, conflict.predicate);
      if (route && !routes.has(route.href)) routes.set(route.href, route);
    }
  }
  return [...routes.values()];
}
