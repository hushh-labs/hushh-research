import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ownerToken: "owner-capability" as string | null,
  link: { state: "quiet", device: { id: "device-1", name: "MacBook Pro" } } as { state: string; device: { id: string; name?: string } } | null,
  streamPuppyPodTurn: vi.fn(),
  getPuppyRelayStatus: vi.fn(),
  getPersonalAgentStatus: vi.fn(),
  pendingRevocations: vi.fn(),
  refreshPuppyLink: vi.fn(),
}));

vi.mock("@/lib/firebase", () => ({ useAuth: () => ({ user: { uid: "owner-1" } }) }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: mocks.ownerToken }),
}));
vi.mock("@/lib/hermes/use-puppy-link", () => ({
  usePuppyLink: () => mocks.link,
}));
vi.mock("@/lib/services/puppy-one-service", () => ({
  refreshPuppyLink: mocks.refreshPuppyLink,
}));
vi.mock("@/lib/services/api-service", () => ({
  PUPPY_TURN_DEADLINE_MS: 205_000,
  PUPPY_INFERENCE_DEADLINE_MS: 170_000,
  ApiService: {
    streamPuppyPodTurn: mocks.streamPuppyPodTurn,
    getPuppyRelayStatus: mocks.getPuppyRelayStatus,
    getPersonalAgentStatus: mocks.getPersonalAgentStatus,
    getPodMemoryStatus: async () => null,
  },
}));
vi.mock("@/lib/services/owner-pod-endpoint", () => ({
  pendingRevocations: mocks.pendingRevocations,
}));
vi.mock("@/components/agent/pod-memory-consent-row", () => ({
  PodMemoryConsentRow: () => null,
}));
vi.mock("@/components/agent/puppy-remote-model-picker", () => ({
  PuppyRemoteModelPicker: () => null,
}));

import { PrivatePuppyInferencePanel } from "@/components/agent/private-puppy-inference-panel";

beforeEach(() => {
  vi.resetAllMocks(); // also drops any queued once-implementations a failed test left behind
  mocks.ownerToken = "owner-capability";
  mocks.link = { state: "quiet", device: { id: "device-1", name: "MacBook Pro" } };
  mocks.pendingRevocations.mockResolvedValue([]);
  mocks.refreshPuppyLink.mockResolvedValue({ state: "quiet", device: { id: "device-1" } });
  mocks.getPersonalAgentStatus.mockResolvedValue({
    hostingMode: "byoc",
    state: "active",
    hushhId: "owner-pod-1",
  });
  mocks.streamPuppyPodTurn.mockImplementation(async ({ onToken, onDispatch }: { onToken: (text: string) => void; onDispatch: () => void }) => {
    onDispatch();
    onToken("Puppy ");
    onToken("answered");
    return {
    model: "local-model",
    modelReported: true,
    provider: "puppy",
    runtimeMode: "device-relay",
    };
  });
});

