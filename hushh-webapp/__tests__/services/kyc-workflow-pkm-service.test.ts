import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: {
    saveMergedDomain: vi.fn(),
  },
}));

import {
  KycWorkflowPkmService,
  KYC_WORKFLOW_PKM_DOMAIN,
} from "@/lib/services/kyc-pkm-write-service";

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
});
