import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on route paths made up entirely
// of numeric directory segments (e.g. `/v2/1028/3403`).
//
// TRUTH-FIRST — IMPORTANT CORRECTION: the premise that numeric segments are
// "validated", coerced to numbers, range-checked, or treated as "numeric
// parameters" is FALSE. normalizeInternalRouteHref does NO per-segment parsing
// and has NO notion of numeric vs. non-numeric tokens. It only:
//   1. returns `null` for non-strings / empty-after-trim,
//   2. trims surrounding whitespace,
//   3. returns `null` for protocol-relative (`//`) or absolute-URL hrefs,
//   4. returns `null` for hrefs not starting with `/`,
//   5. returns `null` for hrefs containing interior CR/LF,
//   6. otherwise returns the trimmed href VERBATIM.
// Digits are just ordinary string characters: `/v2/1028/3403` passes through
// unchanged, with NO leading-zero stripping, NO numeric coercion, and NO
// collapsing of multi-digit segments. These tests pin that opaque string-token
// contract.

describe("normalizeInternalRouteHref — all-numeric path segments", () => {
  it("returns a multi-segment numeric path verbatim", () => {
    expect(normalizeInternalRouteHref("/v2/1028/3403")).toBe("/v2/1028/3403");
  });

  it("returns a purely numeric path verbatim", () => {
    expect(normalizeInternalRouteHref("/1028/3403")).toBe("/1028/3403");
  });

  it("does NOT strip leading zeros from numeric segments", () => {
    expect(normalizeInternalRouteHref("/v2/0007/0042")).toBe("/v2/0007/0042");
  });

  it("does NOT coerce or collapse large numeric segments", () => {
    expect(
      normalizeInternalRouteHref("/orders/900719925474099100")
    ).toBe("/orders/900719925474099100");
  });

  it("trims surrounding whitespace but keeps the numeric path intact", () => {
    expect(normalizeInternalRouteHref("  /v2/1028/3403  ")).toBe(
      "/v2/1028/3403"
    );
  });

  it("rejects a protocol-relative host even when segments are numeric", () => {
    expect(normalizeInternalRouteHref("//1028/3403")).toBeNull();
  });

  it("rejects a numeric path that does not start with '/'", () => {
    expect(normalizeInternalRouteHref("1028/3403")).toBeNull();
  });
});