async function ask(question = "A synthetic question") {
  fireEvent.change(screen.getByRole("textbox", { name: "Message Puppy One" }), {
    target: { value: question },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send to Puppy One" }));
}

describe("private Puppy relay", () => {
  it("lets the approved quiet device wake through the owner pod", async () => {
    mocks.link = null; // The background device poll has not resolved yet.
    render(<PrivatePuppyInferencePanel />);
    await ask();

    expect(await screen.findByText("Puppy answered")).toBeInTheDocument();
    expect(mocks.getPuppyRelayStatus).not.toHaveBeenCalled();
    expect(mocks.streamPuppyPodTurn).toHaveBeenCalledWith(expect.objectContaining({
      hushhId: "owner-pod-1",
      vaultOwnerToken: "owner-capability",
      puppyDeviceId: "device-1",
      signal: expect.any(AbortSignal),
    }));
  });

  it("refuses a turn without the owner's unlock capability", async () => {
    mocks.ownerToken = null;
    render(<PrivatePuppyInferencePanel />);
    await ask();

    await waitFor(() => expect(screen.getByText("Unlock your private agent to chat with Puppy.")).toBeInTheDocument());
    expect(mocks.streamPuppyPodTurn).not.toHaveBeenCalled();
  });

  it("cancels an in-flight owner-pod turn", async () => {
    mocks.streamPuppyPodTurn.mockImplementation(({ signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }),
    );
    render(<PrivatePuppyInferencePanel />);
    await ask();

    await waitFor(() => expect(mocks.streamPuppyPodTurn).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    expect(await screen.findByText("Stopped.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("ends an unanswered turn with a useful timeout instead of spinning forever", async () => {
    vi.useFakeTimers();
    try {
      mocks.streamPuppyPodTurn.mockImplementation(({ signal, onDispatch }: { signal: AbortSignal; onDispatch: () => void }) => {
        onDispatch();
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      });
      render(<PrivatePuppyInferencePanel />);
      await act(async () => { await ask(); });
      expect(mocks.streamPuppyPodTurn).toHaveBeenCalledTimes(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(170_000); });
      expect(screen.getByText("Your Mac took too long to answer. Check that it's awake, then try again.")).toBeInTheDocument();
      expect(screen.queryByTestId("puppy-turn-status")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps cold connection time separate from the dispatched inference budget", async () => {
    vi.useFakeTimers();
    try {
      mocks.streamPuppyPodTurn.mockImplementation(({ signal, onDispatch, onToken }: {
        signal: AbortSignal; onDispatch: () => void; onToken: (text: string) => void;
      }) => new Promise((resolve, reject) => {
        let completion: ReturnType<typeof setTimeout>;
        const dispatch = setTimeout(() => {
          onDispatch();
          completion = setTimeout(() => {
            onToken("Puppy answered");
            resolve({ model: "local-model", modelReported: true });
          }, 40_000);
        }, 172_000);
        signal.addEventListener("abort", () => {
          clearTimeout(dispatch);
          clearTimeout(completion);
          reject(signal.reason);
        }, { once: true });
      }));
      render(<PrivatePuppyInferencePanel />);
      await act(async () => { await ask(); });
      expect(screen.getByText("Connecting…")).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(172_000); });
      expect(screen.getByText("Reading your message…")).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
      expect(screen.getByText("Puppy answered")).toBeInTheDocument();
      expect(screen.queryByText(/did not answer in time/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends a stalled link check and never starts a turn after its deadline", async () => {
    vi.useFakeTimers();
    try {
      let finishLink!: (value: { state: string; device: { id: string } }) => void;
      mocks.refreshPuppyLink.mockReturnValue(new Promise((resolve) => { finishLink = resolve; }));
      render(<PrivatePuppyInferencePanel />);
      await act(async () => { await ask(); });
      expect(mocks.refreshPuppyLink).toHaveBeenCalledTimes(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(205_000); });
      // Still confirming the agent and device: the Mac never had the question.
      expect(screen.getByText("Hussh took too long to check your private agent. Try again in a moment.")).toBeInTheDocument();
      expect(mocks.streamPuppyPodTurn).not.toHaveBeenCalled();

      await act(async () => { finishLink({ state: "quiet", device: { id: "device-1" } }); });
      expect(mocks.streamPuppyPodTurn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("names each phase in plain words and swaps to the answer on the first token", async () => {
    vi.useFakeTimers();
    try {
      const control: { dispatch?: () => void; token?: (text: string) => void; finish?: () => void } = {};
      mocks.streamPuppyPodTurn.mockImplementation(({ onDispatch, onToken }: { onDispatch: () => void; onToken: (text: string) => void }) =>
        new Promise((resolve) => {
          control.dispatch = onDispatch;
          control.token = onToken;
          control.finish = () => resolve({ model: "google/gemma-4-12b", modelReported: true });
        }));
      render(<PrivatePuppyInferencePanel />);
      await act(async () => { await ask(); });
      expect(screen.getByText("Connecting…")).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
      expect(screen.getByText("Waking your agent and your Mac…")).toBeInTheDocument();

      await act(async () => { control.dispatch?.(); });
      expect(screen.getByText("Reading your message…")).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(screen.getByText("5s")).toBeInTheDocument();

      await act(async () => { control.token?.("Hello"); await vi.advanceTimersByTimeAsync(20); });
      expect(screen.getByText("Hello")).toBeInTheDocument();
      expect(screen.queryByTestId("puppy-turn-status")).not.toBeInTheDocument();
      await act(async () => { control.token?.(" there"); await vi.advanceTimersByTimeAsync(20); });
      expect(screen.getByText("Hello there")).toBeInTheDocument();

      await act(async () => { control.finish?.(); });
      expect(screen.getByTestId("puppy-target")).toHaveTextContent("google/gemma-4-12b on your Mac");
    } finally {
      vi.useRealTimers();
    }
  });

  it("streams the model's own reasoning as a trail that folds when the answer starts", async () => {
    vi.useFakeTimers();
    try {
      const control: { thinking?: (text: string) => void; token?: (text: string) => void; finish?: () => void } = {};
      mocks.streamPuppyPodTurn.mockImplementation(({ onDispatch, onToken, onThinking }: {
        onDispatch: () => void; onToken: (text: string) => void; onThinking: (text: string) => void;
      }) => new Promise((resolve) => {
        onDispatch();
        control.thinking = onThinking;
        control.token = onToken;
        control.finish = () => resolve({ model: "m", modelReported: false });
      }));
      render(<PrivatePuppyInferencePanel />);
      await act(async () => { await ask(); });
      await act(async () => { control.thinking?.("The user wants a sum."); await vi.advanceTimersByTimeAsync(3_000); });
      const trail = screen.getByTestId("puppy-thinking-trail");
      expect(trail).toHaveAttribute("data-live", "true");
      expect(screen.getByRole("button", { name: /Thinking…/ })).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText("The user wants a sum.")).toBeInTheDocument();

      await act(async () => { control.token?.("It is 391."); await vi.advanceTimersByTimeAsync(20); });
      expect(screen.getByRole("button", { name: /Thought for 3s/ })).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText("The user wants a sum.")).not.toBeInTheDocument();
      expect(screen.getByText("It is 391.")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /Thought for 3s/ }));
      expect(screen.getByText("The user wants a sum.")).toBeInTheDocument();
      await act(async () => { control.finish?.(); });
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows no trail at all when the model sent no reasoning", async () => {
    render(<PrivatePuppyInferencePanel />);
    await ask();
    expect(await screen.findByText("Puppy answered")).toBeInTheDocument();
    expect(screen.queryByTestId("puppy-thinking-trail")).not.toBeInTheDocument();
  });

  it("keeps a failed question in place and retries it once, without a duplicate", async () => {
    mocks.streamPuppyPodTurn.mockRejectedValueOnce(new Error("PUPPY_BUSY"));
    render(<PrivatePuppyInferencePanel />);
    await ask();
    expect(await screen.findByText("Your Mac is still on another answer. Try again in a moment.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Puppy answered")).toBeInTheDocument();
    expect(screen.getAllByText("A synthetic question")).toHaveLength(1);
    expect(screen.queryByText(/still on another answer/)).not.toBeInTheDocument();
    // The question is the message itself; history holds only complete exchanges.
    expect(mocks.streamPuppyPodTurn).toHaveBeenLastCalledWith(expect.objectContaining({
      message: "A synthetic question",
      history: [],
    }));
  });

  it("opens on a friendly greeting whose suggestions send straight away", async () => {
    render(<PrivatePuppyInferencePanel />);
    expect(screen.getByText("Hi, I'm Puppy One")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "What do you remember about me?" }));
    expect(await screen.findByText("Puppy answered")).toBeInTheDocument();
    expect(screen.queryByTestId("puppy-greeting")).not.toBeInTheDocument();
  });

  it("sends the model only complete exchanges, never an answer without its question", async () => {
    mocks.streamPuppyPodTurn
      .mockImplementationOnce(async ({ onDispatch, onToken }: { onDispatch: () => void; onToken: (text: string) => void }) => {
        onDispatch();
        onToken("First answer");
        return { model: "m", modelReported: false };
      })
      .mockImplementationOnce(async ({ onDispatch, onToken }: { onDispatch: () => void; onToken: (text: string) => void }) => {
        onDispatch();
        onToken("A partial");
        throw new Error("PUPPY_STREAM_INTERRUPTED");
      });
    render(<PrivatePuppyInferencePanel />);
    await ask("First question");
    expect(await screen.findByText("First answer")).toBeInTheDocument();
    await ask("Second question");
    expect(await screen.findByText(/connection to your private agent dropped/)).toBeInTheDocument();
    expect(screen.getByText("A partial")).toBeInTheDocument();

    await ask("Third question");
    expect(await screen.findByText("Puppy answered")).toBeInTheDocument();
    expect(mocks.streamPuppyPodTurn).toHaveBeenLastCalledWith(expect.objectContaining({
      message: "Third question",
      history: [
        { role: "user", content: "First question" },
        { role: "assistant", content: "First answer" },
      ],
    }));
  });

  it("offers Try again only on the newest question, so later messages are never wiped", async () => {
    mocks.streamPuppyPodTurn
      .mockRejectedValueOnce(new Error("PUPPY_BUSY"))
      .mockImplementationOnce(async ({ onDispatch, onToken }: { onDispatch: () => void; onToken: (text: string) => void }) => {
        onDispatch();
        onToken("Second answer");
        return { model: "m", modelReported: false };
      })
      .mockRejectedValueOnce(new Error("PUPPY_BUSY"));
    render(<PrivatePuppyInferencePanel />);
    await ask("First question");
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    await ask("Second question");
    expect(await screen.findByText("Second answer")).toBeInTheDocument();
    // The older failure keeps its note but no longer offers a retry.
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();

    await ask("Third question");
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Puppy answered")).toBeInTheDocument();
    for (const kept of ["First question", "Second question", "Second answer", "Third question"])
      expect(screen.getByText(kept)).toBeInTheDocument();
    expect(screen.getAllByText("Third question")).toHaveLength(1);
  });

  it("names the private agent when the agent, not the Mac, failed", async () => {
    mocks.streamPuppyPodTurn.mockRejectedValueOnce(new Error("POD_DIRECT_UNAVAILABLE:unknown"));
    render(<PrivatePuppyInferencePanel />);
    await ask();
    expect(await screen.findByText("Your private agent couldn't take this message. Try again in a moment.")).toBeInTheDocument();
    expect(screen.queryByText(/Your Mac/)).not.toBeInTheDocument();
  });

  it("says your computer when the linked device has no name", async () => {
    mocks.link = { state: "quiet", device: { id: "device-1" } };
    render(<PrivatePuppyInferencePanel />);
    expect(screen.getByText(/I answer with the model on your computer/)).toBeInTheDocument();
  });

  it("follows the answer only while the owner is at the bottom", async () => {
    const control: { token?: (text: string) => void; finish?: () => void } = {};
    mocks.streamPuppyPodTurn.mockImplementation(({ onDispatch, onToken }: { onDispatch: () => void; onToken: (text: string) => void }) =>
      new Promise((resolve) => {
        onDispatch();
        control.token = onToken;
        control.finish = () => resolve({ model: "m", modelReported: false });
      }));
    render(<PrivatePuppyInferencePanel />);
    const transcript = screen.getByTestId("puppy-transcript");
    let top = 0;
    Object.defineProperty(transcript, "scrollHeight", { configurable: true, get: () => 1_000 });
    Object.defineProperty(transcript, "clientHeight", { configurable: true, get: () => 200 });
    Object.defineProperty(transcript, "scrollTop", { configurable: true, get: () => top, set: (value: number) => { top = value; } });
    await ask();
    await waitFor(() => expect(control.token).toBeDefined());
    expect(top).toBe(1_000);

    // The owner scrolls up to reread; streamed words leave them there.
    top = 100;
    fireEvent.scroll(transcript);
    await act(async () => { control.token?.("Hello"); await new Promise((resolve) => setTimeout(resolve, 40)); });
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(top).toBe(100);

    // Back at the bottom, it follows again.
    top = 800;
    fireEvent.scroll(transcript);
    await act(async () => { control.token?.(" there"); await new Promise((resolve) => setTimeout(resolve, 40)); });
    expect(top).toBe(1_000);
    await act(async () => { control.finish?.(); });
  });
});
