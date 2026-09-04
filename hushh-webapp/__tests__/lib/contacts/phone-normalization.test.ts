import { describe, expect, it } from "vitest";

import {
  normalizeContactPhone,
  resolveContactPhoneRegion,
} from "@/lib/contacts/phone-normalization";

describe("contact phone normalization", () => {
  describe("normalizeContactPhone", () => {
    it("normalizes every way an Indian mobile is stored in a contact book", () => {
      // The regression this guards: a bare 10-digit number used to be assumed
      // North American and hashed as +19876543210, so it could never match the
      // +919876543210 the account was verified with.
      for (const raw of [
        "9876543210",
        "09876543210",
        "098765 43210",
        "+91 98765 43210",
        "+919876543210",
        "0091 9876543210",
        "91 98765 43210",
        "919876543210",
      ]) {
        expect(normalizeContactPhone(raw, "IN")).toMatchObject({
          e164: "+919876543210",
          last4: "3210",
          isMobile: true,
        });
      }
    });

    it("normalizes national numbers against the resolved region, not a fixed +1", () => {
      expect(normalizeContactPhone("4155550101", "US")?.e164).toBe(
        "+14155550101",
      );
      expect(normalizeContactPhone("07911 123456", "GB")?.e164).toBe(
        "+447911123456",
      );
      // Same digits, different region, different account.
      expect(normalizeContactPhone("9876543210", "IN")?.e164).toBe(
        "+919876543210",
      );
      expect(normalizeContactPhone("9876543210", "US")?.e164).toBe(
        "+19876543210",
      );
    });

    it("honours an explicit country code over the default region", () => {
      expect(normalizeContactPhone("+1 415 555 0101", "IN")?.e164).toBe(
        "+14155550101",
      );
      expect(normalizeContactPhone("+44 7911 123456", undefined)?.e164).toBe(
        "+447911123456",
      );
    });

    it("recovers international country codes stored without a plus", () => {
      expect(normalizeContactPhone("14155550101", "IN")?.e164).toBe(
        "+14155550101",
      );
      expect(normalizeContactPhone("919876543210", "US")?.e164).toBe(
        "+919876543210",
      );
      expect(normalizeContactPhone("44 7911 123456", "US")?.e164).toBe(
        "+447911123456",
      );
      expect(normalizeContactPhone("61 412 345 678", "IN")?.e164).toBe(
        "+61412345678",
      );
      expect(normalizeContactPhone("919876543210", undefined)?.e164).toBe(
        "+919876543210",
      );
    });

    it.each([
      ["IN", "4564611442", "+914564611442"],
      ["US", "6589095926", "+16589095926"],
      ["GB", "2316833741", "+442316833741"],
      ["AU", "376568003", "+61376568003"],
    ] as const)(
      "does not reinterpret a valid %s fixed line as a foreign mobile",
      (region, raw, expected) => {
        expect(normalizeContactPhone(raw, region)).toMatchObject({
          e164: expected,
          isMobile: false,
        });
      },
    );

    it.each([
      {
        label: "US national",
        raw: "(415) 555-0101",
        region: "US" as const,
        expected: "+14155550101",
      },
      {
        label: "US country-coded",
        raw: "+1 415 555 0101",
        region: "IN" as const,
        expected: "+14155550101",
      },
      {
        label: "India national",
        raw: "098765 43210",
        region: "IN" as const,
        expected: "+919876543210",
      },
      {
        label: "India country-coded",
        raw: "+91 98765 43210",
        region: "US" as const,
        expected: "+919876543210",
      },
      {
        label: "UK national",
        raw: "07911 123456",
        region: "GB" as const,
        expected: "+447911123456",
      },
      {
        label: "UK country-coded",
        raw: "+44 7911 123456",
        region: "US" as const,
        expected: "+447911123456",
      },
      {
        label: "Australia national",
        raw: "0412 345 678",
        region: "AU" as const,
        expected: "+61412345678",
      },
      {
        label: "Australia country-coded",
        raw: "+61 412 345 678",
        region: "IN" as const,
        expected: "+61412345678",
      },
    ])("normalizes $label format country-wise", ({ raw, region, expected }) => {
      expect(normalizeContactPhone(raw, region)?.e164).toBe(expected);
    });

    it("keeps non-mobile lines but flags them as non-mobile", () => {
      // Landlines cannot match an SMS-verified account, but they are kept so
      // truncation can drop them first rather than dropping real mobiles.
      const landline = normalizeContactPhone("020 7946 0018", "GB");
      expect(landline?.e164).toBe("+442079460018");
      expect(landline?.isMobile).toBe(false);
    });

    it("drops entries that cannot be trusted as a phone number", () => {
      expect(normalizeContactPhone("11", "IN")).toBeNull();
      expect(normalizeContactPhone("", "IN")).toBeNull();
      expect(normalizeContactPhone("   ", "IN")).toBeNull();
      expect(normalizeContactPhone("not a phone", "IN")).toBeNull();
      // No region and no country code means the number is ambiguous; guessing
      // would only produce a hash that cannot match anything.
      expect(normalizeContactPhone("9876543210", undefined)).toBeNull();
    });
  });

  describe("resolveContactPhoneRegion", () => {
    it("prefers the device region reported by the native plugin", () => {
      expect(
        resolveContactPhoneRegion({
          deviceRegion: "in",
          deviceRegionFromNumberPlan: true,
          accountPhoneNumber: "+14155550101",
          localeTag: "en-GB",
        }),
      ).toBe("IN");
    });

    it("falls back to the country of the user's own verified number", () => {
      expect(
        resolveContactPhoneRegion({
          deviceRegion: null,
          accountPhoneNumber: "+919876543210",
          localeTag: "en-US",
        }),
      ).toBe("IN");
    });

    it("falls back to the locale when no stronger signal exists", () => {
      expect(resolveContactPhoneRegion({ localeTag: "en-IN" })).toBe("IN");
      expect(resolveContactPhoneRegion({ localeTag: "en-GB" })).toBe("GB");
    });

    it("ignores unusable signals instead of failing the sync", () => {
      expect(
        resolveContactPhoneRegion({
          deviceRegion: "ZZZ",
          accountPhoneNumber: "not-a-number",
          localeTag: "!!!not-a-locale!!!",
        }),
      ).toBeUndefined();
    });
  });
});
