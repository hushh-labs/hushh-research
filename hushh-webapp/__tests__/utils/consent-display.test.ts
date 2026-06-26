import { describe, expect, it } from "vitest";

import { humanizeConsentScope } from "@/lib/consent/consent-display";

describe("consent-display", () => {
  describe("humanizeConsentScope", () => {
    it("preserves the full vault access label for vault.owner", () => {
      expect(humanizeConsentScope("vault.owner")).toBe("Full vault access");
    });

    it("preserves the consent request fallback for empty scope", () => {
      expect(humanizeConsentScope("")).toBe("Consent request");
      expect(humanizeConsentScope(null)).toBe("Consent request");
    });
  });
});