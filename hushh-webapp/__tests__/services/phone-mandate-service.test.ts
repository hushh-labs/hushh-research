import { describe, expect, it } from "vitest";

import { hasVerifiedPhoneNumber } from "@/lib/services/phone-mandate-service";

describe("hasVerifiedPhoneNumber", () => {
  it("accepts populated phone numbers", () => {
    expect(hasVerifiedPhoneNumber("+16505550101")).toBe(true);
    expect(hasVerifiedPhoneNumber(" 123 ")).toBe(true);
  });

  it("rejects empty values", () => {
    expect(hasVerifiedPhoneNumber("")).toBe(false);
    expect(hasVerifiedPhoneNumber(null)).toBe(false);
    expect(hasVerifiedPhoneNumber(undefined)).toBe(false);
  });
});
