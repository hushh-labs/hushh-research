/**
 * Approving an Azure update from the profile pane keeps the person in the pane.
 *
 * Founder report 2026-10-05: "the experience was I felt within the profile pane
 * and not like a completely new route". The Microsoft sign-in opens in a popup,
 * the popup hands the update back, and the pane follows it inline to "Updated
 * to <version>" or a failure with a retry. A job that failed while the agent
 * reports the approved release installed reads as updated (the live incident).
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentSettingsPanel } from "@/components/profile/agent-settings-panel";
import { NO_UPDATE } from "@/lib/feed/use-agent-deployment-follow";
import { AZURE_SIGN_IN_CHANNEL } from "@/lib/one/azure-sign-in";

const mocks = vi.hoisted(() => ({
  follow: vi.fn(),
  refresh: vi.fn(),
  getStatus: vi.fn(),
  approve: vi.fn(),
  azureUpgrade: vi.fn(),
  setupStatus: vi.fn(),
  assign: vi.fn(),
  promiseToast: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/utils/browser-navigation", async (original) => ({
  ...(await original<object>()),
  assignWindowLocation: mocks.assign,
}));
vi.mock("@/lib/feed/use-agent-deployment-follow", async (original) => ({
  ...(await original<object>()),
  useAgentDeploymentFollow: mocks.follow,
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    getPersonalAgentStatus: mocks.getStatus,
    approvePersonalAgentUpdate: mocks.approve,
    beginAzureByocUpgrade: mocks.azureUpgrade,
    getByocSetupStatus: mocks.setupStatus,
  },
}));
vi.mock("@/lib/morphy-ux/morphy", async (original) => ({
  ...(await original<object>()),
  morphyToast: { promise: mocks.promiseToast, dismiss: vi.fn() },
}));
vi.mock("@/lib/feed/feed-events", () => ({ dispatchFeedStateChanged: vi.fn() }));

const SIGN_IN = "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?state=pane";
const APPROVED = "2026.10-dev.7";
const RUNNING = "2026.10-dev.6";
const RELEASED_AT = "2026-10-05T12:00:00Z";

function agent(installed: string, update: Record<string, unknown> = {}) {
  return {
    hostingMode: "byoc",
    deploymentTarget: "user_azure",
    updateOfferable: true,
    installedRelease: { version: installed },
    availableRelease: {
      version: APPROVED,
      releasedAt: RELEASED_AT,
      summary: "Faster replies.",
      notes: { improvements: [], fixes: [], security: [] },
    },
    update: { summary: "", presentationState: "updating", phase: "installing", ...update },
  };
}

/** The hub kept the lease and recovery continues (`pod_update_presentation._blocked_update`). */
function recovering() {
  const summary = "The update outcome could not be verified. Check again while recovery continues.";
  return {
    ...agent(RUNNING),
    updateFailed: true,
    updateError: summary,
    update: { releaseId: "rel_exact", operationId: "op", presentationState: "blocked", phase: "blocked", summary },
  };
}

function job(status: "running" | "failed", extra: Record<string, unknown> = {}) {
  return {
    status, stage: "deploying_agent", stages: [], projectId: "", jobId: "job-7", errorCode: null,
    errorMessage: status === "failed" ? "The new version did not start." : null,
    stale: false, updatedAt: null, ...extra,
  };
}

function fakePopup() {
  return { closed: false, location: { assign: vi.fn() }, focus: vi.fn(), close: vi.fn() };
}

let popup: ReturnType<typeof fakePopup>;
let microsoftWindow: BroadcastChannel;

function handBack(jobId = "job-7") {
  microsoftWindow.postMessage({ type: "azure-setup-started", kind: "upgrade", jobId });
}

async function approveFromPane() {
  render(<AgentSettingsPanel userId="owner" kind="software-updates" />);
  fireEvent.click(screen.getByRole("button", { name: "Update now" }));
  await waitFor(() => expect(popup.location.assign).toHaveBeenCalledWith(SIGN_IN));
}

beforeEach(() => {
  vi.clearAllMocks();
  popup = fakePopup();
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  microsoftWindow = new BroadcastChannel(AZURE_SIGN_IN_CHANNEL);
  mocks.promiseToast.mockImplementation((request: Promise<unknown>) => ({
    unwrap: () => request,
    valueOf: () => 1,
  }));
  mocks.approve.mockResolvedValue({ operationId: "op", releaseId: "rel_exact", status: "scheduled" });
  mocks.azureUpgrade.mockResolvedValue({ authorizationUrl: SIGN_IN });
  mocks.follow.mockReturnValue({
    status: agent(RUNNING, { presentationState: "ready", phase: undefined }),
    update: { ...NO_UPDATE, available: true, offerable: true, releaseId: "rel_exact" },
    refresh: mocks.refresh,
  });
  mocks.getStatus.mockResolvedValue(agent(RUNNING));
  mocks.setupStatus.mockResolvedValue(job("running"));
});

