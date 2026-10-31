import { describe, expect, it } from "vitest";
import { appRouteMatches } from "@/lib/navigation/route-settlement";
import {
  connectReviewRedirectMatches,
  connectPersonReviewHref,
} from "@/lib/navigation/connect-routes";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";

describe("logical route settlement", () => {
  it("recognizes only the authored incoming review correlated to this Connect person", () => {
    const target = connectPersonReviewHref("person-a");
    const current = buildConsentCenterHref("pending", {
      requestId: "incoming-a",
      from: target,
    });
    expect(connectReviewRedirectMatches(current, target)).toBe(true);
    expect(
      connectReviewRedirectMatches(
        current,
        connectPersonReviewHref("person-b"),
      ),
    ).toBe(false);
    expect(
      connectReviewRedirectMatches(
        buildConsentCenterHref("active", {
          requestId: "incoming-a",
          from: target,
        }),
        target,
      ),
    ).toBe(false);
    expect(
      connectReviewRedirectMatches(
        buildConsentCenterHref("pending", { from: target }),
        target,
      ),
    ).toBe(false);
    expect(
      connectReviewRedirectMatches(`https://other.invalid${current}`, target),
    ).toBe(false);
  });
  it.each([
    "/one/setup/location/",
    "/one/setup/location/index.html",
    "/one/setup/location",
  ])("settles native %s", (current) => {
    expect(appRouteMatches(current, "/one/setup/location", true)).toBe(true);
  });
  it("compares query contents independently of encoding and order", () => {
    expect(
      appRouteMatches(
        "/one/location/?tab=people&action=share",
        "/one/location?action=share&tab=people",
        true,
      ),
    ).toBe(true);
    expect(
      appRouteMatches(
        "/one/location/?action=ask",
        "/one/location?action=share",
        true,
      ),
    ).toBe(false);
    expect(
      appRouteMatches("/one/location?action=share", "/one/location", true),
    ).toBe(false);
  });
  it("rejects a different route or origin and preserves path-only callers", () => {
    expect(appRouteMatches("/one/agents", "/one/location")).toBe(false);
    expect(
      appRouteMatches(
        "https://elsewhere.invalid/one/location",
        "/one/location",
      ),
    ).toBe(false);
    expect(
      appRouteMatches("/one/location/?action=settings", "/one/location"),
    ).toBe(true);
  });
});
