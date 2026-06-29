import { describe, expect, it } from "vitest";

import { resolveInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for resolveInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) pinning its EXACT behavior when the
// candidate href carries a query string that mixes a scalar param key with a
// bracket-notation array of the same name (e.g. '/api/v1?tags=dev&tags[]=prod').
// Test-only; no production change.
//
// TRUTH-FIRST — LITERAL CONTRACT: resolveInternalRouteHref is a one-liner:
//   return normalizeInternalRouteHref(value) ?? fallback;
// and normalizeInternalRouteHref only:
//   const href = String(value ?? "").trim();
//   if (!href) return null;
//   if (!href.startsWith("/") || href.startsWith("//")) return null;
//   if (/[\r\n]/.test(href)) return null;
//   return href;
// So the function performs NO query parsing whatsoever: no `URLSearchParams`,
// no `?`/`&` splitting, no bracket-notation `[]` handling, no scalar-vs-array
// conflict resolution, and no structured indexing. A valid internal href is
// returned BYTE-FOR-BYTE UNCHANGED (query string included); an invalid one
// yields the provided fallback.
//
// TRUTH-FIRST CORRECTION TO THE TASK PREMISE: the task asks how "the extraction
// process resolves the conflict and structured indexing" between `tags=dev` and
// `tags[]=prod`. There is NO extraction process. resolveInternalRouteHref never
// reads, dedupes, merges, or indexes query parameters. The full query string —
// duplicate keys, `[]` tokens, ordering — is preserved verbatim in the returned
// href. The only "resolution" performed is the boundary guard + fallback.

const FALLBACK = "/fallback";

describe("resolveInternalRouteHref — duplicate scalar+array query keys are NOT parsed", () => {
  it("returns the mixed scalar/array query href verbatim (no extraction)", () => {
    const input = "/api/v1?tags=dev&tags[]=prod";
    expect(resolveInternalRouteHref(input, FALLBACK)).toBe(input);
  });

  it("preserves the original parameter ORDER and both duplicate keys", () => {
    const out = resolveInternalRouteHref("/x?tags=dev&tags[]=prod", FALLBACK);
    // No reordering, no "last wins", no collapsing to a single key.
    expect(out).toBe("/x?tags=dev&tags[]=prod");
    expect(out?.indexOf("tags=dev")).toBeLessThan(out?.indexOf("tags[]=prod")!);
  });

  it("retains the literal '[]' bracket tokens (no structured indexing)", () => {
    const out = resolveInternalRouteHref("/x?tags[]=a&tags[]=b", FALLBACK);
    expect(out).toBe("/x?tags[]=a&tags[]=b");
    expect(out).toContain("[]");
  });

  it("does not deduplicate three repeats of the same scalar key", () => {
    const input = "/x?tags=a&tags=b&tags=c";
    expect(resolveInternalRouteHref(input, FALLBACK)).toBe(input);
  });

  it("preserves indexed bracket notation tokens verbatim", () => {
    const input = "/x?tags[0]=a&tags[1]=b";
    expect(resolveInternalRouteHref(input, FALLBACK)).toBe(input);
  });

  it("does not percent-decode encoded brackets in duplicate keys", () => {
    const input = "/x?tags=dev&tags%5B%5D=prod";
    expect(resolveInternalRouteHref(input, FALLBACK)).toBe(input);
  });

  it("falls back when the candidate is protocol-relative even with array keys", () => {
    expect(
      resolveInternalRouteHref("//evil.example?tags=dev&tags[]=prod", FALLBACK),
    ).toBe(FALLBACK);
  });

  it("falls back when the candidate is a bare query not starting with '/'", () => {
    expect(resolveInternalRouteHref("?tags=dev&tags[]=prod", FALLBACK)).toBe(
      FALLBACK,
    );
  });

  it("falls back on null/empty input regardless of intended query shape", () => {
    expect(resolveInternalRouteHref(null, FALLBACK)).toBe(FALLBACK);
    expect(resolveInternalRouteHref("   ", FALLBACK)).toBe(FALLBACK);
  });

  it("trims only outer whitespace while keeping the duplicate-key query intact", () => {
    expect(
      resolveInternalRouteHref("  /x?tags=dev&tags[]=prod  ", FALLBACK),
    ).toBe("/x?tags=dev&tags[]=prod");
  });
});
