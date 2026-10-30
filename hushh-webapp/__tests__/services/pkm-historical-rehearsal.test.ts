import { describe, expect, it } from "vitest";

import { buildPersonalKnowledgeModelStructureArtifacts } from "@/lib/personal-knowledge-model/manifest";
import { runDomainUpgrade, validateLosslessDomainUpgrade } from "@/lib/personal-knowledge-model/upgrade-registry";
import {
  PKM_QUARANTINE_SEGMENT_ID,
  currentDomainContractVersion,
} from "@/lib/personal-knowledge-model/upgrade-contracts";
import { relocateAgentEntriesFromReservedBranches } from "@/lib/personal-knowledge-model/reserved-branch-migration";
import { decryptData, encryptData } from "@/lib/vault/encrypt";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import corpusJson from "../fixtures/pkm/historical-corpus.v1.json";

type Fixture = {
  id: string;
  stored_domain_contract_version: number;
  domain: string;
  data: Record<string, unknown>;
  expected_reserved_migration?: {
    moved: number;
    deduplicated: number;
    quarantined: number;
    reindexedOccurrences: number;
  };
  expect_unchanged?: boolean;
};

const REMOVED = Symbol("removed");

/** The stored data with exactly the relocated nodes taken out: the app-only view. */
function withoutPointers(data: Record<string, unknown>, pointers: string[]): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  for (const pointer of pointers) {
    const segments = pointer.split("/").slice(1).map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    let parent: unknown = copy;
    for (const segment of segments.slice(0, -1)) parent = (parent as Record<string, unknown>)[segment];
    (parent as Record<string, unknown>)[segments[segments.length - 1]!] = REMOVED;
  }
  const compact = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.filter((item) => item !== REMOVED).map(compact);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, child]) => child !== REMOVED)
          .map(([key, child]) => [key, compact(child)])
      );
    }
    return value;
  };
  return compact(copy) as Record<string, unknown>;
}

/** Top-level branches that carry an exposable leaf: what a canonical scope can name. */
function exposedTopLevelScopes(paths: string[]): Set<string> {
  return new Set(paths.map((path) => path.split(".")[0] ?? "").filter(Boolean));
}

const corpus = corpusJson as {
  schema_version: string;
  fixtures: Fixture[];
};
const vaultKey = "11".repeat(32);

