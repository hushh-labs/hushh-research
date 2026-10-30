/**
 * Region-aware payment-card validation. Pure module: no network, no storage.
 *
 * BYOK means only the browser ever sees the PAN, so this module is the
 * local validator for card details (checksum, name and expiry).
 * The server independently re-validates the non-secret envelope (brand, last4,
 * expiry, issuing region) in consent-protocol wallet_card_validation.py -
 * keep the region rules in the two files in sync.
 *
 * Region rule: region-locked schemes (RuPay, Mir, Elo, Verve) must claim their
 * home regions; global schemes validate for every region. Rejecting a global
 * brand for any region would refuse legitimately issued cards.
 */

import { isWalletSecurityCode } from "./card-security-code";

export const CARD_BRANDS = [
  "visa", "mastercard", "amex", "discover", "diners", "jcb",
  "unionpay", "rupay", "mir", "elo", "verve", "other",
] as const;

export type KnownCardBrand = (typeof CARD_BRANDS)[number];
// The backend owns supported networks. This list only specializes credential
// validation for networks this client knows; it must not classify a PAN.
export type CardBrand = string;

export function isCardNetworkId(value: unknown): value is CardBrand {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,39}$/.test(value);
}

export const REGION_LOCKED_BRANDS: Readonly<Partial<Record<CardBrand, readonly string[]>>> = {
  rupay: ["IN"],
  mir: ["RU", "AM", "BY", "KZ", "KG", "TJ", "UZ"],
  elo: ["BR"],
  verve: ["NG", "GH"],
};

const BRAND_PAN_LENGTHS: Readonly<Record<KnownCardBrand, readonly number[]>> = {
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
  other: [12, 13, 14, 15, 16, 17, 18, 19],
};

/** Validate an already identified/selected network; never infer one from a PAN. */
export function isCardPanLengthValid(length: number, network: CardBrand): boolean {
  const credentialBrand = Object.hasOwn(BRAND_PAN_LENGTHS, network) ? network as KnownCardBrand : "other";
  return BRAND_PAN_LENGTHS[credentialBrand].includes(length);
}

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

export interface CardValidationInput {
  pan: string;
  cardholderName: string;
  /** The owner may select a network for overlapping or newer BIN ranges. */
  brand?: CardBrand;
  /** Legacy inputs remain ignored and are never promoted into manual codes. */
  cvv?: string;
  pin?: string;
  /** Optional manual Wallet entry, separate from ignored legacy CVV inputs. */
  securityCode?: string;
  expiryMonth: number;
  expiryYear: number;
  /** Optional ISO-3166 alpha-2, e.g. "IN", "US". */
  issuingRegion?: string;
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
  const selectedBrand = input.brand;
  const validSelection = selectedBrand === undefined || isCardNetworkId(selectedBrand);
  const brand = validSelection ? (selectedBrand ?? "other") : "other";
  const cardholderName = String(input.cardholderName ?? "").trim();
  if (input.securityCode !== undefined && input.securityCode !== "" && !isWalletSecurityCode(input.securityCode)) errors.push("security_code_invalid");
  if (!validSelection) errors.push("brand_invalid");
  if (!cardholderName) {
    errors.push("cardholder_name_required");
  } else if (cardholderName.length > 80 || /[\u0000-\u001f\u007f]/.test(cardholderName)) {
    errors.push("cardholder_name_invalid");
  }
  const region = String(input.issuingRegion ?? "").trim().toUpperCase();

  if (!/^\d{12,19}$/.test(digits)) {
    errors.push("pan_length_invalid");
  } else if (/^(\d)\1+$/.test(digits) || (brand !== "unionpay" && !luhnValid(digits))) {
    errors.push("pan_checksum_invalid");
  }

  if (/^\d{12,19}$/.test(digits) && !isCardPanLengthValid(digits.length, brand)) {
    errors.push("pan_length_invalid_for_brand");
  }

  if (region && !/^[A-Z]{2}$/.test(region)) {
    errors.push("issuing_region_invalid");
  } else if (region) {
    const locked = Object.hasOwn(REGION_LOCKED_BRANDS, brand) ? REGION_LOCKED_BRANDS[brand] : undefined;
    if (locked && !locked.includes(region)) {
      errors.push("brand_region_mismatch");
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
    // UTC on both sides: the boundary must not move with the viewer's zone.
    const endOfExpiryMonth = Date.UTC(year, month, 1);
    if (endOfExpiryMonth <= now.getTime()) {
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
