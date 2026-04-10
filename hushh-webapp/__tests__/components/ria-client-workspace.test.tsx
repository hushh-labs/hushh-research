import { describe, expect, it } from "vitest";

import {
  buildKaiTestClientDetail,
  buildKaiTestClientWorkspace,
  RIA_KAI_SPECIALIZED_TEMPLATE_ID,
} from "@/components/ria/ria-client-test-profile";

describe("RIA client test profile builders", () => {
  it("produces a stable Kai-specialized advisor workspace payload", () => {
    const clientId = "s3xmA4lNSAQFrIaOytnSGAOzXlL2";
    const detail = buildKaiTestClientDetail(clientId);
    const workspace = buildKaiTestClientWorkspace(clientId);

    expect(detail.investor_user_id).toBe(clientId);
    expect(detail.investor_display_name).toBe("Kai Test User");
    expect(detail.kai_specialized_bundle?.template_id).toBe(RIA_KAI_SPECIALIZED_TEMPLATE_ID);
    expect(detail.requestable_scope_templates[0]?.template_id).toBe(RIA_KAI_SPECIALIZED_TEMPLATE_ID);
    expect(detail.request_history[0]?.bundle_id).toBe("ria_kai_specialized");
    expect(detail.account_branches).toHaveLength(2);
    expect(detail.available_scope_metadata.map((scope) => scope.scope)).toEqual(
      expect.arrayContaining([
        "attr.financial.portfolio.*",
        "attr.financial.profile.*",
        "attr.financial.analysis_history.*",
        "attr.financial.runtime.*",
      ])
    );

    expect(workspace.investor_user_id).toBe(clientId);
    expect(workspace.workspace_ready).toBe(true);
    expect(workspace.kai_specialized_bundle?.status).toBe("active");
    expect(workspace.account_branches.map((branch) => branch.branch_id)).toEqual(
      detail.account_branches.map((branch) => branch.branch_id)
    );
    expect(workspace.domain_summaries.financial).toMatchObject({
      holdings_count: 8,
      risk_profile: "Moderate",
      account_count: 2,
    });
  });
});
