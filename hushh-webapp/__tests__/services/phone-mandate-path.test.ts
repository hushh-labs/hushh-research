import { describe, it, expect } from "vitest";
import { isPhoneMandatePath } from "@/lib/services/phone-mandate-service";

describe("isPhoneMandatePath — exact route match contract", () => {
  it("returns true for the exact phone mandate path", () => {
    expect(isPhoneMandatePath("/register-phone")).toBe(true);
  });

  it("returns false for a nested path under the phone mandate route", () => {
    expect(isPhoneMandatePath("/register-phone/step1")).toBe(false);
  });

  it("returns false for a path with a trailing slash", () => {
    expect(isPhoneMandatePath("/register-phone/")).toBe(false);
  });

  it("returns false for an unrelated path", () => {
    expect(isPhoneMandatePath("/login")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isPhoneMandatePath(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isPhoneMandatePath(undefined)).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isPhoneMandatePath("")).toBe(false);
  });

  it("trims whitespace before comparing", () => {
    expect(isPhoneMandatePath("  /register-phone  ")).toBe(true);
  });

  it("is case-sensitive", () => {
    expect(isPhoneMandatePath("/REGISTER-PHONE")).toBe(false);
  });
});