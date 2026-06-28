import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts).
//
// SCOPE NOTE (truth-first / non-duplication):
//   A sibling file `normalize-encoded-slashes.test.ts` already pins the basic
//   `%2F` directory-fragment behavior. This file deliberately covers DISTINCT,
//   previously-untested INTERSECTIONS of percent-encoded slashes with the
//   other guard clauses, so it does not overlap the existing contract.
//
// Real implementation (verified):
//   const href = String(value ?? "").trim();
//   if (!href) return null;
//   if (!href.startsWith("/") || href.startsWith("//")) return null;
//   if (/[\r\n]/.test(href)) return null;
//   return href;
//
// Key invariant under test: `%2F` is opaque to the guard. The function does NOT
// decode percent-escapes, so an encoded slash is never treated as a real path
// separator. The accept/reject decision depends ONLY on the literal first
// character(s) and the presence of raw CR/LF — never on encoded content.

describe("normalizeInternalRouteHref — encoded slash guard intersections", () => {
  it("preserves %2F segments verbatim without decoding them into separators", () => {
    expect(normalizeInternalRouteHref("/legal%2Fprivacy/terms")).toBe(
      "/legal%2Fprivacy/terms"
    );
  });

  it("keeps mixed-case %2f and %2F exactly as written (no normalization)", () => {
    expect(normalizeInternalRouteHref("/a%2fb%2FC")).toBe("/a%2fb%2FC");
  });

  it("rejects a leading literal // even when the rest contains encoded slashes", () => {
    // The `//` protocol-relative guard fires on the RAW prefix; %2F later in the
    // string cannot rescue it.
    expect(normalizeInternalRouteHref("//evil%2Fpath")).toBeNull();
  });

  it("does NOT treat a leading %2F as a second slash (so /%2F... is accepted)", () => {
    // Critical: "/%2Fhost/path" starts with a single "/" then literal "%2F".
    // Because %2F is not decoded, startsWith("//") is false → accepted as-is.
    expect(normalizeInternalRouteHref("/%2Fhost/path")).toBe("/%2Fhost/path");
  });

  it("rejects raw CR/LF even when adjacent to encoded slashes", () => {
    expect(normalizeInternalRouteHref("/legal%2F\nprivacy")).toBeNull();
    expect(normalizeInternalRouteHref("/legal%2F\rprivacy")).toBeNull();
  });

  it("preserves a literal CRLF escape sequence text (%0A/%0D) since it is not decoded", () => {
    // Encoded newlines are just opaque characters; the [\r\n] guard only sees
    // RAW control chars, so an encoded form passes through untouched.
    expect(normalizeInternalRouteHref("/legal%2F%0Aprivacy")).toBe(
      "/legal%2F%0Aprivacy"
    );
  });

  it("trims surrounding whitespace before evaluating the encoded-slash path", () => {
    expect(normalizeInternalRouteHref("   /docs%2Fintro   ")).toBe("/docs%2Fintro");
  });

  it("returns null for a whitespace-only-then-encoded value that loses its leading slash", () => {
    // After trim, "%2Fonly" does not start with "/" → rejected.
    expect(normalizeInternalRouteHref("  %2Fonly")).toBeNull();
  });
});
