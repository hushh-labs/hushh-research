/**
 * The cloud step's placement states (2026-10-06): Shared is never a default.
 *
 * unplaced -> the tier chooser with nothing preselected; a begun setup -> "finish
 * signing in" (pending, never Shared); attaching -> "Connecting to your agent";
 * a stopped attach -> its typed reason; Hussh Pods -> paused with two moves; an
 * organization policy refusing direct access -> a typed blocker with Retry.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiService } from "@/lib/services/api-service";
import { ByocCloudSetupPage } from "@/components/connections/byoc-cloud-setup-page";
import { readHostingMode } from "@/lib/one/hosting-placement";

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({ user: { uid: "owner" }, loading: false }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: () => undefined,
}));
vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    getCachedBootstrapState: () => null,
    bootstrapState: () => Promise.resolve(null),
    hasOneCloudProject: () => false,
  },
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: vi.fn(),
    getFirebaseIdToken: vi.fn(),
    getByocSetupStatus: vi.fn(),
    getPersonalAgentStatus: vi.fn(),
    suggestByocProject: vi.fn(),
    selectHostedCloud: vi.fn(),
    selectSharedHosting: vi.fn(),
    beginByocAuthorize: vi.fn(),
  },
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

const NO_JOB = {
  status: "none", stage: "", stages: [], projectId: "", errorCode: null,
  errorMessage: null, stale: false, updatedAt: null,
};

function given(agent: Record<string, unknown>, job: Record<string, unknown> = NO_JOB) {
  vi.mocked(ApiService.getPersonalAgentStatus).mockResolvedValue(agent as never);
  vi.mocked(ApiService.getByocSetupStatus).mockResolvedValue(job as never);
}

describe("cloud step placement states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ApiService.suggestByocProject).mockResolvedValue(null as never);
  });

  it("reads an unrecognised mode as unknown, never as Shared", () => {
    expect(readHostingMode("unplaced")).toBe("unplaced");
    expect(readHostingMode(undefined)).toBe("unknown");
    expect(readHostingMode("shared-ish")).toBe("unknown");
  });

  it("offers the tier chooser to an unplaced person with nothing preselected", async () => {
    given({ hostingMode: "unplaced", state: "none" });
    render(<ByocCloudSetupPage />);
    expect(await screen.findByTestId("cloud-tier-choice")).toBeInTheDocument();
    expect(screen.queryByTestId("shared-hosting-selected")).toBeNull();
    expect(screen.queryByTestId("cloud-tier-shared-continue")).toBeNull();
  });

  it("shows a begun setup as pending, with a way back to the sign-in and to Shared", async () => {
    given(
      { hostingMode: "pending", state: "none" },
      {
        ...NO_JOB, status: "pending", stage: "consent_pending", projectId: "owner-project",
        stages: [{ stage: "consent_pending", provider: "gcp", project: "owner-project" }],
      },
    );
    vi.mocked(ApiService.beginByocAuthorize).mockReturnValue(new Promise(() => {}));
    render(<ByocCloudSetupPage />);
    expect(await screen.findByTestId("hosting-consent-pending")).toBeInTheDocument();
    expect(screen.queryByTestId("cloud-tier-choice")).toBeNull();
    fireEvent.click(screen.getByTestId("hosting-consent-continue"));
    await waitFor(() =>
      expect(ApiService.beginByocAuthorize).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "owner-project" }),
      ),
    );
  });

  it("choosing Shared from a begun setup records the choice", async () => {
    given(
      { hostingMode: "pending", state: "none" },
      {
        ...NO_JOB, status: "pending", stage: "consent_pending",
        stages: [{ stage: "consent_pending", provider: "azure", project: "" }],
      },
    );
    vi.mocked(ApiService.selectSharedHosting).mockResolvedValue({
      hostingMode: "shared", nextStep: "",
    });
    render(<ByocCloudSetupPage />);
    fireEvent.click(await screen.findByTestId("hosting-consent-choose-shared"));
    await waitFor(() => expect(ApiService.selectSharedHosting).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("byoc-cloud-authorized")).toBeInTheDocument();
  });

  it("shows Connecting to your agent while a recorded home attaches", async () => {
    given(
      { hostingMode: "pending", state: "provisioning", deploymentTarget: "user_gcp" },
      { ...NO_JOB, status: "recorded", stage: "proving", projectId: "owner-project" },
    );
    render(<ByocCloudSetupPage />);
    expect(await screen.findByTestId("hosting-connecting")).toBeInTheDocument();
  });

  it("names the reason a recorded setup did not attach, and sends a phone step to verify", async () => {
    given(
      {
        hostingMode: "pending", state: "reserved", deploymentTarget: "user_gcp",
        cloudProject: "owner-project",
      },
      {
        ...NO_JOB, status: "recorded", stage: "proving", projectId: "owner-project",
        attachBlocked: "PHONE_NOT_VERIFIED",
      },
    );
    render(<ByocCloudSetupPage />);
    const card = await screen.findByTestId("hosting-attach-blocked");
    expect(card).toHaveAttribute("data-code", "PHONE_NOT_VERIFIED");
    expect(screen.getByTestId("hosting-attach-verify-phone")).toBeInTheDocument();
  });

  it("Try again on a stopped attach asks the hub to attach again, then re-reads", async () => {
    given(
      {
        hostingMode: "pending", state: "reserved", deploymentTarget: "user_gcp",
        cloudProject: "owner-project",
      },
      {
        ...NO_JOB, status: "recorded", stage: "proving", projectId: "owner-project",
        attachBlocked: "ATTACH_FAILED",
      },
    );
    vi.mocked(ApiService.getFirebaseIdToken).mockResolvedValue("id-token");
    vi.mocked(ApiService.apiFetch).mockResolvedValue({ ok: true } as Response);
    render(<ByocCloudSetupPage />);
    await screen.findByTestId("hosting-attach-blocked");
    const reads = vi.mocked(ApiService.getByocSetupStatus).mock.calls.length;
    fireEvent.click(screen.getByTestId("hosting-attach-retry"));
    await waitFor(() =>
      expect(ApiService.apiFetch).toHaveBeenCalledWith(
        "/api/one/runtime/byoc/attach/retry",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() =>
      expect(vi.mocked(ApiService.getByocSetupStatus).mock.calls.length).toBeGreaterThan(reads),
    );
  });

  it("shows Hussh Pods as paused with no move the hub would refuse", async () => {
    given({ hostingMode: "hussh_pods", state: "active", deploymentTarget: "gcp" });
    render(<ByocCloudSetupPage />);
    const card = await screen.findByTestId("hussh-pods-paused");
    expect(card).toHaveTextContent("needs the Hussh team to release your Hussh Pods place");
    expect(screen.queryByTestId("hussh-pods-choose-shared")).toBeNull();
    expect(screen.queryByTestId("hussh-pods-move-own-cloud")).toBeNull();
    expect(screen.queryByTestId("cloud-tier-choice")).toBeNull();
  });

  it("shows a typed organization-policy blocker; Retry asks the hub, then re-reads the agent", async () => {
    given({
      hostingMode: "byoc", state: "active", deploymentTarget: "user_gcp",
      cloudProject: "owner-project",
      directIngressBlocker: {
        code: "ORG_POLICY_REFUSES_PUBLIC_INVOKER", message: "Your policy blocks it.", retryable: true,
      },
    });
    vi.mocked(ApiService.getFirebaseIdToken).mockResolvedValue("id-token");
    vi.mocked(ApiService.apiFetch).mockResolvedValue({ ok: true } as Response);
    render(<ByocCloudSetupPage />);
    const card = await screen.findByTestId("hosting-direct-blocked");
    expect(card).toHaveAttribute("data-code", "ORG_POLICY_REFUSES_PUBLIC_INVOKER");
    expect(card).toHaveTextContent("Your policy blocks it.");
    const reads = vi.mocked(ApiService.getPersonalAgentStatus).mock.calls.length;
    fireEvent.click(screen.getByTestId("hosting-direct-retry"));
    await waitFor(() =>
      expect(ApiService.apiFetch).toHaveBeenCalledWith(
        "/api/one/personal-agent/direct-ingress/retry",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() =>
      expect(vi.mocked(ApiService.getPersonalAgentStatus).mock.calls.length).toBeGreaterThan(reads),
    );
  });

  it("offers no Retry when the hub says a retry cannot help", async () => {
    given({
      hostingMode: "byoc", state: "active", deploymentTarget: "user_gcp",
      directIngressBlocker: { code: "ORG_POLICY_REFUSES_PUBLIC_INVOKER", retryable: false },
    });
    render(<ByocCloudSetupPage />);
    expect(await screen.findByTestId("hosting-direct-blocked")).toBeInTheDocument();
    expect(screen.queryByTestId("hosting-direct-retry")).toBeNull();
  });
});
