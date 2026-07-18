/**
 * Characterization tests — maskPhoneNumber formatting behavior
 *
 * Implementation boundary:
 *   lib/services/phone-mandate-service.ts — maskPhoneNumber
 *
 * Exact transform pipeline:
 *   1. normalized = String(phoneNumber ?? "").trim()
 *      Empty result → return ""
 *
 *   2. digits = normalized.replace(/\D/g, "")
 *      (strips every non-digit character)
 *
 *   3. digits.length <= 4 → return normalized
 *      (original trimmed string, NOT the extracted digits)
 *
 *   4. suffix      = digits.slice(-4)
 *      prefixLength = Math.max(0, digits.length - 6)
 *      prefix       = prefixLength > 0 ? `${digits.slice(0, prefixLength)} ` : ""
 *      return `${prefix}•• •• ${suffix}`.trim()
 *
 * Key behaviors guaranteed by the arithmetic:
 *   • 5–6 digits: prefixLength = 0 → no prefix segment → "•• •• {last4}"
 *   • 7 digits:   prefixLength = 1 → prefix = first 1 digit + space
 *   • 10 digits:  prefixLength = 4 → prefix = first 4 digits + space
 *   • 11 digits:  prefixLength = 5 → prefix = first 5 digits + space
 *   Non-digit characters are consumed before the slice arithmetic;
 *   the formatted output is always digit-only (plus •• and spaces).
 *
 * Pure string→string; no IO, no state.
 */

import { describe, it, expect } from "vitest";
import { maskPhoneNumber } from "@/lib/services/phone-mandate-service";

// ---------------------------------------------------------------------------
// Empty and nullish inputs
// ---------------------------------------------------------------------------

describe("maskPhoneNumber — empty and nullish inputs", () => {
  it("returns an empty string for null", () => {
    expect(maskPhoneNumber(null)).toBe("");
  });

  it("returns an empty string for undefined", () => {
    expect(maskPhoneNumber(undefined)).toBe("");
  });

  it("returns an empty string for an empty string", () => {
    expect(maskPhoneNumber("")).toBe("");
  });

  it("returns an empty string for a whitespace-only string (trimmed to empty)", () => {
    expect(maskPhoneNumber("   ")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Short numbers — digit count ≤ 4: return normalized (trimmed original)
// Note: returns the NORMALIZED STRING, not the extracted digits.
// ---------------------------------------------------------------------------

describe("maskPhoneNumber — short inputs (digit count ≤ 4)", () => {
  it("returns the trimmed original string for exactly 4 digits", () => {
    expect(maskPhoneNumber("1234")).toBe("1234");
  });

  it("returns the trimmed original string for 3 digits", () => {
    expect(maskPhoneNumber("123")).toBe("123");
  });

  it("returns the trimmed original string including non-digit chars when digit count is ≤ 4", () => {
    // "+1" has 1 digit → normalized = "+1" is returned, not just "1"
    expect(maskPhoneNumber("+1")).toBe("+1");
  });
});

// ---------------------------------------------------------------------------
// 5–6 digits — prefixLength = 0, no prefix segment
// Output pattern: "•• •• {last4}"
// ---------------------------------------------------------------------------

describe("maskPhoneNumber — 5 and 6 digits (no prefix segment)", () => {
  it("masks a 5-digit number as '•• •• {last4}' with no prefix", () => {
    // digits = "12345", suffix = "2345", prefixLength = max(0, 5-6) = 0
    expect(maskPhoneNumber("12345")).toBe("•• •• 2345");
  });

  it("masks a 6-digit number as '•• •• {last4}' with no prefix", () => {
    // digits = "123456", suffix = "3456", prefixLength = max(0, 6-6) = 0
    expect(maskPhoneNumber("123456")).toBe("•• •• 3456");
  });
});

// ---------------------------------------------------------------------------
// 7+ digits — prefixLength > 0, prefix = first N digits + space
// Output pattern: "{prefix} •• •• {last4}"
// ---------------------------------------------------------------------------

describe("maskPhoneNumber — 7+ digit numbers (prefix segment present)", () => {
  it("masks a 7-digit number: first 1 digit + '•• •• ' + last 4", () => {
    // prefixLength = max(0, 7-6) = 1 → prefix = "1 "
    expect(maskPhoneNumber("1234567")).toBe("1 •• •• 4567");
  });

  it("masks a 10-digit number: first 4 digits + '•• •• ' + last 4", () => {
    // prefixLength = max(0, 10-6) = 4 → prefix = "9876 "
    expect(maskPhoneNumber("9876543210")).toBe("9876 •• •• 3210");
  });

  it("masks an 11-digit number: first 5 digits + '•• •• ' + last 4", () => {
    // prefixLength = max(0, 11-6) = 5 → prefix = "19876 "
    expect(maskPhoneNumber("19876543210")).toBe("19876 •• •• 3210");
  });
});

// ---------------------------------------------------------------------------
// Formatted input strings — non-digit characters are stripped before masking
// ---------------------------------------------------------------------------

describe("maskPhoneNumber — formatted strings (non-digits stripped)", () => {
  it("strips parentheses, spaces, and dashes from a formatted US number", () => {
    // "+1 (987) 654-3210" → digits = "19876543210" (11 digits) → "19876 •• •• 3210"
    expect(maskPhoneNumber("+1 (987) 654-3210")).toBe("19876 •• •• 3210");
  });

  it("strips dashes from a dash-separated number", () => {
    // "987-654-3210" → digits = "9876543210" (10 digits) → "9876 •• •• 3210"
    expect(maskPhoneNumber("987-654-3210")).toBe("9876 •• •• 3210");
  });

  it("trims leading and trailing whitespace before processing", () => {
    // "  9876543210  " → normalized = "9876543210" → same as plain 10 digits
    expect(maskPhoneNumber("  9876543210  ")).toBe("9876 •• •• 3210");
  });
});