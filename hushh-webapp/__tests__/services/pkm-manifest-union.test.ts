import { describe, expect, it } from "vitest";

import { buildPersonalKnowledgeModelStructureArtifacts } from "@/lib/personal-knowledge-model/manifest";

describe("PKM manifest heterogeneous array union", () => {
  it("distinguishes reserved empty shapes from materialized information", () => {
    const { manifest } = buildPersonalKnowledgeModelStructureArtifacts({
      domain: "financial",
      domainData: {
        portfolio: {},
        preferences: { enabled: false, target: "", notes: null },
        positions: [{ symbol: "AAPL" }],
        metadata: { source: "must-not-count" },
      },
    });

    expect(manifest.summary_projection.scope_materialization).toEqual({
      portfolio: { state: "empty", materialized_leaf_count: 0 },
      preferences: { state: "materialized", materialized_leaf_count: 1 },
      positions: { state: "materialized", materialized_leaf_count: 1 },
    });
  });

  it("records paths from every array item instead of sampling the first shape", () => {
    const { manifest } = buildPersonalKnowledgeModelStructureArtifacts({
      domain: "financial",
      domainData: {
        accounts: [
          { account_id: "acct-1", holdings: [{ security_id: "sec-1" }] },
          { account_id: "acct-2", institution: { name: "Broker Two" } },
          null,
          "legacy-marker",
        ],
      },
    });
    const paths = new Map(manifest.paths.map((path) => [path.json_path, path]));

    expect([...paths.keys()]).toEqual(
      expect.arrayContaining([
        "accounts",
        "accounts._items",
        "accounts._items.account_id",
        "accounts._items.holdings",
        "accounts._items.holdings._items.security_id",
        "accounts._items.institution",
        "accounts._items.institution.name",
      ])
    );
    expect(paths.get("accounts._items")?.exposure_eligibility).toBe(false);
    expect(paths.get("accounts._items.institution.name")?.segment_id).toBe("accounts");
  });

  it("preserves nested heterogeneous arrays and empty/null/falsy shapes", () => {
    const { manifest } = buildPersonalKnowledgeModelStructureArtifacts({
      domain: "custom_memory",
      domainData: {
        groups: [
          [{ label: "first" }],
          [{ score: 0, enabled: false, note: "", missing: null }],
          [],
        ],
      },
    });
    const paths = manifest.paths.map((path) => path.json_path);

    expect(paths).toEqual(
      expect.arrayContaining([
        "groups._items._items.label",
        "groups._items._items.score",
        "groups._items._items.enabled",
        "groups._items._items.note",
        "groups._items._items.missing",
      ])
    );
  });

  it("keeps leaf exposure stable when an empty occurrence precedes a populated one", () => {
    const build = (accounts: unknown[]) =>
      buildPersonalKnowledgeModelStructureArtifacts({
        domain: "financial",
        domainData: { accounts },
      }).manifest;

    const firstEmpty = build([{ profile: { professional: null } }, { profile: { professional: "Engineer" } }]);
    const firstPopulated = build([{ profile: { professional: "Engineer" } }, { profile: { professional: null } }]);
    const path = "accounts._items.profile.professional";

    expect(firstEmpty.paths.find((item) => item.json_path === path)?.exposure_eligibility).toBe(true);
    expect(firstPopulated.paths.find((item) => item.json_path === path)?.exposure_eligibility).toBe(true);
    expect(firstEmpty.externalizable_paths).toContain(path);
    expect(firstPopulated.externalizable_paths).toContain(path);
  });

  it("unions entity-map materialization without exposing entity identifiers", () => {
    const { manifest } = buildPersonalKnowledgeModelStructureArtifacts({
      domain: "professional",
      domainData: {
        entities: {
          first: { title: null },
          second: { title: "Staff engineer" },
        },
      },
    });
    const path = "entities._entities.title";

    expect(manifest.externalizable_paths).toContain(path);
    expect(manifest.externalizable_paths.some((item) => item.includes("first") || item.includes("second"))).toBe(false);
  });
});
