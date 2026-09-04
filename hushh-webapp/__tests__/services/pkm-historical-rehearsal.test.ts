import { describe, expect, it } from "vitest";

import { buildPersonalKnowledgeModelStructureArtifacts } from "@/lib/personal-knowledge-model/manifest";
import { runDomainUpgrade, validateLosslessDomainUpgrade } from "@/lib/personal-knowledge-model/upgrade-registry";
import { currentDomainContractVersion } from "@/lib/personal-knowledge-model/upgrade-contracts";
import { decryptData, encryptData } from "@/lib/vault/encrypt";
import corpusJson from "../fixtures/pkm/historical-corpus.v1.json";

type Fixture = {
  id: string;
  stored_domain_contract_version: number;
  domain: string;
  data: Record<string, unknown>;
};

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
      expect(validateLosslessDomainUpgrade(decryptedOld, transformed.domainData).preserved).toBe(
        true
      );

      const manifest = buildPersonalKnowledgeModelStructureArtifacts({
        domain: fixture.domain,
        domainData: transformed.domainData,
      }).manifest;
      expect(manifest.paths.length).toBeGreaterThan(0);

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
});
