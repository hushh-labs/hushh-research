import { describe, expect, it } from "vitest";

import { effectiveOneKycRequiredFields } from "@/lib/services/one-kyc-client-zk-service";

/**
 * Characterization specs for the public zero-knowledge required-field resolver.
 *
 * TRUTH-FIRST NOTE ON SURFACE SELECTION
 * The task framed this as testing a public ZK payload helper that "strips or
 * encapsulates unexpected array properties uniformly". The metadata-stripping
 * logic itself (INTERNAL_APPROVED_VALUE_KEYS, flattenApprovedValues,
 * formatApprovedValue) is NOT exported from one-kyc-client-zk-service.ts and is
 * therefore not a public contract. The genuinely exported, pure ZK payload
 * helper that reconciles array-shaped inputs (required fields plus scope
 * arrays) into a normalized, deduplicated field list is
 * effectiveOneKycRequiredFields. These specs characterize its observed shape
 * handling; they do not assert an invented private stripping contract.
 *
 * TRUTH-FIRST NOTE ON FILE NAME
 * The task requested a ".spec.ts" file, but hushh-webapp/vitest.config.ts only
 * collects test files ending in ".test.ts" / ".test.tsx". A ".spec.ts" file is
 * silently skipped by the runner and CI, so this uses ".test.ts" to keep the
 * verification claim true.
 */

describe("effectiveOneKycRequiredFields — ZK metadata array shape resolution", () => {
  it("resolves identity scope to the identity_profile fallback when no fields given", () => {
    const result = effectiveOneKycRequiredFields({
      requiredFields: [],
      scopes: ["attr.identity.*"],
    });
    expect(result).toEqual(["identity_profile"]);
  });

  it("deduplicates fields uniformly across repeated/overlapping scopes", () => {
    const result = effectiveOneKycRequiredFields({
      requiredFields: ["full_name", "email", "full_name"],
      scopes: ["attr.identity.*", "attr.identity.*"],
    });
    // Each field appears once despite duplicate inputs and duplicate scopes.
    expect(result.filter((field: string) => field === "full_name")).toHaveLength(1);
    expect(result).toContain("full_name");
    expect(result).toContain("email");
  });

  it("ignores unexpected null/undefined scope array entries without throwing", () => {
    const result = effectiveOneKycRequiredFields({
      requiredFields: ["full_name"],
      scopes: [null, undefined, "attr.identity.*", null],
    });
    expect(result).toContain("full_name");
  });

  it("maps a financial portfolio scope to the portfolio field", () => {
    const result = effectiveOneKycRequiredFields({
      requiredFields: [],
      scopes: ["attr.financial.portfolio"],
    });
    expect(result).toEqual(["portfolio"]);
  });

  it("collapses attr.financial.* to the financial_information aggregate field", () => {
    const result = effectiveOneKycRequiredFields({
      requiredFields: [],
      scopes: ["attr.financial.*"],
    });
    expect(result).toEqual(["financial_information"]);
  });

  it("falls back to the domain aggregate field for a dynamic scope whose only required field is identity-scoped", () => {
    const result = effectiveOneKycRequiredFields({
      requiredFields: ["full_name"],
      scopes: ["attr.travel"],
    });
    // full_name is an identity field, so it is filtered out of the dynamic
    // travel domain; the resolver then falls back to the `<domain>_information`
    // aggregate rather than returning an empty list.
    expect(result).toEqual(["travel_information"]);
  });

  it("falls back to the fallbackScope when no scopes are supplied", () => {
    const result = effectiveOneKycRequiredFields({
      requiredFields: ["email"],
      scopes: [],
      fallbackScope: "attr.identity.*",
    });
    expect(result).toContain("email");
  });

  it("defaults to identity_profile when given entirely empty inputs", () => {
    const result = effectiveOneKycRequiredFields({});
    expect(result).toEqual(["identity_profile"]);
  });
});
