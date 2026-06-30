import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) on protocol-relative inputs that
// begin with double forward slashes and omit the protocol word, e.g.
//   "//hushh.ai/legal"
//
// TRUTH-FIRST — CURRENT CONTRACT (verified against source):
//
//   normalizeInternalRouteHref(value):
//     1. href = String(value ?? "").trim()
//     2. if (!href) return null
//     3. if (!href.startsWith("/") || href.startsWith("//")) return null
//     4. if (/[\r\n]/.test(href)) return null
//     5. return href
//
// CORRECTION TO THE TASK PREMISE: there is NO "routing engine" that could
// interpret "//host/path" as a nested internal pathway. Step 3 explicitly
// rejects any value beginning with "//" by returning null. The browser would
// treat "//hushh.ai/legal" as a protocol-relative EXTERNAL pointer, and this
// guard refuses to emit it as an internal href. So the answer to the premise
// question is unambiguous: protocol-relative inputs are treated as external
// and rejected (null), never parsed as internal sub-paths. These tests pin
// that rejection.

describe("normalizeInternalRouteHref — protocol-relative '//' inputs are rejected as external (null)", () => {
  it("rejects a bare protocol-relative host+path", () => {
    expect(normalizeInternalRouteHref("//hushh.ai/legal")).toBeNull();
  });

  it("rejects protocol-relative even for a same-brand host", () => {
    expect(normalizeInternalRouteHref("//hushh.ai")).toBeNull();
  });

  it("rejects a bare double slash", () => {
    expect(normalizeInternalRouteHref("//")).toBeNull();
  });

  it("rejects deeper protocol-relative paths and query/hash variants", () => {
    expect(normalizeInternalRouteHref("//evil.example.com/a/b/c")).toBeNull();
    expect(normalizeInternalRouteHref("//evil.example.com/p?x=1")).toBeNull();
    expect(normalizeInternalRouteHref("//evil.example.com/p#frag")).toBeNull();
  });

  it("rejects protocol-relative even after surrounding whitespace is trimmed", () => {
    expect(normalizeInternalRouteHref("   //hushh.ai/legal   ")).toBeNull();
  });

  it("rejects three-or-more leading slashes (still starts with '//')", () => {
    expect(normalizeInternalRouteHref("///hushh.ai/legal")).toBeNull();
    expect(normalizeInternalRouteHref("////a")).toBeNull();
  });

  it("CONTRAST: a single-slash internal path with the same suffix is accepted verbatim", () => {
    // Only ONE leading slash → genuine internal path → returned unchanged.
    expect(normalizeInternalRouteHref("/hushh.ai/legal")).toBe("/hushh.ai/legal");
    expect(normalizeInternalRouteHref("/legal")).toBe("/legal");
  });
});
