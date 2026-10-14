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
  read: vi.fn(),
  prepare: vi.fn(),
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
  const { refresh } = useWorldModelResearch();
  return <button onClick={refresh}>Refresh</button>;
}
beforeEach(() => {
  vi.clearAllMocks();
  mock.user = { uid: "owner-a" };
  mock.key = "key-a";
  mock.token = "token-a";
  mock.pathname = "/one/profile/world-model";
  mock.preferences.mockResolvedValue({ enabled: true });
  mock.observe.mockResolvedValue(undefined);
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
