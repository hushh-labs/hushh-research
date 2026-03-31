import { beforeEach, describe, expect, it, vi } from "vitest";

const planKaiVoiceIntentMock = vi.fn();
const createVoiceTurnIdMock = vi.fn();

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    planKaiVoiceIntent: (...args: unknown[]) => planKaiVoiceIntentMock(...args),
  },
}));

vi.mock("@/lib/voice/voice-feature-flags", () => ({
  getVoiceV2Flags: () => ({
    groundedActionResolutionEnabled: false,
    groundedActionPolicyEnforcementEnabled: false,
  }),
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

describe("VoiceTurnOrchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createVoiceTurnIdMock.mockReturnValue("vturn_turn_1");
    mockPlanningResponse(makePlannerEnvelope());
  });

  it("continues to dispatch when ack TTS fails", async () => {
    const onVoiceResponse = vi.fn().mockResolvedValue({
      shortTermMemoryWrite: true,
    });
    const speak = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error("ACK_TTS_FAILED");
      })
      .mockResolvedValueOnce(undefined);

    const orchestrator = new VoiceTurnOrchestrator({
      userId: "user_1",
      vaultOwnerToken: "vault_token",
      getAppRuntimeState: () => undefined,
      getVoiceContext: () => undefined,
      onVoiceResponse,
      speak,
      onStageChange: vi.fn(),
      onDebug: vi.fn(),
      onAssistantText: vi.fn(),
    });

    const result = await orchestrator.processTranscript({
      transcript: "Analyze NVDA",
      source: "microphone",
    });

    expect(onVoiceResponse).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledTimes(2);
    expect(result?.response.kind).toBe("execute");
  });

  it("does not fail the turn when final TTS fails after dispatch succeeds", async () => {
    const onVoiceResponse = vi.fn().mockResolvedValue({
      shortTermMemoryWrite: true,
    });
    const speak = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
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
    expect(result?.response.kind).toBe("execute");
    expect(onDebug).toHaveBeenCalledWith(
      "final_tts_failed_turn_continues",
      expect.objectContaining({
        error: "FINAL_TTS_FAILED",
        response_kind: "execute",
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
