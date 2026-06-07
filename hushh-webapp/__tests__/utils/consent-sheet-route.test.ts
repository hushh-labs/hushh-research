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

  it("normalizes Email Helper workflow links to internal app routes", () => {
    expect(
      normalizeInternalAppHref("http://localhost:3000/one/kyc?workflowId=wf_123")
    ).toBe("/one/kyc?workflowId=wf_123");
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

  it("classifies Email Helper workflow links as SPA routes", () => {
    expect(
      resolveConsentNavigationTarget("http://localhost:3000/one/kyc?workflowId=wf_123")
    ).toEqual({
      kind: "internal",
      href: "/one/kyc?workflowId=wf_123",
      pathname: "/one/kyc",
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

// ── Path safety — edge cases, empty inputs, and traversal resistance ──────────

describe("path resolver safety — dangerous edge case handling", () => {

  // ── Null / empty / whitespace inputs ────────────────────────────────────

  it("normalizeInternalAppHref returns null for null — no crash", () => {
    expect(normalizeInternalAppHref(null)).toBeNull();
  });

  it("normalizeInternalAppHref returns null for undefined — no crash", () => {
    expect(normalizeInternalAppHref(undefined)).toBeNull();
  });

  it("normalizeInternalAppHref returns null for empty string", () => {
    expect(normalizeInternalAppHref("")).toBeNull();
  });

  it("normalizeInternalAppHref returns null for whitespace-only string", () => {
    expect(normalizeInternalAppHref("   ")).toBeNull();
  });

  it("resolveConsentNavigationTarget falls back to /consents for null href", () => {
    const result = resolveConsentNavigationTarget(null);
    expect(result.kind).toBe("internal");
    expect(result.href).toContain("/consents");
  });

  it("resolveConsentNavigationTarget falls back to /consents for empty string href", () => {
    const result = resolveConsentNavigationTarget("");
    expect(result.kind).toBe("internal");
    expect(result.href).toContain("/consents");
  });

  // ── Bare relative traversal — classifies as external, never internal ─────

  it("normalizeInternalAppHref does not crash on bare traversal string ../../..", () => {
    const result = normalizeInternalAppHref("../../..");
    // Bare traversal has no leading "/" — treated as an opaque string, never as a known app path.
    expect(typeof result === "string" || result === null).toBe(true);
  });

  it("resolveConsentNavigationTarget classifies bare ../../.. traversal as external", () => {
    const result = resolveConsentNavigationTarget("../../..");
    // A bare relative traversal cannot be parsed as a valid absolute URL.
    // isInternalAppHref returns false → correctly classified as external navigation.
    expect(result.kind).toBe("external");
    expect(result.href).toBe("../../..");
  });

  it("resolveConsentNavigationTarget classifies deeply nested traversal as external", () => {
    const result = resolveConsentNavigationTarget("../../../../admin/secrets");
    expect(result.kind).toBe("external");
  });

  it("resolveConsentRequestHref does not crash on traversal path — returns a string", () => {
    const result = resolveConsentRequestHref("../../..", "pending");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  // ── Deeply nested internal paths — resolved without crashing ─────────────

  it("normalizeInternalAppHref preserves valid deeply nested internal paths", () => {
    const deep = "/consents/details/view/sub/nested/item?tab=active&requestId=r_1";
    expect(normalizeInternalAppHref(deep)).toBe(deep);
  });

  it("resolveConsentNavigationTarget classifies /consents/* deep paths as internal", () => {
    const result = resolveConsentNavigationTarget(
      "/consents/a/b/c/d/e/f?requestId=req_1",
    );
    expect(result.kind).toBe("internal");
    // Pathname is the full path before "?" — not truncated.
    if (result.kind === "internal") {
      expect(result.pathname).toBe("/consents/a/b/c/d/e/f");
    }
  });

  it("resolveConsentNavigationTarget classifies /kai/* deep paths as internal", () => {
    const result = resolveConsentNavigationTarget("/kai/portfolio/analysis/deep/sub");
    expect(result.kind).toBe("internal");
  });

  // ── Protocol-relative and scheme injection — never classified as internal ─

  it("resolveConsentNavigationTarget classifies protocol-relative //evil.com as external", () => {
    // isInternalAppHref short-circuits on leading "//" before any URL parsing.
    const result = resolveConsentNavigationTarget("//evil.com/consents");
    expect(result.kind).toBe("external");
    expect(result.href).toBe("//evil.com/consents");
  });

  it("normalizeInternalAppHref does not reclassify //evil.com/consents as an internal route", () => {
    // Even though the string contains "/consents", the URL parsing guard catches it.
    // The value is returned as-is (opaque), not promoted to an internal pathname.
    const result = normalizeInternalAppHref("//evil.com/consents");
    expect(result).toBe("//evil.com/consents");
  });

  it("resolveConsentNavigationTarget classifies javascript: scheme as external", () => {
    // The router must never classify a javascript: URI as an internal SPA route.
    const result = resolveConsentNavigationTarget("javascript:alert(1)");
    expect(result.kind).toBe("external");
  });

  it("resolveConsentNavigationTarget classifies data: URI as external", () => {
    const result = resolveConsentNavigationTarget("data:text/html,<h1>test</h1>");
    expect(result.kind).toBe("external");
  });
});
// ── End path safety coverage ──────────────────────────────────────────────────
