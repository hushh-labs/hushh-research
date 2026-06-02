import { describe, expect, it } from "vitest";

import {
  inferPkmDomainCompatibility,
  runDomainUpgrade,
} from "@/lib/personal-knowledge-model/upgrade-registry";
import {
  comparePkmSemanticVersions,
  currentDomainContractVersion,
} from "@/lib/personal-knowledge-model/upgrade-contracts";

describe("runDomainUpgrade", () => {
  it("treats unversioned data as a bootstrap into the current PKM contract", () => {
    const result = runDomainUpgrade({
      domain: "financial",
      domainData: {
        portfolio: {
          entities: {
            demo: {
              holdings: [{ symbol: "AAPL" }],
            },
          },
        },
      },
      currentVersion: 0,
    });

    expect(result.domainData).toEqual({
      portfolio: {
        entities: {
          demo: {
            holdings: [{ symbol: "AAPL" }],
          },
        },
      },
    });
    expect(result.newDomainContractVersion).toBe(2);
    expect(result.pkmContractVersion).toBe("4.1.0");
    expect(result.capabilitiesApplied).toContain("encrypted_payload_structure");
    expect(result.notes[0]).toContain("Personal Knowledge Model contract");
  });

  it("uses the generic dynamic target for unknown domains", () => {
    const result = runDomainUpgrade({
      domain: "custom_music",
      domainData: {
        preferences: {
          entities: {
            genre_1: { summary: "Likes ambient music" },
          },
        },
      },
      currentVersion: 1,
      manifest: {
        domain: "custom_music",
        manifest_version: 1,
        summary_projection: {
          readable_summary: "Your custom music memory is ready.",
          consumer_visible: true,
          consumer_item_count: 1,
        },
        top_level_scope_paths: ["preferences"],
        externalizable_paths: ["preferences.entities.genre_1.summary"],
        paths: [{ json_path: "preferences", path_type: "object", exposure_eligibility: true }],
        scope_registry: [
          {
            scope_handle: "s_music",
            scope_label: "Preferences",
            segment_ids: ["preferences"],
            summary_projection: { consumer_visible: true },
          },
        ],
      },
    });

    expect(currentDomainContractVersion("custom_music")).toBe(2);
    expect(result.newDomainContractVersion).toBe(2);
    expect(result.capabilitiesApplied).toEqual(
      expect.arrayContaining([
        "manifest_normalization",
        "readable_summary",
        "scope_registry",
        "consumer_projection",
        "semantic_counts",
        "entity_maps",
      ])
    );
  });

  it("compares semantic versions without decimal-number traps", () => {
    expect(comparePkmSemanticVersions("4.10.0", "4.2.0")).toBe(1);
    expect(comparePkmSemanticVersions("4.1.0", "4.1.0")).toBe(0);
    expect(comparePkmSemanticVersions("4.1.0", "5.0.0")).toBe(-1);
  });

  it("reports manifest blockers without depending on hardcoded domain keys", () => {
    const compatibility = inferPkmDomainCompatibility({
      domainData: { profile: { entities: {} } },
      manifest: null,
    });

    expect(compatibility.blockedReasons).toContain("missing_manifest");
    expect(compatibility.capabilities).toContain("encrypted_payload_structure");
  });
});
