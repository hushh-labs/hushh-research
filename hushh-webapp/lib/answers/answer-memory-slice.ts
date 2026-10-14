/** Render only the exact approved scope values and their source metadata. */

import { buildMemoryDocument } from "@/lib/pkm/memory-document";
import type { MemoryDocument, MemoryDocumentSourceDomain } from "@/lib/pkm/memory-document";
import type { PkmMemorySnapshot } from "@/lib/pkm/pkm-memory-cards";

const EMPTY_SNAPSHOT: PkmMemorySnapshot = { cards: [], domainInsights: [], totalCards: 0 };

export interface AnswerMemorySliceParams {
  /** Approved projections keyed by scope, already period-filtered. */
  byScope: Record<string, unknown>;
  /** `content_revision` per scope, for honest freshness in the document. */
  sourceRevisions: Record<string, number | null>;
  sourceManifestRevisions?: Record<string, number | null>;
  builtAt: string;
}

/** The domain part of an `attr.<domain>[.<path>]` scope. */
function scopeDomain(scope: string): string {
  const parts = String(scope || "").split(".");
  return parts.length >= 2 ? (parts[1] ?? "") : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Merge the approved projections of one domain.
 *
 * Safe because each projection already contains only approved paths: merging
 * two approved slices of `travel` cannot produce an unapproved field.
 */
function mergeInto(target: Record<string, unknown>, source: unknown): void {
  if (!isRecord(source)) return;
  for (const [key, value] of Object.entries(source)) {
    if (isRecord(value) && isRecord(target[key])) {
      mergeInto(target[key] as Record<string, unknown>, value);
    } else {
      target[key] = value;
    }
  }
}

/**
 * Render the approved slice of this person's memory as a document.
 *
 * Returns the same `MemoryDocument` shape the owner's own memory.md uses, so
 * freshness, withheld branches and truncation are reported identically.
 */
export function buildAnswerMemorySlice(params: AnswerMemorySliceParams): MemoryDocument {
  const domainData: Record<string, unknown> = {};
  const sources: MemoryDocumentSourceDomain[] = [];
  const revisionByDomain = new Map<string, number | null>();

  for (const [scope, payload] of Object.entries(params.byScope)) {
    const domain = scopeDomain(scope);
    if (!domain) continue;
    const bucket = (domainData[domain] ??= {}) as Record<string, unknown>;
    mergeInto(bucket, isRecord(payload) && isRecord(payload[domain]) ? payload[domain] : payload);
    // Keep the oldest revision across the domain's scopes: a section is only
    // as current as its least current input.
    const revision = params.sourceRevisions[scope] ?? null;
    if (!revisionByDomain.has(domain)) revisionByDomain.set(domain, revision);
    else {
      const existing = revisionByDomain.get(domain) ?? null;
      revisionByDomain.set(domain, existing === null || revision === null ? null : Math.min(existing, revision));
    }
  }

  for (const [domain, contentRevision] of revisionByDomain) {
    const domainScopes = Object.keys(params.byScope).filter(scope => scopeDomain(scope) === domain);
    const revisions = domainScopes.map(scope => params.sourceManifestRevisions?.[scope] ?? null);
    sources.push({ domain, contentRevision, manifestRevision: revisions.some(value => value === null) ? null : Math.min(...revisions as number[]) });
  }

  return buildMemoryDocument({
    snapshot: EMPTY_SNAPSHOT,
    domainData,
    sources,
    // Always the stricter rule: this document leaves the owner's device.
    audience: "agent",
    builtAt: params.builtAt,
  });
}
