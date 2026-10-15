import { apiJson } from "@/lib/services/api-client";
import { ApiService } from "@/lib/services/api-service";

const CURSOR = /^(0|[1-9][0-9]{0,18})$/;
const MAX_CURSOR = 9_223_372_036_854_775_807n;
const EVENT_PAGE_SIZE = 100;
const MAX_EVENT_PAGES = 32;

export const SOURCE_JOURNAL_KINDS = [
  "profile", "consent", "connection", "document_earning", "payout_activity",
  "document_request_payment",
] as const;
export type SourceJournalKind = typeof SOURCE_JOURNAL_KINDS[number];
const SOURCE_KINDS = new Set<string>(SOURCE_JOURNAL_KINDS);

function cursor(value: unknown, label = "Connector"): bigint {
  if (typeof value !== "string" || !CURSOR.test(value))
    throw new Error(`${label} journal cursor is invalid`);
  const parsed = BigInt(value);
  if (parsed > MAX_CURSOR) throw new Error(`${label} journal cursor is invalid`);
  return parsed;
}

export function isSourceJournalCursor(value: unknown): value is string {
  try { cursor(value, "Source"); return true; } catch { return false; }
}

/** Count and commit-time range of the replayed hints for one source kind.
 * Never an event, source or record identifier. */
export type JournalHint = { count: number; firstOccurredAt: string; lastOccurredAt: string };

/** A hint only schedules an authoritative connector overview read. Its event
 * fields never become memory facts or grant another person access. */
export type ConnectorJournalHead = {
  headCursor: string;
  changed: boolean;
  resetRequired: boolean;
  /** Committed connector hints after the cursor; null after a reset. */
  pendingCount: number | null;
  /** Commit time of the oldest of those hints. */
  firstOccurredAt: string | null;
};

export type SourceJournalChanges = {
  headCursor: string;
  changedKinds: SourceJournalKind[];
  resetRequired: boolean;
  /** Per-kind hint counts; empty unless `exact`. */
  hints: Partial<Record<SourceJournalKind, JournalHint>>;
  /** False after a backend reset or a bounded replay that stopped early. */
  exact: boolean;
};

function commitTime(value: string): string {
  return new Date(Date.parse(value)).toISOString();
}

/** A backend reset carries no events and leaves the cursor where it was. It may
 * also be inside the retained range, when a sequence is missing there. */
function isJournalReset(page: Record<string, unknown>, after: bigint, next: bigint): boolean {
  return Array.isArray(page.events) && page.events.length === 0 &&
    page.hasMore === false && next === after;
}

/** Replay metadata-only hints to a captured head. A gap or excessive backlog
 * forces complete source scans; no event field is projected as a memory fact. */
