import { describe, expect, it } from "vitest";

import { emailHelperConsentSummary } from "@/lib/consent/email-helper-consent";

describe("emailHelperConsentSummary", () => {
  it("returns single-field approval message when one required field is present", () => {
    const result = emailHelperConsentSummary({
      required_fields: ["risk_profile"],
    });

    expect(result).toBe(
      "Email Helper needs approval to use your risk profile.",
    );
  });
});