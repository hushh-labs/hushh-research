import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on sub-domain / host-prefixed
// strings.
//
// Real guard:
//   const href = String(value ?? "").trim();
//   if (!href) return null;
//   if (!href.startsWith("/") || href.startsWith("//")) return null;
//   if (/[\r\n]/.test(href)) return null;
//   return href;
//
// TRUTH-FIRST: the guard does NOT parse hosts or distinguish "subdomains". It is
// a pure prefix check. A bare host-prefixed string like "one.hushh.ai/dashboard"
// does NOT start with "/", so it is REJECTED (returns null) — it is FILTERED OUT,
// not converted/preserved as an external link. Protocol-relative "//host" is
// explicitly rejected too. Only a value that already begins with a single "/"
// survives as a local route, regardless of any host-looking text after it.

describe("normalizeInternalRouteHref — sub-domain / host-prefixed inputs", () => {
  it("rejects a bare subdomain-prefixed string (no leading slash)", () => {
    expect(normalizeInternalRouteHref("one.hushh.ai/dashboard")).toBeNull();
  });

  it("rejects a protocol-relative subdomain URL ('//host/...')", () => {
    expect(normalizeInternalRouteHref("//one.hushh.ai/dashboard")).toBeNull();
  });

  it("rejects an absolute https subdomain URL", () => {
    expect(
      normalizeInternalRouteHref("https://one.hushh.ai/dashboard")
    ).toBeNull();
  });

  it("rejects an http subdomain URL", () => {
    expect(normalizeInternalRouteHref("http://app.hushh.ai/x")).toBeNull();
  });

  it("keeps a local path that merely CONTAINS host-looking text after '/'", () => {
    // Starts with a single "/", so it is a valid internal route verbatim — the
    // "one.hushh.ai" substring is treated as ordinary path text, not a host.
    expect(normalizeInternalRouteHref("/one.hushh.ai/dashboard")).toBe(
      "/one.hushh.ai/dashboard"
    );
  });

  it("preserves a normal internal route unaffected by host filtering", () => {
    expect(normalizeInternalRouteHref("/one/dashboard")).toBe("/one/dashboard");
  });

  it("trims surrounding whitespace before applying the prefix rule", () => {
    expect(normalizeInternalRouteHref("   one.hushh.ai/x   ")).toBeNull();
    expect(normalizeInternalRouteHref("   /one/x   ")).toBe("/one/x");
  });

  it("rejects a mixed-case scheme subdomain URL (still not '/'-leading)", () => {
    expect(normalizeInternalRouteHref("HTTPS://one.hushh.ai")).toBeNull();
  });
});
