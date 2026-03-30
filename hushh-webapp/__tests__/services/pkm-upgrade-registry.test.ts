import { describe, expect, it } from "vitest";

import {
  buildReadableUpgradeSummary,
  runDomainUpgrade,
} from "@/lib/personal-knowledge-model/upgrade-registry";

describe("pkm upgrade registry", () => {
  it("runs the financial contract upgrade chain deterministically", () => {
    const result = runDomainUpgrade({
      domain: "financial",
      domainData: {
        profile: {
          risk_score: 72,
        },
      },
      currentVersion: 1,
    });

    expect(result.newDomainContractVersion).toBe(2);
    expect(result.domainData).toEqual({
      profile: {
        risk_score: 72,
      },
    });
    expect(result.notes[0]).toContain("Financial");
  });

  it("builds a readable upgrade summary without exposing raw schema terms", () => {
    const readable = buildReadableUpgradeSummary({
      domain: "financial",
      domainSummary: {
        key: "financial",
        displayName: "Financial",
        icon: "wallet",
        color: "#123456",
        attributeCount: 4,
        summary: {},
        availableScopes: [],
        lastUpdated: null,
      },
      manifest: {
        domain: "financial",
        manifest_version: 2,
        summary_projection: {},
        top_level_scope_paths: ["analytics", "events"],
        externalizable_paths: [],
        paths: [],
      },
      upgradedAt: "2026-03-24T12:00:00Z",
      notes: ["Refreshed the Financial contract metadata for resumable PKM upgrades."],
    });

    expect(readable.readable_summary).toContain("financial data");
    expect(readable.readable_source_label).toBe("PKM Upgrade");
    expect(readable.readable_summary_version).toBe(1);
    expect(readable.readable_highlights.some((item) => item.includes("Analytics"))).toBe(true);
  });
});
