import { describe, expect, it } from "vitest";

import {
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

describe("validateCardForRegion", () => {
  const base = {
    pan: VISA,
    brand: "visa" as const,
    cardholderName: "Test Owner",
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

  it("validates optional manual codes without accepting legacy or malformed input", () => {
    for (const securityCode of [undefined, "", "007", "0123"]) {
      expect(validateCardForRegion({ ...base, securityCode }).valid).toBe(true);
    }
    for (const securityCode of ["12", "12345", "1a3", " 123", 123, null]) {
      expect(validateCardForRegion({ ...base, securityCode } as never).errors).toContain("security_code_invalid");
    }
  });

  it("requires the name without collecting security codes", () => {
    const minimal = { ...base, issuingRegion: undefined, pin: undefined };
    expect(validateCardForRegion(minimal).valid).toBe(true);
    expect(validateCardForRegion({ ...minimal, cardholderName: "  ", cvv: undefined }).errors)
      .toEqual(expect.arrayContaining(["cardholder_name_required"]));
    expect(validateCardForRegion({ ...minimal, issuingRegion: "", pin: "" }).valid).toBe(true);
  });

  it("accepts new BIN ranges with a chosen network or Other fallback", () => {
    const pan = luhnFix("9111111111111111");
    expect(validateCardForRegion({ ...base, pan, brand: undefined }).brand).toBe("other");
    expect(validateCardForRegion({ ...base, pan, brand: undefined, cvv: "1234" }).valid).toBe(true);
    expect(validateCardForRegion({ ...base, pan, brand: "mastercard" }).brand).toBe("mastercard");
    expect(validateCardForRegion({ ...base, pan, brand: "mastercard", cvv: "1234" }).valid).toBe(true);
    expect(validateCardForRegion({ ...base, pan: "0000000000000000" }).valid).toBe(false);
  });

  it("rejects malformed names and network identifiers", () => {
    expect(validateCardForRegion({ ...base, cardholderName: "Test\u0000Owner" }).errors).toContain("cardholder_name_invalid");
    expect(validateCardForRegion({ ...base, cardholderName: "A".repeat(81) }).errors).toContain("cardholder_name_invalid");
    expect(validateCardForRegion({ ...base, brand: "invalid/network" }).errors).toContain("brand_invalid");
  });

  it("retains new backend network IDs without guessing from the PAN and keeps generic credential checks", () => {
    expect(validateCardForRegion({ ...base, brand: "future_network", cvv: "1234" })).toMatchObject({ valid: true, brand: "future_network" });
    expect(validateCardForRegion({ ...base, brand: "future_network", pan: "4111111111111112" }).errors).toContain("pan_checksum_invalid");
    expect(validateCardForRegion({ ...base, brand: "future_network", cvv: "12" }).valid).toBe(true);
    expect(validateCardForRegion({ ...base, brand: undefined }).brand).toBe("other");
  });

  it("rejects a region-locked brand outside its home market", () => {
    const result = validateCardForRegion({
      ...base,
      pan: luhnFix(RUPAY),
      brand: "rupay",
      issuingRegion: "US",
    });
    expect(result.errors).toContain("brand_region_mismatch");
  });

  it("allows a global brand in any region", () => {
    expect(validateCardForRegion({ ...base, issuingRegion: "IN" }).valid).toBe(true);
  });

  it("does not require or validate legacy security-code input", () => {
    expect(validateCardForRegion({ ...base, cvv: undefined, pin: undefined }).valid).toBe(true);
    expect(validateCardForRegion({ ...base, pan: AMEX, brand: "amex", cvv: "invalid", pin: "invalid" }).valid).toBe(true);
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

it("never classifies a number without a backend-provided brand", () => {
 for (const pan of [VISA, MASTERCARD, AMEX, DISCOVER, luhnFix(RUPAY)]) {
  expect(validateCardForRegion({ pan, cardholderName: "Test", cvv: "123", expiryMonth: 12, expiryYear: 2099 }).brand).toBe("other");
 }
});

describe("backend-supplied networks", () => {
 const base = { cardholderName: "Test", cvv: "123", expiryMonth: 12, expiryYear: 2099 };
 it("validates the common backend-supplied global brands", () => {
  for (const [pan, brand] of [[VISA,"visa"],[MASTERCARD,"mastercard"],[AMEX,"amex"],[DISCOVER,"discover"]] as const) {
   expect(validateCardForRegion({ ...base, pan, brand, cvv: brand === "amex" ? "1234" : "123" }).brand).toBe(brand);
  }
 });
 it("preserves distinct backend-supplied RuPay and Discover networks", () => {
  expect(validateCardForRegion({ ...base, pan: luhnFix(RUPAY), brand: "rupay" }).brand).toBe("rupay");
  expect(validateCardForRegion({ ...base, pan: luhnFix("6511111111111111"), brand: "discover" }).brand).toBe("discover");
 });
 it("preserves distinct backend-supplied Mir and Mastercard networks", () => {
  expect(validateCardForRegion({ ...base, pan: luhnFix("2200111111111111"), brand: "mir" }).brand).toBe("mir");
  expect(validateCardForRegion({ ...base, pan: luhnFix("2221111111111111"), brand: "mastercard" }).brand).toBe("mastercard");
 });
});


it("accepts checksum-valid generic 12-digit cards without broadening known network lengths", () => {
  const input = { pan: "911111111116", cardholderName: "Synthetic Owner", expiryMonth: 12, expiryYear: 2030, now: NOW };
  expect(validateCardForRegion({ ...input, brand: "other" }).valid).toBe(true);
  expect(validateCardForRegion({ ...input, pan: "911111111117", brand: "other" }).valid).toBe(false);
  for (const brand of ["visa", "mastercard", "amex", "rupay"]) {
    expect(validateCardForRegion({ ...input, brand }).errors).toContain("pan_length_invalid_for_brand");
  }
});
