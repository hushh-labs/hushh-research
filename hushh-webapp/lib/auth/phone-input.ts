import { getCountryCallingCode, isSupportedCountry, Metadata, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/core";
import mobilePhoneMetadata from "libphonenumber-js/mobile/metadata";
import { COUNTRY_PHONE_OPTIONS, type CountryPhoneOption } from "@/lib/constants/country-phone-options";

// Country metadata owns national-number length and validity.
export const E164_PHONE_PATTERN = /^\+[1-9]\d{1,14}$/;
export const E164_MAX_DIGITS = 15;
// SSR-safe fallback only. The real starting country is detected from the
// person's own locale in an effect below -- `navigator` does not exist on the
// server, so this is what the first paint renders before detection runs.
export const DEFAULT_COUNTRY_VALUE = "US";
// Offer metadata-backed plans and keep NANP area codes in the national number.
export const PHONE_COUNTRY_OPTIONS: readonly CountryPhoneOption[] =
  COUNTRY_PHONE_OPTIONS.filter((option) =>
    isSupportedCountry(option.value as CountryCode, mobilePhoneMetadata),
  ).map((option) => ({
    ...option,
    dialCode: `+${getCountryCallingCode(
      option.value as CountryCode,
      mobilePhoneMetadata,
    )}`,
  }));
export const DEFAULT_PHONE_COUNTRY_OPTION =
  PHONE_COUNTRY_OPTIONS.find(
    (option) => option.value === DEFAULT_COUNTRY_VALUE,
  ) ?? PHONE_COUNTRY_OPTIONS[0]!;

export function getCountryOptionLabel(option: {
  label: string;
  dialCode: string;
}): string {
  return `${option.label} (${option.dialCode})`;
}

export function getCountryOption(value: string): CountryPhoneOption {
  return (
    PHONE_COUNTRY_OPTIONS.find((option) => option.value === value) ??
    DEFAULT_PHONE_COUNTRY_OPTION
  );
}

export function getCountryOptionForPhoneNumber(
  phoneNumber: string,
): CountryPhoneOption | undefined {
  const matchingOptions = PHONE_COUNTRY_OPTIONS.filter((option) =>
    phoneNumber.startsWith(option.dialCode),
  ).sort((left, right) => right.dialCode.length - left.dialCode.length);
  const firstMatch = matchingOptions[0];
  if (!firstMatch) {
    return undefined;
  }

  const longestDialCodeLength = firstMatch.dialCode.length;
  const longestMatches = matchingOptions.filter(
    (option) => option.dialCode.length === longestDialCodeLength,
  );
  return (
    longestMatches.find((option) => option.value === DEFAULT_COUNTRY_VALUE) ??
    firstMatch
  );
}

export function sanitizeDialCode(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 4);
  return digits ? `+${digits}` : "";
}

export function sanitizeLocalPhoneNumber(value: string): string {
  return value.replace(/\D/g, "");
}

type MobileNumberTypeMetadata = {
  possibleLengths: () => number[];
};

type MobileAwareMetadata = Metadata & {
  type: (type: "MOBILE") => MobileNumberTypeMetadata | undefined;
};

export const mobileNumberLengthCache = new Map<
  string,
  { minimum: number; maximum: number }
>();

export function getMobileNumberLengthRange(countryValue: string): {
  minimum: number;
  maximum: number;
} {
  const dialCode = getCountryOption(countryValue).dialCode;
  const cacheKey = `${countryValue}:${dialCode}`;
  const cached = mobileNumberLengthCache.get(cacheKey);
  if (cached) return cached;

  const fallbackMaximum = Math.max(
    1,
    E164_MAX_DIGITS - dialCode.replace(/\D/g, "").length,
  );
  let range = { minimum: 1, maximum: fallbackMaximum };

  try {
    const metadata = new Metadata(mobilePhoneMetadata);
    metadata.selectNumberingPlan(countryValue as CountryCode);
    // The package exposes this metadata view at runtime but not in its TS API.
    const mobileType = (metadata as MobileAwareMetadata).type("MOBILE");
    const possibleLengths = (mobileType?.possibleLengths() ?? [])
      .filter(
        (length) =>
          Number.isInteger(length) && length > 0 && length <= fallbackMaximum,
      )
      .sort((left, right) => left - right);
    if (possibleLengths.length > 0) {
      range = {
        minimum: possibleLengths[0]!,
        maximum: possibleLengths[possibleLengths.length - 1]!,
      };
    }
  } catch {
    // Invalid programmatic values use the E.164 bound above.
  }

  mobileNumberLengthCache.set(cacheKey, range);
  return range;
}

