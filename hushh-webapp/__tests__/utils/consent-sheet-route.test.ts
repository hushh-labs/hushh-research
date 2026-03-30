import { describe, expect, it } from "vitest";

import {
  resolveConsentNavigationTarget,
  normalizeInternalAppHref,
  resolveConsentRequestHref,
} from "@/lib/consent/consent-sheet-route";

describe("consent sheet route helpers", () => {
  it("keeps internal relative app routes relative", () => {
    expect(normalizeInternalAppHref("/consents?tab=pending")).toBe("/consents?tab=pending");
  });

  it("normalizes absolute localhost consent links to relative app routes", () => {
    expect(
      normalizeInternalAppHref("http://localhost:3000/consents?tab=pending&requestId=req_123")
    ).toBe("/consents?tab=pending&requestId=req_123");
  });

  it("does not rewrite external non-app links", () => {
    expect(normalizeInternalAppHref("https://example.com/disclosures/request-123")).toBe(
      "https://example.com/disclosures/request-123"
    );
  });

  it("falls back to a local consent manager route when the request url is missing", () => {
    expect(
      resolveConsentRequestHref(null, "pending", {
        requestId: "req_123",
        bundleId: "bundle_123",
      })
    ).toBe("/consents?tab=pending&requestId=req_123&bundleId=bundle_123");
  });

  it("adds a safe internal origin when routing into the consent manager", () => {
    expect(
      resolveConsentRequestHref(null, "pending", {
        requestId: "req_123",
        from: "/kai/analysis?tab=history",
      })
    ).toBe("/consents?tab=pending&requestId=req_123&from=%2Fkai%2Fanalysis%3Ftab%3Dhistory");
  });

  it("classifies internal consent links as SPA routes", () => {
    expect(
      resolveConsentNavigationTarget("http://localhost:3000/consents?tab=pending&requestId=req_123")
    ).toEqual({
      kind: "internal",
      href: "/consents?tab=pending&requestId=req_123",
      pathname: "/consents",
    });
  });

  it("keeps external consent review links as external navigation", () => {
    expect(
      resolveConsentNavigationTarget("https://example.com/disclosures/request-123")
    ).toEqual({
      kind: "external",
      href: "https://example.com/disclosures/request-123",
    });
  });
});
