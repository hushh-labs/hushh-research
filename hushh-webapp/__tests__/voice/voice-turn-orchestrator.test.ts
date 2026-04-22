import { beforeEach, describe, expect, it, vi } from "vitest";

const planKaiVoiceIntentMock = vi.fn();
const composeKaiVoiceReplyMock = vi.fn();
const createVoiceTurnIdMock = vi.fn();
const getVoiceV2FlagsMock = vi.fn();

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    planKaiVoiceIntent: (...args: unknown[]) => planKaiVoiceIntentMock(...args),
    composeKaiVoiceReply: (...args: unknown[]) => composeKaiVoiceReplyMock(...args),
  },
}));

vi.mock("@/lib/voice/voice-feature-flags", () => ({
  getVoiceV2Flags: (...args: unknown[]) => getVoiceV2FlagsMock(...args),
}));

vi.mock("@/lib/voice/voice-telemetry", () => ({
  createVoiceTurnId: (...args: unknown[]) => createVoiceTurnIdMock(...args),
  logVoiceMetric: vi.fn(),
}));

import { voiceMemoryStore } from "@/lib/voice/voice-memory-store";
import { VoiceTurnOrchestrator } from "@/lib/voice/voice-turn-orchestrator";

function makePlannerEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    response_id: "vrsp_turn_1",
    ack_text: "Working on it.",
    final_text: "Analysis started.",
    is_long_running: true,
    memory_write_candidates: [
      {
        category: "preferences",
        summary: "Prefers concise responses.",
      },
    ],
    response: {
      kind: "execute",
      message: "Analysis started.",
      speak: true,
      tool_call: {
        tool_name: "execute_kai_command",
        args: {
          command: "analyze",
          params: {
            symbol: "NVDA",
          },
        },
      },
    },
    tool_call: {
      tool_name: "execute_kai_command",
      args: {
        command: "analyze",
        params: {
          symbol: "NVDA",
        },
      },
    },
    memory: {
      allow_durable_write: true,
    },
    ...overrides,
  };
}

function mockPlanningResponse(payload: Record<string, unknown>) {
  planKaiVoiceIntentMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(payload),
  });
}

function mockComposeResponse(payload: Record<string, unknown>, status = 200) {
  composeKaiVoiceReplyMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(payload),
  });
}

