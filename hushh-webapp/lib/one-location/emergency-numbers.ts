/**
 * Emergency-number lookup for the SMS · Save My Soul screen.
 *
 * Country identification is intentionally outside this module. The safety UI
 * supplies an authoritative ISO country code from the authenticated Google Maps
 * reverse-geocode service; approximate coordinate rectangles are not accurate
 * enough for an emergency dial action.
 */

import { haversineMeters } from "@/lib/one-location/marker-interpolation";

export type EmergencyInfo = {
  /** ISO 3166-1 alpha-2 country code (uppercase). */
  countryCode: string;
  /** Human-readable country label. */
  countryName: string;
  /** Primary emergency number to dial in that country. */
  number: string;
};

export type EmergencyNumberLookupStatus =
  "idle" | "resolving" | "resolved" | "unavailable";

const COUNTRIES: readonly EmergencyInfo[] = [
  // South Asia
  { countryCode: "IN", countryName: "India", number: "112" },
  { countryCode: "PK", countryName: "Pakistan", number: "15" },
  { countryCode: "LK", countryName: "Sri Lanka", number: "119" },
  { countryCode: "BD", countryName: "Bangladesh", number: "999" },
  { countryCode: "NP", countryName: "Nepal", number: "112" },

  // Middle East
  { countryCode: "AE", countryName: "United Arab Emirates", number: "999" },
  { countryCode: "QA", countryName: "Qatar", number: "999" },
  { countryCode: "BH", countryName: "Bahrain", number: "999" },
  { countryCode: "KW", countryName: "Kuwait", number: "112" },
  { countryCode: "OM", countryName: "Oman", number: "9999" },
  { countryCode: "SA", countryName: "Saudi Arabia", number: "999" },
  { countryCode: "IL", countryName: "Israel", number: "112" },
  { countryCode: "TR", countryName: "Türkiye", number: "112" },

  // East & Southeast Asia
  { countryCode: "CN", countryName: "China", number: "110" },
  { countryCode: "JP", countryName: "Japan", number: "110" },
  { countryCode: "KR", countryName: "South Korea", number: "112" },
  { countryCode: "SG", countryName: "Singapore", number: "999" },
  { countryCode: "MY", countryName: "Malaysia", number: "999" },
  { countryCode: "ID", countryName: "Indonesia", number: "112" },
  { countryCode: "TH", countryName: "Thailand", number: "191" },
  { countryCode: "PH", countryName: "Philippines", number: "911" },
  { countryCode: "VN", countryName: "Vietnam", number: "113" },
  { countryCode: "HK", countryName: "Hong Kong", number: "999" },

  // Oceania
  { countryCode: "AU", countryName: "Australia", number: "000" },
  { countryCode: "NZ", countryName: "New Zealand", number: "111" },

  // Europe (most use the pan-EU 112)
  { countryCode: "GB", countryName: "United Kingdom", number: "999" },
  { countryCode: "IE", countryName: "Ireland", number: "112" },
  { countryCode: "FR", countryName: "France", number: "112" },
  { countryCode: "DE", countryName: "Germany", number: "112" },
  { countryCode: "ES", countryName: "Spain", number: "112" },
  { countryCode: "PT", countryName: "Portugal", number: "112" },
  { countryCode: "IT", countryName: "Italy", number: "112" },
  { countryCode: "NL", countryName: "Netherlands", number: "112" },
  { countryCode: "BE", countryName: "Belgium", number: "112" },
  { countryCode: "CH", countryName: "Switzerland", number: "112" },
  { countryCode: "AT", countryName: "Austria", number: "112" },
  { countryCode: "SE", countryName: "Sweden", number: "112" },
  { countryCode: "NO", countryName: "Norway", number: "112" },
  { countryCode: "DK", countryName: "Denmark", number: "112" },
  { countryCode: "FI", countryName: "Finland", number: "112" },
  { countryCode: "PL", countryName: "Poland", number: "112" },
  { countryCode: "CZ", countryName: "Czechia", number: "112" },
  { countryCode: "GR", countryName: "Greece", number: "112" },
  { countryCode: "RO", countryName: "Romania", number: "112" },
  { countryCode: "RU", countryName: "Russia", number: "112" },
  { countryCode: "UA", countryName: "Ukraine", number: "112" },

  // Africa
  { countryCode: "ZA", countryName: "South Africa", number: "10111" },
  { countryCode: "EG", countryName: "Egypt", number: "122" },
  { countryCode: "NG", countryName: "Nigeria", number: "112" },
  { countryCode: "KE", countryName: "Kenya", number: "999" },
  { countryCode: "MA", countryName: "Morocco", number: "112" },

  // Americas
  { countryCode: "US", countryName: "United States", number: "911" },
  { countryCode: "CA", countryName: "Canada", number: "911" },
  { countryCode: "MX", countryName: "Mexico", number: "911" },
  { countryCode: "BR", countryName: "Brazil", number: "190" },
  { countryCode: "AR", countryName: "Argentina", number: "911" },
  { countryCode: "CL", countryName: "Chile", number: "133" },
  { countryCode: "CO", countryName: "Colombia", number: "123" },
];

