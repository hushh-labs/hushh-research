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

/** Extract a likely PIN/postal code for a helpful, editable form prefill. */
export function inferPostalCode(address: string | null | undefined): string {
  const value = String(address || "");
  return (
    value.match(/\b\d{6}\b/)?.[0] ??
    value.match(/\b\d{5}(?:-\d{4})?\b/)?.[0] ??
    ""
  );
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
 * "Plot 22"). It will not take "12 MG Road", which is a street that happens to
 * carry a number -- putting that in the House-flat box would be wrong, and a
 * wrong prefill is worse than an empty one because people trust prefilled
 * fields and stop reading them.
 */
export function inferHouseOrFlat(address: string | null | undefined): string {
  const segment = firstAddressSegment(address);
  if (!segment || segment.length > MAX_HOUSE_OR_FLAT_LENGTH) return "";
  if (!/\d/.test(segment)) return "";
  const namesItself =
    /^(flat|plot|house|apartment|apt|no\.?|#|door|shop|unit|block)\b/i.test(
      segment,
    );
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
  return {
    houseOrFlat: inferHouseOrFlat(address),
    postalCode: inferPostalCode(address),
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
  const baseAddress = cleanText(
    String(mapAddress || ""),
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
