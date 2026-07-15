import { describe, expect, it } from "vitest";

import {
  PkmFutureVersionError,
  buildReadableUpgradeSummary,
  extractKnownPkmSourceLabel,
  inferPkmDomainCompatibility,
  runDomainUpgrade,
  validateLosslessDomainUpgrade,
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
    expect(result.newDomainContractVersion).toBe(4);
    expect(result.pkmContractVersion).toBe("6.0.0");
    expect(result.losslessValidation.preserved).toBe(true);
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

    expect(currentDomainContractVersion("custom_music")).toBe(4);
    expect(result.newDomainContractVersion).toBe(4);
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

  it("fails closed instead of downgrading a future domain contract", () => {
    expect(() =>
      runDomainUpgrade({
        domain: "financial",
        domainData: { profile: { risk: "balanced" } },
        currentVersion: currentDomainContractVersion("financial") + 1,
      })
    ).toThrow(PkmFutureVersionError);
  });

  it("fails closed for future semantic and readable contracts", () => {
    expect(() =>
      runDomainUpgrade({
        domain: "financial",
        domainData: { profile: { risk: "balanced" } },
        currentVersion: currentDomainContractVersion("financial"),
        manifest: {
          domain: "financial",
          manifest_version: 1,
          pkm_contract_version: "7.0.0",
          readable_projection_version: "7.0.0",
          summary_projection: {},
          top_level_scope_paths: [],
          externalizable_paths: [],
          paths: [],
        },
      })
    ).toThrow(PkmFutureVersionError);
  });

  it("detects dropped unknown fields and array reordering without exposing values", () => {
    const before = {
      unknown_extension: { opaque_setting: "preserve-me" },
      ordered: [{ id: "first" }, { id: "second" }],
    };
    const dropped = validateLosslessDomainUpgrade(before, {
      ordered: [{ id: "first" }, { id: "second" }],
    });
    const reordered = validateLosslessDomainUpgrade(before, {
      unknown_extension: { opaque_setting: "preserve-me" },
      ordered: [{ id: "second" }, { id: "first" }],
    });

    expect(dropped.preserved).toBe(false);
    expect(dropped.issueCodes).toContain("field_dropped");
    expect(reordered.preserved).toBe(false);
    expect(reordered.issueCodes).toContain("leaf_changed");
    expect(JSON.stringify(reordered)).not.toContain("preserve-me");
  });

  it("maps only known encrypted machine sources to a coarse friendly label", () => {
    const domainData = {
      profile: {
        source: "financial_profile_sync",
        private_note: "never expose this",
      },
    };
    expect(extractKnownPkmSourceLabel(domainData)).toBe("Finance setup");
    const readable = buildReadableUpgradeSummary({
      domain: "financial",
      domainData,
    });
    expect(readable.readable_source_label).toBe("Finance setup");
    expect(JSON.stringify(readable)).not.toContain("financial_profile_sync");
    expect(JSON.stringify(readable)).not.toContain("never expose this");

    expect(
      buildReadableUpgradeSummary({
        domain: "custom",
        domainData: { source: "unknown_private_source" },
      }).readable_source_label
    ).toBeNull();
  });
});
