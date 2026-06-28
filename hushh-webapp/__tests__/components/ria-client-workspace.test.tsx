import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RiaClientWorkspace } from "@/components/ria/ria-client-workspace";
import {
  buildKaiTestClientDetail,
  buildKaiTestClientWorkspace,
  RIA_KAI_SPECIALIZED_TEMPLATE_ID,
} from "@/components/ria/ria-client-test-profile";
import { useRiaClientWorkspaceState } from "@/components/ria/use-ria-client-workspace-state";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
  }),
}));

vi.mock("@/components/ria/use-ria-client-workspace-state", () => ({
  useRiaClientWorkspaceState: vi.fn(),
}));

vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: vi.fn(),
}));

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
    it("preserves client id propagation across detail and workspace payloads", () => {
    const clientId = "client-empty-state";

    const detail = buildKaiTestClientDetail(clientId);
    const workspace = buildKaiTestClientWorkspace(clientId);

    expect(detail.investor_user_id).toBe(clientId);
    expect(workspace.investor_user_id).toBe(clientId);
    expect(workspace.account_branches).toHaveLength(detail.account_branches.length);
  });
});

describe("RiaClientWorkspace", () => {
  it("covers no linked accounts fallback", () => {
    vi.mocked(useRiaClientWorkspaceState).mockReturnValue({
      user: { uid: "advisor-1" },
      riaCapability: "active",
      personaLoading: false,
      detail: {
        investor_user_id: "client-1",
        investor_display_name: "Investor One",
        investor_email: "investor@example.com",
        investor_secondary_label: null,
        investor_headline: null,
        relationship_status: "active",
        is_self_relationship: true,
        granted_scopes: [],
        account_branches: [],
        request_history: [],
        available_scope_metadata: [],
        requestable_scope_templates: [],
        kai_specialized_bundle: null,
      },
      workspace: null,
      loading: false,
      detailError: null,
      iamUnavailable: false,
      isTestProfile: false,
      refreshWorkspace: vi.fn(),
    } as unknown as ReturnType<typeof useRiaClientWorkspaceState>);

    render(<RiaClientWorkspace clientId="client-1" initialTab="overview" />);

    expect(screen.getByText("Accounts")).toBeTruthy();
    expect(screen.getByText("No linked accounts discovered yet.")).toBeTruthy();
  });
});
