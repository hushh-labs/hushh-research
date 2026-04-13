import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchVoiceToolCallMock = vi.fn();
const toastInfoMock = vi.fn();
const toastSuccessMock = vi.fn();
const logVoiceMetricMock = vi.fn();

vi.mock("@/lib/voice/voice-action-dispatcher", () => ({
  dispatchVoiceToolCall: (...args: unknown[]) => dispatchVoiceToolCallMock(...args),
}));

vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: {
    info: (...args: unknown[]) => toastInfoMock(...args),
    success: (...args: unknown[]) => toastSuccessMock(...args),
  },
}));

vi.mock("@/lib/voice/voice-telemetry", () => ({
  logVoiceMetric: (...args: unknown[]) => logVoiceMetricMock(...args),
}));

import { executeVoiceResponse } from "@/lib/voice/voice-response-executor";

const originalGroundedExecutionFlag =
  process.env.NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_EXECUTION_ENABLED;

function baseInput() {
  return {
    userId: "user_1",
    vaultOwnerToken: "vault_token",
    vaultKey: "vault_key",
    router: {
      push: vi.fn(),
    },
    handleBack: vi.fn(),
    executeKaiCommand: vi.fn(() => ({ status: "executed" as const })),
    setAnalysisParams: vi.fn(),
  };
}

