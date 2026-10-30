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
  PKM_QUARANTINE_SEGMENT_ID,
  comparePkmSemanticVersions,
  currentDomainContractVersion,
} from "@/lib/personal-knowledge-model/upgrade-contracts";

const agentEntity = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  entity_id: id,
  kind: "note",
  summary: text,
  observations: [text],
  status: "active",
  ...extra,
});

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

  it("proves occurrence-level moves and equal-value deduplication", () => {
    const before = {
      old_profile: { risk: "balanced" },
      duplicate_risk: "balanced",
      flags: [false, 0, "", null],
      empty: {},
    };
    const after = {
      profile: { risk: "balanced" },
      flags: [false, 0, "", null],
      empty: {},
    };
    const validation = validateLosslessDomainUpgrade(before, after, [
      {
        sourcePointer: "/old_profile/risk",
        targetPointer: "/profile/risk",
        classification: "moved",
      },
      {
        sourcePointer: "/duplicate_risk",
        targetPointer: "/profile/risk",
        classification: "equal_value_deduplicated",
      },
    ]);

    expect(validation.preserved).toBe(true);
    expect(validation.receipt).toMatchObject({
      moved: 1,
      equalValueDeduplicated: 1,
      rejected: 0,
      complete: true,
    });
  });

  it("rejects changed types, values, and missing occurrences without losing falsy values", () => {
    const validation = validateLosslessDomainUpgrade(
      { false_value: false, zero_value: 0, empty_value: "", null_value: null },
      { false_value: 0, zero_value: 1, empty_value: "" }
    );

    expect(validation.preserved).toBe(false);
    expect(validation.receipt.rejected).toBe(3);
    expect(validation.issueCodes).toEqual(
      expect.arrayContaining([
        "source_occurrence_type_changed",
        "source_occurrence_value_changed",
        "source_occurrence_unmapped",
      ])
    );
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

  it("relocates agent entries only for domains that hold a reserved branch, without a version bump", () => {
    // Shipped builds refuse to write a domain stored at a newer version than
    // their own, so the relocation is recorded by a manifest marker instead.
    expect(currentDomainContractVersion("financial")).toBe(4);
    expect(currentDomainContractVersion("wallet")).toBe(4);
    expect(currentDomainContractVersion("food")).toBe(4);
    const financial = runDomainUpgrade({
      domain: "financial",
      domainData: { profile: { entities: { mem_eeeeeeeeeeee: agentEntity("mem_eeeeeeeeeeee", "index funds") } } },
      currentVersion: 4,
    });
    expect(financial.newDomainContractVersion).toBe(4);
    expect(financial.reservedMigration).toMatchObject({ moved: 1 });
    const food = {
      preferences: { entities: { mem_aaaaaaaaaaaa: agentEntity("mem_aaaaaaaaaaaa", "likes ramen") } },
    };
    const result = runDomainUpgrade({ domain: "food", domainData: food, currentVersion: 4 });
    expect(result.domainData).toEqual(food);
    expect(result.reservedMigration).toBeUndefined();
  });

  it("quarantines instead of moving when the sibling lives in another domain", () => {
    const wallet = {
      cards: {
        entities: { mem_bbbbbbbbbbbb: agentEntity("mem_bbbbbbbbbbbb", "card for travel") },
        summary: { count: 1 },
      },
    };
    const result = runDomainUpgrade({ domain: "wallet", domainData: wallet, currentVersion: 4 });
    expect(result.reservedMigration).toMatchObject({ moved: 0, quarantined: 1 });
    expect(result.reservedMigration?.items[0]?.reason).toBe("sibling_in_other_domain");
    expect(result.domainData).toEqual({
      cards: { summary: { count: 1 } },
      [PKM_QUARANTINE_SEGMENT_ID]: {
        reserved_branch_migration_v1: {
          "/cards/entities/mem_bbbbbbbbbbbb": {
            reason: "sibling_in_other_domain",
            source_pointer: "/cards/entities/mem_bbbbbbbbbbbb",
            value: wallet.cards.entities.mem_bbbbbbbbbbbb,
          },
        },
      },
    });
    expect(result.losslessValidation.receipt).toMatchObject({ complete: true, rejected: 0 });
  });

  it("never moves an agent-shaped entry that an app feature's writer label stamped", () => {
    const location = {
      saved_places: {
        entities: {
          mem_cccccccccccc: agentEntity("mem_cccccccccccc", "home pin", {
            source: "one_location_saved_place_confirm",
          }),
          mem_dddddddddddd: agentEntity("mem_dddddddddddd", "chat note", {
            source_agent: "pkm_structure_agent",
          }),
        },
      },
    };
    const result = runDomainUpgrade({ domain: "location", domainData: location, currentVersion: 4 });
    const reasons = Object.fromEntries(
      (result.reservedMigration?.items ?? []).map((item) => [item.sourcePointer, item.reason])
    );
    expect(reasons).toEqual({
      "/saved_places/entities/mem_cccccccccccc": "ambiguous_feature_provenance",
      "/saved_places/entities/mem_dddddddddddd": "agent_entity_id",
    });
    expect(
      (result.domainData.agent_memory as { entities: Record<string, unknown> }).entities
    ).toEqual({ mem_dddddddddddd: location.saved_places.entities.mem_dddddddddddd });
  });
});
