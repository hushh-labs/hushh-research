import { describe, it, expect, vi, beforeEach } from "vitest";

// The module under test imports OneKycService and PKM services at module load.
// Mock them so the orchestrator can be imported in isolation.
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: { getStaleFirst: vi.fn() },
}));
vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: { saveMergedDomain: vi.fn() },
}));
vi.mock("@/lib/services/one-kyc-service", () => ({
  OneKycService: {
    extractDraft: vi.fn(async () => ({
      extracted: [{ scope: "attr.identity.name", label: "Full name", value: "Jane Doe" }],
      missing: [],
      draft: { subject: "Re: KYC", body: "My name is Jane Doe." },
    })),
  },
}));

import { OneKycClientZkService } from "@/lib/services/one-kyc-client-zk-service";
import type { OneKycWorkflow } from "@/lib/services/one-kyc-service";

describe("buildDraftViaLlm", () => {
  beforeEach(() => vi.clearAllMocks());

  it("assembles a KycDraftBuildResult from the Pass 2 response", async () => {
    const workflow = {
      workflow_id: "wf-1",
      subject: "KYC",
      requested_scope: "attr.identity.name",
    } as unknown as OneKycWorkflow;

    const result = await OneKycClientZkService.buildDraftViaLlm({
      workflow,
      input: { userId: "u1", vaultOwnerToken: "tok" },
      decryptedDomains: [
        { domain: "identity", scope: "attr.identity.name", data: { full_name: "Jane Doe" } },
      ],
      approvedScopes: ["attr.identity.name"],
      requestText: "Please share your full name.",
    });

    expect(result.body).toBe("My name is Jane Doe.");
    expect(result.approvedValues["attr.identity.name"]).toBe("Jane Doe");
    expect(result.htmlBody).toBeTruthy();
    expect(result.missingFields).toEqual([]);
  });
});
