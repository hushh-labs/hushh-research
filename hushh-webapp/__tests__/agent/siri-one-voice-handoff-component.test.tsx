import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: { user: { uid: "user-1" } as { uid: string } | null, loading: false },
  runtime: {
    oneVoiceContextSnapshot: { screen: "one_agents" } as object | null,
    tier: "signed_locked" as "signed_locked" | "signed_unlocked" | null,
  },
  pathname: "/one",
  search: "",
  visible: true,
  push: vi.fn(),
  getPendingInvocation: vi.fn(),
  claimInvocation: vi.fn(),
  completeInvocation: vi.fn(),
  addAvailabilityListener: vi.fn(),
  removeAvailabilityListener: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams(mocks.search),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => mocks.auth,
}));

vi.mock("@/lib/agent/agent-runtime-context", () => ({
  useAgentRuntimeStateOptional: () => mocks.runtime,
}));

vi.mock("@/lib/capacitor/one-voice-invocation", () => ({
  OneVoiceInvocationBridge: {
    isSupported: () => true,
    getPendingInvocation: mocks.getPendingInvocation,
    claimInvocation: mocks.claimInvocation,
    completeInvocation: mocks.completeInvocation,
    addAvailabilityListener: mocks.addAvailabilityListener,
  },
}));

vi.mock("@/lib/navigation/kai-bottom-chrome-visibility", () => ({
  snapKaiBottomChromeVisible: vi.fn(),
}));

import { SiriOneVoiceHandoff } from "@/components/agent/siri-one-voice-handoff";
import {
  AGENT_CONVERSATION_REQUEST_EVENT,
  acknowledgeAgentConversation,
  markAgentConversationOwnerReady,
  resetAgentConversationBrokerForTests,
} from "@/lib/agent/agent-voice-settings";

function invocation(overrides: Partial<{
  id: string;
  createdAt: number;
  expiresAt: number;
}> = {}) {
  const now = Date.now();
  return {
    id: overrides.id ?? "siri-request-1",
    kind: "start_one_voice" as const,
    source: "siri_app_shortcut" as const,
    createdAt: overrides.createdAt ?? now,
    expiresAt: overrides.expiresAt ?? now + 300_000,
  };
}

describe("SiriOneVoiceHandoff lifecycle", () => {
  let markOwnerUnavailable: (() => void) | null = null;

  beforeEach(() => {
    resetAgentConversationBrokerForTests();
    markOwnerUnavailable = markAgentConversationOwnerReady();
    mocks.auth = { user: { uid: "user-1" }, loading: false };
    mocks.runtime = {
      oneVoiceContextSnapshot: { screen: "one_agents" },
      tier: "signed_locked",
    };
    mocks.pathname = "/one";
    mocks.search = "";
    mocks.visible = true;
    mocks.push.mockReset();
    mocks.getPendingInvocation.mockReset();
    mocks.claimInvocation.mockReset();
    mocks.completeInvocation.mockReset();
    mocks.addAvailabilityListener.mockReset();
    mocks.removeAvailabilityListener.mockReset();
    mocks.claimInvocation.mockResolvedValue({ claimed: true });
    mocks.completeInvocation.mockResolvedValue(undefined);
    mocks.addAvailabilityListener.mockResolvedValue({
      remove: mocks.removeAvailabilityListener,
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (mocks.visible ? "visible" : "hidden"),
    });
  });

  afterEach(() => {
    markOwnerUnavailable?.();
    markOwnerUnavailable = null;
  });

  it("routes an authenticated invocation into the existing Agent Bar exactly once", async () => {
    const pending = invocation();
    const received = vi.fn();
    mocks.getPendingInvocation.mockResolvedValue(pending);
    window.addEventListener(AGENT_CONVERSATION_REQUEST_EVENT, received);

    render(<SiriOneVoiceHandoff />);

    await waitFor(() =>
      expect(mocks.claimInvocation).toHaveBeenCalledWith({ id: pending.id }),
    );
    expect(received).toHaveBeenCalledTimes(1);
    expect((received.mock.calls[0][0] as CustomEvent).detail).toEqual({
      source: "siri_app_shortcut",
      requestId: pending.id,
    });

    act(() => {
      acknowledgeAgentConversation({
        source: "siri_app_shortcut",
        requestId: pending.id,
        outcome: "accepted",
      });
    });
    await waitFor(() =>
      expect(mocks.completeInvocation).toHaveBeenCalledWith({
        id: pending.id,
        outcome: "accepted",
      }),
    );
    expect(mocks.claimInvocation).toHaveBeenCalledTimes(1);
    window.removeEventListener(AGENT_CONVERSATION_REQUEST_EVENT, received);
  });

  it("waits in the background and dispatches when the open app becomes active", async () => {
    const pending = invocation({ id: "background-request" });
    mocks.visible = false;
    mocks.getPendingInvocation.mockResolvedValue(pending);

    render(<SiriOneVoiceHandoff />);
    await waitFor(() => expect(mocks.getPendingInvocation).toHaveBeenCalled());
    expect(mocks.claimInvocation).not.toHaveBeenCalled();

    act(() => {
      mocks.visible = true;
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() =>
      expect(mocks.claimInvocation).toHaveBeenCalledWith({ id: pending.id }),
    );
  });

  it("survives an expired Hussh session, preserves the route, and resumes after login", async () => {
    const pending = invocation({ id: "session-restore-request" });
    mocks.auth = { user: null, loading: false };
    mocks.pathname = "/one/location";
    mocks.search = "view=people";
    mocks.getPendingInvocation.mockResolvedValue(pending);

    const view = render(<SiriOneVoiceHandoff />);
    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith(
        "/login?redirect=%2Fone%2Flocation%3Fview%3Dpeople",
      ),
    );
    expect(mocks.claimInvocation).not.toHaveBeenCalled();

    mocks.auth = { user: { uid: "user-1" }, loading: false };
    mocks.pathname = "/one/location";
    mocks.search = "view=people";
    view.rerender(<SiriOneVoiceHandoff />);

    await waitFor(() =>
      expect(mocks.claimInvocation).toHaveBeenCalledWith({ id: pending.id }),
    );
  });

  it("expires a stale cold-launch record without starting voice", async () => {
    const pending = invocation({
      id: "expired-request",
      createdAt: Date.now() - 301_000,
      expiresAt: Date.now() - 1_000,
    });
    mocks.getPendingInvocation.mockResolvedValue(pending);

    render(<SiriOneVoiceHandoff />);

    await waitFor(() =>
      expect(mocks.completeInvocation).toHaveBeenCalledWith({
        id: pending.id,
        outcome: "expired",
      }),
    );
    expect(mocks.claimInvocation).not.toHaveBeenCalled();
  });
});
