import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchPuppyStatus: vi.fn(),
  fetchPuppyResources: vi.fn(),
  fetchPuppyJobs: vi.fn(),
  setPuppyJobPaused: vi.fn(),
  link: { current: null as unknown },
  localHost: true,
  owner: "owner",
  hosting: vi.fn(),
}));

vi.mock("@/lib/firebase", () => ({ useAuth: () => ({ user: { uid: mocks.owner } }) }));
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getCurrentUser: () => ({ uid: mocks.owner }) },
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { getPersonalAgentStatus: mocks.hosting },
}));
vi.mock("@/lib/hermes/local-host", () => ({
  isLocalHost: () => mocks.localHost,
}));

vi.mock("@/components/agent/private-puppy-inference-panel", () => ({
  PrivatePuppyInferencePanel: ({ sharedDock = false, active = true }) => <div data-testid="private-puppy-panel">
    <AgentDockPortal enabled={sharedDock} active={active} visible><AgentBarSurface embedded={sharedDock}>
      <textarea aria-label="Message Puppy One" />
    </AgentBarSurface></AgentDockPortal>
  </div>,
}));

vi.mock("@/lib/services/puppy-one-service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/services/puppy-one-service")>();
  return {
    ...original,
    fetchPuppyStatus: mocks.fetchPuppyStatus,
    fetchPuppyResources: mocks.fetchPuppyResources,
    fetchPuppyJobs: mocks.fetchPuppyJobs,
    setPuppyJobPaused: mocks.setPuppyJobPaused,
  };
});

vi.mock("@/lib/hermes/use-puppy-link", () => ({
  usePuppyLink: () => mocks.link.current,
}));

vi.mock("@/components/agent/puppy-model-picker", () => ({
  PuppyModelPicker: () => null,
}));

import { PuppyOneSurface } from "@/components/agent/puppy-one-surface";
import { AgentDockPortal, AgentDockProvider, AgentDockVoiceBoundary } from "@/components/agent/agent-dock";
import { AgentBarSurface, RetainedAgentBar } from "@/components/agent/agent-bar-surface";
import type { PuppyLink } from "@/lib/services/puppy-one-service";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { usePuppyConversations } from "@/lib/agent/puppy-conversations";
import { useNativeDockPorts } from "@/components/agent/native-dock-port";

/**
 * The Puppy One mode, as the workspace mounts it.
 *
 * Two things are load-bearing. Somebody who has never installed anything must
 * be told what this is, once, before being handed an install link. And the
 * mode is kept MOUNTED and hidden when the reader looks at One, so a local
 * answer that takes tens of seconds is not destroyed by the glance, which
 * means `active` has to be what stops it polling and what closes its machine
 * panel: that panel is a portal on document.body, and a `hidden` class on this
 * surface's root cannot reach it.
 */

function link(overrides: Partial<PuppyLink>): PuppyLink {
  return {
    state: "unavailable",
    device: null,
    activeCount: 0,
    checkedAt: Date.now(),
    ...overrides,
  };
}

function reporting(): PuppyLink {
  const now = Date.now();
  return link({
    state: "live",
    activeCount: 1,
    device: {
      id: "dev-1",
      name: "Kushal's Mac",
      lastHeartbeatAt: now - 60_000,
      lastSyncedAt: null,
      heartbeat: { current_model: "gemma-4-26b-a4b-qat", busy: false },
    },
  });
}

