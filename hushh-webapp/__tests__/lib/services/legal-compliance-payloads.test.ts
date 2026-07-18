import { describe, expect, it } from "vitest";

import {
  KAI_LEGAL_DOCUMENTS,
  type KaiLegalDocumentType,
} from "@/lib/legal/kai-legal-content";

/**
 * Characterization: static legal-compliance payload model integrity.
 *
 * TRUTH CORRECTION — read before trusting the original task path
 * -------------------------------------------------------------
 * The task asked for an exported legal/compliance static structure under
 * `lib/services`. There is NO such legal-compliance dictionary under
 * `hushh-webapp/lib/services`. The real, exported, static legal-compliance
 * payload lives at `hushh-webapp/lib/legal/kai-legal-content.ts` as
 * `KAI_LEGAL_DOCUMENTS` (a `Record<KaiLegalDocumentType, KaiLegalDocument>`
 * covering the `terms` and `privacy` documents that back the frontend legal
 * layout). This suite characterizes that actual contract; the test file is kept
 * at the requested `__tests__/lib/services/` path per the task instruction, but
 * imports the genuine module rather than a fictional services-layer symbol.
 *
 * Verified shape (kai-legal-content.ts):
 *   export type KaiLegalDocumentType = "terms" | "privacy";
 *   type KaiLegalSection  = { title: string; points: string[] };
 *   type KaiLegalDocument = { title: string; summary: string;
 *                             updatedAt: string; sections: KaiLegalSection[] };
 *   export const KAI_LEGAL_DOCUMENTS: Record<KaiLegalDocumentType, KaiLegalDocument>
 *
 * These tests pin: the document keys, that every document field is a non-empty
 * string, that sections/points are non-empty arrays of non-empty strings, and
 * that no key node is missing or of the wrong type.
 */

const EXPECTED_DOCUMENT_TYPES: KaiLegalDocumentType[] = ["terms", "privacy"];

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

describe("KAI_LEGAL_DOCUMENTS · static legal compliance payload integrity", () => {
  it("exports exactly the documented compliance document keys", () => {
    expect(Object.keys(KAI_LEGAL_DOCUMENTS).sort()).toEqual(
      [...EXPECTED_DOCUMENT_TYPES].sort()
    );
  });

  it.each(EXPECTED_DOCUMENT_TYPES)(
    "document '%s' exposes non-empty string title, summary, and updatedAt",
    (type) => {
      const doc = KAI_LEGAL_DOCUMENTS[type];
      expect(doc).toBeDefined();
      expect(isNonEmptyString(doc.title)).toBe(true);
      expect(isNonEmptyString(doc.summary)).toBe(true);
      expect(isNonEmptyString(doc.updatedAt)).toBe(true);
    }
  );

  it.each(EXPECTED_DOCUMENT_TYPES)(
    "document '%s' has a non-empty sections array",
    (type) => {
      const { sections } = KAI_LEGAL_DOCUMENTS[type];
      expect(Array.isArray(sections)).toBe(true);
      expect(sections.length).toBeGreaterThan(0);
    }
  );

  it.each(EXPECTED_DOCUMENT_TYPES)(
    "every section in '%s' has a non-empty string title and a non-empty points array",
    (type) => {
      for (const section of KAI_LEGAL_DOCUMENTS[type].sections) {
        expect(isNonEmptyString(section.title)).toBe(true);
        expect(Array.isArray(section.points)).toBe(true);
        expect(section.points.length).toBeGreaterThan(0);
      }
    }
  );

  it.each(EXPECTED_DOCUMENT_TYPES)(
    "every bullet point in '%s' is a strictly typed non-empty string",
    (type) => {
      for (const section of KAI_LEGAL_DOCUMENTS[type].sections) {
        for (const point of section.points) {
          expect(typeof point).toBe("string");
          expect(isNonEmptyString(point)).toBe(true);
        }
      }
    }
  );

  it("contains no extraneous top-level keys beyond the typed document map", () => {
    const allowed = new Set<string>(EXPECTED_DOCUMENT_TYPES);
    for (const key of Object.keys(KAI_LEGAL_DOCUMENTS)) {
      expect(allowed.has(key)).toBe(true);
    }
  });

  it("terms document still carries its educational / not-advice compliance framing", () => {
    const flattened = KAI_LEGAL_DOCUMENTS.terms.sections
      .flatMap((section) => section.points)
      .join(" ")
      .toLowerCase();
    expect(flattened).toContain("not investment advice");
  });
});
