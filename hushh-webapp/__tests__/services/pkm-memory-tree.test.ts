import { describe, expect, it } from "vitest";

import {
  buildPkmMemoryTree,
  buildPkmShareBundles,
  pkmShareBundleState,
} from "@/lib/profile/pkm-memory-tree";

/**
 * Synthetic fixture only. It represents the nested finance/debate shape the
 * product must handle without reading a person's encrypted vault.
 */
const SAMPLE_PKM_CARDS = [
  {
    id: "finance-1",
    domain: "financial",
    domainTitle: "Financial",
    title: "Risk profile: balanced",
    detail: "Profile › Risk profile",
    value: "balanced",
    valueFingerprint: "a",
    path: "profile.risk_profile",
    pathSegments: ["profile", "risk_profile"],
    sourceLabel: "",
    updatedAt: null,
    confidence: 1,
    kind: "financial" as const,
    editable: true,
    searchText: "",
  },
  {
    id: "finance-2",
    domain: "financial",
    domainTitle: "Financial",
    title: "Decision: hold",
    detail: "Analysis › Decisions › AAPL",
    value: "hold",
    valueFingerprint: "b",
    path: "analysis.decisions.aapl",
    pathSegments: ["analysis", "decisions", "aapl"],
    sourceLabel: "",
    updatedAt: null,
    confidence: 1,
    kind: "financial" as const,
    editable: true,
    searchText: "",
  },
];

describe("Memory tree and sharing presentation", () => {
  it("keeps a realistic nested PKM fixture collapsed into folders", () => {
    const tree = buildPkmMemoryTree(SAMPLE_PKM_CARDS);

    expect(tree.map((node) => node.label)).toEqual(["Analysis", "Profile"]);
    expect(tree[0]?.children[0]?.label).toBe("Decisions");
    expect(tree[1]?.children[0]?.card?.id).toBe("finance-1");
  });

  it("offers only materialized top-level consent bundles and derives tri-state", () => {
    const bundles = buildPkmShareBundles({
      domain: "financial",
      manifest_version: 3,
      summary_projection: {},
      top_level_scope_paths: ["portfolio", "analysis_history", "profile"],
      externalizable_paths: [],
      paths: [],
      scope_registry: [
        {
          scope_handle: "portfolio",
          scope_label: "Portfolio",
          segment_ids: [],
          exposure_enabled: true,
          visibility_posture: "consent_required",
          summary_projection: {
            top_level_scope_path: "portfolio",
            materialization_state: "materialized",
            materialized_leaf_count: 2,
          },
        },
        {
          scope_handle: "profile",
          scope_label: "Profile",
          segment_ids: [],
          exposure_enabled: false,
          visibility_posture: "private",
          summary_projection: {
            top_level_scope_path: "profile",
            materialization_state: "materialized",
            materialized_leaf_count: 1,
          },
        },
        {
          scope_handle: "empty-history",
          scope_label: "Analysis history",
          segment_ids: [],
          summary_projection: {
            top_level_scope_path: "analysis_history",
            materialization_state: "empty",
            materialized_leaf_count: 0,
          },
        },
      ],
    });

    expect(bundles.map((bundle) => bundle.topLevelScopePath)).toEqual(["portfolio", "profile"]);
    expect(pkmShareBundleState(bundles)).toBe("indeterminate");
  });
});
