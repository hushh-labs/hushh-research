/**
 * Words for live activity events: a short UI line, first-person digest lines
 * for memory consolidation and a dated packet for chat turns. Pure functions;
 * every word comes from an authored kind, an allowlisted subject or a place
 * label: the owner's own name for a saved place, or a Google venue's public
 * name. Labels are third-party or free text, so wherever a model reads them
 * (digest and chat packet) they are quoted as names, never owner speech.
 */

import { getAgentSection, getAgentsRootSection } from "@/lib/navigation/agent-sections";
import { getOneCapability } from "@/lib/onboarding/one-capabilities";
import { LIVE_ACTIVITY_KINDS, type LiveActivityEvent, type LiveActivityKind } from "./live-activity-types";

const MAX_PACKET_LINES = 20;
const DEFAULT_LOCALE = "en-GB";
const PACKET_HEADER = "Recent activity in One today (seen on this device, not saved memory):";

/** Route ids from lib/observability/route-map.ts that are not agent sections. */
const ROUTE_LABELS: Readonly<Record<string, string>> = {
  connect: "Connections",
  profile_world_model: "Personal World Model",
  one_documents: "Documents",
};
const CONNECTOR_LABELS: Readonly<Record<string, string>> = {
  gmail: "Gmail",
  google_drive: "Google Drive",
  google_calendar: "Google Calendar",
};

function ownLabel(table: Readonly<Record<string, string>>, key: string | null): string | null {
  return key && Object.prototype.hasOwnProperty.call(table, key) ? table[key] ?? null : null;
}

/** Roster label first; a hidden or gated section keeps its authored title. Subjects spell "-" as "_". */
function sectionLabel(subject: string | null): string {
  if (!subject) return "One";
  const sectionId = subject.replace(/_/g, "-");
  return getAgentSection(sectionId)?.label ?? getOneCapability(sectionId)?.title
    ?? ownLabel(ROUTE_LABELS, subject) ?? "One";
}

/** The One home is the hub between sections, not a section the owner used. */
function isHomeVisit(event: LiveActivityEvent): boolean {
  return event.kind === "section_opened" &&
    (!event.subject || event.subject.replace(/_/g, "-") === getAgentsRootSection().id);
}

function connectorLabel(subject: string | null): string {
  return ownLabel(CONNECTOR_LABELS, subject) ?? "a service";
}

type NameStyle = (label: string) => string;
const plainName: NameStyle = label => label;
/** A label as a quoted name for model input; inner double quotes become single so the name stays one span. */
const quotedName: NameStyle = label => `"${label.replace(/["“”]/g, "'")}"`;

const DESCRIBE: Readonly<Record<LiveActivityKind, (event: LiveActivityEvent, name: NameStyle) => string>> = {
  section_opened: e => `Opened ${sectionLabel(e.subject)}`,
  connector_connected: e => `Connected ${connectorLabel(e.subject)}`,
  connector_disconnected: e => `Disconnected ${connectorLabel(e.subject)}`,
  // Passive: the backend also syncs on its own (webhooks, reconciliation), so a sync is not an owner action.
  connector_synced: e => `${ownLabel(CONNECTOR_LABELS, e.subject) ?? "A service"} synced`,
  connector_sync_failed: e => `${ownLabel(CONNECTOR_LABELS, e.subject) ?? "A service"} sync failed`,
  location_sharing_started: () => "Started sharing location",
  location_sharing_stopped: () => "Stopped sharing location",
  place_saved: (e, name) => (e.label ? `Saved ${name(e.label)}` : "Saved a place"),
  place_removed: (e, name) => (e.label ? `Removed ${name(e.label)}` : "Removed a place"),
  checked_in: (e, name) => (e.label ? `Checked in at ${name(e.label)}` : "Checked in"),
  connection_request_sent: () => "Sent a connection request",
  connection_accepted: () => "Accepted a connection",
  connection_removed: () => "Removed a connection",
  consent_approved: () => "Approved an access request",
  consent_declined: () => "Declined an access request",
  consent_revoked: () => "Revoked access",
  profile_updated: () => "Updated profile",
  pwm_reviewed: () => "Reviewed Personal World Model",
  memory_saved: () => "Saved to memory",
  wallet_card_added: () => "Added a wallet card",
  wallet_card_removed: () => "Removed a wallet card",
};

