import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentActionRuntimeResult } from "@/lib/agent/agent-action-runtime";
import {
  classifyOneVoicePkmMemoryCandidate,
  OneVoiceLiveActionBridge,
} from "@/lib/voice/one-voice-live-action-bridge";
import type { AppRuntimeState } from "@/lib/voice/voice-types";
import { runOneGoal } from "@/lib/one-goal/one-goal-runner";

const orchestratorMocks = vi.hoisted(() => ({
  processTranscript: vi.fn(),
  cancelActiveTurn: vi.fn(),
}));

vi.mock("@/lib/one-goal/one-goal-runner", () => ({
  runOneGoal: vi.fn().mockResolvedValue({
    session: {},
    actionResult: {
      status: "started",
      actionId: "analysis.start",
      label: "Start Stock Analysis",
      routeBefore: "/one/kai",
      resultSummary: "Kai debate started.",
    },
    resultSummary: {
      text: "Kai debate started.",
    },
  }),
}));

vi.mock("@/lib/voice/voice-turn-orchestrator", () => ({
  VoiceTurnOrchestrator: vi.fn().mockImplementation(function MockVoiceTurnOrchestrator() {
    return {
      processTranscript: orchestratorMocks.processTranscript,
      cancelActiveTurn: orchestratorMocks.cancelActiveTurn,
    };
  }),
}));

function runtimeState(): AppRuntimeState {
  return {
    auth: {
      signed_in: true,
      user_id: "user_1",
    },
    vault: {
      unlocked: true,
      token_available: true,
      token_valid: true,
    },
    route: {
      pathname: "/one/kai",
      screen: "kai_market",
      subview: null,
    },
    runtime: {
      analysis_active: false,
      analysis_ticker: null,
      analysis_run_id: null,
      import_active: false,
      import_run_id: null,
      busy_operations: [],
    },
    portfolio: {
      has_portfolio_data: true,
    },
    persona: {
      active: "investor",
      primary_nav: "investor",
      available: ["investor"],
      transition_target: null,
      ria_switch_available: false,
      ria_setup_available: false,
    },
    voice: {
      available: true,
      tts_playing: false,
      last_tool_name: null,
      last_ticker: null,
    },
  };
}

describe("OneVoiceLiveActionBridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orchestratorMocks.processTranscript.mockResolvedValue(undefined);
  });

  it("keeps pending goal context across Gemini Live clarification turns", async () => {
    const speak = vi.fn().mockResolvedValue(undefined);
    const executeAction = vi.fn().mockResolvedValue({
      status: "started",
      actionId: "analysis.start",
      label: "Start Stock Analysis",
      routeBefore: "/one/kai",
      resultSummary: "Opened TSLA preview.",
    } satisfies AgentActionRuntimeResult);
    const bridge = new OneVoiceLiveActionBridge({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      getAppRuntimeState: runtimeState,
      getVoiceContext: () => ({}),
      executeAction,
      speak,
      openChatHandoff: vi.fn(),
    });

    await bridge.processTranscript({ transcript: "Analyze TSLA" });
    expect(speak.mock.lastCall?.[0].text).toContain("Which list");
    expect(speak.mock.lastCall?.[0].text).toContain("default");

    await bridge.processTranscript({ transcript: "which lists are available" });
    expect(speak.mock.lastCall?.[0].text).toContain("Available options: default");
    expect(runOneGoal).not.toHaveBeenCalled();

    await bridge.processTranscript({ transcript: "use default" });
    expect(runOneGoal).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runOneGoal).mock.calls[0]?.[0].plan).toMatchObject({
      status: "ready",
      action: {
        action_id: "analysis.start",
      },
      slots: {
        symbol: "TSLA",
        pickSource: "default",
      },
    });
    expect(vi.mocked(runOneGoal).mock.calls[0]?.[0].waitForCompletion).toBe(false);
  });

  it.each([
    "which lists are available",
    "what sources can I choose",
    "show available choices",
  ])("answers option questions during a pending Gemini Live goal: %s", async (optionQuestion) => {
    const speak = vi.fn().mockResolvedValue(undefined);
    const bridge = new OneVoiceLiveActionBridge({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      getAppRuntimeState: runtimeState,
      getVoiceContext: () => ({}),
      executeAction: vi.fn(),
      speak,
      openChatHandoff: vi.fn(),
    });

    await bridge.processTranscript({ transcript: "Analyze TSLA" });
    await bridge.processTranscript({ transcript: optionQuestion });

    expect(speak.mock.lastCall?.[0].text).toContain("Available options: default");
    expect(runOneGoal).not.toHaveBeenCalled();
  });

  it("preserves pending Gemini Live goal state across bridge config refreshes", async () => {
    const speak = vi.fn().mockResolvedValue(undefined);
    const baseConfig = {
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      getAppRuntimeState: runtimeState,
      getVoiceContext: () => ({}),
      executeAction: vi.fn(),
      speak,
      openChatHandoff: vi.fn(),
    };
    const bridge = new OneVoiceLiveActionBridge(baseConfig);

    await bridge.processTranscript({ transcript: "Analyze TSLA" });
    bridge.updateConfig({
      ...baseConfig,
      getVoiceContext: () => ({ refreshed: true }),
    });
    await bridge.processTranscript({ transcript: "which lists are available" });

    expect(speak.mock.lastCall?.[0].text).toContain("Available options: default");
    expect(runOneGoal).not.toHaveBeenCalled();
  });

  it.each([
    {
      start: "Analyze TSLA",
      question: "which lists are available",
      selection: "use default",
    },
    {
      start: "please research TSLA",
      question: "what sources can I choose",
      selection: "default list",
    },
    {
      start: "start a TSLA stock debate",
      question: "show available choices",
      selection: "the default one",
    },
  ])(
    "chains natural-language Gemini Live goal turns without hardcoded transcript branches: $start",
    async ({ start, question, selection }) => {
      const speak = vi.fn().mockResolvedValue(undefined);
      const bridge = new OneVoiceLiveActionBridge({
        userId: "user_1",
        vaultOwnerToken: "vault_token",
        getAppRuntimeState: runtimeState,
        getVoiceContext: () => ({}),
        executeAction: vi.fn(),
        speak,
        openChatHandoff: vi.fn(),
      });

      await bridge.processTranscript({ transcript: start });
      expect(speak.mock.lastCall?.[0].text).toContain("Which list");

      await bridge.processTranscript({ transcript: question });
      expect(speak.mock.lastCall?.[0].text).toContain("Available options: default");
      expect(runOneGoal).not.toHaveBeenCalled();

      await bridge.processTranscript({ transcript: selection });
      expect(runOneGoal).toHaveBeenCalledTimes(1);
      expect(vi.mocked(runOneGoal).mock.calls[0]?.[0].plan).toMatchObject({
        status: "ready",
        action: {
          action_id: "analysis.start",
        },
        slots: {
          symbol: "TSLA",
          pickSource: "default",
        },
      });
      expect(vi.mocked(runOneGoal).mock.calls[0]?.[0].waitForCompletion).toBe(false);
    },
  );

  it("lets the generated goal override a route-only Gemini proposal for stock analysis", async () => {
    const speak = vi.fn().mockResolvedValue(undefined);
    const setStage = vi.fn();
    const bridge = new OneVoiceLiveActionBridge({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      getAppRuntimeState: runtimeState,
      getVoiceContext: () => ({}),
      executeAction: vi.fn(),
      speak,
      openChatHandoff: vi.fn(),
      setStage,
    });

    await bridge.processTranscript({
      transcript: "Analyze TSLA using default",
      candidate: {
        action_id: "route.kai_analysis",
        needs_confirmation: false,
        confidence: 0.9,
        slots: {},
        reason: "Provider thought this was route navigation.",
      },
    });

    expect(runOneGoal).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runOneGoal).mock.calls[0]?.[0]).toMatchObject({
      waitForCompletion: false,
      vaultKey: "vault_key",
      plan: {
        status: "ready",
        action: {
          action_id: "analysis.start",
        },
        slots: {
          symbol: "TSLA",
          pickSource: "default",
        },
      },
    });
    expect(setStage).toHaveBeenCalledWith("speaking_ack");
    expect(setStage).toHaveBeenCalledWith("dispatch");
    expect(setStage.mock.calls.at(-1)?.[0]).toBe("idle");
  });

  it("maps spoken company names from Gemini Live into governed analysis goals", async () => {
    const speak = vi.fn().mockResolvedValue(undefined);
    const bridge = new OneVoiceLiveActionBridge({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      getAppRuntimeState: runtimeState,
      getVoiceContext: () => ({}),
      executeAction: vi.fn(),
      speak,
      openChatHandoff: vi.fn(),
    });

    await bridge.processTranscript({
      transcript: "analyzing nvidia using default",
      candidate: {
        action_id: "route.kai_analysis",
        needs_confirmation: false,
        confidence: 0.88,
        slots: {},
        reason: "Provider proposed opening analysis only.",
      },
    });

    expect(runOneGoal).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runOneGoal).mock.calls[0]?.[0].plan).toMatchObject({
      status: "ready",
      action: {
        action_id: "analysis.start",
      },
      slots: {
        symbol: "NVDA",
        pickSource: "default",
      },
    });
  });

  it("runs read-only specialist-turn goals through the One Goal runner", async () => {
    const speak = vi.fn().mockResolvedValue(undefined);
    vi.mocked(runOneGoal).mockImplementationOnce(async (options) => {
      await options.callbacks?.onFinalText?.("Two threads need a reply today.");
      return {
        session: {} as never,
        actionResult: {
          status: "succeeded",
          actionId: "email.chat.turn",
          label: "Ask Email",
          routeBefore: "/one",
          routeAfter: "/one/gmail",
          resultSummary: "Two threads need a reply today.",
        },
        resultSummary: {
          text: "Two threads need a reply today.",
          route: "/one/gmail",
        },
      };
    });
    const openChatHandoff = vi.fn();
    const bridge = new OneVoiceLiveActionBridge({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      getAppRuntimeState: runtimeState,
      getVoiceContext: () => ({ route: { pathname: "/one/gmail" } }),
      executeAction: vi.fn(),
      speak,
      openChatHandoff,
    });

    await bridge.processTranscript({ transcript: "What needs a reply today?" });

    expect(runOneGoal).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runOneGoal).mock.calls[0]?.[0]).toMatchObject({
      screenContext: { route: { pathname: "/one/gmail" } },
      plan: {
        status: "ready",
        action: {
          action_id: "email.chat.turn",
          delegate_agent_id: "agent_email",
        },
        slots: {
          utterance: "What needs a reply today?",
        },
      },
    });
    expect(openChatHandoff).not.toHaveBeenCalled();
    expect(speak.mock.lastCall?.[0].text).toBe("Two threads need a reply today.");
  });

  it("hands confirmation-required specialist goals to chat instead of direct execution", async () => {
    const openChatHandoff = vi.fn();
    const bridge = new OneVoiceLiveActionBridge({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      getAppRuntimeState: runtimeState,
      getVoiceContext: () => ({}),
      executeAction: vi.fn(),
      speak: vi.fn(),
      openChatHandoff,
    });

    await bridge.processTranscript({
      transcript: "Add Kushal to my trusted connections",
    });

    expect(runOneGoal).not.toHaveBeenCalled();
    expect(openChatHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "sensitive_action",
        actionId: "connections.chat.turn",
        transcript: "Add Kushal to my trusted connections",
      })
    );
  });

  it("preserves specialist directives when voice hands off to Agent Chat", async () => {
    const specialistDirective = {
      delegateAgentId: "agent_location",
      directive: {
        kind: "action" as const,
        payload: {
          id: "share-1",
          type: "publish_share",
        },
      },
      message: "Review this location share before I start it.",
      stateChanged: false,
    };
    vi.mocked(runOneGoal).mockResolvedValueOnce({
      session: {} as never,
      actionResult: {
        status: "blocked",
        actionId: "location.chat.turn",
        label: "Ask Location",
        routeBefore: "/one/location",
        routeAfter: "/one/location",
        resultSummary: "Review this location share before I start it.",
        data: {
          requiresChatHandoff: true,
          specialistDirective,
        },
      },
      resultSummary: {
        text: "Review this location share before I start it.",
        route: "/one/location",
      },
    });
    const openChatHandoff = vi.fn();
    const bridge = new OneVoiceLiveActionBridge({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      getAppRuntimeState: runtimeState,
      getVoiceContext: () => ({}),
      executeAction: vi.fn(),
      speak: vi.fn().mockResolvedValue(undefined),
      openChatHandoff,
    });

    await bridge.processTranscript({
      transcript: "Start sharing my location with Rohan",
    });

    expect(runOneGoal).toHaveBeenCalledTimes(1);
    expect(openChatHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "delegated_action",
        actionId: "location.chat.turn",
        transcript: "Start sharing my location with Rohan",
        specialistDirective,
      })
    );
  });

  it("ignores low-confidence Gemini Live action proposals before planning or orchestration", async () => {
    const bridge = new OneVoiceLiveActionBridge({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      getAppRuntimeState: runtimeState,
      getVoiceContext: () => ({}),
      executeAction: vi.fn(),
      speak: vi.fn(),
      openChatHandoff: vi.fn(),
    });

    await bridge.processTranscript({
      transcript: "unrelatedly supercalifragilistic",
      candidate: {
        action_id: "route.profile",
        needs_confirmation: false,
        confidence: 0.2,
        slots: {},
        reason: "Weak provider-side guess.",
      },
    });

    expect(runOneGoal).not.toHaveBeenCalled();
    expect(orchestratorMocks.processTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        transcript: "unrelatedly supercalifragilistic",
        source: "gemini_live",
        candidateActionId: null,
        candidateSlots: null,
        candidateReason: null,
      })
    );
  });

  it.each([
    ["remember that I prefer concise summaries", true, true],
    ["I usually use the default stock debate list", true, false],
    ["what lists are available", false, false],
    ["my password is hunter2", false, false],
  ])(
    "classifies PKM memory candidates conservatively: %s",
    (transcript, expectedCandidate, expectedExplicit) => {
      expect(classifyOneVoicePkmMemoryCandidate(transcript)).toMatchObject({
        candidate: expectedCandidate,
        explicit: expectedExplicit,
      });
    },
  );

  it("hands useful memory candidates to chat/PKM review instead of saving directly", async () => {
    const openChatHandoff = vi.fn();
    const bridge = new OneVoiceLiveActionBridge({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      getAppRuntimeState: runtimeState,
      getVoiceContext: () => ({}),
      executeAction: vi.fn(),
      speak: vi.fn(),
      openChatHandoff,
    });

    await bridge.processTranscript({
      transcript: "remember that I prefer concise summaries",
    });

    expect(openChatHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "pkm_memory_candidate",
        actionId: "profile.pkm.preview_capture",
        transcript: "remember that I prefer concise summaries",
      })
    );
    expect(runOneGoal).not.toHaveBeenCalled();
  });

  it("does not create PKM handoffs for secret-like voice content", async () => {
    const openChatHandoff = vi.fn();
    const bridge = new OneVoiceLiveActionBridge({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      vaultKey: "vault_key",
      getAppRuntimeState: runtimeState,
      getVoiceContext: () => ({}),
      executeAction: vi.fn(),
      speak: vi.fn(),
      openChatHandoff,
    });

    await bridge.processTranscript({
      transcript: "my password is hunter2",
    });

    expect(openChatHandoff).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "pkm_memory_candidate" })
    );
  });
});
