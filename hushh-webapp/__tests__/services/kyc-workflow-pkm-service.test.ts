import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: {
    saveMergedDomain: vi.fn(),
  },
}));

import {
  buildKycWorkflowArtifact,
  hashKycWorkflowArtifact,
  KycWorkflowPkmService,
  KYC_WORKFLOW_PKM_DOMAIN,
  mergeKycWorkflowArtifact,
} from "@/lib/services/kyc-pkm-write-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";

describe("KycWorkflowPkmService", () => {
  it("uses a workflow namespace instead of a canonical kyc fact domain", () => {
    expect(KYC_WORKFLOW_PKM_DOMAIN).toBe("kyc_workflow");
  });

  it("returns empty state when no workflow artifact exists", () => {
    expect(KycWorkflowPkmService.readWorkflowArtifact(null)).toEqual({
      found: false,
      artifact: null,
    });
    expect(KycWorkflowPkmService.readWorkflowArtifact({})).toEqual({
      found: false,
      artifact: null,
    });
  });

  it("reads KYC workflow state without treating it as canonical identity storage", () => {
    const result = KycWorkflowPkmService.readWorkflowArtifact({
      checks: {
        identity: {
          status: "verified",
          updated_at: "2026-04-20T00:00:00.000Z",
          method: "document_review",
          source_domain: "identity",
        },
        address: {
          status: "pending",
          updated_at: null,
          method: null,
          source_domain: "address",
        },
      },
      counterparty: "example fund admin",
      request_summary: "Missing proof of address",
      pending_requirements: ["proof_of_address"],
      completed_requirements: ["identity_document"],
      overall_status: "pending",
      last_updated: "2026-04-20T00:00:00.000Z",
    });

    expect(result.found).toBe(true);
    expect(result.artifact?.checks.identity.status).toBe("verified");
    expect(result.artifact?.checks.identity.source_domain).toBe("identity");
    expect(result.artifact?.checks.address.status).toBe("pending");
    expect(result.artifact?.checks.bank.status).toBe("not_started");
    expect(result.artifact?.pending_requirements).toEqual(["proof_of_address"]);
    expect(result.artifact).not.toHaveProperty("email.address");
  });

  it("hashes the approved artifact and preserves existing workflow checks during PKM merge", async () => {
    const artifact = buildKycWorkflowArtifact(
      {
        checks: {
          identity: {
            status: "verified",
            updated_at: "2026-05-06T00:00:00.000Z",
            method: "one_email_kyc_consent_export",
            source_domain: "identity",
          },
          address: {
            status: "not_started",
            updated_at: null,
            method: null,
            source_domain: null,
          },
          bank: {
            status: "not_started",
            updated_at: null,
            method: null,
            source_domain: null,
          },
          email: {
            status: "not_started",
            updated_at: null,
            method: null,
            source_domain: null,
          },
        },
        overall_status: "verified",
        counterparty: "broker",
        request_summary: "KYC request",
        pending_requirements: [],
        completed_requirements: ["legal_name"],
      },
      "2026-05-06T00:00:01.000Z"
    );
    const expectedHash = await hashKycWorkflowArtifact(artifact);
    const existingDomainData = {
      checks: {
        address: {
          status: "verified",
          updated_at: "2026-05-05T00:00:00.000Z",
          method: "existing_address_review",
          source_domain: "address",
        },
      },
      overall_status: "pending",
      counterparty: "existing broker",
      request_summary: "Existing request",
      pending_requirements: [],
      completed_requirements: ["proof_of_address"],
      last_updated: "2026-05-05T00:00:00.000Z",
      schema_version: 1,
    };
    let writtenArtifact: Record<string, unknown> | null = null;

    (PkmWriteCoordinator.saveMergedDomain as Mock).mockImplementationOnce(async (params) => {
      const plan = await params.build({
        currentDomainData: existingDomainData,
        currentManifest: null,
        currentEncryptedDomain: null,
        baseFullBlob: {},
        attempt: 0,
        upgradedInSession: false,
      });
      writtenArtifact = plan.domainData;
      return {
        saveState: "saved",
        success: true,
        fullBlob: {},
      };
    });

    await KycWorkflowPkmService.writeWorkflowArtifact({
      userId: "user_1",
      vaultKey: "vault",
      vaultOwnerToken: "token",
      artifact,
    });

    const expectedMerged = mergeKycWorkflowArtifact(
      artifact,
      KycWorkflowPkmService.readWorkflowArtifact(existingDomainData).artifact
    );
    expect(writtenArtifact).toEqual(expectedMerged);
    expect(expectedMerged.checks.identity).toEqual(artifact.checks.identity);
    expect(expectedMerged.checks.address.status).toBe("verified");
    expect(expectedMerged.checks.address.method).toBe("existing_address_review");
    expect(await hashKycWorkflowArtifact(artifact)).toBe(expectedHash);
  });
});
