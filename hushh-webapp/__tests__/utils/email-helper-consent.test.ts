import { describe, expect, it } from "vitest";

import { isEmailHelperConsent } from "@/lib/consent/email-helper-consent";

describe("email-helper-consent", () => {
  describe("isEmailHelperConsent", () => {
    it("preserves detection for the one_email_kyc_v1 request source", () => {
      expect(
        isEmailHelperConsent({ request_source: "one_email_kyc_v1" }),
      ).toBe(true);
    });

    it("preserves detection for paired workflow and gmail thread ids", () => {
      expect(
        isEmailHelperConsent({
          workflow_id: "wf-123",
          gmail_thread_id: "thread-456",
        }),
      ).toBe(true);
    });

    it("preserves false for unrelated metadata", () => {
      expect(isEmailHelperConsent({})).toBe(false);
      expect(isEmailHelperConsent(null)).toBe(false);
    });
  });
});