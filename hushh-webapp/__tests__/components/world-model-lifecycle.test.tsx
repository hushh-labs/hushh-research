import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  user: { uid: "owner-a" },
  key: "key-a",
  token: "token-a",
  pathname: "/one/profile/world-model",
  preferences: vi.fn(),
  observe: vi.fn(),
  load: vi.fn(),
  ownerDecisions: vi.fn(),
  read: vi.fn(),
  prepare: vi.fn(),
  /** Every preferences state the page rendered, in order. */
  seen: [] as string[],
}));
vi.mock("next/navigation", () => ({ usePathname: () => mock.pathname }));
vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({
    user: mock.user,
    loading: false,
    sessionVerificationRequired: false,
  }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    vaultKey: mock.key,
    vaultOwnerToken: mock.token,
    isVaultUnlocked: true,
    tokenExpiresAt: null,
  }),
}));
vi.mock("@/lib/agent/agent-pkm-capture-runtime", () => ({
  createAgentPkmCaptureGuard: ({
    signal,
    isEnabled,
  }: {
    signal: AbortSignal;
    isEnabled: () => boolean;
  }) => ({
    isCurrent: () => !signal.aborted && isEnabled(),
    assertCurrent: () => {
      if (signal.aborted || !isEnabled()) throw new Error("stale");
    },
  }),
}));
vi.mock("@/lib/services/world-model-research-service", () => ({
  WorldModelResearchService: {
    preferences: mock.preferences,
    observe: mock.observe,
  },
}));
vi.mock("@/lib/services/world-model-decision-service", () => ({
  WorldModelDecisionService: {
    load: mock.load,
    ownerDecisions: mock.ownerDecisions,
  },
}));
vi.mock("@/lib/services/world-model-source-service", () => ({
  WorldModelSourceService: { read: mock.read, prepare: mock.prepare },
}));
vi.mock("@/components/agent/profile-research-card", () => ({
  ProfileResearchCard: ({
    initialResult,
  }: {
    initialResult: { draft_id: string };
  }) => <div>{initialResult.draft_id}</div>,
}));
import {
  WorldModelProvider,
  useWorldModelResearch,
} from "@/components/profile/world-model-provider";
import { WorldModelSources } from "@/components/profile/world-model-sources";
function Probe() {
  const { refresh, reload, mounted, preferences, failed } =
    useWorldModelResearch();
  const switches = preferences
    ? preferences.enabled
      ? "enrolled"
      : "opted out"
    : "no preferences";
  mock.seen.push(switches);
  return (
    <>
      <button onClick={refresh}>Refresh</button>
      <button onClick={() => reload()}>Reload</button>
      <button
        onClick={() =>
          reload({
            enabled: false,
            email_enabled: true,
            consent_version: "pwm-native-v1",
          })
        }
      >
        Turn off
      </button>
      <span>{mounted ? "mounted" : "outside"}</span>
      <span>{switches}</span>
      <span>{failed ? "failed" : "not failed"}</span>
    </>
  );
}
const pending = {
  status: "pending",
  pkm_written: false,
  restart_required: false,
} as const;
const decisions = { confirmed: ["Saved."], rejected: ["Declined."] };
beforeEach(() => {
  vi.clearAllMocks();
  mock.user = { uid: "owner-a" };
  mock.key = "key-a";
  mock.token = "token-a";
  mock.pathname = "/one/profile/world-model";
  mock.seen.length = 0;
  mock.preferences.mockResolvedValue({ enabled: true });
  mock.observe.mockResolvedValue(undefined);
  mock.load.mockResolvedValue({});
  mock.ownerDecisions.mockReturnValue(decisions);
});
describe("PWM owner and request isolation", () => {
  it("consumes refresh before another account or vault token takes over", async () => {
    const { rerender } = render(
      <WorldModelProvider>
        <Probe />
      </WorldModelProvider>,
    );
    await waitFor(() => expect(mock.observe).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("Refresh"));
    await waitFor(() => expect(mock.observe).toHaveBeenCalledTimes(2));
    expect(mock.observe.mock.calls[1][0].refresh).toBe(true);
    mock.user = { uid: "owner-b" };
    mock.key = "key-b";
    mock.token = "token-b";
    rerender(
      <WorldModelProvider>
        <Probe />
      </WorldModelProvider>,
    );
    await waitFor(() => expect(mock.observe).toHaveBeenCalledTimes(3));
    expect(mock.observe.mock.calls[2][0].refresh).not.toBe(true);
    mock.token = "renewed-b";
    rerender(
      <WorldModelProvider>
        <Probe />
      </WorldModelProvider>,
    );
    await waitFor(() => expect(mock.observe).toHaveBeenCalledTimes(4));
    expect(mock.observe.mock.calls[3][0].refresh).not.toBe(true);
  });
  it("starts research for an owner with no preferences row and forwards decisions", async () => {
    mock.preferences.mockResolvedValue({
      enabled: true,
      email_enabled: true,
      consent_version: "pwm-native-v1",
    });
    mock.observe.mockImplementation(async ({ onResult }) => {
      expect(mock.preferences).not.toHaveBeenCalled();
      onResult({
        status: "pending",
        pkm_written: false,
        restart_required: false,
      });
    });
    render(
      <WorldModelProvider>
        <Probe />
      </WorldModelProvider>,
    );
    await screen.findByText("enrolled");
    expect(screen.getByText("mounted")).toBeInTheDocument();
    expect(mock.load.mock.calls[0][0].userId).toBe("owner-a");
    expect(mock.observe).toHaveBeenCalledTimes(1);
    expect(mock.observe.mock.calls[0][0].ownerDecisions).toEqual(decisions);
  });
  it("keeps researching when memory is unreadable, and never during setup", async () => {
    mock.load.mockRejectedValue(new Error("locked"));
    const { unmount } = render(
      <WorldModelProvider>
        <Probe />
      </WorldModelProvider>,
    );
    await waitFor(() => expect(mock.observe).toHaveBeenCalledTimes(1));
    expect(mock.observe.mock.calls[0][0].ownerDecisions).toBeUndefined();
    unmount();
    vi.clearAllMocks();
    mock.pathname = "/one/setup/profile";
    render(
      <WorldModelProvider>
        <Probe />
      </WorldModelProvider>,
    );
    await act(async () => {});
    expect(mock.load).not.toHaveBeenCalled();
    expect(mock.observe).not.toHaveBeenCalled();
  });
  it("keeps the last known switches while research restarts for the same owner", async () => {
    mock.observe.mockImplementation(async ({ onResult }) => onResult(pending));
    const view = () => (
      <WorldModelProvider>
        <Probe />
      </WorldModelProvider>
    );
    const { rerender } = render(view());
    await screen.findByText("enrolled");
    // The restarted run's own read never lands.
    mock.preferences.mockReturnValue(new Promise(() => {}));
    mock.seen.length = 0;
    fireEvent.click(screen.getByText("Reload"));
    await waitFor(() => expect(mock.preferences).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(mock.observe).toHaveBeenCalledTimes(2);
    expect(mock.seen).not.toContain("no preferences");
    expect(screen.getByText("enrolled")).toBeInTheDocument();
    // A confirmed write shows at once and survives the restart.
    fireEvent.click(screen.getByText("Turn off"));
    await waitFor(() => expect(mock.preferences).toHaveBeenCalledTimes(3));
    await act(async () => {});
    expect(screen.getByText("opted out")).toBeInTheDocument();
    // Negative control: switches never carry over to another vault token.
    mock.token = "token-renewed";
    rerender(view());
    await waitFor(() => expect(mock.preferences).toHaveBeenCalledTimes(4));
    await act(async () => {});
    expect(screen.getByText("no preferences")).toBeInTheDocument();
  });
  it("still reads the switches when preparing fails, so research can be turned off", async () => {
    mock.observe.mockRejectedValue(new Error("ensure failed"));
    render(
      <WorldModelProvider>
        <Probe />
      </WorldModelProvider>,
    );
    expect(await screen.findByText("enrolled")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(mock.preferences).toHaveBeenCalledTimes(1);
  });
  it("tells a page when no provider is mounted", () => {
    render(<Probe />);
    expect(screen.getByText("outside")).toBeInTheDocument();
  });
  it("publishes to a reader mounted beside the provider, as the Profile pane is", async () => {
    mock.observe.mockImplementation(async ({ onResult }) => onResult(pending));
    // app/providers.tsx renders the Profile pane as a sibling of the provider.
    const view = (provider: boolean) => (
      <>
        {provider ? (
          <WorldModelProvider>
            <span>app</span>
          </WorldModelProvider>
        ) : null}
        <section>
          <Probe />
        </section>
      </>
    );
    const { rerender } = render(view(true));
    await screen.findByText("enrolled");
    expect(screen.getByText("mounted")).toBeInTheDocument();
    // Its actions reach the one reader; the sibling never starts another.
    expect(mock.observe).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Refresh"));
    await waitFor(() => expect(mock.observe).toHaveBeenCalledTimes(2));
    expect(mock.observe.mock.calls[1][0].refresh).toBe(true);
    // A renewed vault token hides the previous token's switches at once.
    mock.preferences.mockReturnValue(new Promise(() => {}));
    mock.token = "token-renewed";
    rerender(view(true));
    expect(screen.getByText("no preferences")).toBeInTheDocument();
    // Without a provider the sibling is told so, and keeps nothing.
    rerender(view(false));
    expect(screen.getByText("outside")).toBeInTheDocument();
    expect(screen.getByText("no preferences")).toBeInTheDocument();
  });
  it("does not let an old initial read replace a newly prepared draft", async () => {
    let finish!: (value: unknown) => void;
    mock.read.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    mock.prepare.mockResolvedValue({
      status: "offered",
      draft_id: "new-draft",
    });
    render(
      <WorldModelSources
        ownerId="owner-a"
        vaultKey="key-a"
        vaultOwnerToken="token-a"
        name="Alice"
      />,
    );
    fireEvent.change(
      screen.getByLabelText("Public source links, one per line"),
      { target: { value: "https://example.test/alice" } },
    );
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(
      screen.getByRole("button", { name: "Prepare details to review" }),
    );
    await screen.findByText("new-draft");
    await act(async () => finish({ status: "offered", draft_id: "old-draft" }));
    expect(screen.getByText("new-draft")).toBeInTheDocument();
    expect(screen.queryByText("old-draft")).not.toBeInTheDocument();
  });
});
