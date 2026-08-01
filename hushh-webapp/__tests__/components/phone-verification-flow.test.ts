import { describe, expect, it } from "vitest";

import {
  derivePhoneFields,
  getPhoneNumberValidationError,
  maskPhoneNumberForOtp,
  resolvePhoneInputChange,
} from "@/components/auth/phone-verification-flow";

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
    expect(getPhoneNumberValidationError("+9108004482372")).toBe(
      "Enter a valid 10-digit Indian mobile number without the leading 0.",
    );
    expect(getPhoneNumberValidationError("+918004482372")).toBeNull();
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
