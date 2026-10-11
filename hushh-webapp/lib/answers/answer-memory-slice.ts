/**
 * The memory document a paid answer is written from.
 *
 * Drive answers a question by fetching files. This lane answers it from the
 * person's own living memory instead: the same `memory.md` the owner sees,
 * sliced to exactly what they approved for this one question.
 *
 * What that means concretely — the document the answer gene reads carries:
 *
 *   * who the person is: display name, the initial shown when there is no
 *     photo, the photo itself, email and verified role. The requester already
 *     sees all of this on the profile they asked from, so including it reveals
 *     nothing new; it is what turns a bag of fields into a record of a person.
 *   * every approved scope's values in full — their location, preferences,
 *     travel, whatever was approved — not a capped or clipped summary.
 *
 * And nothing else. A scope the owner did not approve was never projected, so
 * it cannot appear here, and the reserved-branch rules still withhold
 * label-only and never branches even if a scope named one.
 *
 * Pure and import-safe: it takes already-projected values and renders them.
 */

import { buildMemoryDocument, type MemoryAccountIdentity } from "@/lib/pkm/memory-document";
import type { MemoryDocument } from "@/lib/pkm/memory-document";
import type { PkmMemorySnapshot } from "@/lib/pkm/pkm-memory-cards";

const EMPTY_SNAPSHOT: PkmMemorySnapshot = { cards: [], domainInsights: [], totalCards: 0 };

export interface AnswerMemorySliceParams {
  /** Approved projections keyed by scope, already period-filtered. */
  byScope: Record<string, unknown>;
  /** `content_revision` per scope, for honest freshness in the document. */
  sourceRevisions: Record<string, number | null>;
  /** The owner's own public identity, as the requester already sees it. */
  ownerIdentity?: {
    displayName?: string | null;
    email?: string | null;
    photoUrl?: string | null;
  } | null;
  builtAt: string;
}

/** The domain part of an `attr.<domain>[.<path>]` scope. */
function scopeDomain(scope: string): string {
  const parts = String(scope || "").split(".");
  return parts.length >= 2 ? (parts[1] ?? "") : "";
}

/** The letter shown in place of a photo. */
export function nameInitial(displayName: string | null | undefined): string | null {
  const name = String(displayName || "").trim();
  if (!name) return null;
  // Intl-safe first character, so a non-Latin name does not get mangled.
  const [first] = Array.from(name);
  return first ? first.toUpperCase() : null;
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
  const sources: { domain: string; contentRevision: number | null }[] = [];
  const revisionByDomain = new Map<string, number | null>();

  for (const [scope, payload] of Object.entries(params.byScope)) {
    const domain = scopeDomain(scope);
    if (!domain) continue;
    const bucket = (domainData[domain] ??= {}) as Record<string, unknown>;
    mergeInto(bucket, payload);
    // Keep the oldest revision across the domain's scopes: a section is only
    // as current as its least current input.
    const revision = params.sourceRevisions[scope] ?? null;
    if (!revisionByDomain.has(domain)) revisionByDomain.set(domain, revision);
    else {
      const existing = revisionByDomain.get(domain) ?? null;
      if (existing === null || (revision !== null && revision < existing)) {
        revisionByDomain.set(domain, revision);
      }
    }
  }

  for (const [domain, contentRevision] of revisionByDomain) {
    sources.push({ domain, contentRevision });
  }

  const identity = params.ownerIdentity || null;
  const account: MemoryAccountIdentity | null = identity
    ? {
        displayName: identity.displayName ?? null,
        email: identity.email ?? null,
        photoUrl: identity.photoUrl ?? null,
        // Carried explicitly so the answer can refer to the person the way the
        // profile does when there is no photo.
        nameInitial: nameInitial(identity.displayName),
      }
    : null;

  return buildMemoryDocument({
    snapshot: EMPTY_SNAPSHOT,
    domainData,
    sources,
    // Always the stricter rule: this document leaves the owner's device.
    audience: "agent",
    builtAt: params.builtAt,
    account,
  });
}
