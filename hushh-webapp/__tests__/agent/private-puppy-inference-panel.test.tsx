import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ownerToken: "owner-capability" as string | null,
  link: { state: "quiet", device: { id: "device-1" } } as { state: string; device: { id: string } } | null,
  runPodTurn: vi.fn(),
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
  ApiService: {
    runPodTurn: mocks.runPodTurn,
    getPuppyRelayStatus: mocks.getPuppyRelayStatus,
    getPersonalAgentStatus: mocks.getPersonalAgentStatus,
  },
}));
vi.mock("@/lib/services/owner-pod-endpoint", () => ({
  pendingRevocations: mocks.pendingRevocations,
}));
vi.mock("@/components/agent/pod-memory-consent-row", () => ({
  PodMemoryConsentRow: () => null,
}));

import { PrivatePuppyInferencePanel } from "@/components/agent/private-puppy-inference-panel";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ownerToken = "owner-capability";
  mocks.link = { state: "quiet", device: { id: "device-1" } };
  mocks.pendingRevocations.mockResolvedValue([]);
  mocks.refreshPuppyLink.mockResolvedValue({ state: "quiet", device: { id: "device-1" } });
  mocks.getPersonalAgentStatus.mockResolvedValue({
    hostingMode: "byoc",
    state: "active",
    hushhId: "owner-pod-1",
  });
  mocks.runPodTurn.mockResolvedValue({
    text: "Puppy answered",
    model: "local-model",
    modelReported: true,
    provider: "puppy",
    runtimeMode: "device-relay",
  });
});

async function ask() {
  fireEvent.change(screen.getByPlaceholderText("Ask through your private Puppy relay…"), {
    target: { value: "A synthetic question" },
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
    expect(mocks.runPodTurn).toHaveBeenCalledWith(expect.objectContaining({
      hushhId: "owner-pod-1",
      vaultOwnerToken: "owner-capability",
      runtimeProvider: "puppy",
      puppyDeviceId: "device-1",
      signal: expect.any(AbortSignal),
    }));
  });

  it("refuses a turn without the owner's unlock capability", async () => {
    mocks.ownerToken = null;
    render(<PrivatePuppyInferencePanel />);
    await ask();

    await waitFor(() => expect(screen.getByText("Unlock your private agent before using the Puppy relay.")).toBeInTheDocument());
    expect(mocks.runPodTurn).not.toHaveBeenCalled();
  });

  it("cancels an in-flight owner-pod turn", async () => {
    mocks.runPodTurn.mockImplementation(({ signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }),
    );
    render(<PrivatePuppyInferencePanel />);
    await ask();

    await waitFor(() => expect(mocks.runPodTurn).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Puppy request cancelled.")).toBeInTheDocument();
  });

  it("ends an unanswered turn with a useful timeout instead of spinning forever", async () => {
    vi.useFakeTimers();
    try {
      mocks.runPodTurn.mockImplementation(({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      );
      render(<PrivatePuppyInferencePanel />);
      await act(async () => { await ask(); });
      expect(mocks.runPodTurn).toHaveBeenCalledTimes(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(205_000); });
      expect(screen.getByText("Puppy did not answer in time. Check your machine and try again.")).toBeInTheDocument();
      expect(screen.queryByText(/Still waiting for your machine/)).not.toBeInTheDocument();
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
      expect(screen.getByText("Puppy did not answer in time. Check your machine and try again.")).toBeInTheDocument();
      expect(mocks.runPodTurn).not.toHaveBeenCalled();

      await act(async () => { finishLink({ state: "quiet", device: { id: "device-1" } }); });
      expect(mocks.runPodTurn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