describe("VoiceTurnOrchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createVoiceTurnIdMock.mockReturnValue("vturn_turn_1");
    getVoiceV2FlagsMock.mockReturnValue({
      groundedActionResolutionEnabled: false,
      groundedActionPolicyEnforcementEnabled: false,
      groundedActionExecutionEnabled: false,
    });
    mockPlanningResponse(makePlannerEnvelope());
    mockComposeResponse({
      text: "Composed Kai response.",
      segment_type: "final",
      response_id: "vrsp_turn_1",
    });
  });

  it("speaks a confirmed background ack only after dispatch and tolerates TTS failure", async () => {
    mockPlanningResponse(
      makePlannerEnvelope({
        mode: "start_background_and_ack",
        action_id: "analysis.start",
        reply_strategy: "llm",
      })
    );
    mockComposeResponse({
      text: "I've started analyzing NVDA. I'll keep it running in the background.",
      segment_type: "ack",
      response_id: "vrsp_turn_1",
    });
    const onVoiceResponse = vi.fn().mockResolvedValue({
      shortTermMemoryWrite: true,
      actionResult: {
        status: "started",
        action_id: "analysis.start",
        result_summary: "I've started analyzing NVDA.",
        settled_by: "background_start",
      },
    });
    const speak = vi.fn().mockImplementationOnce(async () => {
      throw new Error("ACK_TTS_FAILED");
    });
    const onDebug = vi.fn();

    const orchestrator = new VoiceTurnOrchestrator({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      getAppRuntimeState: () => undefined,
      getVoiceContext: () => undefined,
      onVoiceResponse,
      speak,
      onStageChange: vi.fn(),
      onDebug,
      onAssistantText: vi.fn(),
    });

    const result = await orchestrator.processTranscript({
      transcript: "Analyze NVDA",
      source: "microphone",
    });

    expect(onVoiceResponse).toHaveBeenCalledTimes(1);
    expect(composeKaiVoiceReplyMock).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "I've started analyzing NVDA. I'll keep it running in the background.",
        segmentType: "ack",
      })
    );
    expect(onDebug).toHaveBeenCalledWith(
      "post_dispatch_tts_failed_turn_continues",
      expect.objectContaining({
        error: "ACK_TTS_FAILED",
        response_kind: "execute",
        segment_type: "ack",
      })
    );
    expect(result?.response.kind).toBe("execute");
    expect(result?.spokenText).toBe("I've started analyzing NVDA. I'll keep it running in the background.");
  });

  it("does not fail the turn when post-dispatch final TTS fails", async () => {
    mockPlanningResponse(
      makePlannerEnvelope({
        mode: "execute_and_wait",
        action_id: "nav.profile",
        reply_strategy: "llm",
        final_text: "Opening profile.",
      })
    );
    mockComposeResponse({
      text: "You're on Profile now. Manage your investor identity and connected data here.",
      segment_type: "final",
      response_id: "vrsp_turn_1",
    });
    const onVoiceResponse = vi.fn().mockResolvedValue({
      shortTermMemoryWrite: true,
      actionResult: {
        status: "succeeded",
        action_id: "nav.profile",
        result_summary: "You're on your profile now.",
        route_after: "/profile",
        screen_after: "profile",
        settled_by: "screen",
      },
    });
    const speak = vi.fn().mockImplementationOnce(async () => {
      throw new Error("FINAL_TTS_FAILED");
    });
    const onDebug = vi.fn();

    const orchestrator = new VoiceTurnOrchestrator({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      getAppRuntimeState: () => undefined,
      getVoiceContext: () => undefined,
      onVoiceResponse,
      speak,
      onStageChange: vi.fn(),
      onDebug,
      onAssistantText: vi.fn(),
    });

    const result = await orchestrator.processTranscript({
      transcript: "Analyze NVDA",
      source: "microphone",
    });

    expect(onVoiceResponse).toHaveBeenCalledTimes(1);
    expect(composeKaiVoiceReplyMock).toHaveBeenCalledTimes(1);
    expect(result?.response.kind).toBe("execute");
    expect(result?.spokenText).toBe(
      "You're on Profile now. Manage your investor identity and connected data here."
    );
    expect(onDebug).toHaveBeenCalledWith(
      "post_dispatch_tts_failed_turn_continues",
      expect.objectContaining({
        error: "FINAL_TTS_FAILED",
        response_kind: "execute",
        segment_type: "final",
      })
    );
  });

  it("skips short-term and durable memory writes when dispatch did not execute", async () => {
    const appendShortTermSpy = vi.spyOn(voiceMemoryStore, "appendShortTerm");
    const writeDurableSpy = vi.spyOn(voiceMemoryStore, "writeDurable");

    const orchestrator = new VoiceTurnOrchestrator({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      getAppRuntimeState: () => undefined,
      getVoiceContext: () => undefined,
      onVoiceResponse: vi.fn().mockResolvedValue({
        shortTermMemoryWrite: false,
      }),
      speak: vi.fn().mockResolvedValue(undefined),
      onStageChange: vi.fn(),
      onDebug: vi.fn(),
      onAssistantText: vi.fn(),
    });

    await orchestrator.processTranscript({
      transcript: "Analyze NVDA",
      source: "microphone",
    });

    expect(appendShortTermSpy).not.toHaveBeenCalled();
    expect(writeDurableSpy).not.toHaveBeenCalled();
  });

  it("passes execution_allowed and needs_confirmation through to dispatch", async () => {
    const onVoiceResponse = vi.fn().mockResolvedValue({
      shortTermMemoryWrite: false,
    });
    mockPlanningResponse(
      makePlannerEnvelope({
        mode: "execute_and_wait",
        action_id: "analysis.cancel_active",
        execution_allowed: false,
        needs_confirmation: true,
      })
    );

    const orchestrator = new VoiceTurnOrchestrator({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      getAppRuntimeState: () => undefined,
      getVoiceContext: () => undefined,
      onVoiceResponse,
      speak: vi.fn().mockResolvedValue(undefined),
      onStageChange: vi.fn(),
      onDebug: vi.fn(),
      onAssistantText: vi.fn(),
    });

    await orchestrator.processTranscript({
      transcript: "cancel the active analysis",
      source: "microphone",
    });

    expect(onVoiceResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        executionAllowed: false,
        needsConfirmation: true,
        plan: expect.objectContaining({
          mode: "execute_and_wait",
          action_id: "analysis.cancel_active",
        }),
      })
    );
  });

  it("logs fallback telemetry when grounding resolves without a canonical planner action", async () => {
    getVoiceV2FlagsMock.mockReturnValue({
      groundedActionResolutionEnabled: true,
      groundedActionPolicyEnforcementEnabled: false,
      groundedActionExecutionEnabled: false,
    });
    mockPlanningResponse(
      makePlannerEnvelope({
        response: {
          kind: "execute",
          message: "Opening dashboard.",
          speak: true,
          tool_call: {
            tool_name: "execute_kai_command",
            args: {
              command: "dashboard",
            },
          },
        },
      })
    );
    const onDebug = vi.fn();

    const orchestrator = new VoiceTurnOrchestrator({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      getAppRuntimeState: () => undefined,
      getVoiceContext: () => undefined,
      onVoiceResponse: vi.fn().mockResolvedValue({
        shortTermMemoryWrite: false,
      }),
      speak: vi.fn().mockResolvedValue(undefined),
      onStageChange: vi.fn(),
      onDebug,
      onAssistantText: vi.fn(),
    });

    await orchestrator.processTranscript({
      transcript: "open gmail receipts",
      source: "microphone",
    });

    expect(onDebug).toHaveBeenCalledWith(
      "grounding_fallback_resolution_used",
      expect.objectContaining({
        resolution_source: "response",
        action_id: "nav.kai_dashboard",
      })
    );
  });

  it("fails closed when the planner sends an unknown canonical action id", async () => {
    getVoiceV2FlagsMock.mockReturnValue({
      groundedActionResolutionEnabled: true,
      groundedActionPolicyEnforcementEnabled: false,
      groundedActionExecutionEnabled: false,
    });
    mockPlanningResponse(
      makePlannerEnvelope({
        mode: "execute_and_wait",
        action_id: "nav.not_real",
        response: {
          kind: "speak_only",
          message: "Opening Gmail.",
          speak: true,
        },
      })
    );
    const onDebug = vi.fn();

    const orchestrator = new VoiceTurnOrchestrator({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      getAppRuntimeState: () => undefined,
      getVoiceContext: () => undefined,
      onVoiceResponse: vi.fn().mockResolvedValue({
        shortTermMemoryWrite: false,
      }),
      speak: vi.fn().mockResolvedValue(undefined),
      onStageChange: vi.fn(),
      onDebug,
      onAssistantText: vi.fn(),
    });

    const result = await orchestrator.processTranscript({
      transcript: "open gmail",
      source: "microphone",
    });

    expect(result?.groundedPlan.status).toBe("unavailable");
    expect(result?.groundedPlan.actionId).toBe("nav.not_real");
    expect(result?.groundedPlan.resolutionSource).toBe("canonical");
    expect(onDebug).toHaveBeenCalledWith(
      "grounding_canonical_action_unavailable",
      expect.objectContaining({
        canonical_action_id: "nav.not_real",
      })
    );
    expect(onDebug).not.toHaveBeenCalledWith(
      "grounding_fallback_resolution_used",
      expect.anything()
    );
  });

  it("falls back to the local template composer when backend compose fails", async () => {
    mockPlanningResponse(
      makePlannerEnvelope({
        mode: "execute_and_wait",
        action_id: "nav.profile",
        reply_strategy: "llm",
        final_text: "Opening profile.",
      })
    );
    composeKaiVoiceReplyMock.mockRejectedValueOnce(new Error("COMPOSE_DOWN"));

    const speak = vi.fn().mockResolvedValue(undefined);
    const onDebug = vi.fn();
    const orchestrator = new VoiceTurnOrchestrator({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      getAppRuntimeState: () => undefined,
      getVoiceContext: () => undefined,
      onVoiceResponse: vi.fn().mockResolvedValue({
        shortTermMemoryWrite: true,
        actionResult: {
          status: "succeeded",
          action_id: "nav.profile",
          result_summary: "You're on your profile now.",
          route_after: "/profile",
          screen_after: "profile",
          settled_by: "screen",
        },
      }),
      speak,
      onStageChange: vi.fn(),
      onDebug,
      onAssistantText: vi.fn(),
    });

    const result = await orchestrator.processTranscript({
      transcript: "take me to profile",
      source: "microphone",
    });

    expect(onDebug).toHaveBeenCalledWith(
      "voice_compose_failed_falling_back_to_template",
      expect.objectContaining({
        error: "COMPOSE_DOWN",
      })
    );
    expect(result?.spokenText).toBe("You're on your profile now.");
    expect(speak).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "You're on your profile now.",
        segmentType: "final",
      })
    );
  });

  it("throws on non-ok planner responses so the UI can enter retry state", async () => {
    const onVoiceResponse = vi.fn().mockResolvedValue({
      shortTermMemoryWrite: false,
    });
    planKaiVoiceIntentMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: vi.fn().mockResolvedValue({
        detail: "planner unavailable",
      }),
    });

    const orchestrator = new VoiceTurnOrchestrator({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      getAppRuntimeState: () => undefined,
      getVoiceContext: () => undefined,
      onVoiceResponse,
      speak: vi.fn().mockResolvedValue(undefined),
      onStageChange: vi.fn(),
      onDebug: vi.fn(),
      onAssistantText: vi.fn(),
    });

    await expect(
      orchestrator.processTranscript({
        transcript: "analyze nvda",
        source: "microphone",
      })
    ).rejects.toThrow("planner unavailable");

    expect(onVoiceResponse).not.toHaveBeenCalled();
  });
});
