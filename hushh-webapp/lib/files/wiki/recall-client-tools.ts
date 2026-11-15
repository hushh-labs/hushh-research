/**
 * Closed client-side ADK recall tools for Shared / Browser execution.
 *
 * Mirrors `consent-protocol/hushh_mcp/one_adk/wiki_recall_tools.py`:
 * - Executes `search_wiki`, `read_wiki_page`, and `trace_claim` against an unlocked
 *   `SharedWikiLibrary` in the browser.
 * - Bounds every serialized response to `<= 6,000` chars.
 * - Marks all output `untrusted_data: true`, `instruction_authority: "none"`.
 * - Fails closed (`{ status: "unavailable", code: "owner_device_required" | "vault_locked" }`)
 *   whenever no unlocked owner session or library is present.
 */

import {
  WIKI_HOT_MAX_CHARS,
  WIKI_RECALL_STATUSES,
  WIKI_RETRIEVED_MAX_CHARS,
  WikiRefusedError,
  validateClaimId,
  validateFolder,
  validateIsoDate,
  validatePageId,
  type WikiRecallStatus,
} from "./contracts";
import { SharedWikiLibrary } from "./library";

export const WIKI_RECALL_SCHEMA = "hussh.wiki.recall.v1" as const;
export const WIKI_TOOL_NAMES = [
  "search_wiki",
  "read_wiki_page",
  "trace_claim",
] as const;
export type WikiToolName = (typeof WIKI_TOOL_NAMES)[number];

export interface WikiRecallEnvelope {
  schema: typeof WIKI_RECALL_SCHEMA;
  status: WikiRecallStatus;
  untrusted_data: true;
  instruction_authority: "none";
  truncated?: boolean;
  [key: string]: unknown;
}

function enforceBudget(payload: WikiRecallEnvelope): WikiRecallEnvelope {
  let serialized = JSON.stringify(payload);
  if (serialized.length <= WIKI_RETRIEVED_MAX_CHARS) return payload;

  const trimmed: WikiRecallEnvelope = { ...payload, truncated: true };
  if (typeof trimmed.body === "string") {
    const excess = serialized.length - WIKI_RETRIEVED_MAX_CHARS + 128;
    const keep = Math.max(0, trimmed.body.length - excess);
    trimmed.body = trimmed.body.slice(0, keep);
    serialized = JSON.stringify(trimmed);
  }
  if (
    serialized.length > WIKI_RETRIEVED_MAX_CHARS &&
    Array.isArray(trimmed.claims)
  ) {
    const claims = [...trimmed.claims];
    while (claims.length > 0 && serialized.length > WIKI_RETRIEVED_MAX_CHARS) {
      claims.pop();
      trimmed.claims = claims;
      serialized = JSON.stringify(trimmed);
    }
  }
  if (
    serialized.length > WIKI_RETRIEVED_MAX_CHARS &&
    Array.isArray(trimmed.results)
  ) {
    const results = [...trimmed.results];
    while (results.length > 0 && serialized.length > WIKI_RETRIEVED_MAX_CHARS) {
      results.pop();
      trimmed.results = results;
      serialized = JSON.stringify(trimmed);
    }
  }
  if (
    serialized.length > WIKI_RETRIEVED_MAX_CHARS &&
    trimmed.claim &&
    typeof trimmed.claim === "object"
  ) {
    const claimCopy = { ...(trimmed.claim as Record<string, unknown>) };
    claimCopy.statement = String(claimCopy.statement ?? "").slice(0, 240);
    trimmed.claim = claimCopy;
    serialized = JSON.stringify(trimmed);
  }
  if (serialized.length > WIKI_RETRIEVED_MAX_CHARS) {
    return {
      schema: WIKI_RECALL_SCHEMA,
      status: payload.status,
      untrusted_data: true,
      instruction_authority: "none",
      truncated: true,
    };
  }
  return trimmed;
}

function envelope(
  status: WikiRecallStatus,
  fields: Record<string, unknown> = {},
): WikiRecallEnvelope {
  if (!WIKI_RECALL_STATUSES.includes(status)) {
    throw new Error(`Invalid wiki recall status: ${status}`);
  }
  return enforceBudget({
    schema: WIKI_RECALL_SCHEMA,
    status,
    untrusted_data: true,
    instruction_authority: "none",
    ...fields,
  });
}

