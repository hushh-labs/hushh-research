import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on PROTOCOL / external-scheme
// isolation.
//
// Real guard:
//   const href = String(value ?? "").trim();
//   if (!href) return null;
//   if (!href.startsWith("/") || href.startsWith("//")) return null;
//   if (/[\r\n]/.test(href)) return null;
//   return href;
//
// Truth-first note: the guard is allow-list-by-shape, not a protocol blocklist.
// Anything that does not start with a single "/" is rejected with null. So any
// absolute URL carrying an explicit scheme ("https://", "http://",
// "javascript:", "data:", "mailto:", "ftp://", etc.) is rejected because it does
// not begin with "/". Protocol-relative "//host" is also rejected by the explicit
// "//"-prefix check. There is no scheme parsing or lowercasing — rejection is
// purely structural.

describe("normalizeInternalRouteHref — external protocol isolation", () => {
  it("rejects https:// absolute URLs", () => {
    expect(normalizeInternalRouteHref("https://evil.example.com")).toBeNull();
    expect(
      normalizeInternalRouteHref("https://evil.example.com/profile")
    ).toBeNull();
  });

  it("rejects http:// absolute URLs", () => {
    expect(normalizeInternalRouteHref("http://evil.example.com")).toBeNull();
  });

  it("rejects protocol-relative '//host' URLs", () => {
    expect(normalizeInternalRouteHref("//evil.example.com")).toBeNull();
    expect(normalizeInternalRouteHref("//evil.example.com/path")).toBeNull();
  });

  it("rejects dangerous non-http schemes (javascript:, data:, mailto:)", () => {
    expect(normalizeInternalRouteHref("javascript:alert(1)")).toBeNull();
    expect(
      normalizeInternalRouteHref("data:text/html,<script>1</script>")
    ).toBeNull();
    expect(normalizeInternalRouteHref("mailto:user@example.com")).toBeNull();
    expect(normalizeInternalRouteHref("ftp://host/file")).toBeNull();
  });

  it("rejects a scheme even after surrounding whitespace is trimmed", () => {
    expect(normalizeInternalRouteHref("   https://evil.example.com  ")).toBeNull();
  });

  it("rejects scheme-bearing values that embed CR/LF (defense in depth)", () => {
    expect(normalizeInternalRouteHref("https://evil\n/path")).toBeNull();
    expect(normalizeInternalRouteHref("/ok\r/path")).toBeNull();
  });

  it("does NOT parse or lowercase schemes — rejection is purely structural", () => {
    // Mixed-case scheme still rejected for the same structural reason.
    expect(normalizeInternalRouteHref("HTTPS://evil.example.com")).toBeNull();
    // A path that merely CONTAINS "http" but starts with "/" is allowed verbatim.
    expect(normalizeInternalRouteHref("/redirect?to=http://x")).toBe(
      "/redirect?to=http://x"
    );
  });

  it("admits genuine internal absolute paths unchanged", () => {
    expect(normalizeInternalRouteHref("/")).toBe("/");
    expect(normalizeInternalRouteHref("/settings")).toBe("/settings");
    expect(normalizeInternalRouteHref("/settings?tab=privacy#security")).toBe(
      "/settings?tab=privacy#security"
    );
  });
});
