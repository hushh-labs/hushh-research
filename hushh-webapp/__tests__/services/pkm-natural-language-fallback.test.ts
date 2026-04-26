import { describe, expect, it } from "vitest";

import { buildNaturalDomainPresentation } from "@/lib/personal-knowledge-model/natural-language";

describe("PKM natural-language fallback messages", () => {
  it("produces a user-centric message when domain has attributes but no sections", () => {
    const presentation = buildNaturalDomainPresentation({
      domain: {
        key: "financial",
        displayName: "Financial",
        icon: "wallet",
        color: "#3B82F6",
        attributeCount: 5,
        summary: {},
        availableScopes: [],
        lastUpdated: null,
      },
    });

    expect(presentation.summary).toMatch(/^Your financial profile/i);
    expect(presentation.summary).toContain("5 saved details");
    expect(presentation.summary).not.toContain("Kai has");
  });

  it("uses singular form when only one attribute exists", () => {
    const presentation = buildNaturalDomainPresentation({
      domain: {
        key: "health",
        displayName: "Health",
        icon: "heart",
        color: "#EF4444",
        attributeCount: 1,
        summary: {},
        availableScopes: [],
        lastUpdated: null,
      },
    });

    expect(presentation.summary).toContain("1 saved detail ");
    expect(presentation.summary).not.toContain("details");
  });

  it("produces a personalized message for zero-attribute domains", () => {
    const presentation = buildNaturalDomainPresentation({
      domain: {
        key: "travel",
        displayName: "Travel",
        icon: "plane",
        color: "#8B5CF6",
        attributeCount: 0,
        summary: {},
        availableScopes: [],
        lastUpdated: null,
      },
    });

    expect(presentation.summary).toMatch(/^Your travel profile is ready/i);
    expect(presentation.summary).not.toContain("Kai has");
  });

  it("prefers server-provided readableSummary over fallback", () => {
    const presentation = buildNaturalDomainPresentation({
      domain: {
        key: "financial",
        displayName: "Financial",
        icon: "wallet",
        color: "#3B82F6",
        attributeCount: 3,
        readableSummary: "Your investment portfolio analysis across 3 sectors.",
        summary: {},
        availableScopes: [],
        lastUpdated: null,
      },
    });

    expect(presentation.summary).toBe(
      "Your investment portfolio analysis across 3 sectors."
    );
  });

  it("falls back to section-aware message when sections exist", () => {
    const presentation = buildNaturalDomainPresentation({
      domain: {
        key: "financial",
        displayName: "Financial",
        icon: "wallet",
        color: "#3B82F6",
        attributeCount: 8,
        summary: {
          message_excerpt: "Uploaded a brokerage statement",
        },
        availableScopes: ["attr.financial.portfolio.*"],
        lastUpdated: null,
      },
      manifest: {
        domain: "financial",
        manifest_version: 1,
        summary_projection: {},
        top_level_scope_paths: ["portfolio"],
        externalizable_paths: [],
        paths: [],
      },
    });

    expect(presentation.summary).toContain("portfolio");
  });
});
