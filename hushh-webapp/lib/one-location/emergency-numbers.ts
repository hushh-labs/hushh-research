/**
 * Emergency-number lookup for the SMS · Save My Soul screen.
 *
 * Country identification is intentionally outside this module. The safety UI
 * supplies an authoritative ISO country code from the authenticated Google Maps
 * reverse-geocode service; approximate coordinate rectangles are not accurate
 * enough for an emergency dial action.
 */

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