describe("mandatory PKM historical rehearsal", () => {
  it("contains a versioned fixture for every supported stored domain contract", () => {
    expect(corpus.schema_version).toBe("pkm_historical_fixture_corpus.v1");
    expect(new Set(corpus.fixtures.map((fixture) => fixture.stored_domain_contract_version))).toEqual(
      new Set([0, 1, 2, 3, 4])
    );
  });

  for (const fixture of corpus.fixtures) {
    it(`${fixture.id}: decrypts, proves, encrypts, compares, and restores`, async () => {
      const originalJson = JSON.stringify(fixture.data);
      const archivedCiphertext = await encryptData(originalJson, vaultKey);
      const decryptedOld = JSON.parse(
        await decryptData(archivedCiphertext, vaultKey)
      ) as Record<string, unknown>;

      const transformed = runDomainUpgrade({
        domain: fixture.domain,
        domainData: decryptedOld,
        currentVersion: fixture.stored_domain_contract_version,
      });
      expect(transformed.losslessValidation.receipt).toMatchObject({
        schemaVersion: "pkm_preservation_receipt.v1",
        complete: true,
        rejected: 0,
      });
      expect(
        validateLosslessDomainUpgrade(decryptedOld, transformed.domainData, transformed.lineage).preserved
      ).toBe(true);
      // Negative control: a relocation without its lineage is indistinguishable
      // from loss, and the proof says so.
      if (transformed.lineage.length > 0) {
        expect(validateLosslessDomainUpgrade(decryptedOld, transformed.domainData).preserved).toBe(false);
      }

      const manifest = buildPersonalKnowledgeModelStructureArtifacts({
        domain: fixture.domain,
        domainData: transformed.domainData,
      }).manifest;
      expect(manifest.paths.length).toBeGreaterThan(0);

      // Canonical scopes: nothing a person could already share disappears,
      // and the quarantine is never offered.
      const before = buildPersonalKnowledgeModelStructureArtifacts({
        domain: fixture.domain,
        domainData: decryptedOld,
      }).manifest;
      const afterScopes = exposedTopLevelScopes(manifest.externalizable_paths);
      for (const scope of exposedTopLevelScopes(before.externalizable_paths)) {
        expect(afterScopes.has(scope)).toBe(true);
      }
      // App branches: exactly what was there minus exactly what the report moved.
      const outsideMigrationTargets = (path: string) =>
        !path.startsWith("agent_memory") && !path.startsWith(PKM_QUARANTINE_SEGMENT_ID);
      const appOnlyBefore = buildPersonalKnowledgeModelStructureArtifacts({
        domain: fixture.domain,
        domainData: withoutPointers(
          decryptedOld,
          (transformed.reservedMigration?.items ?? []).map((item) => item.sourcePointer)
        ),
      }).manifest;
      expect(manifest.externalizable_paths.filter(outsideMigrationTargets)).toEqual(
        appOnlyBefore.externalizable_paths.filter(outsideMigrationTargets)
      );
      expect(afterScopes.has(PKM_QUARANTINE_SEGMENT_ID)).toBe(false);
      expect(
        manifest.paths.filter((path) => path.json_path.startsWith(PKM_QUARANTINE_SEGMENT_ID))
          .every((path) => path.exposure_eligibility === false)
      ).toBe(true);

      if (fixture.expected_reserved_migration) {
        const report = transformed.reservedMigration;
        expect(report).toBeDefined();
        expect({
          moved: report?.moved,
          deduplicated: report?.deduplicated,
          quarantined: report?.quarantined,
          reindexedOccurrences: report?.reindexedOccurrences,
        }).toEqual(fixture.expected_reserved_migration);
        const receipt = transformed.losslessValidation.receipt;
        expect(receipt.moved).toBe((report?.movedOccurrences ?? 0) + (report?.reindexedOccurrences ?? 0));
        expect(receipt.quarantined).toBe(report?.quarantinedOccurrences);
        expect(receipt.equalValueDeduplicated).toBe(report?.deduplicatedOccurrences);
        expect(receipt.preserved + receipt.moved + receipt.equalValueDeduplicated + receipt.quarantined).toBe(
          receipt.totalSourceOccurrences
        );
        // The step is idempotent on its own output, not only behind the version gate.
        const again = relocateAgentEntriesFromReservedBranches({
          domain: fixture.domain,
          domainData: transformed.domainData,
        });
        expect(again.domainData).toEqual(transformed.domainData);
        expect(again.lineage).toEqual([]);
      }
      if (fixture.expect_unchanged) {
        expect(transformed.domainData).toEqual(fixture.data);
      }

      const nextCiphertext = await encryptData(
        JSON.stringify(transformed.domainData),
        vaultKey
      );
      const decryptedNew = JSON.parse(
        await decryptData(nextCiphertext, vaultKey)
      ) as Record<string, unknown>;
      expect(decryptedNew).toEqual(transformed.domainData);

      const idempotent = runDomainUpgrade({
        domain: fixture.domain,
        domainData: decryptedNew,
        currentVersion: currentDomainContractVersion(fixture.domain),
        manifest,
      });
      expect(idempotent.domainData).toEqual(decryptedNew);
      expect(idempotent.losslessValidation.receipt.complete).toBe(true);

      const rolledBack = JSON.parse(
        await decryptData(archivedCiphertext, vaultKey)
      ) as Record<string, unknown>;
      expect(rolledBack).toEqual(fixture.data);
    });
  }

  it("stores the quarantine as its own private segment and reads it back under the same key", async () => {
    const fixture = corpus.fixtures.find((entry) => entry.id === "v4_professional_profile_mixed")!;
    const upgraded = runDomainUpgrade({
      domain: fixture.domain,
      domainData: fixture.data,
      currentVersion: fixture.stored_domain_contract_version,
    }).domainData;
    expect(upgraded[PKM_QUARANTINE_SEGMENT_ID]).toBeDefined();

    // The server requires a segment spelled exactly `__quarantine_v1` for an
    // upgrade that quarantined anything (migration 098). Before Phase 2 the
    // client stripped the underscores and the key came back renamed.
    const service = PersonalKnowledgeModelService as unknown as {
      partitionDomainDataIntoSegments(data: Record<string, unknown>): Record<string, unknown>;
      decryptDomainBlob(params: {
        vaultKey: string;
        domain: string;
        blob: { ciphertext: string; iv: string; tag: string; segments: Record<string, unknown> };
      }): Promise<Record<string, unknown>>;
    };
    const partitioned = service.partitionDomainDataIntoSegments(upgraded);
    expect(Object.keys(partitioned)).toContain(PKM_QUARANTINE_SEGMENT_ID);
    const segments: Record<string, unknown> = {};
    for (const [segmentId, value] of Object.entries(partitioned)) {
      segments[segmentId] = { ...(await encryptData(JSON.stringify(value), vaultKey)), algorithm: "aes-256-gcm" };
    }
    const whole = await encryptData(JSON.stringify(upgraded), vaultKey);
    const readBack = await service.decryptDomainBlob({
      vaultKey,
      domain: fixture.domain,
      blob: { ciphertext: whole.ciphertext, iv: whole.iv, tag: whole.tag, segments },
    });
    expect(readBack).toEqual(upgraded);
  });
});
