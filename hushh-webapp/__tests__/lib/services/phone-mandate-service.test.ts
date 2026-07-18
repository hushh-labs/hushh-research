import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveAppEnvironment } = vi.hoisted(() => ({
  mockResolveAppEnvironment: vi.fn(),
}));

vi.mock("@/lib/app-env", () => ({
  resolveAppEnvironment: mockResolveAppEnvironment,
}));

import { ROUTES } from "@/lib/navigation/routes";
import {
  hasVerifiedPhoneNumber,
  isPhoneMandatePath,
  maskPhoneNumber,
  shouldBypassPhoneMandateForLocalhost,
  shouldBypassPhoneMandateForRoute,
  shouldRequirePhoneMandate,
} from "@/lib/services/phone-mandate-service";

describe("hasVerifiedPhoneNumber", () => {
  it("returns false for empty values", () => {
    expect(hasVerifiedPhoneNumber(null)).toBe(false);
    expect(hasVerifiedPhoneNumber(undefined)).toBe(false);
    expect(hasVerifiedPhoneNumber("")).toBe(false);
  });

  it("returns true for populated values", () => {
    expect(hasVerifiedPhoneNumber("+16505550101")).toBe(true);
  });
});

describe("shouldBypassPhoneMandateForLocalhost", () => {
  beforeEach(() => {
    mockResolveAppEnvironment.mockReset();
  });

  it("allows localhost in development", () => {
    mockResolveAppEnvironment.mockReturnValue("development");
    expect(shouldBypassPhoneMandateForLocalhost("localhost")).toBe(true);
  });

  it("does not allow localhost outside development", () => {
    mockResolveAppEnvironment.mockReturnValue("production");
    expect(shouldBypassPhoneMandateForLocalhost("localhost")).toBe(false);
  });
});

describe("shouldBypassPhoneMandateForRoute", () => {
  it("bypasses RIA onboarding", () => {
    expect(
      shouldBypassPhoneMandateForRoute(ROUTES.RIA_ONBOARDING),
    ).toBe(true);
  });

  it("does not bypass unrelated routes", () => {
    expect(
      shouldBypassPhoneMandateForRoute("/dashboard"),
    ).toBe(false);
  });
});

describe("isPhoneMandatePath", () => {
  it("identifies the mandate route", () => {
    expect(isPhoneMandatePath(ROUTES.PHONE_MANDATE)).toBe(true);
  });

  it("rejects unrelated routes", () => {
    expect(isPhoneMandatePath("/settings")).toBe(false);
  });
});

describe("maskPhoneNumber", () => {
  it("returns empty string for empty values", () => {
    expect(maskPhoneNumber(null)).toBe("");
    expect(maskPhoneNumber(undefined)).toBe("");
  });

  it("masks populated phone numbers", () => {
    expect(maskPhoneNumber("6505550101")).not.toBe("6505550101");
  });
});

describe("shouldRequirePhoneMandate", () => {
  beforeEach(() => {
    mockResolveAppEnvironment.mockReturnValue("production");
  });

  it("does not require mandate when verified", () => {
    expect(
      shouldRequirePhoneMandate({
        phoneVerified: true,
        hasVault: false,
      }),
    ).toBe(false);
  });

  it("requires mandate when unverified", () => {
    expect(
      shouldRequirePhoneMandate({
        phoneVerified: false,
        hasVault: false,
      }),
    ).toBe(true);
  });

  it("bypasses RIA onboarding", () => {
    expect(
      shouldRequirePhoneMandate({
        phoneVerified: false,
        hasVault: false,
        pathname: ROUTES.RIA_ONBOARDING,
      }),
    ).toBe(false);
  });
});