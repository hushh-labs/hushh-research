import { describe, it, expect } from "vitest";

import {
  buildKycWorkflowArtifact,
  mergeKycWorkflowArtifact,
  type KycWorkflowArtifact,
  type KycWorkflowArtifactInput,
} from "@/lib/services/kyc-pkm-write-service";

/**
 * Characterization tests for the public structural factory surface of the
 * KYC workflow PKM write service: `buildKycWorkflowArtifact` and
 * `mergeKycWorkflowArtifact`.
 *
 * TRUTH CORRECTION — read before trusting the title
 * -------------------------------------------------
 * The requested premise ("attempts to mutate object leaves do not modify the
 * global reference values for subsequent requests") is only PARTIALLY true,
 * and these tests pin the ACTUAL behavior rather than an aspirational one.
 *
 * Verified source: hushh-webapp/lib/services/kyc-pkm-write-service.ts
 *
 *   export function buildKycWorkflowArtifact(artifact, lastUpdated) {
 *     return { ...artifact, last_updated, schema_version: 1 };  // SHALLOW spread
 *   }
 *
 * What is TRUE about the premise:
 *   - There is NO module-level "global default" singleton that is handed out
 *     and shared across calls. `buildKycWorkflowArtifact` allocates a NEW top-
 *     level object on every invocation, so two builds never alias each other at
 *     the top level, and one request cannot clobber the top-level object of the
 *     next request.
 *
 * What is FALSE / overstated about the premise:
 *   - The factory does a SHALLOW spread. It does NOT deep-clone. Nested leaves
 *     (the `checks` object, the `pending_requirements` / `completed_requirements`
 *     arrays, the `sent_replies` map) are STILL the SAME references as the caller-
 *     supplied input. Mutating those nested leaves through the returned artifact
 *     DOES mutate the caller's original input object, and vice versa.
 *   - `mergeKycWorkflowArtifact` likewise passes `pending_requirements` and
 *     `completed_requirements` through BY REFERENCE (no copy), so the merged
 *     artifact shares those arrays with its `artifact` argument.
 *
 * These tests therefore lock in: (a) fresh top-level identity per call, and
 * (b) shared nested-leaf references. If deep-immutability is ever desired, this
 * file turns red and forces a visible, reviewed change.
 */

function makeInput(): KycWorkflowArtifactInput {
  return {
    checks: {
      identity: { status: "verified", updated_at: "2024-01-01T00:00:00.000Z", method: "doc", source_domain: "id" },
      address: { status: "pending", updated_at: null, method: null, source_domain: null },
      bank: { status: "not_started", updated_at: null, method: null, source_domain: null },
      email: { status: "not_started", updated_at: null, method: null, source_domain: null },
    },
    overall_status: "pending",
    counterparty: "acme",
    request_summary: "verify me",
    pending_requirements: ["address"],
    completed_requirements: ["identity"],
  };
}

describe("Default/structural factory immutability — public KYC artifact surface", () => {
  describe("top-level identity: each factory call yields a fresh object (premise holds here)", () => {
    it("returns a NEW top-level object on every build, never a shared singleton", () => {
      const a = buildKycWorkflowArtifact(makeInput(), "2024-01-01T00:00:00.000Z");
      const b = buildKycWorkflowArtifact(makeInput(), "2024-01-01T00:00:00.000Z");
      expect(a).not.toBe(b);
      // Mutating the top-level scalar of one build does not affect the other build.
      a.overall_status = "verified";
      expect(b.overall_status).toBe("pending");
    });

    it("stamps schema_version and last_updated deterministically without aliasing", () => {
      const built = buildKycWorkflowArtifact(makeInput(), "2024-05-05T00:00:00.000Z");
      expect(built.schema_version).toBe(1);
      expect(built.last_updated).toBe("2024-05-05T00:00:00.000Z");
    });
  });

  describe("nested leaves: SHALLOW spread shares references (premise does NOT hold here)", () => {
    it("shares the `checks` object reference with the caller input", () => {
      const input = makeInput();
      const built = buildKycWorkflowArtifact(input, "2024-01-01T00:00:00.000Z");
      // Documented reality: checks is NOT cloned.
      expect(built.checks).toBe(input.checks);
      // Mutating a leaf through the built artifact leaks back into the input.
      built.checks.bank.status = "verified";
      expect(input.checks.bank.status).toBe("verified");
    });

    it("shares the requirement arrays by reference with the caller input", () => {
      const input = makeInput();
      const built = buildKycWorkflowArtifact(input, "2024-01-01T00:00:00.000Z");
      expect(built.pending_requirements).toBe(input.pending_requirements);
      built.pending_requirements.push("bank");
      expect(input.pending_requirements).toContain("bank");
    });
  });

  describe("merge: arrays pass through by reference (no defensive copy)", () => {
    it("merged artifact shares requirement arrays with its `artifact` argument", () => {
      const next = buildKycWorkflowArtifact(makeInput(), "2024-02-02T00:00:00.000Z");
      const merged = mergeKycWorkflowArtifact(next, null);
      expect(merged.pending_requirements).toBe(next.pending_requirements);
      expect(merged.completed_requirements).toBe(next.completed_requirements);
    });

    it("merge produces a fresh top-level object and a fresh sent_replies map", () => {
      const next = buildKycWorkflowArtifact(makeInput(), "2024-02-02T00:00:00.000Z");
      const merged = mergeKycWorkflowArtifact(next, null);
      expect(merged).not.toBe(next);
      // `checks` is rebuilt per-key by merge, so it is a new object, not aliased.
      expect(merged.checks).not.toBe(next.checks);
    });

    it("non-not_started checks win and last_updated is carried from the next artifact", () => {
      const existing: KycWorkflowArtifact = buildKycWorkflowArtifact(
        {
          ...makeInput(),
          checks: {
            identity: { status: "verified", updated_at: "x", method: "m", source_domain: "s" },
            address: { status: "verified", updated_at: "x", method: "m", source_domain: "s" },
            bank: { status: "verified", updated_at: "x", method: "m", source_domain: "s" },
            email: { status: "verified", updated_at: "x", method: "m", source_domain: "s" },
          },
        },
        "2023-01-01T00:00:00.000Z"
      );
      const next = buildKycWorkflowArtifact(makeInput(), "2024-09-09T00:00:00.000Z");
      const merged = mergeKycWorkflowArtifact(next, existing);
      // next.checks.bank is "not_started" -> existing "verified" is preserved.
      expect(merged.checks.bank.status).toBe("verified");
      // next.checks.identity is "verified" -> next wins.
      expect(merged.checks.identity.status).toBe("verified");
      expect(merged.last_updated).toBe("2024-09-09T00:00:00.000Z");
    });
  });
});