/** Short UI line: "Opened Location", "Connected Gmail", "Saved Office", "Accepted a connection". Count > 1 is rendered by the UI, not here. `quoteNames` marks place labels as names for model input. */
export function describeLiveActivity(event: LiveActivityEvent, options: { quoteNames?: boolean } = {}): string {
  return DESCRIBE[event.kind](event, options.quoteNames ? quotedName : plainName);
}

type DayGroup = { total: number; names: string[] };

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const times = (count: number) => (count > 1 ? ` (${count} times)` : "");
const counted = (count: number, one: string, many: string) => (count === 1 ? one : `${count} ${many}`);
const quotedList = (names: readonly string[]) => joinList(names.map(quotedName));
const places = (verb: string, g: DayGroup) => (g.names.length
  ? `I ${verb} ${g.names.length === 1 ? "the place" : "the places"} ${quotedList(g.names)}`
  : `I ${verb} ${counted(g.total, "a place", "places")}`);

/**
 * Kinds absent here never reach consolidation: memory_saved, consent_*,
 * profile_updated and connector sync results are already saved elsewhere or
 * carry no durable meaning. section_opened becomes the per-day usage line.
 */
const STATEMENTS: Readonly<Partial<Record<LiveActivityKind, (g: DayGroup) => string>>> = {
  connector_connected: g => `I connected ${joinList(g.names)}`,
  connector_disconnected: g => `I disconnected ${joinList(g.names)}`,
  location_sharing_started: g => `I started sharing my location${times(g.total)}`,
  location_sharing_stopped: g => `I stopped sharing my location${times(g.total)}`,
  place_saved: g => places("saved", g),
  place_removed: g => places("removed", g),
  checked_in: g => (g.names.length ? `I checked in at ${quotedList(g.names)}` : `I checked in${times(g.total)}`),
  connection_request_sent: g => `I sent ${counted(g.total, "a connection request", "connection requests")}`,
  connection_accepted: g => `I accepted ${counted(g.total, "a connection", "connections")}`,
  connection_removed: g => `I removed ${counted(g.total, "a connection", "connections")}`,
  pwm_reviewed: g => `I reviewed my Personal World Model${times(g.total)}`,
  wallet_card_added: g => `I added ${counted(g.total, "a card", "cards")} to my wallet`,
  wallet_card_removed: g => `I removed ${counted(g.total, "a card", "cards")} from my wallet`,
};

/** One consolidation cycle (one local day's not-yet-consolidated events) yields at most one line per statement kind plus the usage line. */
const MAX_STATEMENTS = Object.keys(STATEMENTS).length + 1;

function statementName(event: LiveActivityEvent): string | null {
  if (event.kind === "section_opened") return sectionLabel(event.subject);
  if (event.kind === "connector_connected" || event.kind === "connector_disconnected") return connectorLabel(event.subject);
  return event.label;
}

function dateFormatter(locale: string, options: Intl.DateTimeFormatOptions, timeZone?: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone });
  } catch {
    // An unknown zone or locale falls back to the device default.
    return new Intl.DateTimeFormat(DEFAULT_LOCALE, options);
  }
}

