import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSettingsPanel } from "@/components/profile/agent-settings-panel";
import { NO_UPDATE } from "@/lib/feed/use-agent-deployment-follow";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

const mocks = vi.hoisted(() => ({
  follow: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  getStatus: vi.fn(),
  approve: vi.fn(),
  defer: vi.fn(),
  reconnect: vi.fn(),
  adopt: vi.fn(),
  promiseToast: vi.fn(),
  dismissToast: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/feed/use-agent-deployment-follow", async (original) => ({
  ...(await original<object>()),
  useAgentDeploymentFollow: mocks.follow,
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    getPersonalAgentStatus: mocks.getStatus,
    approvePersonalAgentUpdate: mocks.approve,
    deferPersonalAgentUpdate: mocks.defer,
    reconnectOwnerPod: mocks.reconnect,
    adoptOrphanPod: mocks.adopt,
  },
}));
vi.mock("@/lib/morphy-ux/morphy", async (original) => ({
  ...(await original<object>()),
  morphyToast: { promise: mocks.promiseToast, dismiss: mocks.dismissToast },
}));
vi.mock("@/lib/feed/feed-events", () => ({
  dispatchFeedStateChanged: vi.fn(),
}));

function status(mode: string, extra: object = {}, update = NO_UPDATE) {
  mocks.follow.mockReturnValue({
    status: { hostingMode: mode, ...extra },
    update,
    refresh: mocks.refresh,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  publishValidatedAuthSessionOwner(null);
  publishValidatedAuthSessionOwner("owner");
  mocks.promiseToast.mockImplementation((request: Promise<unknown>) => ({
    unwrap: () => request,
    valueOf: () => 42,
  }));
});

describe("owner hosting and software settings", () => {
  it.each(["hosting", "software-updates"] as const)(
    "repairs a failed BYOC link from %s without claiming direct readiness",
    async (kind) => {
      status("byoc", { state: "failed" });
      let resolve!: (value: { adopted: boolean }) => void;
      mocks.adopt.mockReturnValue(new Promise((done) => { resolve = done; }));
      render(<AgentSettingsPanel userId="owner" kind={kind} />);
      const button = screen.getByRole("button", { name: "Link existing pod" });
      fireEvent.click(button);
      fireEvent.click(button);
      expect(mocks.adopt).toHaveBeenCalledOnce();
      resolve({ adopted: true });
      await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
      expect(mocks.reconnect).not.toHaveBeenCalled();
      expect(mocks.approve).not.toHaveBeenCalled();
      expect(mocks.promiseToast.mock.calls[0][1].success()).toBe(
        "Existing pod linked. Checking its status…",
      );
    },
  );

  it("discards recovery completion after an owner changes away and back", async () => {
    status("byoc", { state: "failed" });
    let resolve!: (value: { adopted: boolean }) => void;
    mocks.adopt.mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<AgentSettingsPanel userId="owner" kind="hosting" />);
    fireEvent.click(screen.getByRole("button", { name: "Link existing pod" }));
    publishValidatedAuthSessionOwner("other-owner");
    publishValidatedAuthSessionOwner("owner");
    expect(mocks.adopt.mock.calls[0][0].isEffectCurrent()).toBe(false);
    resolve({ adopted: true });
    await expect(mocks.promiseToast.mock.calls[0][0]).rejects.toThrow("Session changed");
    expect(mocks.promiseToast.mock.calls[0][1].success()).toBeNull();
    expect(mocks.promiseToast.mock.calls[0][1].error()).toBeNull();
    expect(mocks.dismissToast).toHaveBeenCalledWith(42);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("keeps a refused recovery failed without falling through to direct access", async () => {
    status("byoc", { state: "failed" });
    mocks.adopt.mockResolvedValue({ adopted: false });
    render(<AgentSettingsPanel userId="owner" kind="software-updates" />);
    fireEvent.click(screen.getByRole("button", { name: "Link existing pod" }));
    await waitFor(() => expect(mocks.promiseToast).toHaveBeenCalledOnce());
    await expect(mocks.promiseToast.mock.calls[0][0]).rejects.toThrow("POD_RECOVERY_UNAVAILABLE");
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.reconnect).not.toHaveBeenCalled();
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("keeps a confirmed BYOC pod selected and presents the three hosting choices", () => {
    status("byoc", {
      cloudProject: "owner-project",
      cloudRegion: "us-central1",
    });
    render(<AgentSettingsPanel userId="owner" kind="hosting" />);

    expect(screen.getByText("Your cloud")).toBeTruthy();
    expect(screen.getByText("owner-project · us-central1")).toBeTruthy();
    expect(screen.getByText("Hussh Shared")).toBeTruthy();
    expect(screen.getByText("Hussh Pods")).toBeTruthy();
    expect(
      screen.getByText("Dedicated hosting is unavailable for new setups."),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Bring your own cloud/ }),
    );
    expect(mocks.push).toHaveBeenCalledWith("/one/setup/cloud");
  });

  it("shows automatic Shared updates without pod install controls or duplicate build fields", () => {
    status("shared", {
      installedRelease: {
        version: "Managed service 5d6a7ba5751e",
        sourceRevision: "5d6a7ba5751e1234567890",
      },
    });
    render(<AgentSettingsPanel userId="owner" kind="software-updates" />);

    expect(screen.getByText("Updated automatically by Hussh")).toBeTruthy();
    expect(screen.getByText("Managed build 5d6a7ba5751e")).toBeTruthy();
    expect(screen.getAllByText("Current version")).toHaveLength(1);
    expect(screen.queryByText("Build")).toBeNull();
    expect(screen.queryByRole("button", { name: "Update now" })).toBeNull();
  });

  it.each(["byoc", "hussh_pods"])(
    "offers owner-approved updates for an eligible %s pod",
    async (mode) => {
      mocks.approve.mockResolvedValue({ status: "scheduled" });
      status(
        mode,
        {
          updateOfferable: true,
          installedRelease: { version: "2026.09-dev.1" },
        },
        { ...NO_UPDATE, available: true, releaseId: "rel_exact" },
      );
      render(<AgentSettingsPanel userId="owner" kind="software-updates" />);

      fireEvent.click(screen.getByRole("button", { name: "Update now" }));
      await waitFor(() =>
        expect(mocks.approve).toHaveBeenCalledWith({
          releaseId: "rel_exact",
          idempotencyKey: expect.any(String),
        }),
      );
      await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
      expect(mocks.promiseToast.mock.calls[0][1].loading).toBe(
        "Scheduling your update…",
      );
    },
  );

  it.each([
    ["scheduled", "Update scheduled"],
    ["updating", "Updating your private agent"],
    ["blocked", "Update needs attention"],
  ] as const)("retains the %s operation without claiming a drain phase", (presentationState, label) => {
    status("byoc", { installedRelease: { version: "existing" } }, {
      ...NO_UPDATE, presentationState, offerable: false, available: true,
    });
    render(<AgentSettingsPanel userId="owner" kind="software-updates" />);
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText("existing")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update now" })).toBeNull();
  });

  it("keeps the concise changelog behind one disclosure", () => {
    status(
      "byoc",
      {
        installedReleaseVerified: true,
        installedRelease: {
          version: "2026.09-dev.1",
          sourceRevision: "abcdef1234567890",
        },
        availableRelease: {
          version: "2026.09-dev.2",
          summary: "Improved reconnect behavior.",
          notes: {
            improvements: ["Reconnect after a network change."],
            fixes: [],
            security: [],
          },
        },
      },
      { ...NO_UPDATE, available: true },
    );
    render(<AgentSettingsPanel userId="owner" kind="software-updates" />);

    expect(screen.getByText("2026.09-dev.1")).toBeTruthy();
    expect(screen.getByText("2026.09-dev.2")).toBeTruthy();
    expect(screen.getByText("What’s in this update")).toBeTruthy();
    expect(screen.queryByText("abcdef123456")).toBeNull();
  });

  it("checks the real status request and shows one loading-to-result toast", async () => {
    const response = {
      hostingMode: "byoc",
      updateOfferable: true,
      availableRelease: { version: "2026.09-dev.2" },
    };
    mocks.getStatus.mockResolvedValue(response);
    status("byoc");
    render(<AgentSettingsPanel userId="owner" kind="software-updates" />);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    expect(mocks.getStatus).toHaveBeenCalledOnce();
    const [request, copy] = mocks.promiseToast.mock.calls[0];
    expect(await request).toEqual(response);
    expect(copy.loading).toBe("Checking for updates…");
    expect(copy.success(response)).toBe(
      "Version 2026.09-dev.2 is ready to install.",
    );
  });

  it("does not label an unavailable placement Shared", async () => {
    mocks.getStatus.mockResolvedValue({ hostingMode: "unknown" });
    status("unknown");
    render(<AgentSettingsPanel userId="owner" kind="hosting" />);

    expect(screen.getByText("Hosting unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check hosting" }));
    await waitFor(() => expect(mocks.promiseToast).toHaveBeenCalledOnce());
    expect(mocks.promiseToast.mock.calls[0][1].error).toBe(
      "Couldn’t verify hosting. Try again.",
    );
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("prioritizes an unresolved update over its retained lease and reports attention", async () => {
    const response = {
      hostingMode: "byoc",
      updateFailed: true,
      updateInProgress: true,
      updateOfferable: false,
    };
    mocks.getStatus.mockResolvedValue(response);
    status("byoc", response, {
      ...NO_UPDATE,
      inProgress: true,
      failed: true,
      presentationState: "blocked",
    });
    render(<AgentSettingsPanel userId="owner" kind="software-updates" />);
    expect(screen.getByText("Update needs attention")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update now" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    expect(mocks.promiseToast.mock.calls[0][1].success(response)).toBe(
      "Update needs attention. Its outcome has not been verified.",
    );
  });
});
