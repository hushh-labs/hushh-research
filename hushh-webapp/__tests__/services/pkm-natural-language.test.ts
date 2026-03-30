import { describe, expect, it } from "vitest";

import {
  buildNaturalAccessEntries,
  buildNaturalDomainPresentation,
  buildReadablePkmMetadata,
} from "@/lib/personal-knowledge-model/natural-language";

describe("pkm natural-language helpers", () => {
  it("builds persisted readable metadata from a save preview", () => {
    const readable = buildReadablePkmMetadata({
      domainKey: "financial",
      domainDisplayName: "Financial",
      sourceText: "Remember that I want a lower-risk portfolio with more cash reserves.",
      mergeMode: "merge_entity",
      intentClass: "financial_event",
      structureDecision: {
        top_level_scope_paths: ["profile", "analytics"],
      },
    });

    expect(readable.readable_summary).toContain("financial update");
    expect(readable.readable_highlights).toContain("Merged into an existing memory");
    expect(readable.readable_highlights.some((item) => item.includes("Profile"))).toBe(true);
    expect(readable.readable_event_summary).toContain("Financial");
  });

  it("falls back to a human summary for older PKM domains", () => {
    const presentation = buildNaturalDomainPresentation({
      domain: {
        key: "financial",
        displayName: "Financial",
        icon: "wallet",
        color: "#123456",
        attributeCount: 12,
        summary: {
          message_excerpt: "Uploaded a brokerage statement",
          externalizable_path_count: 4,
        },
        availableScopes: ["attr.financial.analytics.*", "attr.financial.events.*"],
        lastUpdated: "2026-03-23T12:00:00Z",
      },
      manifest: {
        domain: "financial",
        manifest_version: 1,
        summary_projection: {},
        top_level_scope_paths: ["analytics", "events"],
        externalizable_paths: [],
        paths: [],
      },
    });

    expect(presentation.summary).toContain("financial");
    expect(presentation.sections).toEqual(["Analytics", "Events"]);
    expect(presentation.highlights.some((item) => item.includes("consent-ready"))).toBe(true);
  });

  it("translates active grants without exposing raw scope strings", () => {
    const access = buildNaturalAccessEntries({
      domain: {
        key: "financial",
        displayName: "Financial",
        icon: "wallet",
        color: "#123456",
        attributeCount: 4,
        summary: {},
        availableScopes: [],
        lastUpdated: null,
      },
      activeGrants: [
        {
          id: "grant-1",
          kind: "active_grant",
          status: "active",
          action: "grant",
          scope: "attr.financial.analytics.quality_metrics",
          counterpart_type: "developer",
          counterpart_label: "Planner Pro",
          expires_at: "2026-03-24T12:00:00Z",
        },
      ],
    });

    expect(access).toEqual([
      expect.objectContaining({
        requesterLabel: "Planner Pro",
        readableAccessLabel: "Can access Financial > Analytics > Quality Metrics.",
        coverageKind: "limited",
      }),
    ]);
  });
});
