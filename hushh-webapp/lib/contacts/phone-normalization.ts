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
 * `libphonenumber-js/max/metadata` is used deliberately for correctness.
 * Max metadata is required for ambiguity checks. Mobile-only metadata cannot
 * recognize a valid local fixed line, which could otherwise be reinterpreted
 * as a different person's foreign mobile number.
 */

import {
  isSupportedCountry,
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js/core";
import maxPhoneMetadata from "libphonenumber-js/max/metadata";

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
  return isSupportedCountry(candidate as CountryCode, maxPhoneMetadata)
    ? (candidate as CountryCode)
    : undefined;
}

/**
 * Resolve which region bare national numbers ("9876543210") should be read in.
 *
 * Ordered by how strongly each signal predicts the contact book's own region.
 * A region derived from the home number plan (the SIM) is the best predictor
 * and goes first. Everything else is ranked BELOW the
 * account's own verified number, which beats the UI locale.
 *
 * That distinction is the whole point of `deviceRegionFromNumberPlan`, and only
 * one caller can set it. Android reads `simCountryIso` only
 * (HushhContactsPlugin.kt:126); a serving-network country is deliberately not
 * used because it changes while roaming. iOS reads `Locale.current` and nothing else
 * (HushhContactsPlugin.swift:128) -- not an oversight: `CTCarrier` has returned
 * dummy values since iOS 16, so an iPhone has no number plan to report. The web
 * picker passes the browser locale (contacts-web.ts:82).
 *
 * Ranking a locale above the account's own number is not a small mistake. A
 * bare `9876543210` read as US parses to `+19876543210` and as IN to
 * `+919876543210`, and `isPossible()` is true for BOTH -- so nothing is
 * dropped, nothing errors, the digest simply misses and the person is told
 * nobody was found. An Indian account on an iPhone set to English (US) matched
 * none of their own contacts.
 *
 * `google-people-source.ts:198` already documented this and sidestepped it by
 * passing `defaultRegion: null`. This fixes it at the source instead, so the
 * iOS and picker paths get it too.
 */
export function resolveContactPhoneRegion(signals: {
  /** Region reported by the native contacts plugin or the web picker. */
  deviceRegion?: string | null;
  /**
   * True only when `deviceRegion` came from the device's home number plan (the
   * SIM) rather than a locale. Absent means "a locale", which
   * is the safe default: it ranks the value below the account's own number.
   */
  deviceRegionFromNumberPlan?: boolean;
  /** The signed-in user's own verified phone number, in E.164. */
  accountPhoneNumber?: string | null;
  /** BCP-47 locale tag, e.g. `en-IN`. Defaults to the browser locale. */
  localeTag?: string | null;
}): CountryCode | undefined {
  const fromDevice = asCountryCode(signals.deviceRegion);
  if (fromDevice && signals.deviceRegionFromNumberPlan) return fromDevice;

  const accountPhone = String(signals.accountPhoneNumber ?? "").trim();
  if (accountPhone.startsWith("+")) {
    const parsed = parsePhoneNumberFromString(accountPhone, maxPhoneMetadata);
    const fromAccount = asCountryCode(parsed?.country);
    if (fromAccount) return fromAccount;
  }

  // A locale-derived device region still beats the browser's own language --
  // on native it is the phone's region setting, which at least belongs to the
  // person rather than to whatever the WebView reports.
  if (fromDevice) return fromDevice;

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
  const regionalCandidate = defaultRegion
    ? parsePhoneNumberFromString(value, defaultRegion, maxPhoneMetadata)
    : parsePhoneNumberFromString(value, maxPhoneMetadata);

  // Some address books strip the leading `+` while retaining the country
  // calling code. Parsing `14155550101` under IN, for example, yields the
  // merely-possible `+9114155550101`; parsing the same digits as an
  // international number yields the valid US mobile `+14155550101`. Only let
  // this interpretation override the region when it is a valid mobile and the
  // regional interpretation is not. If both are valid but different, the
  // number is genuinely ambiguous and the stronger region signal wins.
  const digits = value.replace(/\D/g, "");
  const mayBeCountryCodedWithoutPlus =
    !value.startsWith("+") &&
    !/[A-Za-z]/.test(value) &&
    /^[1-9]\d{7,14}$/.test(digits);
  const internationalCandidate = mayBeCountryCodedWithoutPlus
    ? parsePhoneNumberFromString(`+${digits}`, maxPhoneMetadata)
    : undefined;
  const internationalType = internationalCandidate?.getType();
  const internationalIsMobile =
    internationalType === "MOBILE" ||
    internationalType === "FIXED_LINE_OR_MOBILE";
  const parsed =
    internationalCandidate?.isValid() &&
    internationalIsMobile &&
    (!regionalCandidate?.isValid() ||
      internationalCandidate.number === regionalCandidate.number)
      ? internationalCandidate
      : regionalCandidate;
  // `isPossible` keeps landlines and unusual-but-real lines while still
  // rejecting short codes and truncated entries. `isValid` is reserved for the
  // mobile signal because matching prioritizes SMS-capable account numbers.
  if (!parsed?.isPossible()) return null;

  const e164 = parsed.number;
  if (!/^\+[1-9]\d{6,14}$/.test(e164)) return null;

  return {
    e164,
    last4: e164.replace(/\D/g, "").slice(-4),
    isMobile:
      parsed.getType() === "MOBILE" ||
      parsed.getType() === "FIXED_LINE_OR_MOBILE",
  };
}