afterEach(() => {
  microsoftWindow.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("an Azure update approved from the profile pane", () => {
  it("signs in beside the pane instead of leaving it", async () => {
    await approveFromPane();
    expect(window.open).toHaveBeenCalledWith("about:blank", "hussh-azure-sign-in", expect.stringContaining("popup"));
    expect(mocks.approve.mock.invocationCallOrder[0]).toBeLessThan(mocks.azureUpgrade.mock.invocationCallOrder[0]);
    expect(mocks.assign).not.toHaveBeenCalled();
    expect(await screen.findByTestId("azure-update-signing-in")).toHaveTextContent(
      "Finish signing in with Microsoft in the window that opened.",
    );
  });

  it("follows the handed-back update inline until the agent runs the approved release", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await approveFromPane();
    handBack();
    expect(await screen.findByTestId("azure-update-updating")).toHaveTextContent("Updating your agent");
    expect(mocks.setupStatus).toHaveBeenCalled();

    mocks.getStatus.mockResolvedValue(agent(APPROVED, { presentationState: "verified", phase: "verified" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(await screen.findByTestId("azure-update-updated")).toHaveTextContent("Updated to 05.10.26 · Dev 7");
    expect(mocks.refresh).toHaveBeenCalled();
    expect(mocks.assign).not.toHaveBeenCalled();
  });

  it("reads a failed job as updated when the agent already runs the approved release", async () => {
    mocks.setupStatus.mockResolvedValue(
      job("failed", { errorMessage: "Something unexpected stopped the setup. (RuntimeError)" }),
    );
    mocks.getStatus.mockResolvedValue(agent(APPROVED, { presentationState: "verified", phase: "verified" }));
    await approveFromPane();
    handBack();
    expect(await screen.findByTestId("azure-update-updated")).toHaveTextContent("Updated to");
    expect(screen.queryByTestId("azure-update-failed")).toBeNull();
    expect(screen.queryByText(/did not finish/)).toBeNull();
  });

  it("keeps confirming while the hub settles the update, then says updated", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.setupStatus.mockResolvedValue(job("failed"));
    mocks.getStatus.mockResolvedValue(agent(RUNNING, { presentationState: "updating", phase: "verifying" }));
    await approveFromPane();
    handBack();
    expect(await screen.findByText("Confirming the new version with your agent…")).toBeTruthy();
    expect(screen.queryByTestId("azure-update-failed")).toBeNull();

    mocks.getStatus.mockResolvedValue(agent(APPROVED, { presentationState: "verified", phase: "verified" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(await screen.findByTestId("azure-update-updated")).toBeTruthy();
  });

  it("keeps confirming while the hub holds the update for recovery, then says updated (2026-10-05)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.setupStatus.mockResolvedValue(
      job("failed", {
        errorCode: "UPGRADE_UNCONFIRMED",
        errorMessage: "We could not confirm the update yet. It is being checked; you do not need to do anything.",
      }),
    );
    mocks.getStatus.mockResolvedValue(recovering());
    await approveFromPane();
    handBack();
    expect(await screen.findByText("Confirming the new version with your agent…")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.queryByTestId("azure-update-failed")).toBeNull();
    expect(screen.queryByText(/did not finish/)).toBeNull();

    // Recovery records the approved release about 40 seconds in.
    mocks.getStatus.mockResolvedValue(agent(APPROVED, { presentationState: "verified", phase: "verified" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    expect(await screen.findByTestId("azure-update-updated")).toHaveTextContent("Updated to 05.10.26 · Dev 7");
    expect(mocks.approve).toHaveBeenCalledOnce();
  });

  it("shows a revision Azure reported failed at once, even while the hub holds the update", async () => {
    const message = "The new version did not start. Your agent keeps running the version it had. Try the update again.";
    mocks.setupStatus.mockResolvedValue(job("failed", { errorCode: "UPGRADE_REVISION_FAILED", errorMessage: message }));
    mocks.getStatus.mockResolvedValue(recovering());
    await approveFromPane();
    handBack();
    const failed = await screen.findByTestId("azure-update-failed");
    expect(failed).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "Try the update again" })).toBeTruthy();
  });

  it("shows the failure with a retry when the job failed and nothing changed", async () => {
    mocks.setupStatus.mockResolvedValue(job("failed"));
    mocks.getStatus.mockResolvedValue(agent(RUNNING, { presentationState: "scheduled", phase: "scheduled" }));
    await approveFromPane();
    handBack();
    const failed = await screen.findByTestId("azure-update-failed");
    expect(failed).toHaveTextContent("The update did not finish");
    expect(failed).toHaveTextContent("The new version did not start.");
    // Nothing is claimed about which version runs beyond what the job observed.
    expect(failed).not.toHaveTextContent("keeps its current version");

    const retryPopup = fakePopup();
    vi.mocked(window.open).mockReturnValue(retryPopup as unknown as Window);
    fireEvent.click(screen.getByRole("button", { name: "Try the update again" }));
    await waitFor(() => expect(retryPopup.location.assign).toHaveBeenCalledWith(SIGN_IN));
    expect(mocks.approve).toHaveBeenCalledOnce();
    expect(mocks.assign).not.toHaveBeenCalled();
  });

  it("says the update did not start when the Microsoft window closes before hand-back", async () => {
    await approveFromPane();
    popup.closed = true;
    expect(await screen.findByTestId("azure-update-closed", {}, { timeout: 3000 })).toHaveTextContent(
      "The Microsoft window closed before the update started. Your agent keeps its current version.",
    );
  });
});
