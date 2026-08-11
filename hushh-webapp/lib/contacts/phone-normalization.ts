/**
 * Contact phone normalization gene.
 *
 * Contact matching works by hashing an E.164 phone number on the device and
 * comparing that digest against the digest of a phone-verified account number.
 * The two sides only ever meet if both produce byte-identical E.164, so this
 * module is the single source of truth for "what E.164 does this raw contact
 * string mean".
 *
 * The previous implementation assumed a bare 10-digit number was North
 * American and prefixed `+1`. That silently broke every match in India (and
 * every other 10-digit national plan): a contact saved as `9876543210` hashed
 * as `+19876543210` while the account itself is `+919876543210`. Region-aware
 * parsing removes the guess.
 *
 * `libphonenumber-js/mobile/metadata` is reused deliberately — the phone
 * verification flow already loads it, so this adds no new metadata blob, and
 * accounts are SMS-verified mobile numbers by construction.
 */

import {
  isSupportedCountry,
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js/core";
import mobilePhoneMetadata from "libphonenumber-js/mobile/metadata";

export type NormalizedContactPhone = {
  /** Strict E.164, e.g. `+919876543210`. This is what gets hashed. */
  e164: string;
  /** Last four digits, used server-side to bucket candidates before hashing. */
  last4: string;
  /**
   * True when the number validates as a mobile line in its region. Accounts are
   * SMS-verified, so mobile numbers are the only ones that can actually match;
   * this lets callers prioritise them when a payload cap forces truncation.
   */
  isMobile: boolean;
};

function asCountryCode(value: unknown): CountryCode | undefined {
  const candidate = String(value ?? "")
    .trim()
    .toUpperCase();
  if (candidate.length !== 2) return undefined;
  return isSupportedCountry(candidate as CountryCode, mobilePhoneMetadata)
    ? (candidate as CountryCode)
    : undefined;
}

/**
 * Resolve which region bare national numbers ("9876543210") should be read in.
 *
 * Ordered by how strongly each signal predicts the contact book's own region:
 * the SIM/network country reported by the device beats the account's own number,
 * which beats the UI locale.
 */
export function resolveContactPhoneRegion(signals: {
  /** Region reported by the native contacts plugin (SIM or network country). */
  deviceRegion?: string | null;
  /** The signed-in user's own verified phone number, in E.164. */
  accountPhoneNumber?: string | null;
  /** BCP-47 locale tag, e.g. `en-IN`. Defaults to the browser locale. */
  localeTag?: string | null;
}): CountryCode | undefined {
  const fromDevice = asCountryCode(signals.deviceRegion);
  if (fromDevice) return fromDevice;

  const accountPhone = String(signals.accountPhoneNumber ?? "").trim();
  if (accountPhone.startsWith("+")) {
    const parsed = parsePhoneNumberFromString(accountPhone, mobilePhoneMetadata);
    const fromAccount = asCountryCode(parsed?.country);
    if (fromAccount) return fromAccount;
  }

  const localeTag =
    signals.localeTag ??
    (typeof navigator !== "undefined" ? navigator.language : null);
  if (localeTag) {
    try {
      const region = new Intl.Locale(localeTag).maximize().region;
      const fromLocale = asCountryCode(region);
      if (fromLocale) return fromLocale;
    } catch {
      /* Malformed locale tags are not worth failing a contact sync over. */
    }
  }

  return undefined;
}

/**
 * Normalize a single raw contact phone string to E.164.
 *
 * Returns null when the string cannot be resolved to a trustworthy E.164 —
 * short codes, junk entries, and national-format numbers with no known region.
 * Guessing in those cases cannot create a match (the digest simply misses) but
 * it does leak an extra hash, so we drop instead.
 */
export function normalizeContactPhone(
  raw: string,
  defaultRegion?: CountryCode,
): NormalizedContactPhone | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;

  // libphonenumber already understands trunk prefixes (`09876543210`) and the
  // `00` international prefix, so no pre-cleaning is needed or wanted here.
  const parsed = defaultRegion
    ? parsePhoneNumberFromString(value, defaultRegion, mobilePhoneMetadata)
    : parsePhoneNumberFromString(value, mobilePhoneMetadata);
  // `isPossible` keeps landlines and unusual-but-real lines while still
  // rejecting short codes and truncated entries. `isValid` is reserved for the
  // mobile signal because the metadata is mobile-only.
  if (!parsed?.isPossible()) return null;

  const e164 = parsed.number;
  if (!/^\+[1-9]\d{6,14}$/.test(e164)) return null;

  return {
    e164,
    last4: e164.replace(/\D/g, "").slice(-4),
    isMobile: parsed.isValid(),
  };
}
