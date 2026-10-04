/**
 * Connect Azure on the cloud step.
 *
 * The provider choice ships dark until a build admits Azure, the Google path
 * stays exactly as it was, and once admitted the Azure path starts the
 * person's own Microsoft sign-in and narrates the hub's twelve-stage job.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ assign: vi.fn() }));

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({ user: { uid: "owner" }, loading: false }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/utils/browser-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils/browser-navigation")>()),
  assignWindowLocation: mocks.assign,
}));
vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: () => undefined,
}));
vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    getCachedBootstrapState: () => null,
    bootstrapState: () => Promise.resolve(null),
    hasOneCloudProject: () => true,
  },
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    getByocSetupStatus: vi.fn(),
    getPersonalAgentStatus: vi.fn(),
    suggestByocProject: vi.fn(),
    selectHostedCloud: vi.fn(),
    selectSharedHosting: vi.fn(),
    beginByocAuthorize: vi.fn(),
    beginAzureByocAuthorize: vi.fn(),
  },
}));
vi.mock("@/components/connections/byoc-cloud-card", () => ({
  ByocCloudCard: () => <div data-testid="byoc-cloud-card">Google project form</div>,
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

import { ByocCloudSetupPage } from "@/components/connections/byoc-cloud-setup-page";
import { ApiService } from "@/lib/services/api-service";
import { AzureByocError } from "@/lib/services/azure-byoc-contract";

const SIGN_IN = "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?state=s";
const SUBSCRIPTION = "00000000-0000-0000-0000-000000000000";
/** What the hub writes as an Azure job's projectId: `azure_setup_plan.group_id`. */
const AZURE_GROUP = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-hussh-one-abc";
const NO_JOB = {
  status: "none", stage: "", stages: [], projectId: "", errorCode: null,
  errorMessage: null, stale: false, updatedAt: null,
} as const;

function azureJob(stage: string, reached: string[], status: "running" | "failed" = "running") {
  return {
    ...NO_JOB,
    status,
    stage,
    stages: reached.map((id) => ({ stage: id, at: "2026-10-02T00:00:00Z" })),
    projectId: AZURE_GROUP,
  };
}

async function openOwnCloud() {
  fireEvent.click(await screen.findByTestId("cloud-tier-own"));
}



