import { describe, expect, it } from "vitest";

import {
  ROUTES,
  buildMarketplaceRiaProfileRoute,
  buildPhoneMandateRoute,
  buildOneOnboardingRoute,
  buildKaiAnalysisPreviewRoute,
  buildMarketplaceConnectionsRoute,
  normalizeInternalRouteHref,
} from "@/lib/navigation/routes";

// Characterization tests for how the navigation route layer
// (hushh-webapp/lib/navigation/routes.ts) treats explicit JavaScript `null` and
// `undefined` values when building query strings. Test-only; no production change.
//
// TRUTH-FIRST CORRECTION TO THE TASK PREMISE
// ------------------------------------------
// The task framed this as passing `{ userId: null, token: undefined }` into
// `normalizeInternalRouteHref`. That is not this function's contract:
//   export function normalizeInternalRouteHref(value: string | null | undefined)
// It accepts a STRING (or null/undefined) href, NOT an object of params. It does
// zero query construction — it trims, applies the boundary guards, and returns
// the href verbatim or null. So it cannot "serialize null/undefined params."
//
// The layer that DOES accept an object of params and decide null/undefined
// handling is the private helper `withQuery`, exercised through the exported
// builder functions. Its literal body is:
//   const params = new URLSearchParams();
//   for (const [key, value] of Object.entries(entries)) {
//     const normalized = String(value ?? "").trim();
//     if (normalized) params.set(key, normalized);
//   }
//   const query = params.toString();
//   return query ? `${pathname}?${query}` : pathname;
//
// LITERAL CONTRACT (verified against source):
//   - `String(value ?? "")` maps BOTH `null` and `undefined` to "" (the `??`
//     short-circuits before any "null"/"undefined" stringification).
//   - The `if (normalized)` guard then DROPS empty values, so the key is OMITTED
//     from the query entirely. It is NEVER emitted as the literal text "null" or
//     "undefined", and no bare `key=` is emitted either.
//   - Whitespace-only string values also normalize to "" and are dropped.
//   - When every value drops, `query` is "" and the BARE pathname is returned
//     with no trailing "?".
//   - The empty string "" is likewise falsy → dropped (indistinguishable here
//     from null/undefined at the output layer).

describe("routes builders — null/undefined query params are OMITTED, never stringified", () => {
  it("omits a null value entirely (no key, returns bare pathname)", () => {
    // buildMarketplaceRiaProfileRoute → withQuery({ riaId })
    expect(buildMarketplaceRiaProfileRoute(null)).toBe(
      ROUTES.MARKETPLACE_RIA_PROFILE,
    );
  });

  it("omits an undefined value entirely (no key, returns bare pathname)", () => {
    expect(buildMarketplaceRiaProfileRoute(undefined)).toBe(
      ROUTES.MARKETPLACE_RIA_PROFILE,
    );
  });

  it("never emits the literal string 'null' for a null value", () => {
    const out = buildPhoneMandateRoute(null);
    expect(out).toBe(ROUTES.PHONE_MANDATE);
    expect(out).not.toContain("null");
    expect(out).not.toContain("redirect");
  });

  it("never emits the literal string 'undefined' for an undefined value", () => {
    const out = buildPhoneMandateRoute(undefined);
    expect(out).toBe(ROUTES.PHONE_MANDATE);
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("redirect");
  });

  it("drops null/undefined mixed entries but keeps the populated one", () => {
    // buildOneOnboardingRoute → withQuery({ from, invite })
    // `from: null` is dropped; a valid internal `invite` is kept.
    const out = buildOneOnboardingRoute({ from: null, invite: "abc123" });
    expect(out).toBe(`${ROUTES.ONE_ONBOARDING}?invite=abc123`);
    expect(out).not.toContain("from");
    expect(out).not.toContain("null");
  });

  it("returns the bare pathname when ALL object entries are null/undefined", () => {
    const out = buildKaiAnalysisPreviewRoute({
      ticker: null,
      pickSource: undefined,
    });
    expect(out).toBe(ROUTES.KAI_ANALYSIS);
    expect(out).not.toContain("?");
  });

  it("treats a whitespace-only value the same as null (dropped)", () => {
    const out = buildMarketplaceRiaProfileRoute("   ");
    expect(out).toBe(ROUTES.MARKETPLACE_RIA_PROFILE);
  });

  it("treats the empty string the same as null/undefined (dropped)", () => {
    const out = buildMarketplaceConnectionsRoute({ tab: null, selected: "" });
    expect(out).toBe(ROUTES.CONSENTS);
    expect(out).not.toContain("?");
  });

  it("keeps a real value while a sibling null is dropped (partial map)", () => {
    // buildMarketplaceConnectionsRoute → withQuery({ tab, requestId: selected })
    const out = buildMarketplaceConnectionsRoute({
      tab: "active",
      selected: null,
    });
    expect(out).toBe(`${ROUTES.CONSENTS}?tab=active`);
    expect(out).not.toContain("requestId");
    expect(out).not.toContain("null");
  });
});

describe("normalizeInternalRouteHref — string surface does NOT parse params", () => {
  // Even when a null/undefined-looking token appears INSIDE a string href, this
  // function performs no query parsing: it returns the href verbatim (if it
  // passes the boundary guards) or null. The literal "null"/"undefined" text is
  // whatever the caller already put in the string — this layer neither adds nor
  // removes it.
  it("returns null for a null href value (not the string 'null')", () => {
    expect(normalizeInternalRouteHref(null)).toBeNull();
  });

  it("returns null for an undefined href value", () => {
    expect(normalizeInternalRouteHref(undefined)).toBeNull();
  });

  it("preserves a literal '?userId=null&token=undefined' query verbatim", () => {
    const input = "/dashboard?userId=null&token=undefined";
    expect(normalizeInternalRouteHref(input)).toBe(input);
  });
});
