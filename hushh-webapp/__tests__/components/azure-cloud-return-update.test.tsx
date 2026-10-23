/**
 * The Microsoft sign-in return for an approved update.
 *
 * In the popup, the update is handed back to the tab that approved it (the
 * profile pane or the Feed card follow it there) exactly like setup, then the
 * popup closes. Only a page that is not a popup, or whose tab never answered,
 * shows the update's progress itself, and it never says "did not finish" for an
 * update whose release the agent reports installed (live incident 2026-10-05).
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  assign: vi.fn(),
  refresh: vi.fn(),
  pathname: "/one/setup/cloud/azure/return",
  auth: { user: { uid: "owner" } as { uid: string } | null, loading: false, sessionVerificationRequired: false },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, push: vi.fn(), refresh: mocks.refresh }),
  usePathname: () => mocks.pathname,
  useSearchParams: () => new URLSearchParams("code=c0de&state=st4te"),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => mocks.auth,
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
import { AzureReturnBootRecovery } from "@/components/connections/azure-return-boot-recovery";
import { BOOT_TIMING, markBootRouteCommitted, resetBootSurfaceForTests } from "@/lib/boot/boot-surface-store";
import { AZURE_SIGN_IN_CHANNEL } from "@/lib/one/azure-sign-in";
import { ApiService } from "@/lib/services/api-service";

const complete = vi.mocked(ApiService.completeAzureByocAuthorize);
const setupStatus = vi.mocked(ApiService.getByocSetupStatus);
const agentStatus = vi.mocked(ApiService.getPersonalAgentStatus);

function job(overrides: Record<string, unknown>) {
  return {
    status: "running", stage: "", stages: [], projectId: "", jobId: "job-2", errorCode: null,
    errorMessage: null, stale: false, updatedAt: null, ...overrides,
  } as Awaited<ReturnType<typeof ApiService.getByocSetupStatus>>;
}

function agent(installed: string) {
  return {
    state: "active",
    deploymentTarget: "user_azure",
    installedRelease: { version: installed },
    availableRelease: {
      version: "2026.10-dev.7",
      summary: "",
      releasedAt: "2026-10-05T12:00:00Z",
      notes: { improvements: [], fixes: [], security: [] },
    },
  };
}

function verifiedAgent(installed: string) {
  const digest = "sha256:" + "a".repeat(64);
  return { ...agent(installed), installedReleaseVerified: true,
    installedRelease: { version: installed, imageDigest: digest },
    completedUpdate: { operationId: "op", releaseId: "rel_exact", podIncarnation: "pod-7", imageDigest: digest,
      verifiedAt: "2026-10-05T12:01:00Z", version: installed, releasedAt: "2026-10-05T12:00:00Z" } };
}

/** The hub kept the lease and recovery continues (`pod_update_presentation._blocked_update`). */
const RECOVERING = {
  updateFailed: true,
  update: {
    summary: "The update outcome could not be verified. Check again while recovery continues.",
    presentationState: "blocked",
    phase: "blocked",
  },
};