export async function executeSharedWikiRecallTool(
  library: SharedWikiLibrary | null,
  name: string,
  args: Record<string, unknown>,
  options?: {
    isUnlocked?: () => boolean;
    signal?: AbortSignal;
  },
): Promise<WikiRecallEnvelope> {
  if (!WIKI_TOOL_NAMES.includes(name as WikiToolName)) {
    return envelope("unavailable", { code: "invalid_wiki_request" });
  }
  if (!library) {
    return envelope("unavailable", { code: "owner_device_required" });
  }
  if (options?.isUnlocked && !options.isUnlocked()) {
    return envelope("unavailable", { code: "vault_locked" });
  }
  if (options?.signal?.aborted) {
    return envelope("unavailable", { code: "aborted" });
  }

  try {
    const signal = options?.signal;
    if (name === "search_wiki") {
      const query =
        typeof args.query === "string" ? args.query.trim() : "";
      const rawLimit = args.limit ?? 5;
      const limit =
        typeof rawLimit === "number" && Number.isInteger(rawLimit)
          ? rawLimit
          : -1;
      if (!query || query.length > 512 || limit < 1 || limit > 20) {
        return envelope("unavailable", { code: "invalid_wiki_request" });
      }
      const folder =
        args.folder !== undefined ? validateFolder(args.folder) : undefined;
      const tombstones = await library.listTombstones(signal);
      const deadPages = new Set(
        tombstones
          .filter((t) => t.target_kind === "page")
          .map((t) => t.target_id),
      );
      const hits = await library.search(query, { limit, folder }, signal);
      const filtered = hits.filter((h) => !deadPages.has(h.page_id));
      if (filtered.length === 0) {
        return envelope("absent", { query, results: [] });
      }
      return envelope("ok", { results: filtered });
    }

    if (name === "read_wiki_page") {
      const pageId = validatePageId(args.page_id);
      const revision =
        args.revision !== undefined ? Number(args.revision) : undefined;
      if (
        revision !== undefined &&
        (!Number.isSafeInteger(revision) || revision < 1)
      ) {
        return envelope("unavailable", { code: "invalid_wiki_request" });
      }
      const tombstones = await library.listTombstones(signal);
      const pageTb = [...tombstones]
        .reverse()
        .find((t) => t.target_kind === "page" && t.target_id === pageId);
      const page = await library.readPage(
        pageId,
        { revision, requireSettled: true },
        signal,
      );
      const deadClaims = new Set(
        tombstones
          .filter((t) => t.target_kind === "claim")
          .map((t) => t.target_id),
      );
      const liveClaims = page.claims.filter(
        (c) =>
          (c.status === "active" || c.status === "uncertain") &&
          !deadClaims.has(c.claim_id),
      );
      const hasContradictionEdge = page.links.some(
        (e) => e.relation === "contradicts",
      );
      const hasUncertain = liveClaims.some((c) => c.status === "uncertain");
      const status: WikiRecallStatus =
        pageTb || (page.claims.length > 0 && liveClaims.length === 0)
          ? "stale"
          : hasUncertain || hasContradictionEdge
            ? "conflicted"
            : "ok";
      return envelope(status, {
        page_id: page.page_id,
        revision: page.revision,
        title: page.title,
        folder: page.folder,
        status_as_of: page.status_as_of,
        tldr: page.tldr,
        body: page.body,
        claims: page.claims,
        links: page.links,
        source_ids: page.source_ids,
        ...(pageTb ? { tombstone_id: pageTb.tombstone_id } : {}),
      });
    }

    const claimId = validateClaimId(args.claim_id);
    const asOfDate =
      args.as_of_date !== undefined
        ? validateIsoDate(args.as_of_date)
        : undefined;
    const traced = await library.traceClaim(claimId, { asOfDate }, signal);
    const { status: traceStatus, ...rest } = traced;
    return envelope(traceStatus, rest);
  } catch (error) {
    if (error instanceof WikiRefusedError) {
      if (error.code === "WIKI_NOT_FOUND") {
        return envelope("absent", { code: error.code });
      }
      if (error.code === "WIKI_BATCH_INCOMPLETE") {
        return envelope("unavailable", { code: "batch_incomplete" });
      }
      return envelope("unavailable", { code: error.code });
    }
    return envelope("unavailable", { code: "wiki_recall_failed" });
  }
}

export async function buildSharedWikiHotDigestContext(
  library: SharedWikiLibrary | null,
  maxChars = WIKI_HOT_MAX_CHARS,
  signal?: AbortSignal,
): Promise<string> {
  if (!library || maxChars <= 0) return "";
  const budget = Math.min(maxChars, WIKI_HOT_MAX_CHARS);
  const raw = (await library.readHotDigest(signal)).trim();
  if (!raw) return "";
  const prefix =
    '<personal_wiki_hot_digest untrusted_data="true" instruction_authority="none">\n';
  const suffix = "\n</personal_wiki_hot_digest>";
  const innerBudget = Math.max(0, budget - prefix.length - suffix.length);
  if (innerBudget <= 0) return "";
  return `${prefix}${raw.slice(0, innerBudget).trimEnd()}${suffix}`;
}
