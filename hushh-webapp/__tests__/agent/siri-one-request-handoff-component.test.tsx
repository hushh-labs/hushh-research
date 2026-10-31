import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RequestRuntimeState } from "@/lib/agent/one-system-request-runtime";

const mocks = vi.hoisted(() => ({
  listener: null as ((state: RequestRuntimeState) => void) | null,
  request: vi.fn(),
  cancel: vi.fn(),
  complete: vi.fn(),
  owned: vi.fn(),
  setOwner: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: "owner" }, isAuthenticated: true }),
}));
vi.mock("@/lib/agent/one-system-request-runtime", () => ({
  oneSystemRequestRuntime: {
    setOwner: mocks.setOwner,
    startListening: () => () => {},
    subscribe: (listener: (state: RequestRuntimeState) => void) => {
      mocks.listener = listener;
      return () => {
        mocks.listener = null;
      };
    },
    getCurrentState: () => ({ status: "idle" }),
    markAppOwned: mocks.owned,
    complete: mocks.complete,
  },
}));
vi.mock("@/lib/agent/agent-voice-settings", () => ({
  AGENT_CONVERSATION_OUTCOME_EVENT: "synthetic-command-outcome",
  requestAgentConversation: mocks.request,
  cancelAgentConversationRequest: mocks.cancel,
}));
vi.mock("@/lib/agent/agent-voice-state", () => ({
  useAgentVoiceState: { getState: () => ({ setStatus: vi.fn() }) },
}));
import { SiriOneRequestHandoff } from "@/components/agent/siri-one-request-handoff";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.request.mockReturnValue("accepted");
  mocks.owned.mockResolvedValue(true);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function claim(deadline = 150_000) {
  render(<SiriOneRequestHandoff />);
  await act(async () => {
    mocks.listener!({
      status: "claimed",
      invocation: {
        id: "request",
        kind: "interpret_one_request",
        source: "siri_app_shortcut",
        requestText: "Synthetic Location request",
        createdAt: Date.now(),
        expiresAt: Date.now() + 300_000,
        handoffDeadlineAt: Date.now() + deadline,
        protocolVersion: "one.request.v1",
        ownerBinding: "owner",
      },
    });
  });
}

it("allows bounded semantic assessment past the old 25-second deadline and accepts only the matching durable handoff", async () => {
  await claim();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(mocks.cancel).not.toHaveBeenCalled();
  expect(mocks.complete).not.toHaveBeenCalled();
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent("synthetic-command-outcome", {
        detail: {
          source: "siri_app_shortcut",
          requestId: "other",
          outcome: "accepted",
        },
      }),
    );
  });
  expect(mocks.owned).not.toHaveBeenCalled();
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent("synthetic-command-outcome", {
        detail: {
          source: "siri_app_shortcut",
          requestId: "request",
          outcome: "accepted",
        },
      }),
    );
  });
  expect(mocks.owned).toHaveBeenCalledOnce();
  expect(mocks.complete).toHaveBeenCalledOnce();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150_000);
  });
  expect(mocks.cancel).not.toHaveBeenCalled();
});

it.each([10_000, 150_000, 200_000])(
  "honors the earlier native or app bound (%i ms)",
  async (deadline) => {
    await claim(deadline);
    const bound = Math.min(deadline, 150_000);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(bound - 1);
    });
    expect(mocks.cancel).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.cancel).toHaveBeenCalledWith({
      source: "siri_app_shortcut",
      requestId: "request",
    });
    expect(mocks.complete).toHaveBeenCalledWith(
      "handoff_timeout",
      expect.any(String),
    );
    expect(mocks.owned).not.toHaveBeenCalled();
  },
);
