import { normalizeConsentResponse } from "@/src/lib/consent/normalizeConsent";

describe("normalizeConsentResponse", () => {
  it("treats active and granted flags as granted", () => {
    expect(normalizeConsentResponse({ active: true }).isGranted).toBe(true);
    expect(normalizeConsentResponse({ granted: true }).isGranted).toBe(true);
  });

  it("normalizes approved and active statuses as granted", () => {
    expect(normalizeConsentResponse({ status: "approved" }).isGranted).toBe(true);
    expect(normalizeConsentResponse({ status: "active" }).isGranted).toBe(true);
  });

  it("keeps denied, pending, and malformed responses ungranted", () => {
    expect(normalizeConsentResponse({ status: "denied" }).isGranted).toBe(false);
    expect(normalizeConsentResponse({ status: "pending" }).isGranted).toBe(false);
    expect(normalizeConsentResponse(null).isGranted).toBe(false);
  });

  it("deduplicates valid permission and scope strings", () => {
    expect(
      normalizeConsentResponse({
        permissions: ["profile:read", "profile:read", ""],
        scopes: ["vault:read"],
      }).permissions
    ).toEqual(["profile:read", "vault:read"]);
  });
});
