/**
 * `/one/setup/cloud/azure/return`: where Microsoft sends the person back.
 *
 * The code is exchanged once, the hub's answer picks the screen, and every
 * failure is one plain sentence with a retry that restarts the right sign-in.
 */
import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  assign: vi.fn(),
  search: { value: "code=c0de&state=st4te" },
  user: { value: { uid: "owner" } as { uid: string } | null },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(mocks.search.value),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({ user: mocks.user.value, loading: false }),
}));
vi.mock("@/lib/utils/browser-navigation", () => ({ assignWindowLocation: mocks.assign }));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    completeAzureByocAuthorize: vi.fn(),
    beginAzureByocAuthorize: vi.fn(),
    beginAzureByocUpgrade: vi.fn(),
    getByocSetupStatus: vi.fn(),
    getPersonalAgentStatus: vi.fn(),
  },
}));
vi.mock("@/components/app-ui/app-page-shell", () => ({
  AppPageShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
  AppPageHeaderRegion: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AppPageContentRegion: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/app-ui/page-sections", () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

import { AzureCloudReturnPage } from "@/components/connections/azure-cloud-return-page";
import {
  ROUTES,
  isOneSetupNavigationRoute,
  isOneSetupSurfaceRoute,
} from "@/lib/navigation/routes";
import { ApiService } from "@/lib/services/api-service";
import { AzureByocError } from "@/lib/services/azure-byoc-contract";
import { deriveVoiceRouteScreen } from "@/lib/voice/route-screen-derivation";

const SIGN_IN = "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?state=s";
const complete = vi.mocked(ApiService.completeAzureByocAuthorize);

function status(overrides: Record<string, unknown>) {
  return {
    status: "running", stage: "", stages: [], projectId: "", errorCode: null,
    errorMessage: null, stale: false, updatedAt: null, ...overrides,
  } as Awaited<ReturnType<typeof ApiService.getByocSetupStatus>>;
}

describe("the Microsoft sign-in return", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.search.value = "code=c0de&state=st4te";
    mocks.user.value = { uid: "owner" };
    vi.mocked(ApiService.beginAzureByocAuthorize).mockResolvedValue({ authorizationUrl: SIGN_IN });
    vi.mocked(ApiService.beginAzureByocUpgrade).mockResolvedValue({ authorizationUrl: SIGN_IN });
    vi.mocked(ApiService.getPersonalAgentStatus).mockResolvedValue({ state: null });
  });

  it("sends a started setup to the cloud step's live checklist", async () => {
    complete.mockResolvedValue({ status: "setup_started", jobId: "job-1" });
    render(<AzureCloudReturnPage />);
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith(ROUTES.ONE_SETUP_CLOUD));
    expect(complete).toHaveBeenCalledWith({ code: "c0de", state: "st4te" });
  });

  it("exchanges the one-time code exactly once under Strict Mode", async () => {
    complete.mockResolvedValue({ status: "setup_started", jobId: "job-1" });
    render(
      <StrictMode>
        <AzureCloudReturnPage />
      </StrictMode>,
    );
    await waitFor(() => expect(mocks.replace).toHaveBeenCalled());
    expect(complete).toHaveBeenCalledOnce();
  });

  it("lets the person pick an enabled subscription and signs in again for it", async () => {
    complete.mockResolvedValue({
      status: "needs_subscription",
      subscriptions: [
        { subscriptionId: "sub-a", displayName: "Pay-As-You-Go", state: "Enabled" },
        { subscriptionId: "sub-b", displayName: "Free Trial", state: "Enabled" },
        { subscriptionId: "sub-c", displayName: "Old", state: "Disabled" },
      ],
    });
    render(<AzureCloudReturnPage />);
    expect(await screen.findByRole("heading", { name: "Choose a subscription" })).toBeTruthy();
    const proceed = screen.getByTestId("azure-subscription-continue");
    expect(proceed).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Old" })).toBeDisabled();
    expect(screen.getByText(/sub-c · Disabled/)).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "Free Trial" }));
    expect(proceed).toBeEnabled();
    fireEvent.click(proceed);
    await waitFor(() => expect(mocks.assign).toHaveBeenCalledWith(SIGN_IN));
    expect(ApiService.beginAzureByocAuthorize).toHaveBeenCalledWith({ subscriptionId: "sub-b" });
  });

  it("preselects the only enabled subscription", async () => {
    complete.mockResolvedValue({
      status: "needs_subscription",
      subscriptions: [
        { subscriptionId: "sub-a", displayName: "Pay-As-You-Go", state: "Enabled" },
        { subscriptionId: "sub-c", displayName: "Old", state: "PastDue" },
      ],
    });
    render(<AzureCloudReturnPage />);
    expect(await screen.findByTestId("azure-subscription-continue")).toBeEnabled();
    expect(screen.getByRole("radio", { name: "Pay-As-You-Go" })).toHaveAttribute("aria-checked", "true");
  });

  it("explains an account with no subscription and offers the portal", async () => {
    complete.mockResolvedValue({ status: "needs_subscription", subscriptions: [] });
    render(<AzureCloudReturnPage />);
    const empty = await screen.findByTestId("azure-no-subscription");
    expect(empty).toHaveTextContent("no Azure subscription");
    expect(screen.getByRole("link", { name: "Open the Azure portal" })).toHaveAttribute("href", "https://portal.azure.com/");
    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    await waitFor(() => expect(ApiService.beginAzureByocAuthorize).toHaveBeenCalledWith({}));
  });

  it("shows an approved update's own stages while it runs", async () => {
    complete.mockResolvedValue({ status: "upgrade_started", jobId: "job-2" });
    vi.mocked(ApiService.getByocSetupStatus).mockResolvedValue(
      status({ stage: "deploying_agent", stages: [{ stage: "importing_image", at: "t" }, { stage: "deploying_agent", at: "t" }] }),
    );
    render(<AzureCloudReturnPage />);
    expect(await screen.findByRole("heading", { name: "Updating your agent" })).toBeTruthy();
    const progress = await screen.findByTestId("byoc-setup-progress");
    expect(progress).toHaveTextContent("Copying your agent into your subscription");
    expect(progress).toHaveTextContent("Starting your private agent…");
    expect(progress).toHaveTextContent("Checking your private agent");
    expect(progress).not.toHaveTextContent("Creating your resource group");
  });

  it("confirms a finished update", async () => {
    complete.mockResolvedValue({ status: "upgrade_started", jobId: "job-2" });
    vi.mocked(ApiService.getByocSetupStatus).mockResolvedValue(status({ status: "recorded", stage: "proving" }));
    render(<AzureCloudReturnPage />);
    expect(await screen.findByTestId("azure-upgrade-done")).toHaveTextContent("Your agent is updated");
    expect(screen.getByRole("link", { name: "Open Software updates" })).toHaveAttribute("href", ROUTES.PROFILE_SOFTWARE_UPDATES);
  });

  it("offers the update sign-in again when the update fails", async () => {
    complete.mockResolvedValue({ status: "upgrade_started", jobId: "job-2" });
    vi.mocked(ApiService.getByocSetupStatus).mockResolvedValue(
      status({ status: "failed", stage: "deploying_agent", errorMessage: "The new version did not start." }),
    );
    render(<AzureCloudReturnPage />);
    expect(await screen.findByTestId("azure-upgrade-failed")).toHaveTextContent("The new version did not start.");
    fireEvent.click(screen.getByTestId("azure-upgrade-retry"));
    await waitFor(() => expect(ApiService.beginAzureByocUpgrade).toHaveBeenCalledOnce());
    expect(mocks.assign).toHaveBeenCalledWith(SIGN_IN);
  });

  it("names the hub's typed refusal and restarts setup for a person without an Azure agent", async () => {
    complete.mockRejectedValue(
      new AzureByocError("AZURE_AUTHORIZE_COMPLETE_FAILED", {
        httpStatus: 409,
        serverCode: "AZURE_SUBSCRIPTION_NOT_ENABLED",
        serverMessage: "That subscription is disabled. Choose another one.",
      }),
    );
    render(<AzureCloudReturnPage />);
    expect(await screen.findByTestId("azure-return-error")).toHaveTextContent(
      "That subscription is disabled. Choose another one.",
    );
    fireEvent.click(screen.getByTestId("azure-return-retry"));
    await waitFor(() => expect(ApiService.beginAzureByocAuthorize).toHaveBeenCalledWith({}));
    expect(ApiService.beginAzureByocUpgrade).not.toHaveBeenCalled();
  });

  it("restarts the update sign-in when the person's agent already runs in Azure", async () => {
    complete.mockRejectedValue(new AzureByocError("AZURE_AUTHORIZE_COMPLETE_FAILED"));
    vi.mocked(ApiService.getPersonalAgentStatus).mockResolvedValue({ deploymentTarget: "user_azure", state: "active" });
    render(<AzureCloudReturnPage />);
    expect(await screen.findByTestId("azure-return-error")).toHaveTextContent(
      "We could not finish connecting Azure. Start the Microsoft sign-in again to continue.",
    );
    fireEvent.click(screen.getByTestId("azure-return-retry"));
    await waitFor(() => expect(ApiService.beginAzureByocUpgrade).toHaveBeenCalledOnce());
  });

  it("shows a begin failure on retry without navigating", async () => {
    complete.mockRejectedValue(new AzureByocError("AZURE_AUTHORIZE_COMPLETE_FAILED"));
    vi.mocked(ApiService.beginAzureByocAuthorize).mockRejectedValue(new AzureByocError("AZURE_RESPONSE_INVALID"));
    render(<AzureCloudReturnPage />);
    fireEvent.click(await screen.findByTestId("azure-return-retry"));
    expect(await screen.findByTestId("azure-sign-in-error")).toHaveTextContent(/safely/);
    expect(mocks.assign).not.toHaveBeenCalled();
  });

  it.each([
    ["error=access_denied&state=s", "Microsoft sign-in was cancelled. Nothing in your subscription changed."],
    ["error=server_error&error_description=AADSTS-raw&state=s", "Microsoft sign-in could not finish. Nothing in your subscription changed."],
    ["state=s", "This sign-in link is incomplete. Start the Microsoft sign-in again."],
  ])("refuses %s before any exchange", async (query, message) => {
    mocks.search.value = query;
    render(<AzureCloudReturnPage />);
    expect(await screen.findByTestId("azure-return-error")).toHaveTextContent(message);
    expect(screen.queryByText(/AADSTS/)).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  it("refuses to exchange a code without a signed-in Hussh account", async () => {
    mocks.user.value = null;
    render(<AzureCloudReturnPage />);
    expect(await screen.findByTestId("azure-return-error")).toHaveTextContent("Sign in to Hussh");
    expect(complete).not.toHaveBeenCalled();
  });

  it("is admitted as a pod-provisioning surface on the cloud step's voice screen", () => {
    expect(ROUTES.ONE_SETUP_CLOUD_AZURE_RETURN).toBe("/one/setup/cloud/azure/return");
    expect(isOneSetupNavigationRoute(ROUTES.ONE_SETUP_CLOUD_AZURE_RETURN)).toBe(true);
    expect(isOneSetupSurfaceRoute(`${ROUTES.ONE_SETUP_CLOUD_AZURE_RETURN}/`)).toBe(true);
    expect(deriveVoiceRouteScreen(ROUTES.ONE_SETUP_CLOUD_AZURE_RETURN).screen).toBe("one_setup_cloud");
  });
});
