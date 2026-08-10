/**
 * Places directory client — businesses near a point, sourced from Google Places
 * through our own backend.
 *
 * The Maps key is server-side only, so every call here goes to `/api/one/places/*`.
 *
 * The read path is a stream. Each category is one provider call on the backend,
 * and the backend emits each as it lands rather than gathering them, so the
 * first rows reach the screen without waiting for the slowest category. When a
 * stream cannot be established — a buffering intermediary, a runtime without
 * `ReadableStream` — `searchNearby` answers the same question in one response
 * and the UI renders the identical shapes. Callers should not care which ran.
 */

import { ApiService } from "@/lib/services/api-service";
import { parseSSEBlocks } from "@/lib/streaming/sse-parser";

export type PlaceCard = {
  placeId: string;
  name: string;
  address: string | null;
  distanceMeters: number;
  primaryType: string | null;
  /** Google's own label for the type, e.g. "Coffee shop". */
  categoryLabel: string | null;
  /** Our directory bucket, e.g. "hotels_stays". */
  category: string;
  businessStatus: string | null;
};

export type PlacesAttribution = {
  source: string;
  sourceUrl: string;
  termsUrl?: string | null;
  notice: string;
  retrievedAt: string;
};

export type PlacesMeta = {
  categories: string[];
  radiusMi: number;
  limit: number;
  attribution: PlacesAttribution;
};

export type PlaceDetails = {
  placeId: string;
  name: string | null;
  address: string | null;
  categoryLabel: string | null;
  phone: string | null;
  website: string | null;
  mapsUrl: string | null;
  businessStatus: string | null;
  /** Posted hours only. Never a live "open now" claim. */
  weekdayDescriptions: string[];
};

export type PlacesCategoryDefinition = {
  slug: string;
  label: string;
};

/**
 * The ten buckets, in the order the chip rail shows them.
 *
 * Ordered by how much of One's own consented memory could eventually rank the
 * list, not by footfall — travel and food memory already exist as PKM domains,
 * so those lead. The slugs must match `_DIRECTORY_CATEGORY_TYPES` on the
 * backend; a slug this file invents would simply be dropped there.
 */
export const PLACES_CATEGORIES: readonly PlacesCategoryDefinition[] = [
  { slug: "hotels_stays", label: "Hotels" },
  { slug: "food_drink", label: "Food & drink" },
  { slug: "health", label: "Health" },
  { slug: "banking", label: "Banking" },
  { slug: "shops", label: "Shops" },
  { slug: "fitness_beauty", label: "Fitness & beauty" },
  { slug: "auto", label: "Auto" },
  { slug: "transit", label: "Transit" },
  { slug: "education", label: "Education" },
  { slug: "outdoors", label: "Outdoors" },
] as const;

export const PLACES_RADIUS_OPTIONS_MI = [1, 5, 15] as const;
export const PLACES_RESULT_LIMIT = 20;

type Origin =
  | { latitude: number; longitude: number; postalCode?: undefined }
  | { postalCode: string; latitude?: undefined; longitude?: undefined };

export type PlacesStreamHandlers = {
  onMeta?: (meta: PlacesMeta) => void;
  /** One category's rows arrived. Called once per category, as each lands. */
  onCategory: (category: string, items: PlaceCard[]) => void;
  /** One category failed. The rest of the stream continues. */
  onCategoryError?: (category: string, message: string) => void;
};

function authHeaders(idToken: string): HeadersInit {
  return { Authorization: `Bearer ${idToken}` };
}

/**
 * POST, not GET: a query string puts the reader's exact position in the request
 * line, which the server access log records verbatim and which also lands in
 * browser history and any Referer header. This is also why the stream is not an
 * `EventSource` — that is GET-only and cannot carry an Authorization header.
 */
function searchBody(opts: {
  origin: Origin;
  categories: string[];
  radiusMi: number;
  limit?: number;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    categories: opts.categories,
    radiusMi: opts.radiusMi,
    limit: opts.limit ?? PLACES_RESULT_LIMIT,
  };
  if (
    typeof opts.origin.latitude === "number" &&
    typeof opts.origin.longitude === "number"
  ) {
    body.lat = Number(opts.origin.latitude.toFixed(6));
    body.lng = Number(opts.origin.longitude.toFixed(6));
  } else if (opts.origin.postalCode) {
    body.postalCode = opts.origin.postalCode;
  }
  return body;
}

async function jsonOrThrow<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    throw new Error(messageForStatus(response.status, payload));
  }
  return payload as T;
}

function messageForStatus(
  status: number,
  payload: Record<string, unknown>,
): string {
  // 503 means this deployment has no Maps key, and 404 means the surface is not
  // switched on here. Both are our plumbing, not the reader's problem.
  if (status === 503 || status === 404) return "Not available yet.";
  const detail = payload?.detail as { message?: string } | string | undefined;
  const message =
    (typeof detail === "object" ? detail?.message : detail) ||
    (payload?.error as string | undefined);
  return message || "Places are unavailable right now.";
}

