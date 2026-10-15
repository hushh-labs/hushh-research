import { apiJson } from "@/lib/services/api-client";
import { ApiService } from "@/lib/services/api-service";

const CURSOR = /^(0|[1-9][0-9]{0,18})$/;
const MAX_CURSOR = 9_223_372_036_854_775_807n;

function cursor(value: unknown): bigint {
  if (typeof value !== "string" || !CURSOR.test(value))
    throw new Error("Connector journal cursor is invalid");
  const parsed = BigInt(value);
  if (parsed > MAX_CURSOR) throw new Error("Connector journal cursor is invalid");
  return parsed;
}

/** A hint only schedules an authoritative connector overview read. Its event
 * fields never become memory facts or grant another person access. */
export type ConnectorJournalHead = {
  headCursor: string;
  changed: boolean;
};

export class SourceJournalService {
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
      if (page.events.length !== 0 || page.hasMore || next !== afterValue ||
          !(afterValue < earliest || afterValue > head))
        throw new Error("Connector journal reset is invalid");
      return { headCursor: String(head), changed: true };
    }

    if (afterValue < earliest || afterValue > head ||
        page.events.length !== (head > afterValue ? 1 : 0) ||
        page.hasMore !== (head > next))
      throw new Error("Connector journal page is incomplete");
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
    }
    return { headCursor: String(head), changed: head > afterValue };
  }
}