describe("the Microsoft sign-in return for an approved update", () => {
  it("does not report a recorded job as updated without a verified receipt", async () => {
    setupStatus.mockResolvedValue(job({ status: "recorded" }));
    agentStatus.mockResolvedValue(agent("2026.10-dev.7"));
    render(<AzureCloudReturnPage />);
    expect(await screen.findByTestId("azure-upgrade-confirming")).toBeTruthy();
    expect(screen.queryByTestId("azure-upgrade-done")).toBeNull();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    complete.mockResolvedValue({ status: "upgrade_started", jobId: "job-2", operationId: "op", releaseId: "rel_exact" });
    agentStatus.mockResolvedValue({ state: null });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("in the popup, hands the update and its job to the approving tab, then closes", async () => {
    vi.stubGlobal("opener", { focus: vi.fn() });
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    const approvingTab = new BroadcastChannel(AZURE_SIGN_IN_CHANNEL);
    const heard: unknown[] = [];
    approvingTab.onmessage = (event) => {
      heard.push(event.data);
      approvingTab.postMessage({ type: "azure-setup-ack" });
    };
    try {
      render(<AzureCloudReturnPage />);
      expect(await screen.findByTestId("azure-return-handed-off")).toHaveTextContent(
        "Your agent is being updated. You can close this window",
      );
      expect(screen.getByRole("heading", { name: "Updating your agent" })).toBeTruthy();
      expect(heard).toEqual([{ type: "azure-setup-started", kind: "upgrade", jobId: "job-2", operationId: "op", releaseId: "rel_exact" }]);
      expect(close).toHaveBeenCalled();
      // The progress is followed in the approving tab, not polled from the popup.
      expect(setupStatus).not.toHaveBeenCalled();
      expect(mocks.replace).not.toHaveBeenCalled();
    } finally {
      approvingTab.close();
    }
  });

  it("in its own tab (the popup was blocked), shows the update's progress here", async () => {
    setupStatus.mockResolvedValue(
      job({ stage: "importing_image", stages: [{ stage: "importing_image", at: "t" }] }),
    );
    render(<AzureCloudReturnPage />);
    expect(await screen.findByTestId("byoc-setup-progress")).toHaveTextContent(
      "Copying your agent into your subscription",
    );
    expect(screen.queryByTestId("azure-return-handed-off")).toBeNull();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("says updated, not 'did not finish', when the job failed but the agent runs the approved release", async () => {
    setupStatus.mockResolvedValue(
      job({ status: "failed", errorMessage: "Something unexpected stopped the setup. (RuntimeError)" }),
    );
    agentStatus.mockResolvedValue(verifiedAgent("2026.10-dev.7"));
    render(<AzureCloudReturnPage />);
    await waitFor(() =>
      expect(screen.getByTestId("azure-upgrade-done")).toHaveTextContent("Updated to 05.10.26 · Dev 7"),
    );
    expect(screen.queryByTestId("azure-upgrade-failed")).toBeNull();
    expect(screen.queryByText(/did not finish/)).toBeNull();
  });

  it("keeps confirming while the hub recovers a failed job, then says updated when the release is recorded", async () => {
    setupStatus.mockResolvedValue(
      job({ status: "failed", errorCode: "UPGRADE_UNCONFIRMED", errorMessage: "We could not confirm the update yet." }),
    );
    agentStatus.mockResolvedValue({ ...agent("2026.10-dev.6"), ...RECOVERING });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<AzureCloudReturnPage />);
      expect(await screen.findByTestId("azure-upgrade-confirming")).toHaveTextContent(
        "Confirming the new version with your agent…",
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(screen.queryByTestId("azure-upgrade-failed")).toBeNull();
      agentStatus.mockResolvedValue(verifiedAgent("2026.10-dev.7"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(await screen.findByTestId("azure-upgrade-done")).toHaveTextContent("Updated to 05.10.26 · Dev 7");
      // The failed job is read once; only the agent's status is asked again.
      expect(setupStatus).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a revision Azure reported failed at once, with the update sign-in again", async () => {
    const message = "The new version did not start. Your agent keeps running the version it had. Try the update again.";
    setupStatus.mockResolvedValue(job({ status: "failed", errorCode: "UPGRADE_REVISION_FAILED", errorMessage: message }));
    agentStatus.mockResolvedValue({ ...agent("2026.10-dev.6"), ...RECOVERING });
    render(<AzureCloudReturnPage />);
    expect(await screen.findByTestId("azure-upgrade-failed")).toHaveTextContent(message);
    expect(screen.getByTestId("azure-upgrade-retry")).toHaveTextContent("Try the update again");
  });

  it("calls an unconfirmed update failed once the hub settles without the release", async () => {
    setupStatus.mockResolvedValue(
      job({ status: "failed", errorCode: "UPGRADE_UNCONFIRMED", errorMessage: "We could not confirm the update yet." }),
    );
    agentStatus.mockResolvedValue({ ...agent("2026.10-dev.6"), update: { summary: "", presentationState: "ready" } });
    render(<AzureCloudReturnPage />);
    expect(await screen.findByTestId("azure-upgrade-failed")).toHaveTextContent(
      "The new version did not start. Your agent keeps running the version it had.",
    );
  });
});

describe("verified owner cold entry before shell hydration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetBootSurfaceForTests();
    mocks.pathname = "/one/setup/cloud/azure/return";
    mocks.auth = { user: { uid: "owner" }, loading: false, sessionVerificationRequired: false };
    complete.mockResolvedValue({ status: "upgrade_started", jobId: "job-2", operationId: "op", releaseId: "rel_exact" });
    setupStatus.mockResolvedValue(job({ status: "running" }));
  });
  afterEach(() => {
    vi.useRealTimers();
    resetBootSurfaceForTests();
    mocks.refresh.mockReset();
  });

  it("recovers a withheld shell once and leaves the exchange to the normal return page", async () => {
    let withheld = true;
    let reveal!: () => void;
    const pending = new Promise<void>((resolve) => { reveal = resolve; });
    function WithheldShell() {
      if (withheld) throw pending;
      return <AzureCloudReturnPage />;
    }
    mocks.refresh.mockImplementation(() => { withheld = false; reveal(); });
    render(<><AzureReturnBootRecovery /><Suspense fallback={null}><WithheldShell /></Suspense></>);
    expect(complete).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(BOOT_TIMING.stuckAfterMs - 1); });
    expect(mocks.refresh).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(BOOT_TIMING.stuckAfterMs * 2); });
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
  });

  it("does not refresh a return whose route committed before the deadline", async () => {
    render(<AzureReturnBootRecovery />);
    markBootRouteCommitted(mocks.pathname);
    await act(async () => { await vi.advanceTimersByTimeAsync(BOOT_TIMING.stuckAfterMs); });
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it.each(["/", "/one", "/one/puppy", "/one/files", "/one/setup", "/one/setup/cloud", "/one/profile/software-updates"])(
    "recovers a withheld owner shell at %s once without executing an action", async (pathname) => {
      mocks.pathname = pathname;
      render(<AzureReturnBootRecovery />);
      await act(async () => { await vi.advanceTimersByTimeAsync(BOOT_TIMING.stuckAfterMs * 3); });
      expect(mocks.refresh).toHaveBeenCalledOnce();
      expect(complete).not.toHaveBeenCalled();
    },
  );

  it.each(["different route", "signed out", "verification pending", "loading"])(
    "does not recover with %s", async (condition) => {
      if (condition === "different route") mocks.pathname = "/login";
      if (condition === "signed out") mocks.auth.user = null;
      if (condition === "verification pending") mocks.auth.sessionVerificationRequired = true;
      if (condition === "loading") mocks.auth.loading = true;
      render(<AzureReturnBootRecovery />);
      await act(async () => { await vi.advanceTimersByTimeAsync(BOOT_TIMING.stuckAfterMs * 2); });
      expect(mocks.refresh).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
    },
  );

  it("cancels a Files recovery when navigation leaves its admitted route", async () => {
    mocks.pathname = "/one/files";
    const view = render(<AzureReturnBootRecovery />);
    await act(async () => { await vi.advanceTimersByTimeAsync(BOOT_TIMING.stuckAfterMs - 1); });
    mocks.pathname = "/login";
    view.rerender(<AzureReturnBootRecovery />);
    await act(async () => { await vi.advanceTimersByTimeAsync(BOOT_TIMING.stuckAfterMs); });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("cancels the pending recovery if the owner signs out", async () => {
    const view = render(<AzureReturnBootRecovery />);
    await act(async () => { await vi.advanceTimersByTimeAsync(BOOT_TIMING.stuckAfterMs - 1); });
    mocks.auth = { ...mocks.auth, user: null };
    view.rerender(<AzureReturnBootRecovery />);
    await act(async () => { await vi.advanceTimersByTimeAsync(BOOT_TIMING.stuckAfterMs); });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