function dayKeyFormatter(timeZone?: string): Intl.DateTimeFormat {
  return dateFormatter("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }, timeZone);
}

/** Local calendar day key (YYYY-MM-DD) in the given zone, or the device zone when omitted. */
export function liveActivityDayKey(timeZone?: string): (at: number) => string {
  const formatter = dayKeyFormatter(timeZone);
  return at => formatter.format(at);
}

type KindGroup = { total: number; names: Map<string, number> };
type Day = { at: number; kinds: Map<LiveActivityKind, KindGroup> };

/** Opposing actions on the same thing share a key; null when the event has no opposite or no identity. */
function opposingPairKey(event: LiveActivityEvent): string | null {
  switch (event.kind) {
    case "connector_connected":
    case "connector_disconnected":
      return event.subject ? `connector|${event.subject}` : null;
    case "place_saved":
    case "place_removed":
      return event.label ? `place|${event.label}` : null;
    case "location_sharing_started":
    case "location_sharing_stopped":
      return "location_sharing";
    default:
      return null;
  }
}

/** Within the events of one cycle and day only the latest of an opposing pair survives, so a reconnect in the same cycle never reads as a disconnect. A day can arrive in several cycles; the model reconciles across them. */
function finalStatePerDay(events: readonly LiveActivityEvent[], dayKey: (at: number) => string): LiveActivityEvent[] {
  const latest = new Map<string, LiveActivityEvent>();
  for (const event of events) {
    const pair = opposingPairKey(event);
    if (!pair) continue;
    const key = `${dayKey(event.lastAt)}|${pair}`;
    const kept = latest.get(key);
    if (!kept || event.lastAt > kept.lastAt || (event.lastAt === kept.lastAt && event.firstAt >= kept.firstAt)) {
      latest.set(key, event);
    }
  }
  const survivors = new Set(latest.values());
  return events.filter(event => !opposingPairKey(event) || survivors.has(event));
}

/** Days oldest first; each kind keeps its names in first-seen order with summed counts. */
function groupByDay(events: readonly LiveActivityEvent[], timeZone?: string): Day[] {
  const dayKey = liveActivityDayKey(timeZone);
  const days = new Map<string, Day>();
  for (const event of finalStatePerDay(events, dayKey)) {
    if (event.kind !== "section_opened" && !STATEMENTS[event.kind]) continue;
    if (isHomeVisit(event)) continue;
    const key = dayKey(event.lastAt);
    const day = days.get(key) ?? { at: event.lastAt, kinds: new Map() };
    days.set(key, day);
    const group = day.kinds.get(event.kind) ?? { total: 0, names: new Map<string, number>() };
    day.kinds.set(event.kind, group);
    group.total += event.count;
    const name = statementName(event);
    if (name) group.names.set(name, (group.names.get(name) ?? 0) + event.count);
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, day]) => day);
}

function usageLine(names: Map<string, number>): string {
  const items = [...names.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}${times(count)}`);
  return `I used ${joinList(items)} in One`;
}

/** First-person, dated digest lines for consolidation, grouped per day and kind over the events passed in (consolidation passes one cycle: one local day's not-yet-consolidated events, so counts cover that cycle, not the whole day). The line bound is only a defensive limit. Excludes memory_saved, consent_*, profile_updated, connector_synced, connector_sync_failed and visits to the One home. An opposing pair within the events passed (connect/disconnect per service, save/remove per place, start/stop sharing) keeps only its final state. Place labels are quoted names. section_opened becomes one usage line per day ("On 29 Oct 2026 I used Location (5 times), Mail (2 times) and Files in One."). */
export function liveActivityStatements(
  events: readonly LiveActivityEvent[],
  options: { timeZone?: string; locale?: string } = {},
): string[] {
  const dateLabel = dateFormatter(options.locale ?? DEFAULT_LOCALE,
    { day: "numeric", month: "short", year: "numeric" }, options.timeZone);
  const lines: string[] = [];
  for (const day of groupByDay(events, options.timeZone)) {
    const date = dateLabel.format(day.at);
    for (const kind of LIVE_ACTIVITY_KINDS) {
      const group = day.kinds.get(kind);
      if (!group) continue;
      const clause = kind === "section_opened"
        ? usageLine(group.names)
        : STATEMENTS[kind]?.({ total: group.total, names: [...group.names.keys()] });
      if (clause) lines.push(`On ${date} ${clause}.`);
    }
  }
  return lines.slice(-MAX_STATEMENTS);
}

/** "" when nothing happened today (visits to the One home are left out); else "Recent activity in One today (seen on this device, not saved memory):" followed by <= 20 lines "HH:MM <describe>" newest first. */
export function liveActivityAgentPacket(
  events: readonly LiveActivityEvent[],
  now: number,
  options: { timeZone?: string; maxChars?: number } = {},
): string {
  const dayKey = liveActivityDayKey(options.timeZone);
  const today = dayKey(now);
  const clock = dateFormatter(DEFAULT_LOCALE, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, options.timeZone);
  const lines = events
    .filter(event => dayKey(event.lastAt) === today && !isHomeVisit(event))
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, MAX_PACKET_LINES)
    .map(event => `${clock.format(event.lastAt)} ${describeLiveActivity(event, { quoteNames: true })}${times(event.count)}`);
  // Newest lines first, as many as fit; a header with no line is left out.
  const maxChars = options.maxChars ?? Number.POSITIVE_INFINITY;
  let packet = "";
  for (const line of lines) {
    const next = `${packet || PACKET_HEADER}\n${line}`;
    if (next.length > maxChars) break;
    packet = next;
  }
  return packet;
}
