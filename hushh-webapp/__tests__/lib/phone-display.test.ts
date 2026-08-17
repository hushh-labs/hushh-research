import { describe, expect, it } from "vitest";

import { formatMaskedPhoneNumber } from "@/lib/services/phone-display";

/**
 * The Account screen printed `919682 •• •• 9352` for `+919682889352`: the
 * country code fused onto the number with no `+`, and two hidden digits drawn
 * as four bullets in two groups. These hold the shape the founder asked for.
 */
describe("formatMaskedPhoneNumber", () => {
  it("keeps the plus and separates the calling code", () => {
    expect(formatMaskedPhoneNumber("+919682889352")).toBe("+91 9682••9352");
  });

  it("reads the calling code from the number, not from a default", () => {
    // A one-digit calling code and a ten-digit national number.
    expect(formatMaskedPhoneNumber("+14155552671")).toBe("+1 4155••2671");
    // A three-digit calling code (UK mobile, +44).
    expect(formatMaskedPhoneNumber("+447911123456")).toBe("+44 7911••3456");
  });

  it("draws one bullet per hidden digit", () => {
    const formatted = formatMaskedPhoneNumber("+919682889352");
    const hidden = (formatted.match(/•/g) ?? []).length;
    const shown = formatted.replace(/\D/g, "").length;
    // 91 + 9682 + 9352 = 10 digits shown, 2 hidden, 12 in the number.
    expect(hidden).toBe(2);
    expect(shown + hidden).toBe(12);
  });

  it("never reveals the whole number on a short national number", () => {
    // Eight digits: a 4-and-4 split would hide nothing while looking masked.
    const formatted = formatMaskedPhoneNumber("+61812345678");
    expect(formatted.startsWith("+61 ")).toBe(true);
    expect(formatted).toContain("•");
    expect(formatted).not.toContain("81234567");
  });

  it("still shows something for a value it cannot parse", () => {
    // Falls back to the digits-only mask rather than rendering nothing.
    expect(formatMaskedPhoneNumber("9682889352")).not.toBe("");
    expect(formatMaskedPhoneNumber("9682889352")).toContain("9352");
  });

  it("is empty for an empty value", () => {
    expect(formatMaskedPhoneNumber("")).toBe("");
    expect(formatMaskedPhoneNumber(null)).toBe("");
    expect(formatMaskedPhoneNumber(undefined)).toBe("");
  });
});
