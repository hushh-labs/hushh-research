import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  user: { uid: "owner-a" },
  key: "key-a",
  token: "token-a",
  pathname: "/one/profile/world-model",
  skipBackgroundWrites: false,
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
vi.mock("@/lib/testing/native-test", async original => {
  const actual = await original<typeof import("@/lib/testing/native-test")>();
  return { ...actual, shouldSkipReviewerBackgroundWritesForAutomation: () => mock.skipBackgroundWrites || actual.shouldSkipReviewerBackgroundWritesForAutomation() };
});
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
import { worldModelResearchStore } from "@/lib/world-model/research-store";
import { useWorldModelOwnerState } from "@/components/profile/world-model-owner-state";
import { nativeSearchSuggestions } from "@/components/profile/world-model-search-suggestions";
function Probe() {
  const {
    refresh,
    reload,
    mounted,
    preferences,
    failed,
    retrying,
    progress,
    validatedFacts,
    live,
    lastActivityAt,
    retryAt,
  } = useWorldModelResearch();
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
            research_provider: "vertex_google_search",
          })
        }
      >
        Turn off
      </button>
      <span>{mounted ? "mounted" : "outside"}</span>
      <span>{switches}</span>
      <span>{failed ? "failed" : "not failed"}</span>
      <span>{retrying ? "retrying" : "not retrying"}</span>
      <span>{live ? "live" : "idle"}</span>
      <span>
        {progress
          ? `progress ${progress.stage} ${progress.searches_used}`
          : "no progress"}
      </span>
      <span>{validatedFacts.length ? `findings ${validatedFacts.length}` : "no findings"}</span>
      <span>
        {lastActivityAt === null ? "no activity" : `activity ${lastActivityAt}`}
      </span>
      <span>{retryAt === null ? "no retry" : `retry at ${retryAt}`}</span>
    </>
  );
}
const pending = {
  status: "pending",
  pkm_written: false,
  restart_required: false,
} as const;
const decisions = { confirmed: ["Saved."], rejected: ["Declined."] };
/**
 * Lets every pending promise run and React paint, without the library's
 * own waiting helpers, which hang while setTimeout is faked.
 */
