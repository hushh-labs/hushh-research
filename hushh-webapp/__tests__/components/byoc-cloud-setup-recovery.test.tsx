import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiService } from "@/lib/services/api-service";
import { ByocCloudSetupPage } from "@/components/connections/byoc-cloud-setup-page";

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({ user: { uid: "owner" }, loading: false }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("intent=migrate"),
}));
vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: () => undefined,
}));
vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    getCachedBootstrapState: () => null,
    bootstrapState: () => new Promise(() => {}),
    hasOneCloudProject: () => false,
  },
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    getByocSetupStatus: vi.fn(),
    getPersonalAgentStatus: vi.fn(),
    suggestByocProject: vi.fn(),
    selectHostedCloud: vi.fn(),
    beginByocAuthorize: vi.fn(),
  },
}));
vi.mock("@/components/connections/byoc-cloud-card", () => ({
  ByocCloudCard: ({ onProjectNamed }: { onProjectNamed: (projectId: string) => void }) => (
    <button type="button" onClick={() => onProjectNamed("owner-project")}>Deploy to your cloud</button>
  ),
}));
vi.mock("@/components/onboarding/setup/setup-completion-footer", () => ({
  SetupCompletionFooter: () => null,
}));
vi.mock("@/components/app-ui/app-page-shell", () => ({
  AppPageShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
  AppPageHeaderRegion: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AppPageContentRegion: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/app-ui/page-sections", () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

describe("BYOC setup recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ApiService.getPersonalAgentStatus).mockResolvedValue({ hostingMode: "shared" });
    vi.mocked(ApiService.suggestByocProject).mockResolvedValue({
      projectId: "owner-project", displayName: "Owner", editable: true,
      rationale: "", creationModes: [], filesAvailable: true,
    });
    vi.mocked(ApiService.beginByocAuthorize).mockRejectedValue(new Error("BYOC_AUTHORIZE_BEGIN_FAILED"));
  });

  it("links billing and retries the recorded project with Files selected", async () => {
    vi.mocked(ApiService.getByocSetupStatus).mockResolvedValue({
      status: "failed", stage: "linking_billing", stages: [], projectId: "owner-project",
      errorCode: "NEEDS_BILLING", errorMessage: "No open billing account", stale: false, updatedAt: null,
    });
    render(<ByocCloudSetupPage />);

    expect(await screen.findByTestId("byoc-open-billing")).toHaveAttribute(
      "href", "https://console.cloud.google.com/billing",
    );
    expect(screen.getByTestId("byoc-link-project-billing")).toHaveAttribute(
      "href", "https://console.cloud.google.com/billing/projects",
    );
    fireEvent.click(screen.getByTestId("byoc-setup-retry"));
    await waitFor(() => expect(ApiService.beginByocAuthorize).toHaveBeenCalledWith({
      projectId: "owner-project", filesEnabled: true,
    }));
  });

  it("does not expose a terminal grant when Google authorization is unavailable", async () => {
    vi.mocked(ApiService.getByocSetupStatus).mockResolvedValue({
      status: "none", stage: "", stages: [], projectId: "", errorCode: null,
      errorMessage: null, stale: false, updatedAt: null,
    });
    render(<ByocCloudSetupPage />);
    fireEvent.click(await screen.findByText("Deploy to your cloud"));
    await screen.findByTestId("byoc-cloud-error");
    expect(screen.queryByTestId("byoc-authorize-script")).toBeNull();
  });
});
