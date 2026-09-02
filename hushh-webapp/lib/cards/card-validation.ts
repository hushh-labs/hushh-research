/**
 * Region-aware payment-card validation. Pure module: no network, no storage.
 *
 * BYOK means only the browser ever sees the PAN, so this module is the
 * authoritative validator for secrets (Luhn, brand detection, CVV/PIN shape).
 * The server independently re-validates the non-secret envelope (brand, last4,
 * expiry, issuing region) in consent-protocol payment_card_validation.py -
 * keep the region rules in the two files in sync.
 *
 * Region rule: region-locked schemes (RuPay, Mir, Elo, Verve) must claim their
 * home regions; global schemes validate for every region. Rejecting a global
 * brand for any region would refuse legitimately issued cards.
 */

export type CardBrand =
  | "visa"
  | "mastercard"
  | "amex"
  | "discover"
  | "diners"
  | "jcb"
  | "unionpay"
  | "rupay"
  | "mir"
  | "elo"
  | "verve"
  | "other";

export const REGION_LOCKED_BRANDS: Readonly<Partial<Record<CardBrand, readonly string[]>>> = {
  rupay: ["IN"],
  mir: ["RU", "AM", "BY", "KZ", "KG", "TJ", "UZ"],
  elo: ["BR"],
  verve: ["NG", "GH"],
};

const BRAND_PAN_LENGTHS: Readonly<Record<CardBrand, readonly number[]>> = {
  visa: [13, 16, 19],
  mastercard: [16],
  amex: [15],
  discover: [16, 19],
  diners: [14, 16, 19],
  jcb: [16, 17, 18, 19],
  unionpay: [16, 17, 18, 19],
  rupay: [16],
  mir: [16, 17, 18, 19],
  elo: [16],
  verve: [16, 18, 19],
  other: [13, 14, 15, 16, 17, 18, 19],
};

/** Numeric prefix ranges per brand; order matters (specific before broad). */
const BRAND_PREFIX_RANGES: ReadonlyArray<[CardBrand, number, number]> = [
  // Region-locked and narrow BINs first so broad ranges never shadow them.
  ["mir", 2200, 2204],
  ["elo", 401178, 401179],
  ["elo", 431274, 431274],
  ["elo", 438935, 438935],
  ["elo", 451416, 451416],
  ["elo", 457393, 457393],
  ["elo", 504175, 504175],
  ["elo", 506699, 506778],
  ["elo", 509000, 509999],
  ["elo", 627780, 627780],
  ["elo", 636297, 636297],
  ["elo", 636368, 636368],
  ["verve", 506099, 506198],
  ["verve", 650002, 650027],
  ["rupay", 6521, 6522],
  ["rupay", 508, 508],
  ["rupay", 353, 353],
  ["rupay", 356, 356],
  ["rupay", 60, 60],
  ["rupay", 81, 82],
  ["jcb", 3528, 3589],
  ["amex", 34, 34],
  ["amex", 37, 37],
  ["diners", 300, 305],
  ["diners", 36, 36],
  ["diners", 38, 39],
  ["discover", 6011, 6011],
  ["discover", 622126, 622925],
  ["discover", 644, 649],
  ["discover", 65, 65],
  ["unionpay", 62, 62],
  ["mastercard", 2221, 2720],
  ["mastercard", 51, 55],
  ["visa", 4, 4],
];

export function normalizePan(raw: string): string {
  return String(raw ?? "").replace(/[\s-]/g, "");
}

export function luhnValid(pan: string): boolean {
  const digits = normalizePan(pan);
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  let doubled = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = digits.charCodeAt(i) - 48;
    if (doubled) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    doubled = !doubled;
  }
  return sum % 10 === 0;
}

export function detectBrand(pan: string): CardBrand | null {
  const digits = normalizePan(pan);
  if (!/^\d{6,19}$/.test(digits)) return null;
  for (const [brand, lo, hi] of BRAND_PREFIX_RANGES) {
    const width = String(lo).length;
    const prefix = Number(digits.slice(0, width));
    if (prefix >= lo && prefix <= hi) return brand;
  }
  return null;
}

export interface CardValidationInput {
  pan: string;
  cvv?: string;
  pin?: string;
  expiryMonth: number;
  expiryYear: number;
  /** ISO-3166 alpha-2, e.g. "IN", "US". */
  issuingRegion: string;
  /** Injectable clock for tests. */
  now?: Date;
}

export interface CardValidationResult {
  valid: boolean;
  brand: CardBrand | null;
  last4: string;
  errors: string[];
}

export function validateCardForRegion(input: CardValidationInput): CardValidationResult {
  const errors: string[] = [];
  const digits = normalizePan(input.pan);
  const brand = detectBrand(digits);
  const region = String(input.issuingRegion ?? "").trim().toUpperCase();

  if (!/^\d{13,19}$/.test(digits)) {
    errors.push("pan_length_invalid");
  } else if (!luhnValid(digits)) {
    errors.push("pan_checksum_invalid");
  }

  if (brand === null) {
    errors.push("brand_unrecognized");
  } else if (/^\d{13,19}$/.test(digits) && !BRAND_PAN_LENGTHS[brand].includes(digits.length)) {
    errors.push("pan_length_invalid_for_brand");
  }

  if (!/^[A-Z]{2}$/.test(region)) {
    errors.push("issuing_region_invalid");
  } else if (brand) {
    const locked = REGION_LOCKED_BRANDS[brand];
    if (locked && !locked.includes(region)) {
      errors.push("brand_region_mismatch");
    }
  }

  if (input.cvv !== undefined && input.cvv !== "") {
    const expectedCvvLength = brand === "amex" ? 4 : 3;
    if (!new RegExp(`^\\d{${expectedCvvLength}}$`).test(input.cvv)) {
      errors.push("cvv_invalid");
    }
  }

  if (input.pin !== undefined && input.pin !== "") {
    if (!/^\d{4,6}$/.test(input.pin)) {
      errors.push("pin_invalid");
    }
  }

  const month = input.expiryMonth;
  const year = input.expiryYear;
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    errors.push("expiry_month_invalid");
  }
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    errors.push("expiry_year_invalid");
  } else if (Number.isInteger(month) && month >= 1 && month <= 12) {
    const now = input.now ?? new Date();
    const endOfExpiryMonth = new Date(year, month, 1);
    if (endOfExpiryMonth <= now) {
      errors.push("card_expired");
    }
  }

  return {
    valid: errors.length === 0,
    brand,
    last4: digits.length >= 4 ? digits.slice(-4) : "",
    errors,
  };
}