export function composePhoneNumber(
  dialCode: string,
  localPhoneNumber: string,
): string {
  return `${sanitizeDialCode(dialCode)}${sanitizeLocalPhoneNumber(localPhoneNumber)}`;
}

export function derivePhoneFields(phoneNumber?: string | null): {
  countryValue: string;
  localPhoneNumber: string;
} {
  const normalizedPhone = String(phoneNumber ?? "").trim();
  if (!normalizedPhone) {
    return {
      countryValue: DEFAULT_COUNTRY_VALUE,
      localPhoneNumber: "",
    };
  }

  const parsedPhone = parsePhoneNumberFromString(
    normalizedPhone,
    mobilePhoneMetadata,
  );
  const parsedCountry = parsedPhone?.country;
  const matchingOption =
    (parsedCountry
      ? PHONE_COUNTRY_OPTIONS.find((option) => option.value === parsedCountry)
      : undefined) ?? getCountryOptionForPhoneNumber(normalizedPhone);

  if (matchingOption) {
    return {
      countryValue: matchingOption.value,
      localPhoneNumber: parsedPhone?.nationalNumber ?? sanitizeLocalPhoneNumber(
        normalizedPhone.slice(matchingOption.dialCode.length),
      ),
    };
  }

  return {
    countryValue: DEFAULT_COUNTRY_VALUE,
    localPhoneNumber: sanitizeLocalPhoneNumber(
      normalizedPhone.replace(/^\+\d{1,4}/, ""),
    ),
  };
}

export function getPhoneNumberValidationError(
  phoneNumber?: string | null,
  countryValue?: string,
): string | null {
  const normalizedPhone = String(phoneNumber ?? "").trim();
  if (!E164_PHONE_PATTERN.test(normalizedPhone)) {
    return "Enter a valid country code and phone number.";
  }

  const fields = derivePhoneFields(normalizedPhone);
  const resolvedCountry = countryValue ?? fields.countryValue;
  const countryOption = getCountryOption(resolvedCountry);
  const nationalNumber = normalizedPhone.startsWith(countryOption.dialCode)
    ? sanitizeLocalPhoneNumber(
        normalizedPhone.slice(countryOption.dialCode.length),
      )
    : fields.localPhoneNumber;
  const lengthRange = getMobileNumberLengthRange(resolvedCountry);

  if (nationalNumber.length < lengthRange.minimum) {
    return `Enter a complete mobile number for ${countryOption.label}.`;
  }
  if (nationalNumber.length > lengthRange.maximum) {
    return `Enter no more than ${lengthRange.maximum} digits for ${countryOption.label}.`;
  }

  const parsedPhone = parsePhoneNumberFromString(
    normalizedPhone,
    mobilePhoneMetadata,
  );
  if (parsedPhone?.number !== normalizedPhone) {
    return `Enter the mobile number without a local leading prefix after ${countryOption.dialCode}.`;
  }
  if (!parsedPhone?.isValid()) {
    return `Enter a valid mobile number for ${countryOption.label}.`;
  }

  return null;
}

export function getPhoneEntryError(localNumber: string, country: string): string | null {
  if (!localNumber) return "Enter your phone number.";
  return getPhoneNumberValidationError(
    composePhoneNumber(getCountryOption(country).dialCode, localNumber), country,
  ) ? "Enter a valid phone number." : null;
}

export function maskPhoneNumberForOtp(
  phoneNumber?: string | null,
): string {
  const localPhoneNumber = derivePhoneFields(phoneNumber).localPhoneNumber;
  if (!localPhoneNumber) return "";
  if (localPhoneNumber.length <= 4) return localPhoneNumber;

  return `${"•".repeat(localPhoneNumber.length - 4)}${localPhoneNumber.slice(-4)}`;
}

export function resolvePhoneInputChange(value: string): {
  countryValue?: string;
  localPhoneNumber: string;
} {
  const trimmedValue = value.trim();
  if (!trimmedValue.startsWith("+")) {
    return {
      localPhoneNumber: sanitizeLocalPhoneNumber(value),
    };
  }

  return derivePhoneFields(trimmedValue);
}

