/**
 * NWS Nearby client — public-association records near a place an advisor chose.
 *
 * The upstream API key is server-side only, so every call goes to our own
 * `/api/ria/nearby/*`. The backend also caches responses, because the upstream
 * rate-limits on {key, egress IP} and all Hushh traffic shares both.
 *
 * Two product facts this module exists to keep straight:
 *
 * NWS is public *professional network strength*, not financial net worth. And
 * "nearby" means a public professional, institutional, civic or opt-in
 * association — never physical presence, never a residence. Nothing here should
 * be renamed or reshaped in a way that lets a screen imply either.
 */

import { ApiService } from "@/lib/services/api-service";

/** The upstream's own lane vocabulary. Its docs call this facet "Focus". */
export type NearbyLane =
  | "BUILDER"
  | "CAPITAL"
  | "KNOWLEDGE"
  | "CIVIC"
  | "CONNECTOR"
  | "GENERAL";

export const NEARBY_LANES: { value: NearbyLane; label: string }[] = [
  { value: "BUILDER", label: "Builders" },
  { value: "CAPITAL", label: "Capital" },
  { value: "KNOWLEDGE", label: "Knowledge" },
  { value: "CIVIC", label: "Civic" },
  { value: "CONNECTOR", label: "Connectors" },
  { value: "GENERAL", label: "General" },
];

export type ConfidenceGrade = "A" | "B" | "C" | "D";

/**
 * Coverage is the whole contract of this surface.
 *
 * A location outside an approved market is a normal success with an empty list,
 * not an error. The reason code is what lets the screen say something true and
 * specific instead of "no results", which would read as failure.
 */
export type NearbyCoverageStatus =
  | "COVERED"
  | "NOT_COVERED"
  | "LOCATION_UNRESOLVED";

export type NearbyCoverage = {
  status: NearbyCoverageStatus;
  reasonCode: string | null;
  marketId: string | null;
  marketLabel: string | null;
  countryCode: string | null;
  message: string | null;
  complete: boolean;
};

/**
 * How the score was reached, published by the scoring service itself.
 *
 * Weights come from upstream rather than being restated here. An explanation
 * that carries its own copy of the weighting goes stale the first time the
 * model is re-weighted, and nothing fails to say so.
 */
export type ScoreComponent = {
  key: string;
  label: string | null;
  /** 0–1. */
  value: number | null;
  /** Share of the score this component can contribute. */
  weight: number | null;
  /** weight × value. */
  contribution: number | null;
};

export type ScoreBreakdown = {
  components: ScoreComponent[];
  /** How many pieces of evidence back the profile. Thin evidence is held back. */
  evidenceCount: number | null;
  /** Scales the weighted sum up toward 1.0 as evidence accumulates. */
  coverageMultiplier: number | null;
  /** Discount for promotional, self-published, or single-source evidence. */
  integrityPenalty: number | null;
  /** Association strength to the queried place; the 10% term in the nearby rank. */
  localRelevance: number | null;
  method: string | null;
};

export type NearbyRecord = {
  rank: number | null;
  personId: string;
  displayName: string | null;
  headline: string | null;
  organization: string | null;
  lane: NearbyLane | null;
  /** The person's standing score. Not what the list is ordered by. */
  globalNws: number | null;
  /** What the upstream ranks by, and therefore what the list shows. */
  nearbyRankScore: number | null;
  scoreStatus: string | null;
  confidence: { score: number | null; grade: ConfidenceGrade | null };
  publicLocation: {
    label: string | null;
    associationKind: string | null;
    granularity: string | null;
    /** A band, never an exact distance — the association is not a residence. */
    distanceBand: string | null;
    note: string | null;
  };
  /** Null when the scoring service did not publish its working for this record. */
  scoreBreakdown: ScoreBreakdown | null;
  reasons: string[];
  warnings: string[];
  tags: string[];
  revalidationRequired: boolean;
  sources: { publisher: string | null; title: string | null; url: string | null }[];
  modelVersion: string | null;
};

export type NearbyDiscoverResult = {
  coverage: NearbyCoverage;
  snapshot: {
    scoreStatus: string | null;
    complete: boolean;
    modelVersion: string | null;
    dataMode: string | null;
    verifiedAt: string | null;
  };
  summary: {
    returnedCount: number;
    candidateCount: number;
    searchPerformed: boolean;
    effectiveRadiusKm: number | null;
  };
  scoreDefinition: string | null;
  results: NearbyRecord[];
};

export type NearbyShortlistEntry = {
  id: string;
  target_key: string;
  status: string;
  profile: Record<string, unknown>;
  updated_at: string | null;
};

/**
 * Where the advisor is looking. Postal is the only form that carries a country,
 * because it is the only one where the advisor stated it.
 */
export type NearbyAnchor =
  | { kind: "coords"; latitude: number; longitude: number }
  | { kind: "postal"; postalCode: string; countryCode: string };

export type NearbyFilters = {
  lanes: NearbyLane[];
  /** Single-valued by design — see SECTOR_FILTER_IS_SINGLE_SELECT below. */
  tag: string | null;
  minimumConfidenceGrade: ConfidenceGrade;
  radiusKm: number;
};

export const NEARBY_RADIUS_OPTIONS_KM = [10, 20, 50, 100];

export const DEFAULT_NEARBY_FILTERS: NearbyFilters = {
  lanes: [],
  tag: null,
  minimumConfidenceGrade: "B",
  radiusKm: 20,
};