function isPlaceCardArray(value: unknown): value is PlaceCard[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as PlaceCard).placeId === "string" &&
        typeof (item as PlaceCard).name === "string",
    )
  );
}

export class PlacesDirectoryService {
  /**
   * Stream the categories, invoking handlers as each one lands.
   *
   * Resolves when the stream completes. Throws on a transport failure so the
   * caller can fall back to `searchNearby`; a category that fails on its own is
   * reported through `onCategoryError` and does not reject, because one dead
   * category is not a dead directory.
   */
  static async streamNearby(opts: {
    idToken: string;
    origin: Origin;
    categories: string[];
    radiusMi: number;
    limit?: number;
    signal?: AbortSignal;
    handlers: PlacesStreamHandlers;
  }): Promise<void> {
    const response = await ApiService.apiFetchStream("/api/one/places/stream", {
      method: "POST",
      headers: {
        ...authHeaders(opts.idToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(searchBody(opts)),
      signal: opts.signal,
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      throw new Error(messageForStatus(response.status, payload));
    }

    const reader = response.body?.getReader();
    if (!reader) {
      // No streaming in this runtime. The caller's fallback handles it.
      throw new Error("No response stream available");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        if (opts.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        const { done, value } = await reader.read();
        if (done) break;

        const parsed = parseSSEBlocks(
          decoder.decode(value, { stream: true }),
          buffer,
        );
        buffer = parsed.remainder;

        for (const frame of parsed.events) {
          let raw: Record<string, unknown>;
          try {
            raw = JSON.parse(frame.data) as Record<string, unknown>;
          } catch {
            // A frame we cannot read is not a reason to discard the rows we
            // already delivered.
            continue;
          }

          if (frame.event === "meta" && raw.categories) {
            opts.handlers.onMeta?.(raw as unknown as PlacesMeta);
          } else if (frame.event === "results") {
            const category = String(raw.category ?? "");
            if (category && isPlaceCardArray(raw.items)) {
              opts.handlers.onCategory(category, raw.items);
            }
          } else if (frame.event === "category_error") {
            opts.handlers.onCategoryError?.(
              String(raw.category ?? ""),
              String(raw.message ?? "This category is unavailable."),
            );
          }
          // "heartbeat" and "done" need no handling: the first exists only to
          // keep intermediaries from closing a quiet connection, and the second
          // is implied by the reader finishing.
        }
      }
    } finally {
      // Releasing matters when the caller aborted mid-read: without it the
      // response body stays locked and the connection is never returned.
      reader.releaseLock();
    }
  }

  /** The same query, one response. Used when the stream cannot run. */
  static async searchNearby(opts: {
    idToken: string;
    origin: Origin;
    categories: string[];
    radiusMi: number;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<{
    groups: { category: string; items: PlaceCard[] }[];
    failed: string[];
    meta: PlacesMeta;
  }> {
    const response = await ApiService.apiFetch("/api/one/places/search", {
      method: "POST",
      headers: {
        ...authHeaders(opts.idToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(searchBody(opts)),
      signal: opts.signal,
    });
    return jsonOrThrow(response);
  }

  static async getDetails(opts: {
    idToken: string;
    placeId: string;
    signal?: AbortSignal;
  }): Promise<PlaceDetails> {
    const response = await ApiService.apiFetch("/api/one/places/details", {
      method: "POST",
      headers: {
        ...authHeaders(opts.idToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ placeId: opts.placeId }),
      signal: opts.signal,
    });
    const payload = await jsonOrThrow<{ place: PlaceDetails }>(response);
    return payload.place;
  }
}

/**
 * Distance for a row, in the same approximate voice the other two directories
 * use. Google returns a venue's own point rather than a ZIP centroid, so a
 * short distance here is real — but the reader's own position carries its own
 * error, so this stays deliberately unprecise.
 */
export function formatPlaceDistance(meters: number | null | undefined): string | null {
  if (typeof meters !== "number" || !Number.isFinite(meters) || meters < 0) {
    return null;
  }
  const miles = meters / 1609.344;
  if (miles >= 10) return `~${Math.round(miles)} mi`;
  if (miles < 0.1) return "~0.1 mi";
  return `~${(Math.round(miles * 10) / 10).toFixed(1)} mi`;
}

/** "Coffee shop · Permanently closed" — one line, only the parts that exist. */
export function formatPlaceSubtitle(card: PlaceCard): string | null {
  const parts: string[] = [];
  if (card.categoryLabel) parts.push(card.categoryLabel);
  // Google reports this rarely, and only when it matters enough to say.
  if (card.businessStatus === "CLOSED_PERMANENTLY") parts.push("Permanently closed");
  else if (card.businessStatus === "CLOSED_TEMPORARILY") parts.push("Temporarily closed");
  if (!parts.length && card.address) parts.push(card.address);
  return parts.length ? parts.join(" · ") : null;
}

export function placesCategoryLabel(slug: string): string {
  return PLACES_CATEGORIES.find((entry) => entry.slug === slug)?.label ?? slug;
}
