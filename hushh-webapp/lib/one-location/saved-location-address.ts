export type SavedLocationAddressDetails = {
  houseOrFlat: string;
  buildingColor: string;
  landmark: string;
  postalCode: string;
};

export const EMPTY_SAVED_LOCATION_ADDRESS_DETAILS: SavedLocationAddressDetails =
  {
    houseOrFlat: "",
    buildingColor: "",
    landmark: "",
    postalCode: "",
  };

const MAX_HOUSE_OR_FLAT_LENGTH = 80;
const MAX_BUILDING_COLOR_LENGTH = 40;
const MAX_LANDMARK_LENGTH = 100;
const MAX_POSTAL_CODE_LENGTH = 12;
const MAX_SAVED_ADDRESS_LENGTH = 300;

function cleanText(value: string, maxLength: number): string {
  return value.trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function comparable(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function landmarkSegment(value: string): string {
  if (!value) return "";
  return /^(near|opposite|beside|behind|next to)\b/i.test(value)
    ? value
    : `Near ${value}`;
}

function buildingColorSegment(value: string): string {
  if (!value) return "";
  return /\b(building|house|gate|door|tower|block)\b/i.test(value)
    ? value
    : `${value} building`;
}

/**
 * An Open Location Code (a Google "plus code") such as `FVJ7+JR2` or the full
 * `7JVW52GR+2V`. Google returns one as the leading segment whenever it has no
 * street address for the pinned point, which is common on unmapped lanes and
 * inside large campuses.
 *
 * It is a coordinate in disguise, not an address. It must never be offered as
 * a house number, and it is stripped from the line we show and save.
 */
const PLUS_CODE_ALPHABET = "23456789CFGHJMPQRVWX";
const PLUS_CODE_PATTERN = new RegExp(
  `^[${PLUS_CODE_ALPHABET}]{2,8}\\+[${PLUS_CODE_ALPHABET}]{2,3}$`,
  "i",
);

export function isPlusCode(value: string | null | undefined): boolean {
  return PLUS_CODE_PATTERN.test(String(value || "").trim());
}

/**
 * Drop a leading plus code so the person reads "Teliarganj, Prayagraj, Uttar
 * Pradesh 211004, India" instead of "FVJ7+JR2, Teliarganj, ...". The code is
 * kept when it is the ONLY thing Google returned -- a coordinate in disguise
 * still beats a blank line.
 */
export function stripPlusCodeSegment(
  address: string | null | undefined,
): string | null {
  const value = String(address || "").trim();
  if (!value) return null;
  const segments = value.split(",").map((segment) => segment.trim());
  const kept = segments.filter((segment) => segment && !isPlusCode(segment));
  if (kept.length === 0) return value;
  if (kept.length === segments.filter(Boolean).length) return value;
  return kept.join(", ");
}

/**
 * Extract a likely PIN/postal code for a helpful, editable form prefill.
 *
 * Ordered most-specific first so a six-digit Indian PIN is never beaten by a
 * four-digit fragment, and so an alphanumeric UK/Canadian/Dutch code is found
 * at all -- `isValidPostalCode` has always accepted those, but nothing ever
 * detected them, so people outside the 5/6-digit world got an empty field on
 * an address that plainly carried one.
 */
export function inferPostalCode(address: string | null | undefined): string {
  const value = String(address || "");
  const direct =
    // India / China / Singapore and friends.
    value.match(/\b\d{6}\b/)?.[0] ??
    // US ZIP and ZIP+4.
    value.match(/\b\d{5}(?:-\d{4})?\b/)?.[0] ??
    // UK: SW1A 1AA, M1 1AE, CR2 6XH.
    value.match(/\b[A-Z]{1,2}\d[A-Z\d]?\s+\d[A-Z]{2}\b/i)?.[0] ??
    // Canada: K1A 0B1.
    value.match(/\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/i)?.[0] ??
    // Netherlands: 1012 AB.
    value.match(/\b\d{4}\s?[A-Z]{2}\b/)?.[0] ??
    null;
  if (direct) return cleanText(direct, MAX_POSTAL_CODE_LENGTH);

  // A bare four-digit code (AU, NZ, much of Europe) only counts when it sits
  // in the tail of the address, where a postal code lives. Taken anywhere it
  // would happily lift a house number or a road number instead.
  const segments = value
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean);
  for (const segment of segments.slice(-2)) {
    const match = segment.match(/\b\d{4}\b/)?.[0];
    if (match) return match;
  }
  return "";
}

/** The part before the first comma, which is where a house number sits. */
function firstAddressSegment(address: string | null | undefined): string {
  return String(address || "").split(",")[0]?.trim() ?? "";
}

/**
 * Pull a house/plot designator out of a formatted address, when there plainly
 * is one -- "B-284/3, Rd Number 1, Chhatarpur, New Delhi 110074" opens with a
 * house number, "Kartavya Path, New Delhi" does not.
 *
 * Deliberately narrow. It accepts a first segment with no spaces that contains
 * a digit ("B-284/3", "42", "A-12"), or one that names itself ("Flat 4B",
 * "Qtr. No.- 123/2", "Plot 22"). It will not take "12 MG Road", which is a
 * street that happens to carry a number -- putting that in the House-flat box
 * would be wrong, and a wrong prefill is worse than an empty one because
 * people trust prefilled fields and stop reading them.
 *
 * Nor will it take a plus code. `FVJ7+JR2` has no spaces and carries digits,
 * so the old shape rule accepted it and put a coordinate in the House-flat
 * box -- exactly the "address is not populating" the form was reported for.
 */
const HOUSE_DESIGNATOR_PATTERN =
  /^(flat|plot|house|apartment|apt|qtr|quarter|no\.?|h\.?\s?no|d\.?\s?no|#|door|shop|unit|block|villa|bungalow|survey|khasra|gala|room|suite|ste)\b/i;

export function inferHouseOrFlat(address: string | null | undefined): string {
  const segment = firstAddressSegment(address);
  if (!segment || segment.length > MAX_HOUSE_OR_FLAT_LENGTH) return "";
  if (!/\d/.test(segment)) return "";
  if (isPlusCode(segment)) return "";
  const namesItself = HOUSE_DESIGNATOR_PATTERN.test(segment);
  if (!namesItself && /\s/.test(segment)) return "";
  return cleanText(segment, MAX_HOUSE_OR_FLAT_LENGTH);
}

/**
 * The fields a detected address can fill on its own. Everything else on the
 * form -- building colour, landmark -- is knowledge the address does not carry
 * and only the person standing there has.
 */
export function inferSavedLocationAddressDetails(
  address: string | null | undefined,
): Pick<SavedLocationAddressDetails, "houseOrFlat" | "postalCode"> {
  // A leading plus code hides the real opening segment. "FVJ7+JR2, Qtr. No.-
  // 123/2, Teliarganj, ..." carries a house number; it is just not first.
  const readable = stripPlusCodeSegment(address);
  return {
    houseOrFlat: inferHouseOrFlat(readable),
    postalCode: inferPostalCode(readable),
  };
}

/**
 * Accept the common global PIN/postal-code shapes without pretending that all
 * countries use India's six-digit format. The field remains human-editable.
 */
export function isValidPostalCode(value: string): boolean {
  const normalized = cleanText(value, MAX_POSTAL_CODE_LENGTH);
  return (
    normalized.length >= 3 &&
    normalized.length <= MAX_POSTAL_CODE_LENGTH &&
    /^[\p{L}\p{N}][\p{L}\p{N}\s-]*[\p{L}\p{N}]$/u.test(normalized)
  );
}

export function normalizeSavedLocationAddressDetails(
  details: SavedLocationAddressDetails,
): SavedLocationAddressDetails {
  return {
    houseOrFlat: cleanText(details.houseOrFlat, MAX_HOUSE_OR_FLAT_LENGTH),
    buildingColor: cleanText(details.buildingColor, MAX_BUILDING_COLOR_LENGTH),
    landmark: cleanText(details.landmark, MAX_LANDMARK_LENGTH),
    postalCode: cleanText(details.postalCode, MAX_POSTAL_CODE_LENGTH),
  };
}

/**
 * Compose the structured onboarding answers into the existing encrypted
 * saved-place address contract. This deliberately avoids a second schema or a
 * plaintext pre-vault record. Required entrance and postal details stay ahead
 * of optional overflow under the existing 300-character address contract.
 */
export function buildSavedLocationAddress(
  mapAddress: string | null | undefined,
  details: SavedLocationAddressDetails,
): string | null {
  const normalized = normalizeSavedLocationAddressDetails(details);
  // Saved exactly as it was shown: the plus code is dropped on screen, so it
  // must not reappear inside the stored line.
  const baseAddress = cleanText(
    String(stripPlusCodeSegment(mapAddress) || ""),
    MAX_SAVED_ADDRESS_LENGTH,
  );
  // The house number is now prefilled FROM the address, so on most saves it is
  // the address's own opening segment coming back round. Prepending it would
  // read "B-284/3, B-284/3, Rd Number 1, ...". Compared segment-to-segment, not
  // as a prefix of the whole line, so a genuine "12" is not swallowed by a
  // "1234 Main St" that merely starts with the same digits.
  const houseOrFlatAlreadyLeads =
    Boolean(normalized.houseOrFlat) &&
    comparable(firstAddressSegment(baseAddress)) ===
      comparable(normalized.houseOrFlat);

  const rawSegments = [
    houseOrFlatAlreadyLeads ? "" : normalized.houseOrFlat,
    buildingColorSegment(normalized.buildingColor),
    landmarkSegment(normalized.landmark),
    baseAddress,
  ].filter(Boolean);

  const seen = new Set<string>();
  const segments = rawSegments.filter((segment) => {
    const key = comparable(segment);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const withoutPostal = segments.join(", ");
  let composed = withoutPostal.slice(0, MAX_SAVED_ADDRESS_LENGTH);
  const postalCode = normalized.postalCode;
  if (
    postalCode &&
    !composed.toLocaleLowerCase().includes(postalCode.toLocaleLowerCase())
  ) {
    const suffix = `, ${postalCode}`;
    const prefix = withoutPostal
      .slice(0, Math.max(0, MAX_SAVED_ADDRESS_LENGTH - suffix.length))
      .replace(/[,\s]+$/u, "");
    composed = prefix ? `${prefix}${suffix}` : postalCode;
  }
  return composed || null;
}