/**
 * The upstream matches `tags` as a *subset* of a candidate's own tags, so two
 * selected tags require a record carrying both. Against the current approved
 * dataset almost every pair returns nothing, which reads as a broken filter.
 *
 * Selecting one at a time is therefore the honest control. Re-implementing OR
 * on the client was considered and rejected: it would quietly disagree with the
 * server's own filter semantics, so the same query would mean two things.
 */
export const SECTOR_FILTER_IS_SINGLE_SELECT = true;

function authHeaders(idToken: string): Record<string, string> {
  return idToken ? { Authorization: `Bearer ${idToken}` } : {};
}

async function jsonOrThrow<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  if (!response.ok) {
    // 503 means this deployment has no NWS wiring. That is our plumbing, and
    // retrying will not fix it, so it is worded as a setup state rather than a
    // transient failure.
    if (response.status === 503) throw new Error("This isn't set up yet.");
    if (response.status === 429)
      throw new Error("Busy right now. Try again in a moment.");
    if (response.status === 504) throw new Error("That took too long. Try again.");

    const detail = payload?.detail as { message?: string } | string | undefined;
    const message =
      (typeof detail === "object" ? detail?.message : detail) ||
      (payload?.error as string | undefined);
    throw new Error(message || "Nearby is unavailable right now.");
  }
  return payload as T;
}

export class NwsNearbyService {
  static async discover(opts: {
    idToken: string;
    anchor: NearbyAnchor;
    filters?: NearbyFilters;
    signal?: AbortSignal;
  }): Promise<NearbyDiscoverResult> {
    const filters = opts.filters ?? DEFAULT_NEARBY_FILTERS;

    // POST, not GET: a query string puts the advisor's position in the request
    // line, which the access log records verbatim and which also lands in
    // browser history and any Referer header.
    const body: Record<string, unknown> = {
      lanes: filters.lanes,
      tags: filters.tag ? [filters.tag] : [],
      minimum_confidence_grade: filters.minimumConfidenceGrade,
      initial_radius_km: filters.radiusKm,
      max_radius_km: Math.max(filters.radiusKm, 100),
    };

    if (opts.anchor.kind === "coords") {
      // Coarsened here as well as on the backend. We hold no reverse geocode,
      // so a coordinate deliberately carries no country: a wrong guess returns
      // COUNTRY_CONTEXT_DOES_NOT_MATCH and hides real results.
      body.latitude = Number(opts.anchor.latitude.toFixed(2));
      body.longitude = Number(opts.anchor.longitude.toFixed(2));
    } else {
      body.postal_code = opts.anchor.postalCode.trim().toUpperCase();
      body.country_code = opts.anchor.countryCode.trim().toUpperCase();
    }

    const response = await ApiService.apiFetch("/api/ria/nearby/discover", {
      method: "POST",
      headers: {
        ...authHeaders(opts.idToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    return jsonOrThrow<NearbyDiscoverResult>(response);
  }

  static async shortlist(opts: {
    idToken: string;
    record: NearbyRecord;
    action?: "shortlist" | "pass";
    signal?: AbortSignal;
  }): Promise<NearbyShortlistEntry> {
    // Only the public fields the shortlist itself renders. Sending the whole
    // record would put reasons, sources and warnings into a JSONB column that
    // nothing reads, and they go stale the moment the upstream re-scores.
    const snapshot = {
      displayName: opts.record.displayName,
      headline: opts.record.headline,
      organization: opts.record.organization,
      lane: opts.record.lane,
      globalNws: opts.record.globalNws,
      nearbyRankScore: opts.record.nearbyRankScore,
      confidenceGrade: opts.record.confidence.grade,
      locationLabel: opts.record.publicLocation.label,
      modelVersion: opts.record.modelVersion,
    };

    const response = await ApiService.apiFetch("/api/ria/nearby/shortlist", {
      method: "POST",
      headers: {
        ...authHeaders(opts.idToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        person_id: opts.record.personId,
        action: opts.action ?? "shortlist",
        snapshot,
      }),
      signal: opts.signal,
    });
    return jsonOrThrow<NearbyShortlistEntry>(response);
  }

  static async listShortlist(opts: {
    idToken: string;
    signal?: AbortSignal;
  }): Promise<NearbyShortlistEntry[]> {
    const response = await ApiService.apiFetch("/api/ria/nearby/shortlist", {
      method: "GET",
      headers: authHeaders(opts.idToken),
      signal: opts.signal,
    });
    const payload = await jsonOrThrow<{ items: NearbyShortlistEntry[] }>(response);
    return payload.items ?? [];
  }
}

/**
 * Live counts per lane, taken from the records actually returned.
 *
 * Two of the six lanes are empty in the approved dataset. Offering all six as
 * equal choices means an advisor taps one and gets a blank screen that reads as
 * a bug, so the control shows what each lane would actually yield.
 */
export function laneCounts(records: NearbyRecord[]): Record<NearbyLane, number> {
  const counts = Object.fromEntries(
    NEARBY_LANES.map((lane) => [lane.value, 0]),
  ) as Record<NearbyLane, number>;
  for (const record of records) {
    if (record.lane && record.lane in counts) counts[record.lane] += 1;
  }
  return counts;
}

/** Sectors present in the current results, so the control never offers a dead option. */
export function availableTags(records: NearbyRecord[]): string[] {
  const seen = new Set<string>();
  for (const record of records) {
    for (const tag of record.tags) seen.add(tag);
  }
  return [...seen].sort();
}

/** Score to one decimal. The approved range spans ~16 points, so a bar would be noise. */
export function formatScore(value: number | null): string {
  return typeof value === "number" ? value.toFixed(1) : "—";
}
