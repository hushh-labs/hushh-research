/**
 * How a saved phone number is shown back to the person who saved it.
 *
 * The stored value is strict E.164 (`+919682XX9352`). The old mask stripped
 * every non-digit first, so the Account screen printed `919682 •• •• 9352` — a
 * country code fused onto the number with no `+` in front of it, and two
 * separated pairs of bullets standing in for two hidden digits. Nobody reads
 * their own number that way.
 *
 * This keeps the `+`, separates the calling code, and hides the middle with one
 * bullet per hidden digit, so the count is honest:
 *
 *   +919682889352  ->  +91 9682••9352
 *   +14155552671   ->  +1 4155••2671
 *
 * `libphonenumber-js/mobile/metadata` is reused deliberately — the phone
 * verification flow already loads it and is imported by both screens that call
 * this, so it adds no new metadata blob. It is NOT added to
 * `phone-mandate-service`, which the auth guard and the post-auth route service
 * both pull in on a hot path.
 */

import { parsePhoneNumberFromString } from "libphonenumber-js/core";
import mobilePhoneMetadata from "libphonenumber-js/mobile/metadata";

import { maskPhoneNumber } from "@/lib/services/phone-mandate-service";

/** How many leading digits of the national number stay visible. */
const VISIBLE_PREFIX_DIGITS = 4;
/** How many trailing digits stay visible — the half people recognise. */
const VISIBLE_SUFFIX_DIGITS = 4;
const BULLET = "•";

/**
 * Mask the national number, keeping the head and the tail.
 *
 * A number short enough that a head plus a tail would leave nothing hidden
 * drops the head: showing `9682` and `9352` of an eight-digit number reveals
 * the whole thing while looking like it hides something.
 */
function maskNationalNumber(nationalNumber: string): string {
  if (nationalNumber.length <= VISIBLE_SUFFIX_DIGITS) return nationalNumber;

  const suffix = nationalNumber.slice(-VISIBLE_SUFFIX_DIGITS);
  const hiddenWithPrefix =
    nationalNumber.length - VISIBLE_PREFIX_DIGITS - VISIBLE_SUFFIX_DIGITS;

  if (hiddenWithPrefix <= 0) {
    return `${BULLET.repeat(
      nationalNumber.length - VISIBLE_SUFFIX_DIGITS,
    )}${suffix}`;
  }

  return `${nationalNumber.slice(0, VISIBLE_PREFIX_DIGITS)}${BULLET.repeat(
    hiddenWithPrefix,
  )}${suffix}`;
}

/**
 * `+91 9682••9352` — the Account screen's read-back of a verified number.
 *
 * Falls back to the digits-only mask when the value will not parse, because a
 * number we cannot split is still a number the owner should recognise, and
 * inventing a calling code would be worse than showing none.
 */
export function formatMaskedPhoneNumber(phoneNumber?: string | null): string {
  const normalized = String(phoneNumber ?? "").trim();
  if (!normalized) return "";

  const parsed = parsePhoneNumberFromString(normalized, mobilePhoneMetadata);
  const callingCode = parsed?.countryCallingCode;
  const nationalNumber = parsed?.nationalNumber;
  if (!callingCode || !nationalNumber) return maskPhoneNumber(normalized);

  return `+${callingCode} ${maskNationalNumber(String(nationalNumber))}`;
}
