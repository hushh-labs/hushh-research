import { describe, expect, it } from "vitest";

import {
  derivePhoneFields,
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
});
