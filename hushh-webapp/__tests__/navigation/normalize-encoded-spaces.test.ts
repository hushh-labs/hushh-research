import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on RAW spaces vs.
// PERCENT-ENCODED spaces inside an internal path.
//
// Real guard:
//   const href = String(value ?? "").trim();
//   if (!href) return null;
//   if (!href.startsWith("/") || href.startsWith("//")) return null;
//   if (/[\r\n]/.test(href)) return null;
//   return href;
//
// Truth-first note: the guard does NOT encode, decode, or re-format the path.
//   - `.trim()` only strips LEADING/TRAILING ASCII whitespace; interior spaces
//     are left untouched.
//   - A percent-encoded space ("%20") is just ordinary characters to the guard;
//     it is preserved verbatim.
//   - A raw interior space (" ") is also preserved verbatim (space is not "/",
//     not "\r", not "\n"), so "/legal docs" passes through UNCHANGED — it is not
//     converted to "/legal%20docs" and not rejected.
//   - There is no equivalence/normalization between "%20" and " ".

describe("normalizeInternalRouteHref — raw vs percent-encoded spaces", () => {
  it("preserves a percent-encoded space verbatim", () => {
    expect(normalizeInternalRouteHref("/legal%20docs")).toBe("/legal%20docs");
  });

  it("preserves a raw interior space verbatim (no encoding applied)", () => {
    expect(normalizeInternalRouteHref("/legal docs")).toBe("/legal docs");
  });

  it("does NOT treat '%20' and ' ' as equivalent (no normalization)", () => {
    const encoded = normalizeInternalRouteHref("/legal%20docs");
    const raw = normalizeInternalRouteHref("/legal docs");
    expect(encoded).not.toBe(raw);
  });

  it("trims only leading/trailing whitespace, keeping interior raw spaces", () => {
    expect(normalizeInternalRouteHref("   /legal docs   ")).toBe("/legal docs");
  });

  it("does not decode a percent-encoded space surrounded by trimmed whitespace", () => {
    expect(normalizeInternalRouteHref("  /legal%20docs  ")).toBe("/legal%20docs");
  });

  it("preserves spaces (raw and encoded) inside query strings", () => {
    expect(normalizeInternalRouteHref("/search?q=a b")).toBe("/search?q=a b");
    expect(normalizeInternalRouteHref("/search?q=a%20b")).toBe("/search?q=a%20b");
  });

  it("still rejects a value that becomes empty after trimming whitespace", () => {
    expect(normalizeInternalRouteHref("    ")).toBeNull();
  });

  it("rejects a space-bearing value that does not start with '/'", () => {
    // After trim, "legal docs" does not begin with "/", so it is rejected.
    expect(normalizeInternalRouteHref("  legal docs  ")).toBeNull();
  });
});