async function sourceChanges(vaultOwnerToken: string, after: string): Promise<SourceJournalChanges> {
  let position = cursor(after, "Source");
  if (!vaultOwnerToken) throw new Error("Unlock your vault to read source changes");
  let capturedHead: bigint | null = null;
  const counts = new Map<SourceJournalKind, { count: number; first: number; last: number }>();
  for (let pageNumber = 0; pageNumber < MAX_EVENT_PAGES; pageNumber++) {
    const remaining = capturedHead === null ? EVENT_PAGE_SIZE :
      Number(capturedHead - position);
    const limit = Math.min(EVENT_PAGE_SIZE, remaining);
    const body = await apiJson<unknown>(
      `/api/one/source-journal/events?after=${position}&limit=${limit}`,
      { method: "GET", headers: ApiService.getAuthHeaders(vaultOwnerToken), cache: "no-store" },
    );
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error("Source journal response is invalid");
    const result = body as Record<string, unknown>;
    const head = cursor(result.headCursor, "Source");
    const earliest = cursor(result.earliestCursor, "Source");
    const next = cursor(result.nextCursor, "Source");
    if (typeof result.resetRequired !== "boolean" || typeof result.hasMore !== "boolean" ||
        !Array.isArray(result.events) || result.events.length > limit || earliest > head)
      throw new Error("Source journal response is invalid");
    if (result.resetRequired) {
      if (!isJournalReset(result, position, next))
        throw new Error("Source journal reset is invalid");
      return {
        headCursor: String(head), changedKinds: [...SOURCE_JOURNAL_KINDS],
        resetRequired: true, hints: {}, exact: false,
      };
    }
    if (position < earliest || position > head ||
        (capturedHead !== null && head < capturedHead))
      throw new Error("Source journal page is incomplete");
    if (capturedHead === null) capturedHead = head;
    if (head > position && result.events.length === 0)
      throw new Error("Source journal page is incomplete");
    if (result.events.length !== Number(next - position) ||
        result.hasMore !== (head > next) || next > head)
      throw new Error("Source journal page is incomplete");
    for (const event of result.events) {
      if (!event || typeof event !== "object" || Array.isArray(event))
        throw new Error("Source journal event is invalid");
      const row = event as Record<string, unknown>;
      const sequence = cursor(row.sequence, "Source");
      if (sequence !== position + 1n ||
          typeof row.eventId !== "string" || !row.eventId ||
          typeof row.sourceKind !== "string" || !SOURCE_KINDS.has(row.sourceKind) ||
          !["changed", "deleted"].includes(String(row.operation)) ||
          row.schemaVersion !== 1 || typeof row.occurredAt !== "string" ||
          !Number.isFinite(Date.parse(row.occurredAt)))
        throw new Error("Source journal event is invalid");
      const at = Date.parse(row.occurredAt);
      const prior = counts.get(row.sourceKind as SourceJournalKind);
      counts.set(row.sourceKind as SourceJournalKind, prior ? {
        count: prior.count + 1, first: Math.min(prior.first, at), last: Math.max(prior.last, at),
      } : { count: 1, first: at, last: at });
      position = sequence;
    }
    if (position !== next || (position < capturedHead && !result.hasMore))
      throw new Error("Source journal page is incomplete");
    if (position === capturedHead) {
      const hints: Partial<Record<SourceJournalKind, JournalHint>> = {};
      for (const kind of SOURCE_JOURNAL_KINDS) {
        const hint = counts.get(kind);
        if (hint) hints[kind] = {
          count: hint.count,
          firstOccurredAt: new Date(hint.first).toISOString(),
          lastOccurredAt: new Date(hint.last).toISOString(),
        };
      }
      return {
        headCursor: String(capturedHead),
        changedKinds: SOURCE_JOURNAL_KINDS.filter((kind) => counts.has(kind)),
        resetRequired: false,
        hints,
        exact: true,
      };
    }
  }
  // Snapshot after the captured head is still authoritative, even if replay
  // was too long to list every hint within this bounded client read.
  return {
    headCursor: String(capturedHead),
    changedKinds: [...SOURCE_JOURNAL_KINDS],
    resetRequired: true,
    hints: {},
    exact: false,
  };
}

export class SourceJournalService {
  static sourceChanges = sourceChanges;

  static async connectorHead(
    vaultOwnerToken: string,
    after: string,
  ): Promise<ConnectorJournalHead> {
    const afterValue = cursor(after);
    if (!vaultOwnerToken) throw new Error("Unlock your vault to read connector changes");
    const body = await apiJson<unknown>(
      `/api/one/source-journal/connectors?after=${encodeURIComponent(after)}&limit=1`,
      { method: "GET", headers: ApiService.getAuthHeaders(vaultOwnerToken), cache: "no-store" },
    );
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error("Connector journal response is invalid");
    const page = body as Record<string, unknown>;
    const head = cursor(page.headCursor);
    const earliest = cursor(page.earliestCursor);
    const next = cursor(page.nextCursor);
    if (typeof page.resetRequired !== "boolean" || typeof page.hasMore !== "boolean" ||
        !Array.isArray(page.events) || page.events.length > 1 || earliest > head)
      throw new Error("Connector journal response is invalid");

    if (page.resetRequired) {
      if (!isJournalReset(page, afterValue, next))
        throw new Error("Connector journal reset is invalid");
      return {
        headCursor: String(head), changed: true, resetRequired: true,
        pendingCount: null, firstOccurredAt: null,
      };
    }

    if (afterValue < earliest || afterValue > head ||
        page.events.length !== (head > afterValue ? 1 : 0) ||
        page.hasMore !== (head > next))
      throw new Error("Connector journal page is incomplete");
    let firstOccurredAt: string | null = null;
    if (page.events.length === 0) {
      if (next !== afterValue) throw new Error("Connector journal page is incomplete");
    } else {
      const event = page.events[0];
      if (!event || typeof event !== "object" || Array.isArray(event))
        throw new Error("Connector journal event is invalid");
      const row = event as Record<string, unknown>;
      if (cursor(row.sequence) !== afterValue + 1n || next !== afterValue + 1n ||
          typeof row.eventId !== "string" || !row.eventId ||
          typeof row.sourceId !== "string" || !row.sourceId ||
          !["changed", "deleted"].includes(String(row.operation)) ||
          row.schemaVersion !== 1 || typeof row.occurredAt !== "string" ||
          !Number.isFinite(Date.parse(row.occurredAt)))
        throw new Error("Connector journal event is invalid");
      firstOccurredAt = commitTime(row.occurredAt);
    }
    const pending = head - afterValue;
    return {
      headCursor: String(head),
      changed: head > afterValue,
      resetRequired: false,
      pendingCount: pending <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(pending) : null,
      firstOccurredAt,
    };
  }
}
