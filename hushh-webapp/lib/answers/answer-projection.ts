/**
 * Projects a paid answer's inputs down to exactly what the owner approved.
 *
 * Pure and import-safe so the scope-isolation rules can be tested without a
 * vault, a network or a browser.
 *
 * Two reductions happen here, in this order:
 *
 *   1. **Exact scope, never its domain.** The caller supplies one projection
 *      per approved scope, already resolved through the manifest by
 *      `buildConsentExportForScope` ("Consent authorizes an exact path, never
 *      a semantically similar field"). This module refuses to merge anything
 *      it was not given a scope for, so an approved field cannot drag its
 *      siblings along.
 *   2. **The requested period.** When the requester asked about a window, a
 *      record carrying an unambiguous date outside it is dropped and counted.
 *
 * The period filter is deliberately narrow. It only looks at a closed set of
 * date-shaped keys and only drops a record whose date it can actually parse.
 * Guessing which field "means" time would be a semantic judgement, and getting
 * it wrong silently removes information the owner agreed to share.
 */

/** Keys a record may carry that unambiguously date it. */
const DATE_KEYS = [
  "date",
  "occurred_at",
  "occurredAt",
  "timestamp",
  "created_at",
  "createdAt",
  "start_date",
  "startDate",
  "transaction_date",
  "transactionDate",
] as const;

export interface AnswerPeriod {
  start: string;
  end: string;
}

export interface ScopeProjection {
  scope: string;
  payload: unknown;
  contentRevision: number | null;
}

export interface ProjectedAnswer {
  /** Keyed by approved scope. Nothing else is ever present. */
  byScope: Record<string, unknown>;
  sourceRevisions: Record<string, number | null>;
  /** Records dropped because they fall outside the requested period. */
  excludedByPeriod: number;
  /** True when at least one scope yielded something. */
  hasContent: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The record's own date, when it carries one this module is sure about. */
function recordDate(value: unknown): string | null {
  if (!isRecord(value)) return null;
  for (const key of DATE_KEYS) {
    const raw = value[key];
    if (typeof raw !== "string") continue;
    const text = raw.trim();
    // ISO-8601 date or datetime only. Anything else is not something this
    // module is entitled to interpret.
    if (/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(text)) return text.slice(0, 10);
  }
  return null;
}

/**
 * Drop dated records outside the window, counting what went.
 *
 * Only arrays are filtered: an array is a list of records, where dropping one
 * is meaningful. A bare object is left alone, because removing a field from it
 * would change the shape of the answer rather than its time range.
 */
function applyPeriod(
  value: unknown,
  period: AnswerPeriod,
  counter: { excluded: number },
): unknown {
  if (Array.isArray(value)) {
    const kept = value.filter((item) => {
      const date = recordDate(item);
      if (!date) return true; // undated: not this module's call to remove
      const inside = date >= period.start && date <= period.end;
      if (!inside) counter.excluded += 1;
      return inside;
    });
    return kept.map((item) => applyPeriod(item, period, counter));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, applyPeriod(inner, period, counter)]),
    );
  }
  return value;
}

/** True when a projection carries anything at all worth answering from. */
function hasAnyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.some(hasAnyValue);
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([key]) => !key.startsWith("__"));
    return entries.some(([, inner]) => hasAnyValue(inner));
  }
  return true;
}

/**
 * Assemble the answer's inputs from per-scope projections.
 *
 * `projections` must contain one entry per approved scope and nothing else.
 * This function never reaches for a value it was not handed, so the only way
 * an unapproved field can appear is if the caller projected it — which is why
 * the caller resolves each scope through the manifest individually.
 */
export function projectApprovedAnswer(params: {
  approvedScopes: readonly string[];
  projections: readonly ScopeProjection[];
  period?: AnswerPeriod | null;
}): ProjectedAnswer {
  const approved = new Set(params.approvedScopes.map((scope) => scope.trim().toLowerCase()));
  const counter = { excluded: 0 };
  const byScope: Record<string, unknown> = {};
  const sourceRevisions: Record<string, number | null> = {};

  for (const projection of params.projections) {
    const scope = String(projection.scope || "").trim().toLowerCase();
    // Fail closed: a projection for a scope that was not approved is dropped,
    // even if the caller produced it by mistake.
    if (!approved.has(scope)) continue;
    const projected = params.period
      ? applyPeriod(projection.payload, params.period, counter)
      : projection.payload;
    byScope[scope] = projected;
    sourceRevisions[scope] = projection.contentRevision;
  }

  return {
    byScope,
    sourceRevisions,
    excludedByPeriod: counter.excluded,
    hasContent: Object.values(byScope).some(hasAnyValue),
  };
}
