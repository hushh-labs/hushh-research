/**
 * Offline emergency-number resolver for the SMS · Save My Soul screen.
 *
 * The Save My Soul flow must work even with no internet, so we CANNOT rely on a
 * network reverse-geocode to learn which country the user is in. Instead we map
 * the device's last known coordinates to a country using a lightweight set of
 * bounding boxes, then look up that country's primary emergency dial number.
 *
 * This is intentionally coordinate-only and dependency-free. When no location is
 * known (or the point falls outside every known box) we degrade gracefully to a
 * sensible default (US 911 with no location; 112 — the international GSM
 * emergency number — for an unrecognised location).
 */

import type { PlainLocationPoint } from "@/lib/one-location/types";

export type EmergencyInfo = {
  /** ISO 3166-1 alpha-2 country code (uppercase), or "" when unknown. */
  countryCode: string;
  /** Human-readable country label, or "" when unknown. */
  countryName: string;
  /** Primary emergency number to dial in that country. */
  number: string;
};

/** Fallback used when we have no location signal at all. */
export const DEFAULT_EMERGENCY: EmergencyInfo = {
  countryCode: "US",
  countryName: "United States",
  number: "911",
};

/**
 * 112 works on virtually every GSM network worldwide, so it is the safest
 * fallback when we DO have a location but cannot match it to a known country.
 */
export const INTERNATIONAL_EMERGENCY: EmergencyInfo = {
  countryCode: "",
  countryName: "",
  number: "112",
};

type BoundingBox = readonly [
  latMin: number,
  latMax: number,
  lngMin: number,
  lngMax: number,
];

type CountryEmergency = {
  code: string;
  name: string;
  number: string;
  /** One or more approximate bounding boxes covering the country. */
  boxes: readonly BoundingBox[];
};

/**
 * Curated country table with primary emergency numbers and approximate bounding
 * boxes. Boxes are deliberately coarse; when several match a point we choose the
 * smallest-area box so small nations (UAE, Singapore, UK) win over the large
 * regions that may enclose them.
 */
