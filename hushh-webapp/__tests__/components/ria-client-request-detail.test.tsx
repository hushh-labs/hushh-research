import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RiaClientRequestDetail } from "@/components/ria/ria-client-request-detail";
import { useRiaClientWorkspaceState } from "@/components/ria/use-ria-client-workspace-state";

vi.mock("@/components/ria/use-ria-client-workspace-state", () => ({
  useRiaClientWorkspaceState: vi.fn(),
}));

vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: vi.fn(),
}));

describe("RiaClientRequestDetail", () => {
  it("covers request metadata fallback", () => {
    vi.mocked(useRiaClientWorkspaceState).mockReturnValue({
      user: { uid: "advisor-1" },
      riaCapability: "active",
      personaLoading: false,
      detail: {
        investor_user_id: "client-1",
        investor_display_name: "Investor One",
        investor_email: "investor@example.com",
        relationship_status: null,
        granted_scopes: [],
        account_branches: [],
        request_history: [
          {
            request_id: "request-1",
            action: null,
            scope: "",
            scope_metadata: null,
            bundle_label: "",
            issued_at: null,
            expires_at: "not-a-date",
          },
        ],
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

    render(
      <RiaClientRequestDetail clientId="client-1" requestId="request-1" />,
    );

    expect(screen.getByRole("heading", { name: "Request" })).toBeTruthy();
    expect(screen.getByText("Direct request")).toBeTruthy();
    expect(screen.getByText("No bundle metadata")).toBeTruthy();
    expect(screen.getByText("request-1")).toBeTruthy();
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThanOrEqual(2);
  });
});
