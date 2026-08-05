/**
 * Insurance agent directory client — Nationwide agencies near a point, through
 * our own backend.
 *
 * The sibling of `advisor-directory-service`. The upstream bearer key is
 * server-side only, so every call here goes to `/api/one/insurance-agents/*`.
 *
 * Scope: Nationwide agencies, which is what the source locator covers — not a
 * carrier-neutral feed. The attribution line says so wherever this is shown.
 */

import { ApiService } from "@/lib/services/api-service";

export type InsuranceAgentAddress = {
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  formatted: string | null;
};

export type InsuranceAgentCard = {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  products: string[];
  agencyType: string | null;
  tier: string | null;
  distanceMiles: number | null;
  address: InsuranceAgentAddress | null;
  city: string | null;
  state: string | null;
};

export type InsuranceAgentSearchMeta = {
  hasMore: boolean;
  nextOffset: number | null;
  returned: number;
  available: number | null;
  limit: number;
  radiusMi: number | null;
  truncated: boolean;
  /** "cold" | "warm" — a warm result can trail the locator by up to a day. */
  cache: string | null;
  resolvedLocation: {
    city: string | null;
    state: string | null;
    zip: string | null;
  } | null;
};

/**
 * The locator's own credit. Unlike BrokerCheck this carries no terms or
 * error-reporting URL, so both are optional here and the UI omits the link
 * rather than rendering a dead one.
 */
export type InsuranceAgentAttribution = {
  source: string;
  sourceUrl: string;
  notice: string;
  termsUrl?: string | null;
  errorReporting?: string | null;
  retrievedAt: string;
};

export type InsuranceAgentSearchResult = {
  items: InsuranceAgentCard[];
  meta: InsuranceAgentSearchMeta;
  attribution: InsuranceAgentAttribution;
};

export const INSURANCE_AGENT_PAGE_SIZE = 10;
export const INSURANCE_AGENT_RADIUS_OPTIONS_MI = [5, 10, 25] as const;

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
    throw new Error(message || "Agents are unavailable right now.");
  }
  return payload as T;
}

export class InsuranceAgentDirectoryService {
  static async searchNearby(opts: {
    idToken: string;
    latitude?: number;
    longitude?: number;
    postalCode?: string;
    radiusMi?: number;
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
  }): Promise<InsuranceAgentSearchResult> {
    // POST, not GET: a query string puts the user's exact position in the
    // request line, which the server access log records verbatim and which also
    // lands in browser history and any Referer header.
    const body: Record<string, unknown> = {
      limit: opts.limit ?? INSURANCE_AGENT_PAGE_SIZE,
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

    const response = await ApiService.apiFetch(
      "/api/one/insurance-agents/search",
      {
        method: "POST",
        headers: {
          ...authHeaders(opts.idToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      },
    );
    return jsonOrThrow<InsuranceAgentSearchResult>(response);
  }
}

/**
 * The locator geocodes agencies rather than surveying them, so an exact figure
 * would be a fiction. Always approximate.
 */
export function formatAgentDistance(
  miles: number | null | undefined,
): string | null {
  if (typeof miles !== "number" || !Number.isFinite(miles) || miles < 0) {
    return null;
  }
  // A postal-code search measures from the ZIP centroid, which *is* the query
  // point, so a row sitting on it comes back at exactly 0. Showing "~0.1 mi"
  // there would invent a number.
  if (miles === 0) return null;
  if (miles >= 10) return `~${Math.round(miles)} mi`;
  return `~${Math.max(0.1, Math.round(miles * 10) / 10).toFixed(1)} mi`;
}

/**
 * "Auto · Home · Commercial" — what this agency can actually insure, which is
 * the one thing that distinguishes two agencies on the same street.
 *
 * Capped at three because the row is one line: a Standard Independent agency
 * routinely carries six or more products, and the full list pushes the distance
 * off the row on a phone.
 */
export function formatAgentSubtitle(card: InsuranceAgentCard): string | null {
  const products = card.products.slice(0, 3);
  if (products.length) return products.join(" · ");
  // No products listed: fall back to where it is, so the row is never bare.
  return card.city ?? null;
}