/** Emergency info for an explicit ISO alpha-2 country code, if we know it. */
export function emergencyInfoForCountryCode(
  code: string | null | undefined,
): EmergencyInfo | null {
  const normalized = String(code || "")
    .trim()
    .toUpperCase();
  if (!normalized) return null;
  const country = COUNTRIES.find((entry) => entry.countryCode === normalized);
  if (!country) return null;
  return country;
}

/**
 * A cached result, plus the fix it was confirmed at.
 *
 * The origin is what makes a cache safe to trust instantly. A number cached in
 * Delhi is the right answer in Delhi and the WRONG answer in Chicago, and the
 * one screen that must never show a wrong number is this one. Entries written
 * before the origin existed have no coordinates and are only ever used as a
 * last-resort fallback, never as an instant seed.
 */
export type CachedEmergencyInfo = EmergencyInfo & {
  lat: number | null;
  lng: number | null;
};

/**
 * How far from the cached fix the cached country is still assumed to hold.
 *
 * Generous enough to cover a normal day's movement so returning users skip the
 * lookup entirely, and far tighter than any flight. Beyond it the cached answer
 * is not shown at all until the authoritative lookup confirms the country.
 */
export const EMERGENCY_CACHE_TRUST_RADIUS_METERS = 100_000;

/** localStorage key for the last successfully resolved local emergency info. */
export const EMERGENCY_INFO_CACHE_KEY = "one_location_emergency_info_v1";

/**
 * Hard cap on how long the Save My Soul screen waits for the authoritative
 * reverse-geocode before it falls back to the last cached local number (or the
 * retry state). Keeps a slow Maps response from stranding the Call button on a
 * spinner during a safety-critical flow.
 */
export const EMERGENCY_LOOKUP_TIMEOUT_MS = 5_000;

/**
 * Last resolved local emergency info, re-validated against the country table so
 * a stale or tampered cache entry can never surface a wrong number — the table
 * stays the source of truth for the digits, and the cache only remembers which
 * country was last resolved. Returns null when nothing is cached, storage is
 * unavailable, or the cached country is no longer known.
 */
export function readCachedEmergencyInfo(): CachedEmergencyInfo | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(EMERGENCY_INFO_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      countryCode?: unknown;
      lat?: unknown;
      lng?: unknown;
    } | null;
    const countryCode =
      typeof parsed?.countryCode === "string" ? parsed.countryCode : null;
    const info = emergencyInfoForCountryCode(countryCode);
    if (!info) return null;
    const lat = typeof parsed?.lat === "number" && Number.isFinite(parsed.lat)
      ? parsed.lat
      : null;
    const lng = typeof parsed?.lng === "number" && Number.isFinite(parsed.lng)
      ? parsed.lng
      : null;
    // Both or neither: half an origin cannot be distance-checked, and a
    // half-checked origin is the failure this field exists to prevent.
    const hasOrigin = lat !== null && lng !== null;
    return { ...info, lat: hasOrigin ? lat : null, lng: hasOrigin ? lng : null };
  } catch {
    return null;
  }
}

/**
 * Persist the resolved local emergency info together with the fix that proved
 * it. Callers that genuinely have no coordinates may omit them, at the cost of
 * the entry never being trusted as an instant seed.
 */
export function writeCachedEmergencyInfo(
  info: EmergencyInfo,
  origin?: { latitude: number; longitude: number } | null,
): void {
  if (typeof window === "undefined") return;
  try {
    const hasOrigin =
      Number.isFinite(origin?.latitude) && Number.isFinite(origin?.longitude);
    window.localStorage.setItem(
      EMERGENCY_INFO_CACHE_KEY,
      JSON.stringify(
        hasOrigin
          ? {
              countryCode: info.countryCode,
              lat: origin!.latitude,
              lng: origin!.longitude,
            }
          : { countryCode: info.countryCode },
      ),
    );
  } catch {
    // Best-effort: a full or disabled store simply skips the warm cache.
  }
}

/**
 * Whether a country confirmed at `origin` is still assumed to hold at `point`.
 *
 * The single distance rule behind both reusing a cached number and deciding a
 * fresh fix needs re-checking. Missing or non-finite coordinates are false:
 * "we cannot tell" must never read as "same country".
 */
export function isWithinEmergencyTrustRadius(
  origin: { latitude: number; longitude: number } | null | undefined,
  point: { latitude: number; longitude: number } | null | undefined,
): boolean {
  if (
    !origin ||
    !point ||
    !Number.isFinite(origin.latitude) ||
    !Number.isFinite(origin.longitude) ||
    !Number.isFinite(point.latitude) ||
    !Number.isFinite(point.longitude)
  ) {
    return false;
  }
  return (
    haversineMeters(
      { lat: origin.latitude, lng: origin.longitude },
      { lat: point.latitude, lng: point.longitude },
    ) <= EMERGENCY_CACHE_TRUST_RADIUS_METERS
  );
}

/**
 * Whether a cached country may be shown immediately for the given fix.
 *
 * False for entries with no origin and for anything outside the trust radius —
 * in both cases the honest state is "still checking", not a number from
 * somewhere the person no longer is.
 */
export function isCachedEmergencyInfoUsableAt(
  cached: CachedEmergencyInfo | null,
  point: { latitude: number; longitude: number } | null | undefined,
): boolean {
  if (!cached || cached.lat === null || cached.lng === null) return false;
  return isWithinEmergencyTrustRadius(
    { latitude: cached.lat, longitude: cached.lng },
    point,
  );
}
