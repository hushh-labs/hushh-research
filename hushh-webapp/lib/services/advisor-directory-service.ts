/**
 * Advisor directory client — advisers near a point, sourced from FINRA
 * BrokerCheck through our own backend.
 *
 * The upstream bearer key is server-side only, so every call here goes to
 * `/api/one/advisors/*`. The backend also collapses the upstream's two result
 * shapes (people, or branch offices in dense metros) onto one card shape, so
 * this layer and the UI never fork on which one arrived.
 */

import { ApiService } from "@/lib/services/api-service";

export type AdvisorCard = {
  kind: "advisor" | "branch";
  id: string;
  crd?: string | null;
  name: string | null;
  firmName: string | null;
  yearsExperience?: number | null;
  hasDisclosures?: boolean;
  /** Branch rows only: how many advisers register to this office. */
  advisorCount?: number | null;
  advisorNames?: string[];
  distanceMiles: number | null;
  city: string | null;
  state: string | null;
  phone: string | null;
};

export type AdvisorSearchMeta = {
  grouped: boolean;
  hasMore: boolean;
  nextOffset: number | null;
  returned: number;
  available: number | null;
  limit: number;
  radiusMi: number | null;
  radiusRequested: number | null;
  radiusAdjusted: boolean;
  truncated: boolean;
};

export type AdvisorAttribution = { source: string; url: string };

export type AdvisorSearchResult = {
  items: AdvisorCard[];
  meta: AdvisorSearchMeta;
  attribution: AdvisorAttribution;
};

export type AdvisorProfile = {
  crd: string | null;
  name: string | null;
  firmName: string | null;
  yearsExperience: number | null;
  firmCount: number | null;
  isBarred: boolean;
  hasDisclosures: boolean;
  disclosureCount: number;
  states: string[];
  exams: string[];
  office: {
    street: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  } | null;
  reportUrl: string | null;
};

export const ADVISOR_PAGE_SIZE = 10;
export const ADVISOR_RADIUS_OPTIONS_MI = [5, 10, 25] as const;

function authHeaders(idToken: string): HeadersInit {
  return { Authorization: `Bearer ${idToken}` };
}

async function jsonOrThrow<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    // A 503 means this deployment has no directory wired up. That is our
    // plumbing, not the reader's problem — "not configured on this backend" is
    // a sentence no user should ever be shown.
    if (response.status === 503) throw new Error("Not available yet.");

    const detail = payload?.detail as { message?: string } | string | undefined;
    const message =
      (typeof detail === "object" ? detail?.message : detail) ||
      (payload?.error as string | undefined);
    throw new Error(message || "Advisors are unavailable right now.");
  }
  return payload as T;
}

export class AdvisorDirectoryService {
  static async searchNearby(opts: {
    idToken: string;
    latitude?: number;
    longitude?: number;
    postalCode?: string;
    radiusMi?: number;
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
  }): Promise<AdvisorSearchResult> {
    // POST, not GET: a query string puts the user's exact position in the
    // request line, which the server access log records verbatim and which also
    // lands in browser history and any Referer header.
    const body: Record<string, unknown> = {
      limit: opts.limit ?? ADVISOR_PAGE_SIZE,
      offset: opts.offset ?? 0,
    };
    if (
      typeof opts.latitude === "number" &&
      typeof opts.longitude === "number"
    ) {
      body.lat = Number(opts.latitude.toFixed(6));
      body.lng = Number(opts.longitude.toFixed(6));
    } else if (opts.postalCode) {
      body.postalCode = opts.postalCode;
    }
    if (typeof opts.radiusMi === "number") body.radiusMi = opts.radiusMi;

    const response = await ApiService.apiFetch("/api/one/advisors/search", {
      method: "POST",
      headers: {
        ...authHeaders(opts.idToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    return jsonOrThrow<AdvisorSearchResult>(response);
  }

  static async getProfile(opts: {
    idToken: string;
    crd: string;
    signal?: AbortSignal;
  }): Promise<AdvisorProfile> {
    const response = await ApiService.apiFetch(
      `/api/one/advisors/${encodeURIComponent(opts.crd)}`,
      {
        method: "GET",
        headers: authHeaders(opts.idToken),
        signal: opts.signal,
      },
    );
    const payload = await jsonOrThrow<{ profile: AdvisorProfile }>(response);
    return payload.profile;
  }
}

/**
 * FINRA geocodes offices to ZIP centroids, so an exact figure would be a
 * fiction — every adviser in a ZIP shares one coordinate. Always approximate.
 */
export function formatDistance(
  miles: number | null | undefined,
): string | null {
  if (typeof miles !== "number" || !Number.isFinite(miles) || miles < 0) {
    return null;
  }
  // A postal-code search measures from the ZIP centroid, which *is* the query
  // point, so every row comes back at exactly 0. Showing "~0.1 mi" there would
  // invent a number. A coordinate search never yields 0 — the upstream floors
  // those at 500 m — so treating 0 as "no usable distance" is safe.
  if (miles === 0) return null;
  if (miles >= 10) return `~${Math.round(miles)} mi`;
  return `~${Math.max(0.1, Math.round(miles * 10) / 10).toFixed(1)} mi`;
}

/** "Morgan Stanley · 47 yrs" — one line, only the parts that exist. */
export function formatAdvisorSubtitle(card: AdvisorCard): string | null {
  const parts: string[] = [];
  if (card.kind === "branch") {
    if (card.advisorCount) parts.push(`${card.advisorCount} advisors`);
    if (card.city) parts.push(card.city);
  } else {
    if (card.firmName) parts.push(card.firmName);
    if (typeof card.yearsExperience === "number" && card.yearsExperience >= 1) {
      // Floor, never round: 47.5 years of tenure is 47 completed years, and
      // rounding up would overstate a credential.
      parts.push(`${Math.floor(card.yearsExperience)} yrs`);
    }
  }
  return parts.length ? parts.join(" · ") : null;
}