const settle = () =>
  act(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
beforeEach(() => {
  vi.clearAllMocks();
  mock.user = { uid: "owner-a" };
  mock.key = "key-a";
  mock.token = "token-a";
  mock.pathname = "/one/profile/world-model";
  mock.skipBackgroundWrites = false;
  mock.seen.length = 0;
  mock.preferences.mockResolvedValue({ enabled: true });
  mock.observe.mockResolvedValue(undefined);
  mock.load.mockResolvedValue({});
  mock.ownerDecisions.mockReturnValue(decisions);
});
afterEach(() => {
  vi.useRealTimers();
  delete (document as { hidden?: boolean }).hidden;
});
describe("PWM owner and request isolation", () => {
  it.each([
    ["read_only", true], ["preparation_only", true],
    ["bounded_mutation", true], ["mutation_authorized", false],
  ] as const)("restores retained findings with %s admission without swallowing explicit refresh", async (policy, readOnly) => {
    const previous = window.__HUSHH_NATIVE_TEST__;
    window.__HUSHH_NATIVE_TEST__ = { enabled: true, autoReviewerLogin: true, reviewerMutationPolicy: policy };
    mock.observe.mockImplementation(async ({ onPartial }) => onPartial([{ id: "retained-finding" }]));
    const view = render(<WorldModelProvider><Probe /></WorldModelProvider>);
    try {
      await screen.findByText("findings 1");
      expect(mock.observe).toHaveBeenCalledOnce();
      expect(mock.observe.mock.calls[0][0]).toMatchObject({ readOnly, refresh: false });
      fireEvent(document, new Event("visibilitychange"));
      await settle();
      expect(mock.observe).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByText("Reload"));
      await waitFor(() => expect(mock.observe).toHaveBeenCalledTimes(2));
      expect(mock.observe.mock.calls[1][0]).toMatchObject({ readOnly, refresh: false });
      fireEvent.click(screen.getByText("Refresh"));
      await waitFor(() => expect(mock.observe).toHaveBeenCalledTimes(3));
      expect(mock.observe.mock.calls.at(-1)?.[0]).toMatchObject({ readOnly: false, refresh: true });
    } finally {
      view.unmount();
      window.__HUSHH_NATIVE_TEST__ = previous;
    }
  });

  it("preserves no-op state updates so repeated query synchronization cannot render-loop", () => {
    const owner = { live: true };
    let renders = 0;
    const view = renderHook(() => { renders += 1; return useWorldModelOwnerState<string | null>(owner, null); });
    const before = renders;
    act(() => view.result.current[1](null));
    expect(renders).toBe(before);
    act(() => view.result.current[1]("public-sample"));
    expect(view.result.current[0]).toBe("public-sample");
    view.unmount();
  });
  it("keeps provider attribution inert and never maps executable or credential-bearing links", () => {
    const result = nativeSearchSuggestions('<style>secret-css</style><script>secret-script</script><p>Google related searches</p><a href="https://www.google.com/search?q=public">Public search</a><a href="javascript:alert(1)">Blocked</a><a href="https://user:pass@example.test/">Blocked credentials</a>');
    expect(result.text).toContain("Google related searches");
    expect(result.text).not.toMatch(/secret-css|secret-script/);
    expect(result.links).toEqual([{ title: "Public search", url: "https://www.google.com/search?q=public" }]);
  });
  it("rejects a sibling's old snapshot before the provider can update its owner or token", () => {
    const writer = worldModelResearchStore.attach({ reload: vi.fn(), refresh: vi.fn(), researchPublicProfiles: vi.fn() });
    const owner = { owner: "owner-a", key: "key-a", token: "token-a" };
    writer.setAuthority(owner);
    writer.setSnapshot(() => ({ ...owner, result: pending, preferences: { enabled: true, email_enabled: true,
      consent_version: "pwm-native-v1", research_provider: "vertex_google_search" },
      failed: false, retrying: false, progress: null, validatedFacts: [], live: false, lastActivityAt: null, retryAt: null }));
    const view = render(<Probe />);
    try {
      expect(screen.getByText("enrolled")).toBeInTheDocument();
      mock.token = "renewed-token-a";
      view.rerender(<Probe />);
      expect(screen.getByText("no preferences")).toBeInTheDocument();
      mock.user = { uid: "owner-b" }; mock.key = "key-b"; mock.token = "token-b";
      view.rerender(<Probe />);
      expect(screen.getByText("no preferences")).toBeInTheDocument();
    } finally { writer.detach(); }
  });
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
      research_provider: "vertex_google_search",
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
  it("publishes live progress, and clears it when research ends", async () => {
    let finish!: () => void;
    mock.observe.mockImplementation(async ({ onProgress, onResult }) => {
      onResult(pending);
      onProgress({ stage: "coverage", searches_used: 7 });
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      onResult({ status: "saved", pkm_written: false });
    });
    render(
      <WorldModelProvider>
        <Probe />
      </WorldModelProvider>,
    );
    expect(await screen.findByText("progress coverage 7")).toBeInTheDocument();
    expect(screen.getByText("live")).toBeInTheDocument();
    await act(async () => finish());
    expect(screen.getByText("no progress")).toBeInTheDocument();
    expect(screen.getByText("idle")).toBeInTheDocument();
  });
  it("retains the last progress update when research ends unavailable", async () => {
    mock.observe.mockImplementation(async ({ onProgress, onResult }) => {
      onResult(pending);
      onProgress({ stage: "report", searches_used: 9 });
      onResult({
        status: "unavailable", pkm_written: false,
        progress: { stage: "report", searches_used: 9 },
        validated_facts: [],
      });
    });
    render(
      <WorldModelProvider>
        <Probe />
      </WorldModelProvider>,
    );
    expect(await screen.findByText("progress report 9")).toBeInTheDocument();
    expect(screen.getByText("idle")).toBeInTheDocument();
  });
  it("shows retrying immediately and keeps the checkpoint until a fresh result arrives", async () => {
    mock.observe.mockImplementationOnce(async ({ onProgress, onResult }) => {
      onProgress({ stage: "report", searches_used: 9 });
      onResult({
        status: "unavailable", pkm_written: false,
        progress: { stage: "report", searches_used: 9 },
        validated_facts: [],
      });
    });
    let finish!: () => void;
    mock.observe.mockImplementation(async ({ onResult }) => {
      await new Promise<void>((resolve) => {
        finish = () => {
          onResult({ status: "saved", pkm_written: false });
          resolve();
        };
      });
    });
    render(<WorldModelProvider><Probe /></WorldModelProvider>);
    expect(await screen.findByText("progress report 9")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Reload"));
    expect(screen.getByText("retrying")).toBeInTheDocument();
    expect(screen.getByText("progress report 9")).toBeInTheDocument();
    await waitFor(() => expect(mock.observe).toHaveBeenCalledTimes(2));
    await act(async () => finish());
    expect(screen.getByText("not retrying")).toBeInTheDocument();
    expect(screen.getByText("no progress")).toBeInTheDocument();
  });
  it("retains cited partial findings and the server checkpoint after an unavailable result", async () => {
    const finding = {
      id: "career:1",
      topic: "career",
      statement: "Works at Acme",
      confidence: "supported",
      sources: [{ title: "Acme", url: "https://acme.example/team" }],
      identity_state: "owner_linked",
    };
    mock.observe.mockImplementation(async ({ onPartial, onResult }) => {
      onPartial([finding]);
      onResult({
        status: "unavailable",
        pkm_written: false,
        validated_facts: [finding],
        progress: { stage: "report", searches_used: 9 },
      });
    });
    render(
      <WorldModelProvider>
        <Probe />
      </WorldModelProvider>,
    );
    expect(await screen.findByText("findings 1")).toBeInTheDocument();
    expect(screen.getByText("progress report 9")).toBeInTheDocument();
    expect(screen.getByText("idle")).toBeInTheDocument();
  });
  it("clears previously shown findings on a bare restart for the same authority", async () => {
    mock.observe.mockImplementation(async ({ onProgress, onPartial, onResult }) => {
      onResult(pending);
      onProgress({ stage: "coverage", searches_used: 7 });
      onPartial([{
        id: "career:1", topic: "career", statement: "Works at Acme",
        confidence: "supported", sources: [{ title: "Acme", url: "https://acme.example/team" }],
        identity_state: "owner_linked",
      }]);
      // A changed account identity binding returns no checkpoint fields.
      onResult({ status: "pending", pkm_written: false, restart_required: true });
    });
    render(<WorldModelProvider><Probe /></WorldModelProvider>);
    expect(await screen.findByText("failed")).toBeInTheDocument();
    expect(screen.getByText("no findings")).toBeInTheDocument();
    expect(screen.getByText("no progress")).toBeInTheDocument();
  });
  it("clears previously shown findings on an unavailable result without a checkpoint", async () => {
    mock.observe.mockImplementation(async ({ onProgress, onPartial, onResult }) => {
      onResult(pending);
      onProgress({ stage: "coverage", searches_used: 7 });
      onPartial([{
        id: "career:1", topic: "career", statement: "Works at Acme",
        confidence: "supported", sources: [{ title: "Acme", url: "https://acme.example/team" }],
        identity_state: "owner_linked",
      }]);
      onResult({ status: "unavailable", pkm_written: false });
    });
    render(<WorldModelProvider><Probe /></WorldModelProvider>);
    expect(await screen.findByText("no findings")).toBeInTheDocument();
    expect(screen.getByText("no progress")).toBeInTheDocument();
  });
  it("hides provisional findings immediately when the vault authority changes", async () => {
    mock.observe.mockImplementationOnce(async ({ onPartial, onResult }) => {
      onResult(pending);
      onPartial([{
        id: "career:1", topic: "career", statement: "Works at Acme",
        confidence: "supported", sources: [{ title: "Acme", url: "https://acme.example/team" }],
        identity_state: "owner_linked",
      }]);
      await new Promise(() => {});
    });
    mock.observe.mockImplementation(async ({ onResult }) => onResult(pending));
    const view = () => <WorldModelProvider><Probe /></WorldModelProvider>;
    const { rerender } = render(view());
    expect(await screen.findByText("findings 1")).toBeInTheDocument();
    mock.user = { uid: "owner-b" };
    mock.key = "key-b";
    mock.token = "token-b";
    rerender(view());
    expect(screen.getByText("no findings")).toBeInTheDocument();
    expect(screen.queryByText("findings 1")).toBeNull();
  });
  it("retains the last progress update when the research watch fails", async () => {
    mock.observe.mockImplementation(async ({ onProgress }) => {
      onProgress({ stage: "coverage", searches_used: 7 });
      throw new Error("status connection failed");
    });
    render(
      <WorldModelProvider>
        <Probe />
      </WorldModelProvider>,
    );
    expect(await screen.findByText("failed")).toBeInTheDocument();
    expect(screen.getByText("progress coverage 7")).toBeInTheDocument();
  });
  it("marks research failed when the watch ends while it is still pending, so the page offers Try again", async () => {
    mock.observe.mockImplementation(async ({ onResult }) => {
      onResult(pending);
      // The hour-long watch ran out: the service's own closing result.
      onResult({ status: "paused", pkm_written: false, restart_required: true });
    });
    render(
      <WorldModelProvider>
        <Probe />
      </WorldModelProvider>,
    );
    expect(await screen.findByText("failed")).toBeInTheDocument();
    expect(screen.getByText("idle")).toBeInTheDocument();
    // Try again restarts the watch with a fresh budget.
    mock.observe.mockImplementation(async ({ onResult }) =>
      onResult({ status: "saved", pkm_written: false }),
    );
    fireEvent.click(screen.getByText("Reload"));
    expect(await screen.findByText("not failed")).toBeInTheDocument();
    expect(mock.observe).toHaveBeenCalledTimes(2);
  });
  it("retries on its own when research is unavailable for a while, pane or no pane", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-10-15T10:00:00.000Z"));
    const started = Date.now();
    mock.observe.mockImplementationOnce(async ({ onResult }) =>
      onResult({
        status: "unavailable",
        pkm_written: false,
        reason: "provider_unavailable",
        retry_after_s: 900,
      }),
    );
    mock.observe.mockImplementation(async ({ onResult }) =>
      onResult({ status: "saved", pkm_written: false }),
    );
    // Only the app-level provider is mounted: no page, no pane.
    render(
      <WorldModelProvider>
        <Probe />
      </WorldModelProvider>,
    );
    await settle();
    expect(screen.getByText(`retry at ${started + 900_000}`)).toBeInTheDocument();
    expect(screen.getByText("not failed")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(899_000);
    });
    expect(mock.observe).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await settle();
    expect(mock.observe).toHaveBeenCalledTimes(2);
    // A fresh start, not a read of the run that ended.
    expect(mock.observe.mock.calls[1][0].refresh).not.toBe(true);
    // Any other result clears the wait.
    expect(screen.getByText("no retry")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900_000);
    });
    expect(mock.observe).toHaveBeenCalledTimes(2);
  });
  it("does not count repeated pending reads or tab visibility as research activity", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T10:00:00.000Z"));
    const started = Date.now();
    let onResult!: (result: typeof pending) => void;
    let onProgress!: (progress: { stage: string; searches_used: number; last_activity_at?: string }) => void;
    let hidden = false;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => hidden,
    });
    mock.observe.mockImplementation(async (callbacks) => {
      onResult = callbacks.onResult;
      onProgress = callbacks.onProgress;
      callbacks.onResult(pending);
      await new Promise(() => {});
    });
    render(
      <WorldModelProvider>
        <Probe />
      </WorldModelProvider>,
    );
    expect(await screen.findByText(`activity ${started}`)).toBeInTheDocument();
    hidden = true;
    await act(async () => {
      vi.setSystemTime(started + 6 * 60_000);
      onResult(pending);
    });
    hidden = false;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(screen.getByText(`activity ${started}`)).toBeInTheDocument();
    await act(async () => onProgress({ stage: "coverage", searches_used: 1 }));
    expect(screen.getByText(`activity ${Date.now()}`)).toBeInTheDocument();
    const progressedAt = Date.now();
    await act(async () => {
      vi.setSystemTime(progressedAt + 60_000);
      onProgress({
        stage: "coverage",
        searches_used: 1,
        last_activity_at: new Date().toISOString(),
      });
      onResult(pending);
    });
    expect(screen.getByText(`activity ${progressedAt}`)).toBeInTheDocument();
    await act(async () => onProgress({ stage: "coverage", searches_used: 2 }));
    expect(screen.getByText(`activity ${Date.now()}`)).toBeInTheDocument();
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
  it("uses the sole provider for owner-selected profiles and drops them on token replacement", async () => {
    const decisions = { confirmed: ["Private saved sentinel"], rejected: ["Private rejected sentinel"] };
    mock.ownerDecisions.mockReturnValue(decisions);
    const view = render(<WorldModelProvider><Probe /></WorldModelProvider>);
    await waitFor(() => expect(mock.observe).toHaveBeenCalledTimes(1));
    const urls = ["https://github.com/public-example"];
    act(() => { worldModelResearchStore.getSnapshot().researchPublicProfiles(urls); urls[0] = "https://github.com/changed"; });
    await waitFor(() => expect(mock.observe).toHaveBeenCalledTimes(2));
    expect(mock.observe.mock.calls[1][0]).toMatchObject({ refresh: true, publicProfileUrls: ["https://github.com/public-example"], ownerDecisions: decisions });
    mock.token = "token-renewed";
    view.rerender(<WorldModelProvider><Probe /></WorldModelProvider>);
    await waitFor(() => expect(mock.observe).toHaveBeenCalledTimes(3));
    expect(mock.observe.mock.calls[2][0].publicProfileUrls).toBeUndefined();
    expect(mock.observe.mock.calls[2][0].refresh).not.toBe(true);
  });

});