const COUNTRIES: readonly CountryEmergency[] = [
  // South Asia
  { code: "IN", name: "India", number: "112", boxes: [[6.5, 35.6, 68.0, 97.5]] },
  { code: "PK", name: "Pakistan", number: "15", boxes: [[23.5, 37.1, 60.9, 77.9]] },
  { code: "LK", name: "Sri Lanka", number: "119", boxes: [[5.8, 9.9, 79.6, 81.9]] },
  { code: "BD", name: "Bangladesh", number: "999", boxes: [[20.6, 26.7, 88.0, 92.7]] },
  { code: "NP", name: "Nepal", number: "112", boxes: [[26.3, 30.5, 80.0, 88.2]] },

  // Middle East
  { code: "AE", name: "United Arab Emirates", number: "999", boxes: [[22.6, 26.1, 51.5, 56.4]] },
  { code: "QA", name: "Qatar", number: "999", boxes: [[24.4, 26.2, 50.7, 51.7]] },
  { code: "BH", name: "Bahrain", number: "999", boxes: [[25.7, 26.4, 50.3, 50.8]] },
  { code: "KW", name: "Kuwait", number: "112", boxes: [[28.5, 30.1, 46.5, 48.5]] },
  { code: "OM", name: "Oman", number: "9999", boxes: [[16.6, 26.4, 52.0, 59.9]] },
  { code: "SA", name: "Saudi Arabia", number: "999", boxes: [[16.3, 32.2, 34.5, 55.7]] },
  { code: "IL", name: "Israel", number: "112", boxes: [[29.4, 33.4, 34.2, 35.9]] },
  { code: "TR", name: "Türkiye", number: "112", boxes: [[35.8, 42.2, 25.6, 44.9]] },

  // East & Southeast Asia
  { code: "CN", name: "China", number: "110", boxes: [[18.0, 53.6, 73.5, 134.8]] },
  { code: "JP", name: "Japan", number: "110", boxes: [[24.0, 45.6, 122.9, 146.0]] },
  { code: "KR", name: "South Korea", number: "112", boxes: [[33.1, 38.7, 125.9, 129.7]] },
  { code: "SG", name: "Singapore", number: "999", boxes: [[1.15, 1.48, 103.6, 104.1]] },
  { code: "MY", name: "Malaysia", number: "999", boxes: [[0.8, 7.4, 99.6, 119.3]] },
  { code: "ID", name: "Indonesia", number: "112", boxes: [[-11.0, 6.1, 95.0, 141.0]] },
  { code: "TH", name: "Thailand", number: "191", boxes: [[5.6, 20.5, 97.3, 105.7]] },
  { code: "PH", name: "Philippines", number: "911", boxes: [[4.6, 21.1, 116.9, 126.6]] },
  { code: "VN", name: "Vietnam", number: "113", boxes: [[8.2, 23.4, 102.1, 109.5]] },
  { code: "HK", name: "Hong Kong", number: "999", boxes: [[22.15, 22.56, 113.83, 114.44]] },

  // Oceania
  { code: "AU", name: "Australia", number: "000", boxes: [[-43.7, -10.5, 113.0, 153.7]] },
  { code: "NZ", name: "New Zealand", number: "111", boxes: [[-47.3, -34.1, 166.4, 178.6]] },

  // Europe (most use the pan-EU 112)
  { code: "GB", name: "United Kingdom", number: "999", boxes: [[49.9, 60.9, -8.7, 1.8]] },
  { code: "IE", name: "Ireland", number: "112", boxes: [[51.4, 55.5, -10.6, -6.0]] },
  { code: "FR", name: "France", number: "112", boxes: [[41.3, 51.1, -5.2, 9.6]] },
  { code: "DE", name: "Germany", number: "112", boxes: [[47.2, 55.1, 5.8, 15.1]] },
  { code: "ES", name: "Spain", number: "112", boxes: [[36.0, 43.8, -9.4, 3.4]] },
  { code: "PT", name: "Portugal", number: "112", boxes: [[36.9, 42.2, -9.6, -6.2]] },
  { code: "IT", name: "Italy", number: "112", boxes: [[36.6, 47.1, 6.6, 18.6]] },
  { code: "NL", name: "Netherlands", number: "112", boxes: [[50.7, 53.6, 3.3, 7.3]] },
  { code: "BE", name: "Belgium", number: "112", boxes: [[49.5, 51.6, 2.5, 6.4]] },
  { code: "CH", name: "Switzerland", number: "112", boxes: [[45.8, 47.9, 5.9, 10.6]] },
  { code: "AT", name: "Austria", number: "112", boxes: [[46.3, 49.1, 9.5, 17.2]] },
  { code: "SE", name: "Sweden", number: "112", boxes: [[55.3, 69.1, 11.1, 24.2]] },
  { code: "NO", name: "Norway", number: "112", boxes: [[57.9, 71.2, 4.6, 31.1]] },
  { code: "DK", name: "Denmark", number: "112", boxes: [[54.5, 57.8, 8.0, 12.7]] },
  { code: "FI", name: "Finland", number: "112", boxes: [[59.7, 70.1, 20.5, 31.6]] },
  { code: "PL", name: "Poland", number: "112", boxes: [[49.0, 54.9, 14.1, 24.2]] },
  { code: "CZ", name: "Czechia", number: "112", boxes: [[48.5, 51.1, 12.1, 18.9]] },
  { code: "GR", name: "Greece", number: "112", boxes: [[34.8, 41.8, 19.3, 28.3]] },
  { code: "RO", name: "Romania", number: "112", boxes: [[43.6, 48.3, 20.2, 29.7]] },
  { code: "RU", name: "Russia", number: "112", boxes: [[41.2, 77.7, 27.3, 180.0]] },
  { code: "UA", name: "Ukraine", number: "112", boxes: [[44.3, 52.4, 22.1, 40.2]] },

  // Africa
  { code: "ZA", name: "South Africa", number: "10111", boxes: [[-34.9, -22.1, 16.4, 32.9]] },
  { code: "EG", name: "Egypt", number: "122", boxes: [[22.0, 31.7, 24.7, 36.9]] },
  { code: "NG", name: "Nigeria", number: "112", boxes: [[4.2, 13.9, 2.7, 14.7]] },
  { code: "KE", name: "Kenya", number: "999", boxes: [[-4.7, 5.0, 33.9, 41.9]] },
  { code: "MA", name: "Morocco", number: "112", boxes: [[27.6, 35.9, -13.2, -1.0]] },

  // Americas
  {
    code: "US",
    name: "United States",
    number: "911",
    boxes: [
      [24.5, 49.5, -125.0, -66.9], // contiguous
      [51.0, 71.5, -170.0, -129.0], // Alaska
      [18.9, 22.3, -160.3, -154.8], // Hawaii
    ],
  },
  { code: "CA", name: "Canada", number: "911", boxes: [[41.7, 83.1, -141.0, -52.6]] },
  { code: "MX", name: "Mexico", number: "911", boxes: [[14.5, 32.7, -118.4, -86.7]] },
  { code: "BR", name: "Brazil", number: "190", boxes: [[-33.8, 5.3, -74.0, -34.8]] },
  { code: "AR", name: "Argentina", number: "911", boxes: [[-55.1, -21.8, -73.6, -53.6]] },
  { code: "CL", name: "Chile", number: "133", boxes: [[-56.0, -17.5, -75.7, -66.4]] },
  { code: "CO", name: "Colombia", number: "123", boxes: [[-4.2, 13.4, -79.0, -66.9]] },
];

