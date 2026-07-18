import { describe, expect, it } from "vitest";

import { maskPhoneNumber } from "@/lib/services/phone-mandate-service";

describe("maskPhoneNumber", () => {
  it("preserves the last four digits", () => {
    const masked = maskPhoneNumber("+1 (650) 555-0101");

    expect(masked).toContain("0101");
    expect(masked).not.toContain("6505550101");
  });

  it("returns short values unchanged", () => {
    expect(maskPhoneNumber("1234")).toBe("1234");
  });

  it("returns empty string for empty values", () => {
    expect(maskPhoneNumber("")).toBe("");
    expect(maskPhoneNumber(null)).toBe("");
    expect(maskPhoneNumber(undefined)).toBe("");
  });
});
