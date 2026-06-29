import { describe, expect, it } from "vitest";

import { COUNTRY_PHONE_OPTIONS } from "@/lib/constants/country-phone-options";

describe("country phone options", () => {
  it("contains a non-trivial set of entries", () => {
    expect(COUNTRY_PHONE_OPTIONS.length).toBeGreaterThanOrEqual(250);
  });

  it("has a unique ISO value for every entry", () => {
    const values = COUNTRY_PHONE_OPTIONS.map((option) => option.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it("uses a two-letter uppercase code for every value", () => {
    for (const option of COUNTRY_PHONE_OPTIONS) {
      expect(option.value).toMatch(/^[A-Z]{2}$/);
    }
  });

  it("has a non-empty trimmed label for every entry", () => {
    for (const option of COUNTRY_PHONE_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.label).toBe(option.label.trim());
    }
  });

  it("uses a plus-prefixed numeric dial code for every entry", () => {
    for (const option of COUNTRY_PHONE_OPTIONS) {
      expect(option.dialCode).toMatch(/^\+\d+$/);
    }
  });
});