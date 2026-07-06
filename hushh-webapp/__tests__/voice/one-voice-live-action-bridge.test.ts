import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentActionRuntimeResult } from "@/lib/agent/agent-action-runtime";
import { OneVoiceLiveActionBridge } from "@/lib/voice/one-voice-live-action-bridge";
import type { AppRuntimeState } from "@/lib/voice/voice-types";
import { runOneGoal } from "@/lib/one-goal/one-goal-runner";

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
      processTranscript: vi.fn(),
      cancelActiveTurn: vi.fn(),
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
});