function boxArea(box: BoundingBox): number {
  return (box[1] - box[0]) * (box[3] - box[2]);
}

function boxContains(box: BoundingBox, lat: number, lng: number): boolean {
  return lat >= box[0] && lat <= box[1] && lng >= box[2] && lng <= box[3];
}

/**
 * Resolve a country entry from coordinates, preferring the smallest matching
 * bounding box so small countries win over the larger regions enclosing them.
 */
function resolveCountry(lat: number, lng: number): CountryEmergency | null {
  let best: CountryEmergency | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const country of COUNTRIES) {
    for (const box of country.boxes) {
      if (!boxContains(box, lat, lng)) continue;
      const area = boxArea(box);
      if (area < bestArea) {
        bestArea = area;
        best = country;
      }
    }
  }
  return best;
}

/** Emergency info for an explicit ISO alpha-2 country code, if we know it. */
export function emergencyInfoForCountryCode(
  code: string | null | undefined,
): EmergencyInfo | null {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return null;
  const country = COUNTRIES.find((entry) => entry.code === normalized);
  if (!country) return null;
  return {
    countryCode: country.code,
    countryName: country.name,
    number: country.number,
  };
}

/**
 * Resolve the emergency number for the user's current location.
 *
 * - No point → {@link DEFAULT_EMERGENCY} (US 911), preserving prior behaviour.
 * - Known country → that country's primary emergency number.
 * - Point outside every known box → {@link INTERNATIONAL_EMERGENCY} (112).
 */
export function emergencyInfoForPoint(
  point: PlainLocationPoint | null | undefined,
): EmergencyInfo {
  if (
    !point ||
    typeof point.latitude !== "number" ||
    typeof point.longitude !== "number" ||
    Number.isNaN(point.latitude) ||
    Number.isNaN(point.longitude)
  ) {
    return DEFAULT_EMERGENCY;
  }
  const country = resolveCountry(point.latitude, point.longitude);
  if (!country) return INTERNATIONAL_EMERGENCY;
  return {
    countryCode: country.code,
    countryName: country.name,
    number: country.number,
  };
}
