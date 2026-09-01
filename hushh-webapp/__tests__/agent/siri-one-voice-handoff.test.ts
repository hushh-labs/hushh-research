import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_CONVERSATION_OUTCOME_EVENT,
  AGENT_CONVERSATION_REQUEST_EVENT,
  acknowledgeAgentConversation,
  markAgentConversationOwnerReady,
  requestAgentConversation,
  resetAgentConversationBrokerForTests,
} from "@/lib/agent/agent-voice-settings";
import {
  buildSiriOneVoiceLoginRoute,
  resolveSiriOneVoiceHandoffState,
} from "@/lib/agent/siri-one-voice-handoff-policy";

const readyInput = {
  now: 1_000,
  expiresAt: 301_000,
  visible: true,
  authLoading: false,
  signedIn: true,
  pathname: "/one/location",
  loginPath: "/login",
  runtimeReady: true,
  tier: "signed_locked" as const,
  ownerReady: true,
  voiceEnabled: true,
};

describe("Siri One Voice handoff", () => {
  beforeEach(() => resetAgentConversationBrokerForTests());

  it("waits for foreground, auth restoration, route, runtime, and Agent Bar ownership", () => {
    expect(
      resolveSiriOneVoiceHandoffState({ ...readyInput, visible: false }),
    ).toBe("waiting_for_foreground");
    expect(
      resolveSiriOneVoiceHandoffState({ ...readyInput, authLoading: true }),
    ).toBe("waiting_for_auth_restoration");
    expect(
      resolveSiriOneVoiceHandoffState({ ...readyInput, signedIn: false }),
    ).toBe("waiting_for_auth");
    expect(
      resolveSiriOneVoiceHandoffState({ ...readyInput, pathname: "/login" }),
    ).toBe("waiting_for_route");
    expect(
      resolveSiriOneVoiceHandoffState({ ...readyInput, runtimeReady: false }),
    ).toBe("waiting_for_runtime");
    expect(
      resolveSiriOneVoiceHandoffState({ ...readyInput, ownerReady: false }),
    ).toBe("waiting_for_owner");
  });

  it("preserves a protected route through an expired-session login", () => {
    expect(
      buildSiriOneVoiceLoginRoute({
        currentRoute: "/one/location?view=people",
        loginPath: "/login",
        publicHomePath: "/",
      }),
    ).toBe("/login?redirect=%2Fone%2Flocation%3Fview%3Dpeople");
    expect(
      buildSiriOneVoiceLoginRoute({
        currentRoute: "/",
        loginPath: "/login",
        publicHomePath: "/",
      }),
    ).toBe("/login");
  });

  it("allows signed-locked voice without widening vault authority", () => {
    expect(resolveSiriOneVoiceHandoffState(readyInput)).toBe("dispatch");
    expect(
      resolveSiriOneVoiceHandoffState({
        ...readyInput,
        tier: "signed_unlocked",
      }),
    ).toBe("dispatch");
  });

  it("rejects expired and kill-switched invocations", () => {
    expect(
      resolveSiriOneVoiceHandoffState({
        ...readyInput,
        expiresAt: readyInput.now,
      }),
    ).toBe("expired");
    expect(
      resolveSiriOneVoiceHandoffState({ ...readyInput, voiceEnabled: false }),
    ).toBe("voice_disabled");
  });

  it("queues one request until the sole owner mounts", async () => {
    const received = vi.fn();
    window.addEventListener(AGENT_CONVERSATION_REQUEST_EVENT, received);

    expect(
      requestAgentConversation({
        source: "siri_app_shortcut",
        requestId: "siri-1",
      }),
    ).toBe("queued");
    markAgentConversationOwnerReady();
    await Promise.resolve();

    expect(received).toHaveBeenCalledTimes(1);
    expect((received.mock.calls[0][0] as CustomEvent).detail).toEqual({
      source: "siri_app_shortcut",
      requestId: "siri-1",
    });
    window.removeEventListener(AGENT_CONVERSATION_REQUEST_EVENT, received);
  });

  it("coalesces duplicate ids while preserving no-argument callers", () => {
    markAgentConversationOwnerReady();
    const received = vi.fn();
    window.addEventListener(AGENT_CONVERSATION_REQUEST_EVENT, received);

    expect(
      requestAgentConversation({
        source: "siri_app_shortcut",
        requestId: "same",
      }),
    ).toBe("dispatched");
    expect(
      requestAgentConversation({
        source: "siri_app_shortcut",
        requestId: "same",
      }),
    ).toBe("duplicate");
    expect(requestAgentConversation()).toBe("dispatched");
    expect(received).toHaveBeenCalledTimes(2);
    expect((received.mock.calls[1][0] as CustomEvent).detail).toEqual({
      source: "agent_chat",
      requestId: undefined,
    });
    window.removeEventListener(AGENT_CONVERSATION_REQUEST_EVENT, received);
  });

  it("emits one correlated terminal acknowledgement", () => {
    const received = vi.fn();
    window.addEventListener(AGENT_CONVERSATION_OUTCOME_EVENT, received);
    acknowledgeAgentConversation({
      source: "siri_app_shortcut",
      requestId: "siri-2",
      outcome: "accepted",
    });
    expect((received.mock.calls[0][0] as CustomEvent).detail).toEqual({
      source: "siri_app_shortcut",
      requestId: "siri-2",
      outcome: "accepted",
    });
    window.removeEventListener(AGENT_CONVERSATION_OUTCOME_EVENT, received);
  });
});
