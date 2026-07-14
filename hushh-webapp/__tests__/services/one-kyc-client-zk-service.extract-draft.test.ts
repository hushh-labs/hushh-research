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
import { OneKycService } from "@/lib/services/one-kyc-service";
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

  it("forwards ALL decryptedDomains as the domains array to extractDraft", async () => {
    const workflow = {
      workflow_id: "wf-multi",
      subject: "KYC + Portfolio",
      requested_scope: "attr.identity.*",
    } as unknown as OneKycWorkflow;

    await OneKycClientZkService.buildDraftViaLlm({
      workflow,
      input: { userId: "u1", vaultOwnerToken: "tok" },
      decryptedDomains: [
        { domain: "identity", scope: "attr.identity.*", data: { full_name: "Jane Doe" } },
        { domain: "financial", scope: "attr.financial.portfolio.*", data: { portfolio: { value: 500000 } } },
      ],
      approvedScopes: ["attr.identity.*", "attr.financial.portfolio.*"],
      requestText: "Please share your identity and portfolio details.",
    });

    // extractDraft must have been called once with a domains array of length 2
    expect(OneKycService.extractDraft).toHaveBeenCalledTimes(1);
    const callArgs = (OneKycService.extractDraft as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.domains).toBeDefined();
    expect(callArgs.domains).toHaveLength(2);
    expect(callArgs.domains[0].domain).toBe("identity");
    expect(callArgs.domains[1].domain).toBe("financial");
  });
});
