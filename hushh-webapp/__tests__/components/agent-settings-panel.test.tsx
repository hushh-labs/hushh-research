import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSettingsPanel } from "@/components/profile/agent-settings-panel";
import { NO_UPDATE } from "@/lib/feed/use-agent-deployment-follow";

const mocks = vi.hoisted(() => ({
  follow: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  approve: vi.fn(),
  defer: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/feed/use-agent-deployment-follow", async (original) => ({
  ...(await original<object>()),
  useAgentDeploymentFollow: mocks.follow,
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    approvePersonalAgentUpdate: mocks.approve,
    deferPersonalAgentUpdate: mocks.defer,
  },
}));
vi.mock("@/lib/feed/feed-events", () => ({
  dispatchFeedStateChanged: vi.fn(),
}));

function status(mode: string, extra: object = {}) {
  mocks.follow.mockReturnValue({
    status: { hostingMode: mode, ...extra },
    update: NO_UPDATE,
    refresh: mocks.refresh,
  });
}
beforeEach(() => {
  vi.clearAllMocks();
});

describe("owner hosting and software settings", () => {
  it("offers Shared users the existing cloud setup route, without install controls", () => {
    status("shared");
    const view = render(<AgentSettingsPanel userId="owner" kind="hosting" />);
    fireEvent.click(screen.getByRole("button", { name: "Set up your cloud" }));
    expect(mocks.push).toHaveBeenCalledWith("/one/setup/cloud");
    view.rerender(
      <AgentSettingsPanel userId="owner" kind="software-updates" />,
    );
    expect(screen.getByText("Managed by Hussh")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update now" })).toBeNull();
  });
  it.each([
    ["pending", "Continue setup"],
    ["byoc", "Manage hosting"],
    ["hussh_pods", "Manage hosting"],
  ])("preserves the %s assignment", (mode, label) => {
    status(mode);
    render(<AgentSettingsPanel userId="owner" kind="hosting" />);
    expect(screen.getByRole("button", { name: label })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Set up your cloud" }),
    ).toBeNull();
    expect(
      screen.getByText("New Hussh Pods deployments are currently unavailable."),
    ).toBeTruthy();
  });
  it("does not turn unknown placement into Shared", () => {
    status("unknown");
    render(<AgentSettingsPanel userId="owner" kind="hosting" />);
    expect(
      screen.queryByRole("button", { name: "Set up your cloud" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check hosting" }));
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });
  it("requires an explicit eligible release and submits that exact release", async () => {
    status("byoc");
    const view = render(
      <AgentSettingsPanel userId="owner" kind="software-updates" />,
    );
    expect(screen.queryByRole("button", { name: "Update now" })).toBeNull();
    mocks.follow.mockReturnValue({
      status: { hostingMode: "byoc", updateOfferable: true },
      update: { ...NO_UPDATE, available: true, releaseId: "rel_exact" },
      refresh: mocks.refresh,
    });
    view.rerender(
      <AgentSettingsPanel userId="owner" kind="software-updates" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    await waitFor(() =>
      expect(mocks.approve).toHaveBeenCalledWith({
        releaseId: "rel_exact",
        idempotencyKey: expect.any(String),
      }),
    );
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });
  it("distinguishes installed verification from checking a newer release", () => {
    status("byoc", {
      installedRelease: { version: "2026.09-dev.1" },
      installedReleaseVerifiedAt: "2026-09-24T10:00:00Z",
      releaseCheckedAt: "2026-09-25T11:00:00Z",
      availableRelease: {
        version: "2026.09-dev.2",
        summary: "Improved reconnect behavior.",
        notes: { improvements: ["Reconnect after a network interruption."], fixes: [], security: [] },
      },
    });
    render(<AgentSettingsPanel userId="owner" kind="software-updates" />);
    expect(screen.getByText("2026.09-dev.1")).toBeTruthy();
    expect(screen.getByText("2026.09-dev.2")).toBeTruthy();
    expect(screen.getByText("Installation verified")).toBeTruthy();
    expect(screen.getByText("Release channel checked")).toBeTruthy();
    expect(screen.getByText("Reconnect after a network interruption.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update now" })).toBeNull();
  });
  it.each([
    ["unreachable", "Not responding. Installed version details are from the last verification."],
    ["sleeping", "Asleep; wakes when needed."],
    [undefined, "Connection not verified"],
  ])("keeps %s connection evidence separate from a verified installation", (health, label) => {
    mocks.follow.mockReturnValue({
      status: { hostingMode: "byoc", health, installedReleaseVerified: true },
      update: { ...NO_UPDATE, available: false },
      refresh: mocks.refresh,
    });
    render(<AgentSettingsPanel userId="owner" kind="software-updates" />);
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText("Latest offered version installed")).toBeTruthy();
    expect(screen.queryByText("Up to date")).toBeNull();
  });
});
