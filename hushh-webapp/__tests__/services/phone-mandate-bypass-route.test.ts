import { describe, it, expect } from "vitest";
import { shouldBypassPhoneMandateForRoute } from "@/lib/services/phone-mandate-service";
import { ROUTES } from "@/lib/navigation/routes";

describe("shouldBypassPhoneMandateForRoute — exact allowlist match contract", () => {
  it("returns true for the exact ria onboarding path", () => {
    expect(shouldBypassPhoneMandateForRoute(ROUTES.RIA_ONBOARDING)).toBe(true);
  });

  it("returns false for a nested path under ria onboarding (exact match only, no startsWith)", () => {
    expect(shouldBypassPhoneMandateForRoute("/ria/onboarding/step1")).toBe(false);
  });

  it("returns false for an unrelated path", () => {
    expect(shouldBypassPhoneMandateForRoute("/ria/clients")).toBe(false);
  });

  it("returns false for null", () => {
    expect(shouldBypassPhoneMandateForRoute(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(shouldBypassPhoneMandateForRoute(undefined)).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(shouldBypassPhoneMandateForRoute("")).toBe(false);
  });

  it("trims whitespace before comparing", () => {
    expect(shouldBypassPhoneMandateForRoute("  /ria/onboarding  ")).toBe(true);
  });
});