describe("Connect Azure on the cloud step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ApiService.getPersonalAgentStatus).mockResolvedValue({ hostingMode: "shared" });
    vi.mocked(ApiService.getByocSetupStatus).mockResolvedValue({ ...NO_JOB });
    vi.mocked(ApiService.beginAzureByocAuthorize).mockResolvedValue({ authorizationUrl: SIGN_IN });
    // A blocked popup: the sign-in continues in this tab (the popup path has its own tests).
    vi.spyOn(window, "open").mockReturnValue(null);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("keeps the Google path unchanged while Azure is not admitted on this build", async () => {
    render(<ByocCloudSetupPage />);
    await openOwnCloud();
    expect(await screen.findByTestId("byoc-cloud-card")).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: "Your cloud provider" })).toBeNull();
    expect(screen.queryByTestId("azure-connect")).toBeNull();
  });

  it("offers Google Cloud or Microsoft Azure, defaulting to Google Cloud", async () => {
    vi.stubEnv("NEXT_PUBLIC_AZURE_BYOC_SELECTABLE", "1");
    render(<ByocCloudSetupPage />);
    await openOwnCloud();
    const group = await screen.findByRole("radiogroup", { name: "Your cloud provider" });
    expect(group).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Google Cloud Platform" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("byoc-cloud-card")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "Microsoft Azure" }));
    expect(screen.queryByTestId("byoc-cloud-card")).toBeNull();
    const notes = screen.getByTestId("azure-capability-notes");
    expect(notes).toHaveTextContent("Memory recall is keyword-based for now.");
    expect(notes).toHaveTextContent("Voice is not available yet.");
    expect(notes).toHaveTextContent("Web search is not available yet.");
    expect(notes).toHaveTextContent("New-mail alerts are off.");
    expect(screen.getByTestId("azure-cost-note")).toHaveTextContent(
      "About $5/month while idle, billed by Microsoft to your subscription. A full idle day measured $0.14.",
    );
  });

  it("starts the person's own Microsoft sign-in from Connect Azure", async () => {
    vi.stubEnv("NEXT_PUBLIC_AZURE_BYOC_SELECTABLE", "1");
    render(<ByocCloudSetupPage />);
    await openOwnCloud();
    fireEvent.click(await screen.findByRole("radio", { name: "Microsoft Azure" }));
    // One tap, like Google: no subscription to type. The hub finds the directory.
    expect(screen.queryByTestId("azure-card-subscription-id")).toBeNull();
    fireEvent.click(screen.getByTestId("azure-connect"));
    await waitFor(() => expect(mocks.assign).toHaveBeenCalledWith(SIGN_IN));
    expect(ApiService.beginAzureByocAuthorize).toHaveBeenCalledWith({});
    expect(ApiService.beginByocAuthorize).not.toHaveBeenCalled();
  });

  it("signs in to Microsoft in a popup when the browser allows one", async () => {
    vi.stubEnv("NEXT_PUBLIC_AZURE_BYOC_SELECTABLE", "1");
    const popup = { closed: false, location: { assign: vi.fn() }, focus: vi.fn(), close: vi.fn() };
    vi.mocked(window.open).mockReturnValue(popup as unknown as Window);
    render(<ByocCloudSetupPage />);
    await openOwnCloud();
    fireEvent.click(await screen.findByRole("radio", { name: "Microsoft Azure" }));
    fireEvent.click(screen.getByTestId("azure-connect"));
    // Opened inside the tap (popup blockers need the gesture), filled once the hub answers.
    expect(window.open).toHaveBeenCalledWith("about:blank", "hussh-azure-sign-in", expect.stringContaining("popup"));
    await waitFor(() => expect(popup.location.assign).toHaveBeenCalledWith(SIGN_IN));
    expect(mocks.assign).not.toHaveBeenCalled();
  });

  it("closes the popup when the hub refuses to start the sign-in", async () => {
    vi.stubEnv("NEXT_PUBLIC_AZURE_BYOC_SELECTABLE", "1");
    const popup = { closed: false, location: { assign: vi.fn() }, focus: vi.fn(), close: vi.fn() };
    vi.mocked(window.open).mockReturnValue(popup as unknown as Window);
    vi.mocked(ApiService.beginAzureByocAuthorize).mockRejectedValue(
      new AzureByocError("AZURE_AUTHORIZE_BEGIN_FAILED", { httpStatus: 503 }),
    );
    render(<ByocCloudSetupPage />);
    await openOwnCloud();
    fireEvent.click(await screen.findByRole("radio", { name: "Microsoft Azure" }));
    fireEvent.click(screen.getByTestId("azure-connect"));
    await waitFor(() => expect(popup.close).toHaveBeenCalled());
    expect(popup.location.assign).not.toHaveBeenCalled();
  });

  it("shows the hub's refusal in the page's alert and never navigates", async () => {
    vi.stubEnv("NEXT_PUBLIC_AZURE_BYOC_SELECTABLE", "1");
    vi.mocked(ApiService.beginAzureByocAuthorize).mockRejectedValue(
      new AzureByocError("AZURE_AUTHORIZE_BEGIN_FAILED", {
        httpStatus: 403,
        serverCode: "PHONE_REQUIRED",
        serverMessage: "Verify your phone number first.",
      }),
    );
    render(<ByocCloudSetupPage />);
    await openOwnCloud();
    fireEvent.click(await screen.findByRole("radio", { name: "Microsoft Azure" }));
    fireEvent.click(screen.getByTestId("azure-connect"));
    expect(await screen.findByTestId("byoc-cloud-error")).toHaveTextContent("Verify your phone number first.");
    expect(screen.getByTestId("byoc-cloud-verify-phone")).toBeTruthy();
    expect(mocks.assign).not.toHaveBeenCalled();
  });

  it("narrates a running Azure job with the Azure stages", async () => {
    vi.mocked(ApiService.getByocSetupStatus).mockResolvedValue(
      azureJob("creating_key_vault", ["creating_resource_group", "registering_providers", "creating_identity", "creating_key_vault"]),
    );
    render(<ByocCloudSetupPage />);
    const progress = await screen.findByTestId("byoc-setup-progress");
    expect(progress).toHaveTextContent("Setting up your agent in Microsoft Azure");
    expect(progress).toHaveTextContent("Creating your resource group");
    expect(progress).toHaveTextContent("Creating your agent’s key vault…");
    expect(progress).toHaveTextContent("Checking your private agent");
    expect(progress).not.toHaveTextContent("Linking your billing");
  });

  it("shows a just-started Azure job as starting, never as a Google project", async () => {
    vi.mocked(ApiService.getByocSetupStatus).mockResolvedValue(azureJob("starting", []));
    render(<ByocCloudSetupPage />);
    const progress = await screen.findByTestId("byoc-setup-progress");
    expect(progress).toHaveTextContent("Starting in Microsoft Azure");
    expect(progress).toHaveTextContent("Starting…");
    expect(progress).not.toHaveTextContent("/subscriptions/");
    expect(progress).not.toHaveTextContent("Creating your project");
    expect(progress).not.toHaveTextContent("Linking your billing");
  });

  it("retries an Azure job that failed before its first stage through the Microsoft sign-in", async () => {
    vi.mocked(ApiService.getByocSetupStatus).mockResolvedValue({
      ...azureJob("starting", [], "failed"),
      errorCode: "NEEDS_BILLING",
      errorMessage: "Approve the Hussh app in your directory, then try again.",
    });
    render(<ByocCloudSetupPage />);
    const failed = await screen.findByTestId("byoc-setup-failed");
    expect(failed).toHaveTextContent("Your agent is not set up in Azure yet");
    expect(failed).toHaveTextContent("Approve the Hussh app in your directory, then try again.");
    expect(screen.queryByTestId("byoc-open-billing")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Microsoft again" }));
    // The retry reads the subscription back from the failed job's record.
    await waitFor(() =>
      expect(ApiService.beginAzureByocAuthorize).toHaveBeenCalledWith({ subscriptionId: SUBSCRIPTION }),
    );
    expect(ApiService.beginByocAuthorize).not.toHaveBeenCalled();
  });

  it("only offers a refresh for a failed job whose cloud cannot be told", async () => {
    vi.mocked(ApiService.getByocSetupStatus).mockResolvedValue({ ...azureJob("starting", [], "failed"), projectId: "" });
    render(<ByocCloudSetupPage />);
    await screen.findByTestId("byoc-setup-failed");
    expect(screen.queryByTestId("byoc-setup-retry")).toBeNull();
    expect(screen.getByTestId("byoc-setup-refresh")).toBeTruthy();
    expect(ApiService.beginByocAuthorize).not.toHaveBeenCalled();
  });

  it("retries a failed Azure job through the Microsoft sign-in", async () => {
    vi.mocked(ApiService.getByocSetupStatus).mockResolvedValue(
      azureJob("creating_model", ["creating_resource_group", "creating_model"], "failed"),
    );
    render(<ByocCloudSetupPage />);
    fireEvent.click(await screen.findByTestId("byoc-setup-retry"));
    // The retry reads the subscription back from the failed job's record.
    await waitFor(() =>
      expect(ApiService.beginAzureByocAuthorize).toHaveBeenCalledWith({ subscriptionId: SUBSCRIPTION }),
    );
    expect(ApiService.beginByocAuthorize).not.toHaveBeenCalled();
  });

  it("shows an assigned Azure home as connected without asking for a Google project", async () => {
    vi.mocked(ApiService.getPersonalAgentStatus).mockResolvedValue({
      hostingMode: "byoc",
      state: "active",
      deploymentTarget: "user_azure",
      cloudProject: null,
    });
    render(<ByocCloudSetupPage />);
    const connected = await screen.findByTestId("byoc-cloud-connected");
    expect(connected).toHaveTextContent("Connected: Microsoft Azure");
    expect(connected).toHaveTextContent("Your private agent runs in your own Azure subscription.");
    expect(screen.queryByTestId("byoc-cloud-card")).toBeNull();
    expect(ApiService.suggestByocProject).not.toHaveBeenCalled();
  });

  it("deploys a reserved Azure home through the Microsoft sign-in", async () => {
    vi.mocked(ApiService.getPersonalAgentStatus).mockResolvedValue({
      hostingMode: "pending",
      state: "reserved",
      deploymentTarget: "user_azure",
      cloudProject: "rg-hussh-one-abc",
    });
    render(<ByocCloudSetupPage />);
    fireEvent.click(await screen.findByTestId("byoc-reserved-project-deploy"));
    await waitFor(() => expect(ApiService.beginAzureByocAuthorize).toHaveBeenCalledWith({}));
    expect(ApiService.beginByocAuthorize).not.toHaveBeenCalled();
  });
});