beforeEach(() => {
  mocks.owner = "owner";
  publishValidatedAuthSessionOwner(null);
  publishValidatedAuthSessionOwner(mocks.owner);
  mocks.hosting.mockResolvedValue({ hostingMode: "byoc", state: "active", hushhId: "pod-1" });
  mocks.localHost = true;
  mocks.fetchPuppyStatus.mockResolvedValue({ connected: false });
  mocks.fetchPuppyResources.mockResolvedValue({
    configured: true,
    reachable: true,
    agent: { model: "m", on_device: true, on_device_gate: true },
  });
  mocks.fetchPuppyJobs.mockResolvedValue({
    configured: true,
    reachable: true,
    jobs: [],
  });
  mocks.link.current = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("PuppyOneSurface identity", () => {
  it("opens the Puppy composer on first activation without a second Start step", async () => {
    mocks.fetchPuppyStatus.mockResolvedValue({ connected: true, model: "local-model" });
    function Workspace() {
      const history = usePuppyConversations(mocks.owner, true);
      return <AgentDockProvider>
        <PuppyOneSurface sharedDock conversations={history.conversations} activeConversationId={history.activeId} onCreateConversation={history.create} />
        <AgentDockVoiceBoundary><RetainedAgentBar><AgentBarSurface><button>Cloud voice</button></AgentBarSurface></RetainedAgentBar></AgentDockVoiceBoundary>
      </AgentDockProvider>;
    }
    render(<Workspace />);
    const input = await screen.findByPlaceholderText("Ask Puppy One…");
    expect(input).toBeEnabled();
    expect(input.closest("[data-agent-dock-composer]")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Start a Puppy chat" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cloud voice" })).not.toBeInTheDocument();
  });

  it.each([true, false])("keeps Shared off the local bridge and relay (localhost=%s)", async (localHost) => {
    mocks.localHost = localHost;
    mocks.hosting.mockResolvedValue({ hostingMode: "shared" });
    let native: ReturnType<typeof useNativeDockPorts> = null;
    function DockObserver() {
      const ports = useNativeDockPorts();
      useLayoutEffect(() => { native = ports; });
      return null;
    }
    render(<AgentDockProvider><DockObserver /><PuppyOneSurface sharedDock />
      <AgentDockVoiceBoundary><RetainedAgentBar><AgentBarSurface><button>Cloud voice</button></AgentBarSurface></RetainedAgentBar></AgentDockVoiceBoundary>
    </AgentDockProvider>);
    expect(await screen.findByText("Puppy needs your own cloud.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Hosting" })).toHaveAttribute("href", "/one/profile/hosting");
    expect(screen.queryByTestId("private-puppy-panel")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message Puppy One" })).toBeDisabled();
    expect(native!.get("text")?.projection).toMatchObject({ editable: false, sendEnabled: false, micEnabled: false });
    expect(screen.queryByRole("button", { name: "Cloud voice" })).not.toBeInTheDocument();
    expect(mocks.fetchPuppyStatus).not.toHaveBeenCalled();
    expect(mocks.fetchPuppyResources).not.toHaveBeenCalled();
  });

  it("rejects a previous owner's delayed placement response", async () => {
    let resolve!: (value: object) => void;
    mocks.localHost = false;
    mocks.hosting.mockImplementationOnce(() => new Promise(value => { resolve = value; }));
    const view = render(<PuppyOneSurface />);
    mocks.owner = "next-owner";
    publishValidatedAuthSessionOwner(mocks.owner);
    mocks.hosting.mockResolvedValue({ hostingMode: "shared" });
    view.rerender(<PuppyOneSurface />);
    await screen.findByText("Puppy needs your own cloud.");
    await act(async () => { resolve({ hostingMode: "byoc", hushhId: "old-pod" }); });
    expect(screen.queryByTestId("private-puppy-panel")).not.toBeInTheDocument();
  });

  it("fences an old placement read across sign-out and sign-in to the same account", async () => {
    let settle!: (value: object) => void;
    mocks.localHost = false;
    mocks.hosting.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    const view = render(<PuppyOneSurface />);
    publishValidatedAuthSessionOwner(null);
    publishValidatedAuthSessionOwner("owner");
    mocks.hosting.mockResolvedValue({ hostingMode: "shared" });
    view.rerender(<PuppyOneSurface />);
    await screen.findByText("Puppy needs your own cloud.");
    await act(async () => { settle({ hostingMode: "byoc", hushhId: "old-pod" }); });
    expect(screen.queryByTestId("private-puppy-panel")).not.toBeInTheDocument();
  });

  it("retains the admitted transcript across a failed status refresh", async () => {
    mocks.localHost = false;
    const view = render(<PuppyOneSurface />);
    const transcript = await screen.findByTestId("private-puppy-panel");
    view.rerender(<PuppyOneSurface active={false} />);
    mocks.hosting.mockRejectedValueOnce(new Error("offline"));
    view.rerender(<PuppyOneSurface active />);
    await screen.findByText("Couldn’t check your agent.");
    expect(screen.getByTestId("private-puppy-panel")).toBe(transcript);
    expect(transcript.closest("[inert]")).toBeNull();
  });

  it("uses the owner pod relay on a deployed origin", async () => {
    mocks.localHost = false;
    mocks.link.current = reporting();
    const view = render(<AgentDockProvider>
      <PuppyOneSurface sharedDock />
      <AgentDockVoiceBoundary><RetainedAgentBar><AgentBarSurface><button>Cloud voice</button></AgentBarSurface></RetainedAgentBar></AgentDockVoiceBoundary>
    </AgentDockProvider>);
    expect(await screen.findByTestId("private-puppy-panel")).toBeInTheDocument();
    expect(mocks.fetchPuppyStatus).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Cloud voice" })).not.toBeInTheDocument();
    view.rerender(<AgentDockProvider>
      <PuppyOneSurface sharedDock active={false} />
      <AgentDockVoiceBoundary><RetainedAgentBar><AgentBarSurface><button>Cloud voice</button></AgentBarSurface></RetainedAgentBar></AgentDockVoiceBoundary>
    </AgentDockProvider>);
    expect(await screen.findByRole("button", { name: "Cloud voice" })).toBeInTheDocument();
  });
  it("says what Puppy One is to someone who has never connected one", async () => {
    mocks.link.current = link({ state: "unlinked" });
    render(<PuppyOneSurface />);
    expect(
      await screen.findByText(
        /A local model on your trusted machine\. Requests and replies travel through your private pod\./,
      ),
    ).toBeInTheDocument();
  });

  it("does not repeat it to an owner whose machine is already reporting", async () => {
    mocks.link.current = reporting();
    render(<PuppyOneSurface />);
    await waitFor(() => expect(mocks.fetchPuppyStatus).toHaveBeenCalled());
    expect(
      screen.queryByText(/A local model on your trusted machine/),
    ).not.toBeInTheDocument();
  });
});

describe("PuppyOneSurface when it is not the surface on screen", () => {
  it("takes no readings at all", async () => {
    mocks.link.current = reporting();
    render(<PuppyOneSurface active={false} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.fetchPuppyStatus).not.toHaveBeenCalled();
    expect(mocks.fetchPuppyResources).not.toHaveBeenCalled();
  });

  it("reads again the moment it comes back, rather than showing a stale pill", async () => {
    // Green means "reported inside the freshness window". Coming back after
    // ten minutes hidden to a cached green pill would assert a live machine
    // on stale data, which is the one promise this pill makes.
    mocks.link.current = reporting();
    const view = render(<PuppyOneSurface active={false} />);
    view.rerender(<PuppyOneSurface active />);
    await waitFor(() => expect(mocks.fetchPuppyStatus).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(mocks.fetchPuppyResources).toHaveBeenCalledTimes(1),
    );
  });

  it("closes the machine panel instead of leaving it over One's transcript", async () => {
    mocks.link.current = reporting();
    const view = render(<PuppyOneSurface active />);
    fireEvent.click(await screen.findByRole("button", { name: /this machine/i }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    view.rerender(<PuppyOneSurface active={false} />);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
});
