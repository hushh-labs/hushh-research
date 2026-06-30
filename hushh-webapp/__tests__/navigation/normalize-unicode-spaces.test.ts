import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) against non-breaking spaces and
// alternative Unicode space characters in route values.
//
// TRUTH-FIRST — LITERAL CONTRACT:
//
//   const href = String(value ?? "").trim();
//   if (!href) return null;
//   if (!href.startsWith("/") || href.startsWith("//")) return null;
//   if (/[\r\n]/.test(href)) return null;
//   return href;
//
// The only space-related transformation is `String.prototype.trim()`. Per the
// ECMAScript spec, `.trim()` removes leading/trailing code points in the union
// of WhiteSpace + LineTerminator, which INCLUDES the Unicode Space_Separator
// (Zs) category — so `\u00A0` (no-break space), `\u2002` (en space), `\u2003`
// (em space), `\u3000` (ideographic space), and the BOM `\uFEFF` are all
// stripped at the ENDS of the string.
//
// Consequences this test pins:
//  * Leading/trailing Unicode spaces are TRIMMED (not preserved), and trimming
//    can REVEAL a leading "/" so the value passes the guard.
//  * INTERIOR Unicode spaces are PRESERVED VERBATIM — there is no collapse,
//    replacement, or percent-encoding of mid-string spaces.
//  * A value made up ONLY of Unicode spaces trims to "" and returns null.
//  * The CRLF rejection regex is `/[\r\n]/` only; it does NOT reject Unicode
//    spaces, so an interior `\u00A0` does not by itself cause a null.

describe("normalizeInternalRouteHref — Unicode space handling", () => {
  it("trims a leading no-break space (\\u00A0), revealing the leading '/'", () => {
    expect(normalizeInternalRouteHref("\u00A0/dashboard")).toBe("/dashboard");
  });

  it("trims a trailing en space (\\u2002)", () => {
    expect(normalizeInternalRouteHref("/dashboard\u2002")).toBe("/dashboard");
  });

  it("trims leading AND trailing mixed Unicode spaces", () => {
    expect(normalizeInternalRouteHref("\u3000\u2003/profile\u00A0")).toBe(
      "/profile",
    );
  });

  it("PRESERVES an interior no-break space verbatim", () => {
    expect(normalizeInternalRouteHref("/my\u00A0route")).toBe("/my\u00A0route");
  });

  it("PRESERVES an interior en space verbatim", () => {
    expect(normalizeInternalRouteHref("/a\u2002b")).toBe("/a\u2002b");
  });

  it("returns null for a string of only Unicode spaces (trims to empty)", () => {
    expect(normalizeInternalRouteHref("\u00A0\u2002\u3000")).toBeNull();
  });

  it("still rejects '//' even after trimming a leading Unicode space", () => {
    // trim -> "//evil" which startsWith("//") -> rejected.
    expect(normalizeInternalRouteHref("\u00A0//evil")).toBeNull();
  });

  it("does NOT reject an interior Unicode space (only \\r and \\n are rejected)", () => {
    expect(normalizeInternalRouteHref("/x\u00A0y\u2002z")).toBe(
      "/x\u00A0y\u2002z",
    );
  });
});
