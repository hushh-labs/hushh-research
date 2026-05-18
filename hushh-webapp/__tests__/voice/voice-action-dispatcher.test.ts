import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  toastInfo: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  resumeActiveRun: vi.fn(),
  getActiveTaskForUser: vi.fn(),
  cancelRun: vi.fn(),
  getInvestorKaiActionByVoiceToolCall: vi.fn(),
  resolveInvestorKaiActionWiring: vi.fn(() => ({ resolvable: true })),
}));

vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: {
    info: (...args: unknown[]) => mocks.toastInfo(...args),
    error: (...args: unknown[]) => mocks.toastError(...args),
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
  },
}));

vi.mock("@/lib/services/debate-run-manager", () => ({
  DebateRunManagerService: {
    resumeActiveRun: (...args: unknown[]) => mocks.resumeActiveRun(...args),
    getActiveTaskForUser: (...args: unknown[]) => mocks.getActiveTaskForUser(...args),
    cancelRun: (...args: unknown[]) => mocks.cancelRun(...args),
  },
}));

vi.mock("@/lib/voice/investor-kai-action-registry", () => ({
  getInvestorKaiActionByVoiceToolCall: (...args: unknown[]) =>
    mocks.getInvestorKaiActionByVoiceToolCall(...args),
  resolveInvestorKaiActionWiring: (...args: unknown[]) =>
    mocks.resolveInvestorKaiActionWiring(...args),
}));

import { dispatchVoiceToolCall } from "@/lib/voice/voice-action-dispatcher";

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

describe("dispatchVoiceToolCall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveInvestorKaiActionWiring.mockReturnValue({ resolvable: true });
    mocks.resumeActiveRun.mockResolvedValue(null);
    mocks.getActiveTaskForUser.mockReturnValue(null);
    mocks.cancelRun.mockResolvedValue(undefined);
  });

  it("passes the canonical execute payload into executeKaiCommand and returns executed", async () => {
    const input = baseInput();
    const toolCall = {
      tool_name: "execute_kai_command" as const,
      args: {
        command: "analyze" as const,
        params: {
          symbol: "NVDA",
        },
      },
    };

    const result = await dispatchVoiceToolCall({
      ...input,
      toolCall,
    });

    expect(input.executeKaiCommand).toHaveBeenCalledWith(toolCall);
    expect(result).toMatchObject({
      status: "executed",
      toolName: "execute_kai_command",
      actionResult: {
        status: "succeeded",
        resultSummary: "Executed the requested Kai command.",
      },
    });
  });

  it("returns blocked when a vault token is required but missing", async () => {
    const result = await dispatchVoiceToolCall({
      ...baseInput(),
      vaultOwnerToken: undefined,
      toolCall: {
        tool_name: "resume_active_analysis",
        args: {},
      },
    });

    expect(mocks.toastError).toHaveBeenCalledWith("Unlock your vault to use voice actions.");
    expect(result).toMatchObject({
      status: "blocked",
      toolName: "resume_active_analysis",
      reason: "missing_vault_token",
      actionResult: {
        status: "blocked",
        resultSummary: "Unlock the vault before using this Kai voice action.",
      },
    });
  });

  it("returns invalid when execute_kai_command reports an invalid payload", async () => {
    const input = baseInput();
    input.executeKaiCommand = vi.fn(() => ({
      status: "invalid" as const,
      reason: "missing_symbol",
    }));


    const result = await dispatchVoiceToolCall({
      ...input,
      toolCall: {
        tool_name: "execute_kai_command",
        args: {
          command: "analyze",
          params: {},
        },
      },
    });

    expect(result).toMatchObject({
      status: "invalid",
      toolName: "execute_kai_command",
      reason: "missing_symbol",
      actionResult: {
        status: "invalid",
        resultSummary: "The requested Kai command was invalid.",
      },
    });
  });

  it("keeps execute_kai_command ownership inside the canonical gateway executor", async () => {
    const input = baseInput();
    const toolCall = {
      tool_name: "execute_kai_command" as const,
      args: {
        command: "open_dashboard",
      },
    };

    input.executeKaiCommand.mockReturnValue({
      status: "invalid",
      reason: "Unknown Kai command",
    });

    const result = await dispatchVoiceToolCall({
      ...input,
      toolCall,
    });

    expect(input.executeKaiCommand).toHaveBeenCalledTimes(1);
    expect(input.executeKaiCommand).toHaveBeenCalledWith(toolCall);
    expect(result).toMatchObject({
      status: "invalid",
      toolName: "execute_kai_command",
    });
  });

  it("returns failed when resume_active_analysis throws", async () => {
    mocks.resumeActiveRun.mockRejectedValueOnce(new Error("resume failed"));

    const result = await dispatchVoiceToolCall({
      ...baseInput(),
      toolCall: {
        tool_name: "resume_active_analysis",
        args: {},
      },
    });

    expect(mocks.toastError).toHaveBeenCalledWith("Could not resume active analysis.", {
      description: "resume failed",
    });
    expect(result).toMatchObject({
      status: "failed",
      toolName: "resume_active_analysis",
      reason: "resume_failed",
      actionResult: {
        status: "failed",
        resultSummary: "Could not resume the active analysis run.",
      },
    });
  });

  it("returns route-aware action results for resume_active_analysis success", async () => {
    mocks.resumeActiveRun.mockResolvedValueOnce({
      runId: "run_123",
    });

    const result = await dispatchVoiceToolCall({
      ...baseInput(),
      currentRoute: "/kai/dashboard",
      currentScreen: "dashboard",
      toolCall: {
        tool_name: "resume_active_analysis",
        args: {},
      },
    });

    expect(result).toMatchObject({
      status: "executed",
      toolName: "resume_active_analysis",
      actionResult: {
        status: "succeeded",
        routeBefore: "/kai/dashboard",
        routeAfter: "/kai/analysis?focus=active&run_id=run_123",
        screenBefore: "dashboard",
        screenAfter: "kai_analysis",
        resultSummary: "Resumed the active analysis run.",
      },
    });
  });

  it("rejects malformed execute_kai_command payload variants", async () => {
    const malformedToolCalls = [
      "execute_kai_comman",
      " execute_kai_command ",
      "EXECUTE_KAI_COMMAND",
      "execute-kai-command",
    ] as const;

    for (const toolName of malformedToolCalls) {
      const input = baseInput();

      const result = await dispatchVoiceToolCall({
        ...input,
        toolCall: {
          tool_name: toolName,
          args: {
            command: "dashboard",
          },
        },
      });

      expect(input.executeKaiCommand).not.toHaveBeenCalled();

      expect(result).toMatchObject({
        status: "invalid",
        reason: "unsupported_tool_call",
      });
    }
  });
});
