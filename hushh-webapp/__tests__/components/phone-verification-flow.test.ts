import { describe, expect, it } from "vitest";
import {
  getCountryCallingCode,
  getExampleNumber,
  isSupportedCountry,
  type CountryCode,
} from "libphonenumber-js/core";
import mobileExamples from "libphonenumber-js/examples.mobile.json";
import mobilePhoneMetadata from "libphonenumber-js/mobile/metadata";

import {
  derivePhoneFields,
  getMobileNumberLengthRange,
  getPhoneNumberValidationError,
  maskPhoneNumberForOtp,
  resolvePhoneInputChange,
} from "@/components/auth/phone-verification-flow";
import { COUNTRY_PHONE_OPTIONS } from "@/lib/constants/country-phone-options";

describe("PhoneVerificationFlow phone input normalization", () => {
  it("preserves a pasted E.164 US test number by splitting country and local digits", () => {
    const nextInput = resolvePhoneInputChange("+16505554567");

    expect(nextInput).toEqual({
      countryValue: "US",
      localPhoneNumber: "6505554567",
    });
  });

  it("keeps national input as local digits for the selected country", () => {
    expect(resolvePhoneInputChange("(650) 555-4567")).toEqual({
      localPhoneNumber: "6505554567",
    });
  });

  it("derives display fields from an existing linked phone number", () => {
    expect(derivePhoneFields("+16505550101")).toEqual({
      countryValue: "US",
      localPhoneNumber: "6505550101",
    });
  });

  it("rejects an Indian trunk prefix before the provider request", () => {
    expect(getPhoneNumberValidationError("+9108004482372", "IN")).toBe(
      "Enter no more than 10 digits for India.",
    );
    expect(getPhoneNumberValidationError("+918004482372", "IN")).toBeNull();
  });

  it("uses country-specific mobile lengths", () => {
    expect(getMobileNumberLengthRange("IN")).toEqual({
      minimum: 10,
      maximum: 10,
    });
    expect(getMobileNumberLengthRange("GB")).toEqual({
      minimum: 10,
      maximum: 10,
    });
    expect(getMobileNumberLengthRange("DE")).toEqual({
      minimum: 10,
      maximum: 11,
    });
    expect(getMobileNumberLengthRange("BR")).toEqual({
      minimum: 10,
      maximum: 11,
    });
  });

  it("preserves alternate national area codes instead of rewriting recipients", () => {
    expect(derivePhoneFields("+16582101234")).toEqual({
      countryValue: "JM",
      localPhoneNumber: "6582101234",
    });
    expect(getPhoneNumberValidationError("+16582101234", "JM")).toBeNull();
  });

  it("accepts canonical mobile examples for every selectable country", () => {
    const selectableCountries = COUNTRY_PHONE_OPTIONS.filter((option) =>
      isSupportedCountry(option.value, mobilePhoneMetadata),
    );

    for (const option of selectableCountries) {
      const example = getExampleNumber(
        option.value as CountryCode,
        mobileExamples,
        mobilePhoneMetadata,
      );
      expect(example, `${option.label} has a mobile example`).toBeTruthy();
      if (!example) continue;

      expect(
        getPhoneNumberValidationError(example.number, option.value),
        `${option.label} ${example.number}`,
      ).toBeNull();
      const canonicalDialCode = `+${getCountryCallingCode(
        option.value as CountryCode,
        mobilePhoneMetadata,
      )}`;
      expect(
        example.number.slice(canonicalDialCode.length).length,
      ).toBeLessThanOrEqual(getMobileNumberLengthRange(option.value).maximum);
    }

    expect(selectableCountries).toHaveLength(243);
  });

  it("masks the OTP destination without exposing the country code", () => {
    expect(maskPhoneNumberForOtp("+918004482372")).toBe("•••••• 2372");
    expect(maskPhoneNumberForOtp("+16505550101")).toBe("•••••• 0101");
  });

  it("preserves empty phone input normalization stability", () => {
    expect(resolvePhoneInputChange("")).toEqual({
      localPhoneNumber: "",
    });

    expect(derivePhoneFields("")).toEqual({
      countryValue: "US",
      localPhoneNumber: "",
    });
  });
});
