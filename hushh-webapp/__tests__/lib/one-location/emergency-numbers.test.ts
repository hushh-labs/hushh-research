import { describe, expect, it } from "vitest";

import { emergencyInfoForCountryCode } from "@/lib/one-location/emergency-numbers";

describe("emergencyInfoForCountryCode", () => {
  it.each([
    ["in", "India", "112"],
    ["US", "United States", "911"],
    ["GB", "United Kingdom", "999"],
    ["AU", "Australia", "000"],
  ])("looks up %s only after an ISO country is known", (code, name, number) => {
    expect(emergencyInfoForCountryCode(code)).toEqual({
      countryCode: code.toUpperCase(),
      countryName: name,
      number,
    });
  });

  it("fails closed for missing or unsupported country codes", () => {
    expect(emergencyInfoForCountryCode(null)).toBeNull();
    expect(emergencyInfoForCountryCode("ZZ")).toBeNull();
    expect(emergencyInfoForCountryCode("KH")).toBeNull();
    expect(emergencyInfoForCountryCode("")).toBeNull();
  });
});
