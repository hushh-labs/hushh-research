import { describe, expect, it } from "vitest";

import {
  detectBrand,
  luhnValid,
  validateCardForRegion,
} from "@/lib/wallet/card-validation";

// Standard public test numbers (Luhn-valid, non-chargeable).
const VISA = "4111111111111111";
const MASTERCARD = "5555555555554444";
const AMEX = "378282246310005";
const DISCOVER = "6011111111111117";
const RUPAY = "6521111111111114"; // 6521 prefix, checksum-corrected below if needed

function luhnFix(base: string): string {
  // Replace the last digit so the number passes Luhn - keeps BIN prefixes honest.
  for (let d = 0; d <= 9; d += 1) {
    const candidate = base.slice(0, -1) + String(d);
    if (luhnValid(candidate)) return candidate;
  }
  throw new Error("unreachable");
}

const NOW = new Date("2026-09-01T00:00:00Z");

describe("luhnValid", () => {
  it("accepts known-good vectors", () => {
    for (const pan of [VISA, MASTERCARD, AMEX, DISCOVER]) {
      expect(luhnValid(pan)).toBe(true);
    }
  });

  it("rejects a single-digit typo", () => {
    expect(luhnValid("4111111111111112")).toBe(false);
  });

  it("tolerates spaces and dashes", () => {
    expect(luhnValid("4111 1111 1111 1111")).toBe(true);
    expect(luhnValid("4111-1111-1111-1111")).toBe(true);
  });
});

describe("detectBrand", () => {
  it("detects the majors", () => {
    expect(detectBrand(VISA)).toBe("visa");
    expect(detectBrand(MASTERCARD)).toBe("mastercard");
    expect(detectBrand(AMEX)).toBe("amex");
    expect(detectBrand(DISCOVER)).toBe("discover");
  });

  it("ranks RuPay's 6521 window ahead of Discover's broad 65", () => {
    expect(detectBrand(luhnFix(RUPAY))).toBe("rupay");
    expect(detectBrand(luhnFix("6511111111111111"))).toBe("discover");
  });

  it("detects Mir ahead of Mastercard's 2-series", () => {
    expect(detectBrand(luhnFix("2200111111111111"))).toBe("mir");
    expect(detectBrand(luhnFix("2221111111111111"))).toBe("mastercard");
  });
});

describe("validateCardForRegion", () => {
  const base = {
    pan: VISA,
    cvv: "123",
    pin: "1234",
    expiryMonth: 4,
    expiryYear: 2030,
    issuingRegion: "US",
    now: NOW,
  };

  it("passes a valid card", () => {
    const result = validateCardForRegion(base);
    expect(result.valid).toBe(true);
    expect(result.brand).toBe("visa");
    expect(result.last4).toBe("1111");
  });

  it("rejects a region-locked brand outside its home market", () => {
    const result = validateCardForRegion({
      ...base,
      pan: luhnFix(RUPAY),
      issuingRegion: "US",
    });
    expect(result.errors).toContain("brand_region_mismatch");
  });

  it("allows a global brand in any region", () => {
    expect(validateCardForRegion({ ...base, issuingRegion: "IN" }).valid).toBe(true);
  });

  it("requires a 4-digit CVV for amex and 3 for others", () => {
    expect(
      validateCardForRegion({ ...base, pan: AMEX, cvv: "123" }).errors,
    ).toContain("cvv_invalid");
    expect(
      validateCardForRegion({ ...base, pan: AMEX, cvv: "1234" }).valid,
    ).toBe(true);
    expect(validateCardForRegion({ ...base, cvv: "1234" }).errors).toContain(
      "cvv_invalid",
    );
  });

  it("bounds the PIN at 4-6 digits and keeps it optional", () => {
    expect(validateCardForRegion({ ...base, pin: "12" }).errors).toContain("pin_invalid");
    expect(validateCardForRegion({ ...base, pin: undefined }).valid).toBe(true);
  });

  it("rejects an expired card and bad expiry shapes", () => {
    expect(
      validateCardForRegion({ ...base, expiryMonth: 8, expiryYear: 2026 }).errors,
    ).toContain("card_expired");
    expect(
      validateCardForRegion({ ...base, expiryMonth: 13 }).errors,
    ).toContain("expiry_month_invalid");
  });

  it("rejects checksum failures and unknown regions", () => {
    expect(
      validateCardForRegion({ ...base, pan: "4111111111111112" }).errors,
    ).toContain("pan_checksum_invalid");
    expect(
      validateCardForRegion({ ...base, issuingRegion: "USA1" }).errors,
    ).toContain("issuing_region_invalid");
  });
});
