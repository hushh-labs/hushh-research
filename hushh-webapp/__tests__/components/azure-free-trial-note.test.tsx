/**
 * An Azure free trial is named in one plain line on the cloud step.
 *
 * Microsoft disables a free trial after 30 days unless it is upgraded, and the
 * agent in it stops with it. The hub records the subscription's offer on the
 * setup record as a `subscription_offer` entry; the cloud step shows the line
 * while setup runs and on the connected state after it, and never for a paid
 * subscription.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import {
  AZURE_FREE_TRIAL_NOTICE,
  azureFreeTrialNotice,
} from "@/lib/one/azure-subscription-offer";
import { ApiService } from "@/lib/services/api-service";

const NOTICE =
  "This is a free trial subscription. Microsoft stops it after 30 days unless you upgrade, and your agent stops with it.";
const AZURE_GROUP =
  "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-hussh-one-abc";

/** The entry as `azure_subscription_offer.py` records it (measured trial values). */
function offer(freeTrial: boolean) {
  return {
    stage: "subscription_offer",
    at: "2026-10-06T00:00:00Z",
    quotaId: freeTrial ? "FreeTrial_2014-09-01" : "PayAsYouGo_2014-09-01",
    spendingLimit: freeTrial ? "On" : "Off",
    freeTrial,
  };
}

function azureJob(
  stage: string,
  reached: string[],
  extra: Array<Record<string, unknown>>,
  status: "running" | "recorded" = "running",
) {
  return {
    status,
    stage,
    stages: [...extra, ...reached.map((id) => ({ stage: id, at: "2026-10-06T00:00:00Z" }))],
    projectId: AZURE_GROUP,
    errorCode: null,
    errorMessage: null,
    stale: false,
    updatedAt: null,
  };
}

describe("the free-trial line on the cloud step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ApiService.getPersonalAgentStatus).mockResolvedValue({ hostingMode: "shared" });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the exact sentence, and only from a free-trial entry", () => {
    expect(AZURE_FREE_TRIAL_NOTICE).toBe(NOTICE);
    expect(NOTICE).not.toContain("—");
    expect(azureFreeTrialNotice([offer(true)])).toBe(NOTICE);
    expect(azureFreeTrialNotice([offer(false)])).toBeNull();
    expect(azureFreeTrialNotice([{ stage: "subscription_offer" }])).toBeNull();
    expect(azureFreeTrialNotice([{ stage: "proving" }])).toBeNull();
    expect(azureFreeTrialNotice(undefined)).toBeNull();
  });

  it("shows the line while a trial setup runs, without adding a checklist row", async () => {
    vi.mocked(ApiService.getByocSetupStatus).mockResolvedValue(
      azureJob("creating_identity", ["creating_resource_group", "creating_identity"], [offer(true)]),
    );
    render(<ByocCloudSetupPage />);
    const progress = await screen.findByTestId("byoc-setup-progress");
    expect(progress).toHaveTextContent("Setting up your agent in Microsoft Azure");
    expect(screen.getByTestId("azure-free-trial-note")).toHaveTextContent(NOTICE);
    expect(progress.querySelectorAll("li")).toHaveLength(12);
    expect(progress).not.toHaveTextContent("subscription_offer");
  });

  it("says nothing for a paid subscription", async () => {
    vi.mocked(ApiService.getByocSetupStatus).mockResolvedValue(
      azureJob("creating_identity", ["creating_resource_group", "creating_identity"], [offer(false)]),
    );
    render(<ByocCloudSetupPage />);
    await screen.findByTestId("byoc-setup-progress");
    expect(screen.queryByTestId("azure-free-trial-note")).toBeNull();
  });

  it("keeps the line on the connected state once setup is recorded", async () => {
    vi.mocked(ApiService.getPersonalAgentStatus).mockResolvedValue({
      hostingMode: "byoc",
      state: "active",
      deploymentTarget: "user_azure",
      cloudProject: null,
    });
    vi.mocked(ApiService.getByocSetupStatus).mockResolvedValue(
      azureJob("proving", ["creating_resource_group", "proving"], [offer(true)], "recorded"),
    );
    render(<ByocCloudSetupPage />);
    const connected = await screen.findByTestId("byoc-cloud-connected");
    expect(connected).toHaveTextContent("Connected: Microsoft Azure");
    expect(await screen.findByTestId("azure-free-trial-note")).toHaveTextContent(NOTICE);
  });

  it("shows no line on the connected state when the setup record names no trial", async () => {
    vi.mocked(ApiService.getPersonalAgentStatus).mockResolvedValue({
      hostingMode: "byoc",
      state: "active",
      deploymentTarget: "user_azure",
      cloudProject: null,
    });
    vi.mocked(ApiService.getByocSetupStatus).mockResolvedValue(
      azureJob("proving", ["creating_resource_group", "proving"], [], "recorded"),
    );
    render(<ByocCloudSetupPage />);
    await screen.findByTestId("byoc-cloud-connected");
    expect(screen.queryByTestId("azure-free-trial-note")).toBeNull();
  });
});
