/**
 * The cloud step's placement states (2026-10-06): Shared is never a default.
 *
 * unplaced -> the tier chooser with nothing preselected; a begun setup -> "finish
 * signing in" (pending, never Shared); attaching -> "Connecting to your agent";
 * a stopped attach -> its typed reason; Hussh Pods -> paused with two moves; an
 * organization policy refusing direct access -> a typed blocker with Retry.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { ApiService } from "@/lib/services/api-service";
import { ByocCloudSetupPage } from "@/components/connections/byoc-cloud-setup-page";
import { SANDBOX_CUTOVER_PILL_STORAGE_KEY } from "@/components/connections/hussh-pods-cloud-card";
import { readHostingMode } from "@/lib/one/hosting-placement";
import { ROUTES } from "@/lib/navigation/routes";
import { INTERNAL_APP_NAVIGATION_REQUEST_EVENT } from "@/lib/utils/browser-navigation";

const authState = vi.hoisted(() => ({ ready: true }));
vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({
    user: { uid: "owner" }, loading: !authState.ready,
    accountPrincipal: authState.ready
      ? { firebaseUid: "owner", ownerId: "owner", accountGeneration: 0 }
      : null,
  }),
}));
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getCurrentUser: () => ({ uid: "owner" }) },
}));
vi.mock("@/lib/services/owner-pod-endpoint", () => ({
  loadPinnedEndpoint: async () => null,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/one/kai",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/kai/actions/voice-surface-metadata", () => ({
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
    getPersonalAgentStatusForRouting: vi.fn(),
    suggestByocProject: vi.fn(),
    selectHostedCloud: vi.fn(),
    selectSharedHosting: vi.fn(),
    beginByocAuthorize: vi.fn(),
    getHostedAzureMigrationStatus: vi.fn(),
    migrateToHostedAzure: vi.fn(),
    getHostedSourceRetirementStatus: vi.fn(),
    confirmHostedSourceRetirement: vi.fn(),
    adoptPooledSandbox: vi.fn(),
    reconnectOwnerPod: vi.fn(),
  },
}));
vi.mock("@/components/connections/gemini-runtime-configuration-page", () => ({
  GeminiRuntimeConfigurationPage: () => <section aria-label="AI access" />,
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
  const status = { featureEnabled: true, ...agent } as never;
  vi.mocked(ApiService.getPersonalAgentStatus).mockResolvedValue(status);
  vi.mocked(ApiService.getPersonalAgentStatusForRouting).mockResolvedValue(status);
  vi.mocked(ApiService.getByocSetupStatus).mockResolvedValue(job as never);
}

describe("cloud step placement states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    window.sessionStorage.clear();
    authState.ready = true;
    publishValidatedAuthSessionPrincipal({ firebaseUid: "owner", ownerId: "owner", accountGeneration: 0 });
    vi.mocked(ApiService.suggestByocProject).mockResolvedValue(null as never);
    vi.mocked(ApiService.getHostedSourceRetirementStatus).mockResolvedValue({
      environment: "dev",
      items: [],
      hasPendingConfirmation: false,
    });
    vi.mocked(ApiService.adoptPooledSandbox).mockResolvedValue({
      status: "ready",
      hostingMode: "hussh_pods",
      deploymentTarget: "ace",
      hushhId: "ha1_sandbox",
      podUrl: "https://sandbox-edge.dev.one.hussh.ai/u/ha1_sandbox",
      detachedPriorHost: true,
    });
    vi.mocked(ApiService.reconnectOwnerPod).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("opens Shared Finance after the same Firebase owner's validation settles", async () => {
    given({ hostingMode: "shared", state: "none" });
    await import("@/lib/services/owner-pod-endpoint");
    await import("@/lib/services/pod-app-access");
    await import("@/lib/services/private-agent-specialist-chat");
    authState.ready = false;
    publishValidatedAuthSessionPrincipal(null);
    const { KaiPrivateAgentGate } = await import("@/components/kai/kai-private-agent-gate");
    const view = render(<KaiPrivateAgentGate><div>kai workspace</div></KaiPrivateAgentGate>);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    publishValidatedAuthSessionPrincipal({ firebaseUid: "owner", ownerId: "owner", accountGeneration: 0 });
    authState.ready = true;
    view.rerender(<KaiPrivateAgentGate><div>kai workspace</div></KaiPrivateAgentGate>);
    expect(await screen.findByText("kai workspace")).toBeTruthy();
  });

  it("opens Finance on Confidential Sandbox while keeping external BYOC off the hub", async () => {
    given({ hostingMode: "hussh_pods", state: "active" });
    const { KaiPrivateAgentGate } = await import("@/components/kai/kai-private-agent-gate");
    const sandboxView = render(<KaiPrivateAgentGate><div>kai workspace</div></KaiPrivateAgentGate>);
    expect(await screen.findByText("kai workspace")).toBeTruthy();
    sandboxView.unmount();

    given({ hostingMode: "byoc", state: "active" });
    render(<KaiPrivateAgentGate><div>kai workspace</div></KaiPrivateAgentGate>);
    expect(await screen.findByText("Kai will be available on your agent soon.")).toBeTruthy();
    expect(screen.queryByText("kai workspace")).toBeNull();
    expect(ApiService.apiFetch).not.toHaveBeenCalled();
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
    vi.mocked(ApiService.selectSharedHosting).mockImplementation(async () => {
      given({ hostingMode: "shared", state: "none" });
      return { hostingMode: "shared", nextStep: "" };
    });
    render(<ByocCloudSetupPage />);
    await screen.findByTestId("hosting-consent-pending");
    expect(screen.queryByRole("region", { name: "AI access" })).toBeNull();
    fireEvent.click(await screen.findByTestId("hosting-consent-choose-shared"));
    await waitFor(() => expect(ApiService.selectSharedHosting).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("region", { name: "AI access" })).toBeInTheDocument();
    expect(screen.queryByTestId("hosting-consent-pending")).toBeNull();
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

  it.each(["direct", "attach"])("preserves a paused cloud's %s blocker without a doomed retry", async (kind) => {
    const direct = kind === "direct";
    given({
      featureEnabled: false, hostingMode: direct ? "byoc" : "pending",
      state: direct ? "active" : "reserved", deploymentTarget: "user_gcp", cloudProject: "owner-project",
      ...(direct ? { directIngressBlocker: { code: "ORG_POLICY_REFUSES_PUBLIC_INVOKER", retryable: true } } : {}),
    }, direct ? NO_JOB : {
      ...NO_JOB, status: "recorded", stage: "proving", projectId: "owner-project", attachBlocked: "ATTACH_FAILED",
    });
    render(<ByocCloudSetupPage />);
    expect(await screen.findByTestId(`hosting-${kind}-blocked`)).toBeInTheDocument();
    expect(screen.queryByTestId(`hosting-${kind}-retry`)).toBeNull();
    expect(ApiService.apiFetch).not.toHaveBeenCalled();
    expect(ApiService.selectSharedHosting).not.toHaveBeenCalled();
  });

  it("shows graphical Hussh Pods provider identity and legacy Azure migration option when explicitly enabled outside Dev", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_HOSTED_POD_TIER_MAINTENANCE", "0");
    vi.stubEnv("NEXT_PUBLIC_HOSTED_AZURE_MIGRATION_ENABLED", "1");
    vi.mocked(ApiService.getHostedAzureMigrationStatus).mockResolvedValue({
      job: null,
      deploymentTarget: "gcp",
      registryStatus: "provisioned",
      cutover: { relayReady: true, directReady: true, ingress: "direct", mode: "direct" },
      cellPool: { environment: "uat", cells: [], totalAzureWarmSlots: 2, azureWarmReady: true },
    });
    given({ hostingMode: "hussh_pods", state: "active", deploymentTarget: "gcp" });
    render(<ByocCloudSetupPage />);
    const card = await screen.findByTestId("hussh-pods-connected");
    expect(card).toHaveAttribute("data-provider", "gcp");
    expect(card).toHaveTextContent("Hussh Pods · Google Cloud");
    expect(await screen.findByTestId("hussh-pods-migration-route")).toBeInTheDocument();
  });

  it("shows Google Cloud mark on active ACE Confidential Sandbox without false Azure claim", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "dev");
    given({ hostingMode: "hussh_pods", state: "active", deploymentTarget: "ace" });
    render(<ByocCloudSetupPage />);
    const card = await screen.findByTestId("hussh-pods-connected");
    expect(card).toHaveAttribute("data-provider", "ace");
    expect(card).toHaveTextContent("Isolated Confidential Sandbox on Google Cloud");
    expect(card).not.toHaveTextContent("Hussh Confidential Sandbox");
    expect(card).not.toHaveTextContent("Microsoft Azure");
    expect(screen.getByTestId("hussh-pods-active-gcp-cloud")).toBeInTheDocument();
    expect(screen.queryByTestId("pooled-sandbox-switch-card")).toBeNull();
  });

  it.each([
    { label: "GCP", deploymentTarget: "user_gcp", cloudProject: "owner-gcp-proj" },
    { label: "Azure", deploymentTarget: "user_azure", cloudProject: "eastus2" },
  ] as const)(
    "replaces legacy migration with confirmed Personal Sandbox switch on Dev for $label BYOC",
    async ({ deploymentTarget, cloudProject }) => {
      vi.stubEnv("NEXT_PUBLIC_APP_ENV", "dev");
      given({ hostingMode: "byoc", state: "active", deploymentTarget, cloudProject });
      vi.mocked(ApiService.suggestByocProject).mockResolvedValue({
        projectId: cloudProject,
        rationale: "Assigned",
      } as never);
      let resolveAdopt!: (value: {
        status: string;
        hostingMode: string;
        deploymentTarget: string;
        hushhId: string;
        podUrl: string;
        detachedPriorHost: boolean;
        backgroundCleanupQueued?: boolean;
        migrationMode?: string;
      }) => void;
      vi.mocked(ApiService.adoptPooledSandbox).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveAdopt = resolve;
          }),
      );
      const navHrefs: string[] = [];
      const onNav = (event: Event) => {
        navHrefs.push((event as CustomEvent<{ href?: string }>).detail?.href ?? "");
      };
      window.addEventListener(INTERNAL_APP_NAVIGATION_REQUEST_EVENT, onNav);

      try {
        render(<ByocCloudSetupPage />);
        expect(await screen.findByTestId("pooled-sandbox-switch-card")).toHaveTextContent(
          "Switch to Hussh Confidential Sandbox",
        );
        expect(screen.queryByTestId("hussh-pods-migration-route")).toBeNull();
        expect(screen.getByTestId("byoc-open-home-fallback")).toHaveTextContent("Open Home");

        fireEvent.click(screen.getByTestId("pooled-sandbox-switch-trigger"));
        expect(ApiService.adoptPooledSandbox).not.toHaveBeenCalled();

        const removeCheckbox = await screen.findByTestId("pooled-sandbox-remove-cloud-checkbox");
        expect(removeCheckbox).not.toBeChecked();
        fireEvent.click(removeCheckbox);
        expect(removeCheckbox).toBeChecked();

        fireEvent.click(screen.getByTestId("pooled-sandbox-switch-confirm"));
        expect(await screen.findByTestId("pooled-sandbox-switch-progress")).toBeInTheDocument();
        expect(screen.getByTestId("pooled-sandbox-switch-progress")).toHaveTextContent(
          "Locking prior pod",
        );

        await waitFor(() =>
          expect(ApiService.adoptPooledSandbox).toHaveBeenCalledWith({
            allowCleanSlate: true,
            removePriorCloudResources: true,
            isEffectCurrent: expect.any(Function),
          }),
        );

        await act(async () => {
          resolveAdopt({
            status: "ready",
            hostingMode: "hussh_pods",
            deploymentTarget: "ace",
            hushhId: "ha1_sandbox",
            podUrl: "https://sandbox-edge.dev.one.hussh.ai/u/ha1_sandbox",
            detachedPriorHost: true,
            migrationMode: "lossless_commit_log",
            backgroundCleanupQueued: true,
          });
        });

        await waitFor(() => expect(ApiService.reconnectOwnerPod).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(navHrefs).toContain(ROUTES.HOME));
        expect(window.sessionStorage.getItem(SANDBOX_CUTOVER_PILL_STORAGE_KEY)).toContain(
          "\"backgroundCleanupQueued\":true",
        );
      } finally {
        window.removeEventListener(INTERNAL_APP_NAVIGATION_REQUEST_EVENT, onNav);
      }
    },
  );

  it.each([
    {
      label: "failed GCP setup job",
      agent: { hostingMode: "pending", state: "none" },
      job: {
        ...NO_JOB,
        status: "failed",
        stage: "linking_billing",
        projectId: "owner-proj",
        errorMessage: "Billing needed",
      },
      expectConfirm: false,
    },
    {
      label: "failed Azure setup job",
      agent: { hostingMode: "pending", state: "none" },
      job: {
        ...NO_JOB,
        status: "failed",
        stage: "azure_provider_request",
        projectId: "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-1",
        errorMessage: "Quota refused",
      },
      expectConfirm: false,
    },
    {
      label: "failed Azure assigned pod",
      agent: { hostingMode: "byoc", state: "failed", deploymentTarget: "user_azure", cloudProject: "eastus2" },
      job: NO_JOB,
      expectConfirm: true,
    },
    {
      label: "connecting Azure assigned pod",
      agent: { hostingMode: "byoc", state: "connecting", deploymentTarget: "user_azure", cloudProject: "eastus2" },
      job: NO_JOB,
      expectConfirm: true,
    },
  ])(
    "offers Personal Sandbox recovery on Dev for $label",
    async ({ agent, job, expectConfirm }) => {
      vi.stubEnv("NEXT_PUBLIC_APP_ENV", "dev");
      given(agent, job);
      render(<ByocCloudSetupPage />);
      const card = await screen.findByTestId("pooled-sandbox-switch-card");
      expect(card).toHaveTextContent(
        expectConfirm ? "Switch to Hussh Confidential Sandbox" : "Start in Hussh Confidential Sandbox",
      );
      fireEvent.click(screen.getByTestId("pooled-sandbox-switch-trigger"));
      if (expectConfirm) {
        expect(ApiService.adoptPooledSandbox).not.toHaveBeenCalled();
        fireEvent.click(await screen.findByTestId("pooled-sandbox-switch-confirm"));
      }
      await waitFor(() =>
        expect(ApiService.adoptPooledSandbox).toHaveBeenCalledWith({
          allowCleanSlate: true,
          isEffectCurrent: expect.any(Function),
        }),
      );
      await waitFor(() => expect(ApiService.reconnectOwnerPod).toHaveBeenCalledTimes(1));
    },
  );

  it("renders the 3-day source-pod retirement card on non-cutover env-flagged builds and records owner confirmation", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging");
    vi.stubEnv("NEXT_PUBLIC_HOSTED_AZURE_MIGRATION_ENABLED", "1");
    const futureIso = new Date(Date.now() + 3 * 86400 * 1000).toISOString();
    vi.mocked(ApiService.getHostedSourceRetirementStatus).mockResolvedValue({
      environment: "dev",
      hasPendingConfirmation: true,
      items: [
        {
          placementId: "ret_test_123",
          sourceTarget: "user_azure",
          sourceProvider: "azure",
          sourceKind: "byoc",
          sourceLabel: "Your Azure",
          resourceHint: "rg-owner-pod",
          detachedAt: new Date().toISOString(),
          graceReapAfter: futureIso,
          daysRemaining: 3,
          graceExpired: false,
          ownerConfirmed: false,
          confirmedAt: null,
          retiredAt: null,
          status: "awaiting_owner_confirmation",
          ownerCloudCleanupReady: false,
          revokedRoleAssignmentCount: 0,
        },
      ],
    });
    vi.mocked(ApiService.confirmHostedSourceRetirement).mockResolvedValue({
      environment: "dev",
      hasPendingConfirmation: false,
      confirmedPlacementId: "ret_test_123",
      items: [
        {
          placementId: "ret_test_123",
          sourceTarget: "user_azure",
          sourceProvider: "azure",
          sourceKind: "byoc",
          sourceLabel: "Your Azure",
          resourceHint: "rg-owner-pod",
          detachedAt: new Date().toISOString(),
          graceReapAfter: futureIso,
          daysRemaining: 3,
          graceExpired: false,
          ownerConfirmed: true,
          confirmedAt: new Date().toISOString(),
          retiredAt: null,
          status: "owner_confirmed",
          ownerCloudCleanupReady: false,
          revokedRoleAssignmentCount: 0,
        },
      ],
    });

    const { HusshPodsActiveCard } = await import("@/components/connections/hussh-pods-cloud-card");
    render(<HusshPodsActiveCard deploymentTarget="azure" cutover={{ relayReady: true, directReady: true, ingress: "direct", mode: "direct" }} />);

    const card = await screen.findByTestId("hussh-pods-source-retirement");
    expect(card).toHaveTextContent("Prior cloud · Your Azure");
    expect(card).toHaveTextContent("3d left in 3-day safety window");

    fireEvent.click(await screen.findByTestId("hussh-pods-confirm-retirement-trigger"));
    fireEvent.click(await screen.findByTestId("hussh-pods-confirm-retirement-action"));

    await waitFor(() => {
      expect(ApiService.confirmHostedSourceRetirement).toHaveBeenCalledWith({
        placementId: "ret_test_123",
        isEffectCurrent: expect.any(Function),
      });
    });
    expect(await screen.findByTestId("hussh-pods-retirement-confirmed")).toBeInTheDocument();
  });

  it("keeps source-pod retirement hidden outside the dev build lane", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    const { HusshPodsActiveCard } = await import("@/components/connections/hussh-pods-cloud-card");
    render(<HusshPodsActiveCard deploymentTarget="azure" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("hussh-pods-source-retirement")).toBeNull();
    expect(ApiService.getHostedSourceRetirementStatus).not.toHaveBeenCalled();
  });

  it("hides legacy Prior cloud source-pod retirement on Dev Confidential Sandbox (ace) while keeping the home pill", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "dev");

    const { HusshPodsActiveCard, SandboxCutoverStatusPill } = await import(
      "@/components/connections/hussh-pods-cloud-card"
    );
    window.sessionStorage.setItem(
      SANDBOX_CUTOVER_PILL_STORAGE_KEY,
      JSON.stringify({ backgroundCleanupQueued: true, migrationMode: "lossless_commit_log" }),
    );
    render(
      <>
        <SandboxCutoverStatusPill />
        <HusshPodsActiveCard deploymentTarget="ace" />
      </>,
    );

    const pill = await screen.findByTestId("sandbox-cutover-ready-pill");
    expect(pill).toHaveTextContent(
      "Confidential Sandbox ready · Prior cloud cleanup running in background",
    );
    fireEvent.click(screen.getByTestId("sandbox-cutover-pill-dismiss"));
    expect(screen.queryByTestId("sandbox-cutover-ready-pill")).toBeNull();
    expect(window.sessionStorage.getItem(SANDBOX_CUTOVER_PILL_STORAGE_KEY)).toBeNull();

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("hussh-pods-source-retirement")).toBeNull();
    expect(screen.queryByText(/Prior cloud/i)).toBeNull();
    expect(ApiService.getHostedSourceRetirementStatus).not.toHaveBeenCalled();
  });

  it("hides residual Hussh Shared copy and defaults on Dev cutover lanes", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "dev");
    given({ hostingMode: "shared", state: "none" }, NO_JOB);
    const { unmount } = render(<ByocCloudSetupPage />);
    expect(await screen.findByRole("radio", { name: /Hussh Confidential Sandbox/i })).toBeInTheDocument();
    expect(screen.queryByText(/Hussh Shared/i)).toBeNull();
    expect(screen.queryByTestId("cloud-tier-shared-continue")).toBeNull();
    unmount();

    given(
      { hostingMode: "pending", state: "none" },
      {
        ...NO_JOB,
        status: "pending",
        stage: "consent_pending",
        projectId: "owner-proj",
        stages: [{ stage: "consent_pending", provider: "gcp", project: "owner-proj" }],
      },
    );
    const pendingView = render(<ByocCloudSetupPage />);
    const pendingCard = await screen.findByTestId("hosting-consent-pending");
    expect(pendingCard).not.toHaveTextContent("Hussh Shared");
    expect(screen.queryByTestId("hosting-consent-choose-shared")).toBeNull();
    pendingView.unmount();

    const { HusshPodsPausedCard } = await import("@/components/connections/hosting-placement-cards");
    render(<HusshPodsPausedCard deploymentTarget="gcp" />);
    expect(screen.getByTestId("hussh-pods-paused")).not.toHaveTextContent("Hussh Shared");
  });

  it("keeps Bring your own cloud (GCP and Azure) selectable alongside active Confidential Sandbox on Dev", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "dev");
    given({ hostingMode: "hussh_pods", deploymentTarget: "ace", state: "active" }, NO_JOB);
    render(<ByocCloudSetupPage />);

    const sandboxRadio = await screen.findByRole("radio", { name: /Hussh Confidential Sandbox/i });
    const ownCloudRadio = screen.getByRole("radio", { name: /Bring your own cloud/i });
    expect(sandboxRadio).toHaveAttribute("aria-checked", "true");
    expect(ownCloudRadio).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("hussh-pods-connected")).toBeInTheDocument();

    fireEvent.click(ownCloudRadio);
    expect(ownCloudRadio).toHaveAttribute("aria-checked", "true");
    expect(await screen.findByTestId("owner-cloud-provider-choice")).toBeInTheDocument();
    expect(screen.getByTestId("owner-cloud-provider-gcp")).toBeInTheDocument();
    expect(screen.getByTestId("owner-cloud-provider-azure")).toBeInTheDocument();

    fireEvent.click(sandboxRadio);
    expect(sandboxRadio).toHaveAttribute("aria-checked", "true");
    expect(await screen.findByTestId("hussh-pods-connected")).toBeInTheDocument();
  });
});
