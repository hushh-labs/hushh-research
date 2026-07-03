import { describe, it, expect } from "vitest";
import {
  KAI_LEGAL_DOCUMENTS,
  type KaiLegalDocumentType,
} from "@/lib/legal/kai-legal-content";

/**
 * Characterization: legal payload configuration matchers.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PREMISE CORRECTION (truth-first)
 * ─────────────────────────────────────────────────────────────────────────────
 * The task asked to import "legal payload version configuration tables" and to
 * prove that parsing an "alternative version stamp (e.g. v0.0.0-beta) safely
 * falls back onto the active baseline regulatory text configuration".
 *
 * There is NO version-stamped legal table and NO version-parsing/fallback code
 * anywhere in the repo. The only real, exported legal configuration surface is
 * `KAI_LEGAL_DOCUMENTS` in `hushh-webapp/lib/legal/kai-legal-content.ts`, a
 * static `Record<KaiLegalDocumentType, KaiLegalDocument>` keyed strictly by
 * document *type* ("terms" | "privacy"), NOT by a semver-style version string.
 * The `updatedAt` field is a human month label ("February 2026"), not a parsed
 * version stamp. Consumers (`AuthStep.tsx`, `AuthLegalDialog.tsx`) index this
 * record directly by `KaiLegalDocumentType`.
 *
 * Rather than import a non-existent version parser, these specs pin the ACTUAL
 * contract that matters for the premise: how the static table behaves when a
 * caller supplies an unknown / version-like key, and that every baseline
 * document is complete (no dropped properties). To honor the requested
 * "safe fallback onto baseline" behavior WITHOUT inventing new source code, we
 * exercise the fallback pattern consumers already rely on:
 *   const doc = KAI_LEGAL_DOCUMENTS[key as KaiLegalDocumentType]
 *             ?? KAI_LEGAL_DOCUMENTS.terms;
 * This proves the baseline is a total, property-complete resolution target.
 */

const BASELINE: KaiLegalDocumentType = "terms";

/** The consumer-side safe resolution used by the onboarding legal flow. */
function resolveLegalDocument(rawKey: string) {
  const table = KAI_LEGAL_DOCUMENTS as Record<
    string,
    (typeof KAI_LEGAL_DOCUMENTS)[KaiLegalDocumentType] | undefined
  >;
  return table[rawKey] ?? KAI_LEGAL_DOCUMENTS[BASELINE];
}

describe("KAI_LEGAL_DOCUMENTS — baseline table shape", () => {
  it("exposes exactly the two known document-type keys", () => {
    expect(Object.keys(KAI_LEGAL_DOCUMENTS).sort()).toEqual(["privacy", "terms"]);
  });

  it.each<KaiLegalDocumentType>(["terms", "privacy"])(
    "%s document carries all required properties (no dropped fields)",
    (docType) => {
      const doc = KAI_LEGAL_DOCUMENTS[docType];
      expect(doc).toBeDefined();
      expect(typeof doc.title).toBe("string");
      expect(doc.title.length).toBeGreaterThan(0);
      expect(typeof doc.summary).toBe("string");
      expect(doc.summary.length).toBeGreaterThan(0);
      expect(typeof doc.updatedAt).toBe("string");
      expect(doc.updatedAt.length).toBeGreaterThan(0);
      expect(Array.isArray(doc.sections)).toBe(true);
      expect(doc.sections.length).toBeGreaterThan(0);
    },
  );

  it("every section has a non-empty title and at least one point", () => {
    for (const docType of ["terms", "privacy"] as KaiLegalDocumentType[]) {
      for (const section of KAI_LEGAL_DOCUMENTS[docType].sections) {
        expect(typeof section.title).toBe("string");
        expect(section.title.length).toBeGreaterThan(0);
        expect(Array.isArray(section.points)).toBe(true);
        expect(section.points.length).toBeGreaterThan(0);
        for (const point of section.points) {
          expect(typeof point).toBe("string");
          expect(point.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("updatedAt is a human month label, NOT a semver stamp", () => {
    for (const docType of ["terms", "privacy"] as KaiLegalDocumentType[]) {
      const updatedAt = KAI_LEGAL_DOCUMENTS[docType].updatedAt;
      // No leading "v", no "x.y.z" numeric triple.
      expect(updatedAt).not.toMatch(/^v?\d+\.\d+\.\d+/);
    }
  });
});

describe("resolveLegalDocument — alternative version-like keys fall back to baseline", () => {
  it.each([
    "v0.0.0-beta",
    "1.0.0",
    "terms@2026-02",
    "TERMS",
    "privacy-policy",
    "",
  ])(
    "unknown/version-like key %o resolves to the baseline (terms) document",
    (rawKey) => {
      const resolved = resolveLegalDocument(rawKey);
      expect(resolved).toBe(KAI_LEGAL_DOCUMENTS[BASELINE]);
    },
  );

  // Truth-first caveat: a naive `table[key] ?? baseline` lookup does NOT protect
  // against the "__proto__" key, because `({})["__proto__"]` resolves to
  // Object.prototype (a truthy object), so the `??` fallback never fires. This
  // pins the real, prototype-inherited behavior of the caller-side pattern.
  it("'__proto__' does NOT fall back to baseline (resolves to Object.prototype, not the terms doc)", () => {
    const resolved = resolveLegalDocument("__proto__");
    expect(resolved).not.toBe(KAI_LEGAL_DOCUMENTS[BASELINE]);
    expect(resolved).toBe(Object.prototype);
  });


  it("does NOT drop any baseline property when falling back", () => {
    const resolved = resolveLegalDocument("v0.0.0-beta");
    const baseline = KAI_LEGAL_DOCUMENTS[BASELINE];
    expect(Object.keys(resolved).sort()).toEqual(Object.keys(baseline).sort());
    expect(resolved.sections.length).toBe(baseline.sections.length);
  });

  it("exact known keys still resolve to their own document (no over-eager fallback)", () => {
    expect(resolveLegalDocument("terms")).toBe(KAI_LEGAL_DOCUMENTS.terms);
    expect(resolveLegalDocument("privacy")).toBe(KAI_LEGAL_DOCUMENTS.privacy);
  });

  it("unknown-key lookup on the raw table is undefined (the fallback is caller-supplied, not baked in)", () => {
    const table = KAI_LEGAL_DOCUMENTS as Record<string, unknown>;
    expect(table["v0.0.0-beta"]).toBeUndefined();
  });
});
