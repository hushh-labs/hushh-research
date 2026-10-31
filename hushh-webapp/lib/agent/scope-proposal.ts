/**
 * "One picks, you confirm" (consent contract C4).
 *
 * `propose_information_request` resolves the best matching information from the
 * question on the server and returns
 * `{person, proposed:[{scope,label,why}], duration_default, reason_suggestion}`.
 * This module turns that untrusted tool payload into a bounded, typed proposal
 * the ask card can render as one sentence. It never carries values, only the
 * requestable reference and its human label.
 */
import {
  REQUEST_DURATION_OPTIONS,
  DEFAULT_REQUEST_DURATION_HOURS,
  requestDurationLabel,
} from "@/lib/agent/action-directive-summary";

export type ScopeProposalItem = {
  /** Opaque requestable reference; submitted, never rendered. */
  scopeRef: string;
  /** Human label ("Food preferences"). */
  label: string;
  /** One short reason One picked it, when the server gave one. */
  why: string | null;
  /**
   * Where the item sits, when the server says (the catalog's own `domain`,
   * `wildcard` and `pathSegments`). It is how the card nests a broad ask
   * ("Food & dining information") over the items it covers.
   */
  domain?: string;
  wildcard?: boolean;
  pathSegments?: string[];
};

export type ScopeProposal = {
  proposed: ScopeProposalItem[];
  /** Always one of REQUEST_DURATION_OPTIONS so Send can submit it unchanged. */
  durationHours: number;
  /** Suggested reason, already phrased to follow "for" ("dinner planning"). */
  reasonSuggestion: string;
};

const MAX_PROPOSED = 10;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function bounded(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

/** Snap any hour count to the nearest duration a request may be made for. */
export function snapRequestDurationHours(hours: number): number {
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_REQUEST_DURATION_HOURS;
  return REQUEST_DURATION_OPTIONS.reduce((best, option) =>
    Math.abs(option.hours - hours) < Math.abs(best - hours) ? option.hours : best,
  REQUEST_DURATION_OPTIONS[0].hours as number);
}

/**
 * Read a duration the way the server may send it: hours, seconds, "7d",
 * "24h", "1w", or ISO 8601 ("P7D", "PT24H"). Unknown shapes fall back to the
 * default rather than guessing.
 */
export function parseProposalDurationHours(record: Record<string, unknown>): number {
  const hoursField = record.durationDefaultHours ?? record.duration_default_hours ?? record.durationHours;
  if (typeof hoursField === "number") return snapRequestDurationHours(hoursField);
  const secondsField = record.durationDefaultSeconds ?? record.duration_default_seconds;
  if (typeof secondsField === "number") return snapRequestDurationHours(secondsField / 3600);
  const raw = record.duration_default ?? record.durationDefault;
  if (typeof raw === "number") {
    // Hours never exceed 30 days; anything larger is seconds.
    return snapRequestDurationHours(raw > 720 ? raw / 3600 : raw);
  }
  if (typeof raw === "string") {
    const text = raw.trim().toLowerCase();
    const short = /^(\d{1,4})\s*(h|d|w)$/.exec(text);
    if (short) {
      const amount = Number(short[1]);
      return snapRequestDurationHours(short[2] === "h" ? amount : short[2] === "d" ? amount * 24 : amount * 168);
    }
    const iso = /^p(?:(\d{1,3})w)?(?:(\d{1,3})d)?(?:t(\d{1,4})h)?$/.exec(text);
    if (iso && (iso[1] || iso[2] || iso[3])) {
      return snapRequestDurationHours(Number(iso[1] || 0) * 168 + Number(iso[2] || 0) * 24 + Number(iso[3] || 0));
    }
  }
  return DEFAULT_REQUEST_DURATION_HOURS;
}

const MAX_PATH_SEGMENTS = 12;

/** Bounded path segments, or null for anything that is not a short list of short strings. */
export function boundedPathSegments(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_PATH_SEGMENTS) return null;
  const parts = value.map((part) => bounded(part, 80));
  return parts.every((part): part is string => part !== null) ? parts : null;
}

/** The item's place in the catalog, only the fields the server actually sent. */
function proposalHierarchy(item: Record<string, unknown>): Pick<ScopeProposalItem, "domain" | "wildcard" | "pathSegments"> {
  const domain = bounded(item.domain, 80);
  const pathSegments = boundedPathSegments(item.pathSegments ?? item.path_segments);
  return {
    ...(domain ? { domain } : {}),
    ...(typeof item.wildcard === "boolean" ? { wildcard: item.wildcard } : {}),
    ...(pathSegments ? { pathSegments } : {}),
  };
}

/** A bounded proposal, or null when the payload carries none. */
export function parseScopeProposal(content: unknown): ScopeProposal | null {
  const outer = asRecord(content);
  const record = asRecord(outer?.proposal) ?? outer;
  if (!record || !Array.isArray(record.proposed)) return null;
  const seen = new Set<string>();
  const proposed = record.proposed.slice(0, MAX_PROPOSED).flatMap<ScopeProposalItem>((raw) => {
    const item = asRecord(raw);
    const scopeRef = bounded(item?.scope ?? item?.scopeRef ?? item?.scope_ref, 180);
    const label = bounded(item?.label, 120);
    if (!scopeRef || !label || seen.has(scopeRef)) return [];
    seen.add(scopeRef);
    return [{ scopeRef, label, why: bounded(item?.why, 200), ...proposalHierarchy(item!) }];
  });
  if (!proposed.length) return null;
  const reasonSuggestion = bounded(record.reason_suggestion ?? record.reasonSuggestion, 500) ?? "";
  return { proposed, durationHours: parseProposalDurationHours(record), reasonSuggestion };
}

/** The ask sentence's duration: the one shared wording (`requestDurationLabel`). */
export const proposalDurationLabel = requestDurationLabel;
