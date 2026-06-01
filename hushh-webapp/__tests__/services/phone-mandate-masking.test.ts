/**
 * Focused tests for the masking utilities in
 * hushh-webapp/lib/services/phone-mandate-service.ts
 *
 * Covers both the existing maskPhoneNumber (already called from
 * app/profile/page.tsx) and the new maskEmailAddress, which applies the
 * same consent-minimisation pattern to email identifiers in the profile
 * and consent-center UI.
 */

import { describe, expect, it } from "vitest";
import {
  maskEmailAddress,
  maskPhoneNumber,
} from "@/lib/services/phone-mandate-service";

// ── maskPhoneNumber ───────────────────────────────────────────────────────────

describe("maskPhoneNumber", () => {
  it("masks a 10-digit national number, showing last 4 digits", () => {
    const result = maskPhoneNumber("5551234567");
    expect(result).toContain("4567");
    expect(result).toContain("••");
  });

  it("masks an E.164 number, preserving last 4 digits", () => {
    const result = maskPhoneNumber("+15551234567");
    expect(result).toContain("4567");
    expect(result).toContain("••");
  });

  it("returns the original value for a very short number (≤ 4 digits)", () => {
    expect(maskPhoneNumber("1234")).toBe("1234");
  });

  it("returns empty string for null input", () => {
    expect(maskPhoneNumber(null)).toBe("");
  });

  it("returns empty string for undefined input", () => {
    expect(maskPhoneNumber(undefined)).toBe("");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(maskPhoneNumber("   ")).toBe("");
  });
});

// ── maskEmailAddress ──────────────────────────────────────────────────────────

describe("maskEmailAddress", () => {
  it("masks a standard email — preserves first and last chars of local part", () => {
    expect(maskEmailAddress("abdulgaffar@hushh.ai")).toBe("a***r@hushh.ai");
  });

  it("preserves the full domain verbatim after masking", () => {
    const result = maskEmailAddress("user@sub.domain.org");
    expect(result.endsWith("@sub.domain.org")).toBe(true);
  });

  it("two-char local part — first char + *** before @", () => {
    expect(maskEmailAddress("ab@hushh.ai")).toBe("a***@hushh.ai");
  });

  it("single-char local part — single char + *** before @", () => {
    expect(maskEmailAddress("a@hushh.ai")).toBe("a***@hushh.ai");
  });

  it("three-char local part — both boundary chars preserved", () => {
    expect(maskEmailAddress("abc@hushh.ai")).toBe("a***c@hushh.ai");
  });

  it("trims leading and trailing whitespace before masking", () => {
    expect(maskEmailAddress("  jane.doe@hushh.ai  ")).toBe("j***e@hushh.ai");
  });

  it("returns empty string for null input", () => {
    expect(maskEmailAddress(null)).toBe("");
  });

  it("returns empty string for undefined input", () => {
    expect(maskEmailAddress(undefined)).toBe("");
  });

  it("returns empty string for empty string input", () => {
    expect(maskEmailAddress("")).toBe("");
  });

  it("returns the value unchanged when no @ is present (not a maskable address)", () => {
    expect(maskEmailAddress("notanemail")).toBe("notanemail");
  });
});
