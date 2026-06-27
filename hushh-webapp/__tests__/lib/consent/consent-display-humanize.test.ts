import { describe, expect, it } from "vitest";

import { humanizeConsentScope } from "@/lib/consent/consent-display";

describe("humanizeConsentScope", () => {
  describe("empty inputs", () => {
    it("returns a default label for null", () => {
      expect(
        humanizeConsentScope(null),
      ).toBe("Consent request");
    });

    it("returns a default label for whitespace-only values", () => {
      expect(
        humanizeConsentScope("   "),
      ).toBe("Consent request");
    });
  });

  describe("known literal mappings", () => {
    it("maps vault.owner", () => {
      expect(
        humanizeConsentScope("vault.owner"),
      ).toBe("Full vault access");
    });

    it("maps pkm.read", () => {
      expect(
        humanizeConsentScope("pkm.read"),
      ).toBe("Personal Knowledge Model access");
    });

    it("maps pkm.write", () => {
      expect(
        humanizeConsentScope("pkm.write"),
      ).toBe("Personal Knowledge Model updates");
    });
  });

  describe("attr scopes", () => {
    it("handles domains without tails", () => {
      expect(
        humanizeConsentScope("attr.financial_data"),
      ).toBe("Financial Data data");
    });

    it("handles wildcard tails", () => {
      expect(
        humanizeConsentScope("attr.financial_data.*"),
      ).toBe("Financial Data data");
    });

    it("handles named tails", () => {
      expect(
        humanizeConsentScope(
          "attr.financial_data.transactions",
        ),
      ).toBe("Financial Data Transactions");
    });
  });

  describe("generic fallback", () => {
    it("humanizes dot-separated scopes", () => {
      expect(
        humanizeConsentScope("profile.read"),
      ).toBe("Profile Read");
    });

    it("humanizes underscore-separated scopes", () => {
      expect(
        humanizeConsentScope("notification_settings"),
      ).toBe("Notification Settings");
    });
  });
});