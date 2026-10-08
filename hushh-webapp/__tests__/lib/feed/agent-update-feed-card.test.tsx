/**
 * The Feed's software-update card approves an Azure update without leaving the
 * Feed: the Microsoft sign-in opens in a popup and the card itself follows the
 * update to "Updated to <version>" or a failure with a retry. With nothing
 * followed, the card reads exactly as it did before.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assign: vi.fn(),
  approve: vi.fn(),
  defer: vi.fn(),
  azureUpgrade: vi.fn(),
  getStatus: vi.fn(),
  setupStatus: vi.fn(),
}));
vi.mock("@/lib/utils/browser-navigation", async (original) => ({
  ...(await original<object>()),
  assignWindowLocation: mocks.assign,
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    approvePersonalAgentUpdate: mocks.approve,
    deferPersonalAgentUpdate: mocks.defer,
    beginAzureByocUpgrade: mocks.azureUpgrade,
    getPersonalAgentStatus: mocks.getStatus,
    getByocSetupStatus: mocks.setupStatus,
  },
}));

import { azureUpdateCardBody, useAgentUpdateFeedCard } from "@/lib/feed/agent-update-feed-card";
import { NO_UPDATE, type AgentUpdateStatus } from "@/lib/feed/agent-update-status";
import { ROUTES } from "@/lib/navigation/routes";
import { AZURE_SIGN_IN_CHANNEL } from "@/lib/one/azure-sign-in";

const SIGN_IN = "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?state=feed";
const RELEASE = `rel_${"9".repeat(32)}`;
const OFFER: AgentUpdateStatus = {
  ...NO_UPDATE, available: true, offerable: true, releaseId: RELEASE, summary: "Keeps your agent current.",
};

function agent(installed: string) {
  return {
    installedRelease: { version: installed },
    availableRelease: { version: "2026.10-dev.7", releasedAt: "2026-10-05T12:00:00Z", summary: "", notes: { improvements: [], fixes: [], security: [] } },
    update: { summary: "", presentationState: "updating", phase: "installing" },
  };
}

let microsoftWindow: BroadcastChannel;
let popup: { closed: boolean; location: { assign: ReturnType<typeof vi.fn> }; focus: () => void; close: () => void };
const onResolved = vi.fn();

function renderCard(deploymentTarget: string) {
  return renderHook(() =>
    useAgentUpdateFeedCard({
      userId: "owner",
      update: OFFER,
      deploymentTarget,
      availableVersion: "2026.10-dev.7",
      onResolved,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  popup = { closed: false, location: { assign: vi.fn() }, focus: vi.fn(), close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  microsoftWindow = new BroadcastChannel(AZURE_SIGN_IN_CHANNEL);
  mocks.approve.mockResolvedValue({ operationId: "op", releaseId: RELEASE, status: "scheduled" });
  mocks.azureUpgrade.mockResolvedValue({ authorizationUrl: SIGN_IN });
  mocks.getStatus.mockResolvedValue(agent("2026.10-dev.6"));
  mocks.setupStatus.mockResolvedValue({
    status: "running", stage: "", stages: [], projectId: "", jobId: "job-9",
    errorCode: null, errorMessage: null, stale: false, updatedAt: null,
  });
});

afterEach(() => {
  microsoftWindow.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the Feed's update card for an Azure agent", () => {
  it("offers the update exactly as before while nothing is followed", () => {
    const { result } = renderCard("user_azure");
    expect(result.current).toMatchObject({
      id: `personal-agent-update:${RELEASE}`,
      title: "An update is ready",
      description: "Keeps your agent current.",
    });
    expect(result.current?.actions.map((action) => action.label)).toEqual(["Update now", "Later"]);
  });

  it("approves in a popup and follows the update on the card to updated", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderCard("user_azure");
    await act(async () => {
      await result.current?.actions.find((action) => action.key === "approve")?.run();
    });
    expect(popup.location.assign).toHaveBeenCalledWith(SIGN_IN);
    expect(mocks.assign).not.toHaveBeenCalled();
    expect(result.current?.title).toBe("Waiting for your Microsoft sign-in");

    microsoftWindow.postMessage({ type: "azure-setup-started", kind: "upgrade", jobId: "job-9" });
    await waitFor(() => expect(result.current?.title).toBe("Updating your agent"));

    mocks.getStatus.mockResolvedValue(agent("2026.10-dev.7"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await waitFor(() => expect(result.current?.title).toBe("Updated to 05.10.26 · Dev 7"));
    expect(onResolved).toHaveBeenCalled();
    expect(result.current?.actions.map((action) => action.label)).toEqual(["Done"]);
  });

  it("keeps confirming a failed job while the hub recovers it, then says updated (2026-10-05)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const summary = "The update outcome could not be verified. Check again while recovery continues.";
    mocks.setupStatus.mockResolvedValue({
      status: "failed", stage: "deploying_agent", stages: [], projectId: "", jobId: "job-9",
      errorCode: "UPGRADE_UNCONFIRMED", errorMessage: "We could not confirm the update yet.", stale: false, updatedAt: null,
    });
    mocks.getStatus.mockResolvedValue({
      ...agent("2026.10-dev.6"),
      updateFailed: true,
      update: { summary, presentationState: "blocked", phase: "blocked" },
    });
    const { result } = renderCard("user_azure");
    await act(async () => {
      await result.current?.actions.find((action) => action.key === "approve")?.run();
    });
    microsoftWindow.postMessage({ type: "azure-setup-started", kind: "upgrade", jobId: "job-9" });
    await waitFor(() => expect(result.current?.description).toBe("Confirming the new version with your agent…"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(result.current?.title).toBe("Updating your agent");

    mocks.getStatus.mockResolvedValue(agent("2026.10-dev.7"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await waitFor(() => expect(result.current?.title).toBe("Updated to 05.10.26 · Dev 7"));
  });

  it("keeps a Google agent's approval scheduled through the hub with no popup", async () => {
    const { result } = renderCard("user_gcp");
    await act(async () => {
      await result.current?.actions.find((action) => action.key === "approve")?.run();
    });
    expect(window.open).not.toHaveBeenCalled();
    expect(mocks.azureUpgrade).not.toHaveBeenCalled();
    expect(onResolved).toHaveBeenCalledOnce();
  });

  it("words every followed state, with a retry only where one helps", () => {
    const act = { retry: vi.fn(), dismiss: vi.fn() };
    expect(azureUpdateCardBody({ kind: "idle" }, OFFER, act)).toBeNull();
    expect(azureUpdateCardBody({ kind: "closed" }, OFFER, act)).toMatchObject({
      description: "The Microsoft window closed before the update started. Your agent keeps its current version.",
      actions: [{ label: "Continue", run: act.retry }],
    });
    expect(azureUpdateCardBody({ kind: "failed", message: "The new version did not start." }, OFFER, act)).toMatchObject({
      title: "The update did not finish",
      description: "The new version did not start.",
      actions: [{ label: "Try again", run: act.retry }],
    });
    expect(azureUpdateCardBody({ kind: "updating", confirming: true }, OFFER, act)).toMatchObject({
      title: "Updating your agent",
      description: "Confirming the new version with your agent…",
      actions: [],
    });
    expect(azureUpdateCardBody({ kind: "unconfirmed" }, OFFER, act)).toMatchObject({
      href: ROUTES.PROFILE_SOFTWARE_UPDATES,
      actions: [],
    });
  });
});