describe("executeVoiceResponse", () => {
  beforeEach(() => {
    dispatchVoiceToolCallMock.mockReset();
    dispatchVoiceToolCallMock.mockImplementation(async ({ toolCall }: { toolCall: { tool_name: string } }) => ({
      status: "executed",
      toolName: toolCall.tool_name,
    }));
    toastInfoMock.mockReset();
    toastSuccessMock.mockReset();
    logVoiceMetricMock.mockReset();
    if (originalGroundedExecutionFlag === undefined) {
      delete process.env.NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_EXECUTION_ENABLED;
    } else {
      process.env.NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_EXECUTION_ENABLED =
        originalGroundedExecutionFlag;
    }
  });

  it("dispatches execute response through voice tool dispatcher", async () => {
    const result = await executeVoiceResponse({
      ...baseInput(),
      response: {
        kind: "execute",
        message: "Starting analysis for NVDA.",
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
    });

    expect(dispatchVoiceToolCallMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      shortTermMemoryWrite: true,
      toolName: "execute_kai_command",
      ticker: "NVDA",
      responseKind: "execute",
    });
  });

  it("blocks destructive grounded actions and asks for manual completion", async () => {
    const result = await executeVoiceResponse({
      ...baseInput(),
      response: {
        kind: "speak_only",
        message: "Please do that yourself in the app.",
        speak: true,
      },
      groundedPlan: {
        status: "manual_only",
        actionId: "profile.delete_account",
        actionLabel: "Delete Account",
        destructive: true,
        message: "Please do that yourself in the app.",
        execution: {
          mode: "manual_only",
          steps: [
            {
              type: "prompt",
              message: "Please do that yourself in the app.",
              reason: "destructive_action_policy",
            },
          ],
        },
      },
    });

    expect(dispatchVoiceToolCallMock).not.toHaveBeenCalled();
    expect(toastInfoMock).toHaveBeenCalledWith("Please do that yourself in the app.");
    expect(result).toEqual({
      shortTermMemoryWrite: false,
      toolName: null,
      ticker: null,
      responseKind: "speak_only",
    });
  });

  it("does not execute grounded or legacy actions when execution is disallowed", async () => {
    const result = await executeVoiceResponse({
      ...baseInput(),
      executionAllowed: false,
      response: {
        kind: "execute",
        message: "Resuming active analysis.",
        speak: true,
        tool_call: {
          tool_name: "resume_active_analysis",
          args: {},
        },
      },
      groundedPlan: {
        status: "resolved",
        actionId: "analysis.resume_active",
        actionLabel: "Resume Active Analysis Run",
        destructive: false,
        message: null,
        execution: {
          mode: "navigate_then_action",
          steps: [
            {
              type: "navigate",
              href: "/kai/analysis",
              reason: "hidden_action_navigation_prerequisite",
            },
          ],
        },
      },
    });

    expect(dispatchVoiceToolCallMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      shortTermMemoryWrite: false,
      toolName: null,
      ticker: null,
      responseKind: "execute",
    });
  });

  it("defers execution when the planner requires confirmation", async () => {
    const setPendingConfirmation = vi.fn();
    const result = await executeVoiceResponse({
      ...baseInput(),
      needsConfirmation: true,
      setPendingConfirmation,
      response: {
        kind: "execute",
        message: "Do you want me to cancel the active analysis?",
        speak: true,
        tool_call: {
          tool_name: "cancel_active_analysis",
          args: {
            confirm: false,
          },
        },
      },
    });

    expect(dispatchVoiceToolCallMock).not.toHaveBeenCalled();
    expect(setPendingConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "cancel_active_analysis",
        prompt: "Do you want me to cancel the active analysis?",
      })
    );
    expect(result).toEqual({
      shortTermMemoryWrite: false,
      toolName: null,
      ticker: null,
      responseKind: "execute",
    });
  });

  it("executes hidden action plans as navigation followed by tool dispatch", async () => {
    const input = baseInput();
    const result = await executeVoiceResponse({
      ...input,
      response: {
        kind: "execute",
        message: "Resuming active analysis.",
        speak: true,
        tool_call: {
          tool_name: "resume_active_analysis",
          args: {},
        },
      },
      groundedPlan: {
        status: "resolved",
        actionId: "analysis.resume_active",
        actionLabel: "Resume Active Analysis Run",
        destructive: false,
        message: null,
        execution: {
          mode: "navigate_then_action",
          steps: [
            {
              type: "navigate",
              href: "/kai/analysis",
              reason: "hidden_action_navigation_prerequisite",
            },
            {
              type: "tool_call",
              toolCall: {
                tool_name: "resume_active_analysis",
                args: {},
              },
              reason: "wired_tool_after_navigation",
            },
          ],
        },
      },
    });

    expect(input.router.push).toHaveBeenCalledWith("/kai/analysis");
    expect(dispatchVoiceToolCallMock).toHaveBeenCalledTimes(1);
    expect(input.router.push.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchVoiceToolCallMock.mock.invocationCallOrder[0]
    );
    expect(result).toEqual({
      shortTermMemoryWrite: true,
      toolName: "resume_active_analysis",
      ticker: null,
      responseKind: "execute",
    });
  });

  it("shows unavailable grounded action message without dispatch", async () => {
    const result = await executeVoiceResponse({
      ...baseInput(),
      response: {
        kind: "speak_only",
        message: "I can’t do that right now.",
        speak: true,
      },
      groundedPlan: {
        status: "unavailable",
        actionId: "command.optimize_legacy",
        actionLabel: "Legacy Optimize Voice Command",
        destructive: false,
        message: "I can’t do that right now.",
        execution: {
          mode: "unavailable",
          steps: [
            {
              type: "prompt",
              message: "I can’t do that right now.",
              reason: "legacy_unavailable",
            },
          ],
        },
      },
    });

    expect(dispatchVoiceToolCallMock).not.toHaveBeenCalled();
    expect(toastInfoMock).toHaveBeenCalledWith("I can’t do that right now.");
    expect(result).toEqual({
      shortTermMemoryWrite: false,
      toolName: null,
      ticker: null,
      responseKind: "speak_only",
    });
  });

  it("executes grounded navigation for speak-only route intents", async () => {
    const input = baseInput();
    const result = await executeVoiceResponse({
      ...input,
      response: {
        kind: "speak_only",
        message: "Opening Gmail.",
        speak: true,
      },
      groundedPlan: {
        status: "resolved",
        actionId: "nav.profile_gmail_panel",
        actionLabel: "Open Gmail Connector Panel",
        destructive: false,
        message: null,
        execution: {
          mode: "navigate_only",
          steps: [
            {
              type: "navigate",
              href: "/profile?tab=account&panel=gmail",
              reason: "route_bound_action",
            },
          ],
        },
      },
    });

    expect(input.router.push).toHaveBeenCalledWith("/profile?tab=account&panel=gmail");
    expect(dispatchVoiceToolCallMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      shortTermMemoryWrite: true,
      toolName: "navigate",
      ticker: null,
      responseKind: "speak_only",
    });
  });

  it("falls back to legacy execute path when grounded execution rollout flag is disabled", async () => {
    process.env.NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_EXECUTION_ENABLED = "0";
    const input = baseInput();
    const result = await executeVoiceResponse({
      ...input,
      response: {
        kind: "execute",
        message: "Resuming active analysis.",
        speak: true,
        tool_call: {
          tool_name: "resume_active_analysis",
          args: {},
        },
      },
      groundedPlan: {
        status: "resolved",
        actionId: "analysis.resume_active",
        actionLabel: "Resume Active Analysis Run",
        destructive: false,
        message: null,
        execution: {
          mode: "navigate_then_action",
          steps: [
            {
              type: "navigate",
              href: "/kai/analysis",
              reason: "hidden_action_navigation_prerequisite",
            },
            {
              type: "tool_call",
              toolCall: {
                tool_name: "resume_active_analysis",
                args: {},
              },
              reason: "wired_tool_after_navigation",
            },
          ],
        },
      },
    });

    expect(input.router.push).not.toHaveBeenCalled();
    expect(dispatchVoiceToolCallMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      shortTermMemoryWrite: true,
      toolName: "resume_active_analysis",
      ticker: null,
      responseKind: "execute",
    });
  });

  it("does not write short-term memory for stt_unusable clarify", async () => {
    const result = await executeVoiceResponse({
      ...baseInput(),
      response: {
        kind: "clarify",
        reason: "stt_unusable",
        message: "I couldn’t understand what you said, please repeat.",
        speak: true,
      },
    });

    expect(toastInfoMock).toHaveBeenCalledTimes(1);
    expect(result.shortTermMemoryWrite).toBe(false);
    expect(result.toolName).toBeNull();
  });

  it("suppresses duplicate notifications when the voice UI already presents the reply", async () => {
    const result = await executeVoiceResponse({
      ...baseInput(),
      suppressNotifications: true,
      response: {
        kind: "clarify",
        reason: "stt_unusable",
        message: "I couldn’t understand what you said, please repeat.",
        speak: true,
      },
    });

    expect(toastInfoMock).not.toHaveBeenCalled();
    expect(result.shortTermMemoryWrite).toBe(false);
    expect(result.toolName).toBeNull();
  });

  it("keeps ticker_ambiguous clarify in fallback flow", async () => {
    const result = await executeVoiceResponse({
      ...baseInput(),
      response: {
        kind: "clarify",
        reason: "ticker_ambiguous",
        message: "Did you mean NVDA or AMD?",
        speak: true,
      },
      groundedPlan: {
        status: "ambiguous",
        actionId: null,
        actionLabel: null,
        destructive: false,
        message: "Did you mean NVDA or AMD?",
        execution: {
          mode: "ambiguous",
          steps: [],
        },
      },
    });

    expect(dispatchVoiceToolCallMock).not.toHaveBeenCalled();
    expect(toastInfoMock).toHaveBeenCalledWith("Did you mean NVDA or AMD?");
    expect(result).toEqual({
      shortTermMemoryWrite: true,
      toolName: "clarify",
      ticker: null,
      responseKind: "clarify",
    });
  });

  it("returns already_running as short-term memory eligible", async () => {
    const result = await executeVoiceResponse({
      ...baseInput(),
      response: {
        kind: "already_running",
        task: "analysis",
        ticker: "AAPL",
        run_id: "run_1",
        message: "Analysis is already running for AAPL.",
        speak: true,
      },
    });

    expect(result).toEqual({
      shortTermMemoryWrite: true,
      toolName: "already_running",
      ticker: "AAPL",
      responseKind: "already_running",
    });
  });

  it("treats background_started as non-blocking and memory-eligible", async () => {
    const result = await executeVoiceResponse({
      ...baseInput(),
      response: {
        kind: "background_started",
        task: "analysis",
        ticker: "MSFT",
        run_id: "run_2",
        message: "Started analysis for MSFT in background.",
        speak: true,
      },
    });

    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      shortTermMemoryWrite: true,
      toolName: "background_started",
      ticker: "MSFT",
      responseKind: "background_started",
    });
  });

  it("suppresses background-started success toasts when voice compact UI is active", async () => {
    const result = await executeVoiceResponse({
      ...baseInput(),
      suppressNotifications: true,
      response: {
        kind: "background_started",
        task: "analysis",
        ticker: "MSFT",
        run_id: "run_2",
        message: "Started analysis for MSFT in background.",
        speak: true,
      },
    });

    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      shortTermMemoryWrite: true,
      toolName: "background_started",
      ticker: "MSFT",
      responseKind: "background_started",
    });
  });

  it("does not mark grounded execution successful when tool dispatch is blocked", async () => {
    dispatchVoiceToolCallMock.mockResolvedValueOnce({
      status: "blocked",
      toolName: "resume_active_analysis",
      reason: "missing_vault_token",
    });
    const emitTelemetry = vi.fn();

    const result = await executeVoiceResponse({
      ...baseInput(),
      turnId: "vturn_1",
      responseId: "vrsp_1",
      emitTelemetry,
      response: {
        kind: "execute",
        message: "Resuming active analysis.",
        speak: true,
        tool_call: {
          tool_name: "resume_active_analysis",
          args: {},
        },
      },
      groundedPlan: {
        status: "resolved",
        actionId: "analysis.resume_active",
        actionLabel: "Resume Active Analysis Run",
        destructive: false,
        message: null,
        execution: {
          mode: "navigate_then_action",
          steps: [
            {
              type: "navigate",
              href: "/kai/analysis",
              reason: "hidden_action_navigation_prerequisite",
            },
            {
              type: "tool_call",
              toolCall: {
                tool_name: "resume_active_analysis",
                args: {},
              },
              reason: "wired_tool_after_navigation",
            },
          ],
        },
      },
    });

    expect(result).toEqual({
      shortTermMemoryWrite: false,
      toolName: null,
      ticker: null,
      responseKind: "execute",
    });
    expect(emitTelemetry).not.toHaveBeenCalledWith(
      "grounded_execution_success",
      expect.anything()
    );
    expect(logVoiceMetricMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        metric: "execution_grounded_execution_success",
      })
    );
  });

  it("does not write legacy execute memory when dispatch returns invalid", async () => {
    dispatchVoiceToolCallMock.mockResolvedValueOnce({
      status: "invalid",
      toolName: "execute_kai_command",
      reason: "missing_symbol",
    });
    const emitTelemetry = vi.fn();

    const result = await executeVoiceResponse({
      ...baseInput(),
      turnId: "vturn_2",
      responseId: "vrsp_2",
      emitTelemetry,
      response: {
        kind: "execute",
        message: "Starting analysis.",
        speak: true,
        tool_call: {
          tool_name: "execute_kai_command",
          args: {
            command: "analyze",
            params: {},
          },
        },
      },
    });

    expect(result).toEqual({
      shortTermMemoryWrite: false,
      toolName: null,
      ticker: null,
      responseKind: "execute",
    });
    expect(emitTelemetry).not.toHaveBeenCalledWith(
      "legacy_execute_success",
      expect.anything()
    );
  });
});
