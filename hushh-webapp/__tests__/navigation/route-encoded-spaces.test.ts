import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on the two WEB WIRE
// encodings of a space inside a query string: "+" (application/x-www-form-
// urlencoded style) versus "%20" (percent-encoding).
//
// Real guard (verbatim from source):
//   const href = String(value ?? "").trim();
//   if (!href) return null;
//   if (!href.startsWith("/") || href.startsWith("//")) return null;
//   if (/[\r\n]/.test(href)) return null;
//   return href;
//
// Truth-first note: the guard performs NO query parsing, NO percent-decoding,
// and NO "+"->space translation. It is a pure allow/deny + trim gate. Whatever
// space encoding the caller passes in is returned byte-for-byte unchanged.
//   - "/search?query=hello+world"  -> preserved as "hello+world"
//   - "/search?query=hello%20world" -> preserved as "hello%20world"
//   - The "+" form and the "%20" form are therefore NOT equivalent through this
//     function; they remain distinct literal strings.
//
// This complements normalize-encoded-spaces.test.ts (which pins RAW space vs
// "%20"); here we pin the PLUS ("+") vs "%20" contract, which is a separate
// wire-encoding boundary the existing test does not cover.

describe("normalizeInternalRouteHref — '+' vs '%20' query space encodings", () => {
  it("preserves a plus-encoded query space verbatim", () => {
    expect(normalizeInternalRouteHref("/search?query=hello+world")).toBe(
      "/search?query=hello+world",
    );
  });

  it("preserves a percent-encoded query space verbatim", () => {
    expect(normalizeInternalRouteHref("/search?query=hello%20world")).toBe(
      "/search?query=hello%20world",
    );
  });

  it("does NOT treat '+' and '%20' as equivalent (no wire decoding)", () => {
    const plus = normalizeInternalRouteHref("/search?query=hello+world");
    const percent = normalizeInternalRouteHref("/search?query=hello%20world");
    expect(plus).not.toBe(percent);
  });

  it("does not convert '+' into a raw space", () => {
    expect(normalizeInternalRouteHref("/search?query=hello+world")).not.toBe(
      "/search?query=hello world",
    );
  });

  it("keeps multiple plus signs untouched", () => {
    expect(normalizeInternalRouteHref("/search?q=a+b+c")).toBe(
      "/search?q=a+b+c",
    );
  });

  it("preserves a mixed '+' and '%20' query string exactly as given", () => {
    expect(normalizeInternalRouteHref("/search?q=a+b%20c")).toBe(
      "/search?q=a+b%20c",
    );
  });

  it("trims only leading/trailing whitespace, leaving the '+' encoding intact", () => {
    expect(normalizeInternalRouteHref("   /search?query=hello+world   ")).toBe(
      "/search?query=hello+world",
    );
  });

  it("still rejects a plus-bearing value that does not start with '/'", () => {
    expect(normalizeInternalRouteHref("search?query=hello+world")).toBeNull();
  });
});
