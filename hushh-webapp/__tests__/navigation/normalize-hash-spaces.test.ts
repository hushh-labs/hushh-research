import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) focused on spaces / encoding
// variations inside a TRAILING hash fragment
// (e.g. "/legal#privacy policy" vs "/legal#privacy%20policy").
//
// TRUTH-FIRST: normalizeInternalRouteHref does NOT parse, split, decode, or
// re-encode the fragment. It applies only whole-href structural guards
// (reject empty/whitespace-only, reject non-rooted, reject protocol-relative
// "//", reject interior CR/LF) and otherwise returns the trimmed string
// VERBATIM. The "#" character is never special-cased, so a fragment is treated
// EXACTLY like any other path text:
//   - a raw space inside the fragment is preserved (NOT encoded to %20)
//   - an existing %20 is preserved (NOT decoded to a space)
//   - leading/trailing whitespace on the whole href is trimmed (so a trailing
//     space after the fragment is removed by trim())
// The premise that fragments are "treated differently than standard path
// segments" is FALSE — there is no fragment-specific manipulation.

describe("normalizeInternalRouteHref — spaces in hash fragments", () => {
  it("keeps a raw space inside the fragment verbatim (no %20 encoding)", () => {
    expect(normalizeInternalRouteHref("/legal#privacy policy")).toBe(
      "/legal#privacy policy"
    );
  });

  it("keeps an existing %20 in the fragment verbatim (no decoding)", () => {
    expect(normalizeInternalRouteHref("/legal#privacy%20policy")).toBe(
      "/legal#privacy%20policy"
    );
  });

  it("does not collapse multiple raw spaces inside the fragment", () => {
    expect(normalizeInternalRouteHref("/legal#a  b")).toBe("/legal#a  b");
  });

  it("treats a space before '#' the same way (kept verbatim)", () => {
    expect(normalizeInternalRouteHref("/legal #privacy")).toBe(
      "/legal #privacy"
    );
  });

  it("trims a trailing space AFTER the fragment (whole-href trim)", () => {
    expect(normalizeInternalRouteHref("/legal#privacy policy ")).toBe(
      "/legal#privacy policy"
    );
  });

  it("preserves a bare trailing '#' with no fragment text", () => {
    expect(normalizeInternalRouteHref("/legal#")).toBe("/legal#");
  });

  it("still rejects a non-rooted href even with a hash fragment", () => {
    expect(normalizeInternalRouteHref("legal#privacy policy")).toBeNull();
  });

  it("still rejects a protocol-relative href with a hash fragment", () => {
    expect(normalizeInternalRouteHref("//evil.com#privacy policy")).toBeNull();
  });
});
