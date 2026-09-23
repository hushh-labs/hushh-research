import { describe, expect, it } from "vitest";

import { buildPersonalKnowledgeModelStructureArtifacts } from "@/lib/personal-knowledge-model/manifest";
import { humanizeMemoryPath } from "@/lib/pkm/humanize-segment";

describe("PKM manifest heterogeneous array union", () => {
  it("maps surviving backend entity sensitivity without reviving stale entities or identifier labels", () => {
    const domainData = { preferences: { entities: { syntheticEntry: { summary: "synthetic" } } } };
    const concrete = "preferences.entities.syntheticentry.summary";
    const canonical = "preferences.entities._entities.summary";
    const source = buildPersonalKnowledgeModelStructureArtifacts({ domain: "professional", domainData }).manifest;
    source.paths = [{
      json_path: concrete, path_type: "leaf", exposure_eligibility: true,
      consent_label: humanizeMemoryPath("preferences.entities.syntheticEntry.summary"),
      sensitivity_label: "restricted",
    }];
    const result = buildPersonalKnowledgeModelStructureArtifacts({
      domain: "professional", domainData, semanticManifests: [source],
      semanticDecision: { target_domain: "professional", sensitivity_labels: {
        [concrete]: "restricted", "preferences.entities.removed.summary": "confidential",
      } },
    });
    expect(result.structureDecision.sensitivity_labels).toEqual({ [canonical]: "restricted" });
    expect(JSON.stringify(result)).not.toContain("syntheticentry");
    expect(JSON.stringify(result)).not.toContain("Synthetic Entry");
    expect(result.manifest.paths.find(path => path.json_path === canonical)?.consent_label)
      .toBe(humanizeMemoryPath(canonical));
    source.paths[0]!.consent_label = "A custom record-specific label";
    expect(() => buildPersonalKnowledgeModelStructureArtifacts({
      domain: "professional", domainData, semanticManifests: [source],
    })).toThrow("Memory metadata needs review");
  });

  it("does not silently choose between conflicting entity assessments", () => {
    expect(() => buildPersonalKnowledgeModelStructureArtifacts({
      domain: "professional",
      domainData: { preferences: { entities: { first: { summary: "one" }, second: { summary: "two" } } } },
      semanticDecision: { target_domain: "professional", sensitivity_labels: {
        "preferences.entities.first.summary": "restricted",
        "preferences.entities.second.summary": "confidential",
      } },
    })).toThrow("Memory metadata needs review");
  });

  it.each(["preferences.entities.first.summary", "preferences.entities._entities.summary"])(
    "does not let a partial sibling update downgrade prior %s sensitivity", (priorPath) => {
      const domainData = { preferences: { entities: { first: { summary: "one" }, second: { summary: "two" } } } };
      const previous = buildPersonalKnowledgeModelStructureArtifacts({ domain: "professional", domainData }).manifest;
      previous.paths = [{ json_path: priorPath, path_type: "leaf", exposure_eligibility: true, sensitivity_label: "restricted" }];
      expect(() => buildPersonalKnowledgeModelStructureArtifacts({
        domain: "professional", domainData, semanticManifests: [previous],
        semanticDecision: { target_domain: "professional", sensitivity_labels: {
          "preferences.entities.second.summary": "confidential",
        } },
      })).toThrow("Memory metadata needs review");
      if (priorPath.includes(".first.")) {
        const revised = buildPersonalKnowledgeModelStructureArtifacts({
          domain: "professional", domainData, semanticManifests: [previous],
          semanticDecision: { target_domain: "professional", sensitivity_labels: { [priorPath]: "confidential" } },
        });
        expect(revised.structureDecision.sensitivity_labels["preferences.entities._entities.summary"]).toBe("confidential");
      }
    },
  );
  it("copies semantic metadata only for matching surviving paths, never authority", () => {
    const source = buildPersonalKnowledgeModelStructureArtifacts({
      domain: "professional", domainData: { role: "old", removed: "old", changed: "leaf" },
    }).manifest;
    for (const path of source.paths) {
      path.consent_label = "Reviewed";
      path.sensitivity_label = "restricted";
      path.exposure_eligibility = false;
      path.scope_handle = "must-not-copy";
    }
    const domainData = { role: "new", changed: { nested: "new" } };
    const baseline = buildPersonalKnowledgeModelStructureArtifacts({ domain: "professional", domainData });
    const result = buildPersonalKnowledgeModelStructureArtifacts({
      domain: "professional", domainData, semanticManifests: [source],
      semanticDecision: { target_domain: "other", sensitivity_labels: { role: "wrong-domain" } },
    });
    const role = result.manifest.paths.find(path => path.json_path === "role")!;
    expect(role.consent_label).toBe("Reviewed");
    expect(role.sensitivity_label).toBe("restricted");
    expect(role.scope_handle).toBeUndefined();
    expect(result.manifest.externalizable_paths).toEqual(baseline.manifest.externalizable_paths);
    expect(result.manifest.paths.some(path => path.json_path === "removed")).toBe(false);
    expect(result.manifest.paths.find(path => path.json_path === "changed")?.consent_label).not.toBe("Reviewed");
    const wrongDomain = buildPersonalKnowledgeModelStructureArtifacts({
      domain: "professional", domainData, semanticManifests: [{ ...source, domain: "other" }],
    });
    expect(wrongDomain.manifest.paths).toEqual(baseline.manifest.paths);
    const invalid = buildPersonalKnowledgeModelStructureArtifacts({
      domain: "professional", domainData,
      semanticManifests: [{ ...source, paths: source.paths.map(path => ({ ...path, consent_label: " ", sensitivity_label: "" })) }],
      semanticDecision: { target_domain: "professional", sensitivity_labels: { role: null, changed: 5 } },
    });
    expect(invalid.manifest.paths).toEqual(baseline.manifest.paths);
  });

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
