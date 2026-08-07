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
  const rawSegments = [
    normalized.houseOrFlat,
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
