import { describe, expect, it } from "vitest";

import { detectLikelyPan, redactLikelyPans } from "@/lib/wallet/pan-paste-guard";

describe("detectLikelyPan", () => {
  it("detects a bare Luhn-valid 16-digit number", () => {
    expect(detectLikelyPan("my card is 4111111111111111 ok?")).toBe(true);
  });

  it("detects spaced and dashed groupings", () => {
    expect(detectLikelyPan("4111 1111 1111 1111")).toBe(true);
    expect(detectLikelyPan("4111-1111-1111-1111")).toBe(true);
  });

  it("detects a 15-digit amex", () => {
    expect(detectLikelyPan("378282246310005")).toBe(true);
  });

  it("ignores phone numbers (too short)", () => {
    expect(detectLikelyPan("call me at +1 415 555 0000")).toBe(false);
    expect(detectLikelyPan("9876543210")).toBe(false);
  });

  it("ignores long non-Luhn digit runs like order ids", () => {
    expect(detectLikelyPan("order 1234567890123456 shipped")).toBe(false);
  });

  it("ignores ordinary text and empty input", () => {
    expect(detectLikelyPan("")).toBe(false);
    expect(detectLikelyPan("what cards do I have?")).toBe(false);
  });
});

describe("redactLikelyPans", () => {
  it("redacts the PAN but keeps last four", () => {
    const redacted = redactLikelyPans("use 4111 1111 1111 1111 please");
    expect(redacted).not.toContain("4111 1111 1111 1111");
    expect(redacted).toContain("•••• 1111");
  });

  it("leaves non-PAN digit runs alone", () => {
    const text = "order 1234567890123456 shipped";
    expect(redactLikelyPans(text)).toBe(text);
  });
});
