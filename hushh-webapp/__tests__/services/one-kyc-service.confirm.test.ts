import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/services/api-client", () => ({
  apiJson: vi.fn(async () => ({ workflow_id: "wf-1", status: "needs_scope" })),
}));

import { apiJson } from "@/lib/services/api-client";
import { OneKycService } from "@/lib/services/one-kyc-service";

describe("OneKycService.confirmProposal", () => {
  beforeEach(() => vi.clearAllMocks());

  it("POSTs approved_scopes to confirm-proposal", async () => {
    await OneKycService.confirmProposal({
      userId: "u1", vaultOwnerToken: "tok", workflowId: "wf-1",
      approvedScopes: ["attr.identity.name"],
    });
    expect(apiJson).toHaveBeenCalledWith(
      "/api/one/kyc/workflows/wf-1/confirm-proposal",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ user_id: "u1", approved_scopes: ["attr.identity.name"] }),
      }),
    );
  });
});
