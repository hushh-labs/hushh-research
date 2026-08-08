import { describe, expect, it } from "vitest";

import { resolveLocationDeepLinkFocus } from "@/components/one-location/redesign/location-redesign-hub";

/**
 * Deep-link focus resolution for One-Location notification "Open" actions.
 *
 * Regression guard: an approval notification ("location_access_approved")
 * carries BOTH the newly created grantId and the originating requestId, plus an
 * explicit section=shared. The recipient must land on "Shared with me", not
 * "Needs my review". The explicit section must win over the requestId heuristic.
 */
describe("resolveLocationDeepLinkFocus", () => {
  it("routes an approved request (section=shared with a requestId + grantId) to Shared with me", () => {
    expect(
      resolveLocationDeepLinkFocus({
        section: "shared",
        hasRequest: true,
        hasGrant: true,
        hasSubmission: false,
      }),
    ).toEqual({ detailAction: "shared-with-me", nextTab: null });
  });

  it("routes an access request (section=approvals) to Needs my review", () => {
    expect(
      resolveLocationDeepLinkFocus({
        section: "approvals",
        hasRequest: true,
        hasGrant: false,
        hasSubmission: false,
      }),
    ).toEqual({ detailAction: "needs-review", nextTab: null });
  });

  it("routes section=my_requests to Needs my review", () => {
    expect(
      resolveLocationDeepLinkFocus({
        section: "my_requests",
        hasRequest: false,
        hasGrant: false,
        hasSubmission: false,
      }),
    ).toEqual({ detailAction: "needs-review", nextTab: null });
  });

  it("routes section=public_responses to the Links tab", () => {
    expect(
      resolveLocationDeepLinkFocus({
        section: "public_responses",
        hasRequest: false,
        hasGrant: false,
        hasSubmission: true,
      }),
    ).toEqual({ detailAction: null, nextTab: "links" });
  });

  it("routes section=people to the People tab", () => {
    expect(
      resolveLocationDeepLinkFocus({
        section: "people",
        hasRequest: false,
        hasGrant: false,
        hasSubmission: false,
      }),
    ).toEqual({ detailAction: null, nextTab: "people" });
  });

  describe("fallbacks when no explicit section is present", () => {
    it("falls back to Needs my review when only a requestId is present", () => {
      expect(
        resolveLocationDeepLinkFocus({
          section: "",
          hasRequest: true,
          hasGrant: false,
          hasSubmission: false,
        }),
      ).toEqual({ detailAction: "needs-review", nextTab: null });
    });

    it("falls back to Shared with me when only a grantId is present", () => {
      expect(
        resolveLocationDeepLinkFocus({
          section: "",
          hasRequest: false,
          hasGrant: true,
          hasSubmission: false,
        }),
      ).toEqual({ detailAction: "shared-with-me", nextTab: null });
    });

    it("falls back to the Links tab when only a submissionId is present", () => {
      expect(
        resolveLocationDeepLinkFocus({
          section: "",
          hasRequest: false,
          hasGrant: false,
          hasSubmission: true,
        }),
      ).toEqual({ detailAction: null, nextTab: "links" });
    });

    it("prefers the requestId fallback over the grantId fallback", () => {
      expect(
        resolveLocationDeepLinkFocus({
          section: "",
          hasRequest: true,
          hasGrant: true,
          hasSubmission: false,
        }),
      ).toEqual({ detailAction: "needs-review", nextTab: null });
    });
  });

  it("resolves to nothing when neither a section nor any id is present", () => {
    expect(
      resolveLocationDeepLinkFocus({
        section: "",
        hasRequest: false,
        hasGrant: false,
        hasSubmission: false,
      }),
    ).toEqual({ detailAction: null, nextTab: null });
  });
});
