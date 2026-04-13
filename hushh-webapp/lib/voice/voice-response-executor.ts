import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import type { AnalysisParams } from "@/lib/stores/kai-session-store";
import {
  dispatchVoiceToolCall,
  type VoiceDispatchResult,
} from "@/lib/voice/voice-action-dispatcher";
import { getVoiceV2Flags } from "@/lib/voice/voice-feature-flags";
import {
  type GroundedVoicePlan,
  VOICE_MANUAL_ONLY_MESSAGE,
  VOICE_UNAVAILABLE_MESSAGE,
} from "@/lib/voice/voice-grounding";
import type { PendingVoiceConfirmation } from "@/lib/voice/voice-session-store";
import { logVoiceMetric } from "@/lib/voice/voice-telemetry";
import type {
  VoiceExecuteKaiCommandCall,
  VoiceResponse,
} from "@/lib/voice/voice-types";
import type { ExecuteKaiCommandResult } from "@/lib/kai/command-executor";

type RouterLike = {
  push: (href: string) => void;
};

type VoiceExecutionTelemetryEmitter = (
  event: string,
  payload?: Record<string, unknown>
) => void;

export type ExecuteVoiceResponseInput = {
  response: VoiceResponse;
  groundedPlan?: GroundedVoicePlan;
  executionAllowed?: boolean;
  needsConfirmation?: boolean;
  suppressNotifications?: boolean;
  turnId?: string;
  responseId?: string;
  userId: string;
  vaultOwnerToken?: string;
  vaultKey?: string;
  router: RouterLike;
  handleBack: () => void;
  executeKaiCommand: (toolCall: VoiceExecuteKaiCommandCall) => ExecuteKaiCommandResult;
  setAnalysisParams: (params: AnalysisParams | null) => void;
  setPendingConfirmation?: (payload: PendingVoiceConfirmation) => void;
  emitTelemetry?: VoiceExecutionTelemetryEmitter;
};

export type ExecuteVoiceResponseResult = {
  shortTermMemoryWrite: boolean;
  toolName: string | null;
  ticker: string | null;
  responseKind: VoiceResponse["kind"];
};

function extractTickerFromToolCall(
  toolCall: Extract<VoiceResponse, { kind: "execute" }>["tool_call"]
): string | null {
  if (toolCall.tool_name !== "execute_kai_command") return null;
  if (toolCall.args.command !== "analyze") return null;
  return toolCall.args.params?.symbol ?? null;
}

function extractTickerFromExecute(response: VoiceResponse): string | null {
  if (response.kind !== "execute") return null;
  return extractTickerFromToolCall(response.tool_call);
}

function emitExecutionTelemetry(
  input: ExecuteVoiceResponseInput,
  event: string,
  payload?: Record<string, unknown>
): void {
  input.emitTelemetry?.(event, payload);
  if (!input.turnId) return;
  const normalizedTags: Record<string, string | number | boolean | null | undefined> = {};
  Object.entries(payload || {}).forEach(([key, value]) => {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null ||
      value === undefined
    ) {
      normalizedTags[key] = value;
      return;
    }
    normalizedTags[key] = String(value);
  });
  if (input.responseId) {
    normalizedTags.response_id = input.responseId;
  }
  logVoiceMetric({
    metric: `execution_${event}`,
    value: 1,
    turnId: input.turnId,
    tags: normalizedTags,
  });
}

function buildDispatchTelemetry(
  prefix: "grounded_execution" | "legacy_execute",
  result: VoiceDispatchResult,
  extra: Record<string, unknown> = {}
): {
  event: string;
  payload: Record<string, unknown>;
} {
  const event =
    result.status === "executed" ? `${prefix}_success` : `${prefix}_${result.status}`;
  return {
    event,
    payload: {
      tool_name: result.toolName,
      reason: result.reason ?? null,
      ...extra,
    },
  };
}

export async function executeVoiceResponse(
  input: ExecuteVoiceResponseInput
): Promise<ExecuteVoiceResponseResult> {
  const { response, groundedPlan } = input;
  const voiceFlags = getVoiceV2Flags();
  const groundedExecutionEnabled = voiceFlags.groundedActionExecutionEnabled;
  const executionAllowed = input.executionAllowed !== false;
  const waitingForConfirmation = input.needsConfirmation === true && response.kind === "execute";
  const suppressNotifications = input.suppressNotifications === true;
  const notifyInfo = (...args: Parameters<typeof toast.info>) => {
    if (suppressNotifications) return;
    toast.info(...args);
  };
  const notifySuccess = (...args: Parameters<typeof toast.success>) => {
    if (suppressNotifications) return;
    toast.success(...args);
  };

  if (!executionAllowed) {
    emitExecutionTelemetry(input, "execution_disallowed_by_backend", {
      response_kind: response.kind,
      grounded_status: groundedPlan?.status || "none",
    });
    return {
      shortTermMemoryWrite: false,
      toolName: null,
      ticker: null,
      responseKind: response.kind,
    };
  }

  if (
    (response.kind === "execute" || response.kind === "speak_only") &&
    groundedPlan &&
    groundedPlan.status !== "none" &&
    groundedExecutionEnabled
  ) {
    if (groundedPlan.status === "manual_only") {
      const message = groundedPlan.message || VOICE_MANUAL_ONLY_MESSAGE;
      notifyInfo(message);
      emitExecutionTelemetry(input, "blocked_destructive_intent", {
        action_id: groundedPlan.actionId,
        reason: "self_serve_required",
      });
      return {
        shortTermMemoryWrite: false,
        toolName: null,
        ticker: null,
        responseKind: response.kind,
      };
    }

    if (groundedPlan.status === "unavailable") {
      const message = groundedPlan.message || VOICE_UNAVAILABLE_MESSAGE;
      notifyInfo(message);
      emitExecutionTelemetry(input, "grounded_unavailable", {
        action_id: groundedPlan.actionId,
      });
      return {
        shortTermMemoryWrite: false,
        toolName: null,
        ticker: null,
        responseKind: response.kind,
      };
    }

    if (groundedPlan.status === "resolved" && groundedPlan.execution.steps.length > 0) {
      let executedToolName: string | null = null;
      let extractedTicker: string | null = null;
      let navigated = false;
      let dispatchResult: VoiceDispatchResult | null = null;

      try {
        for (const step of groundedPlan.execution.steps) {
          if (step.type === "navigate") {
            input.router.push(step.href);
            navigated = true;
            emitExecutionTelemetry(input, "hidden_navigation_step", {
              action_id: groundedPlan.actionId,
              href: step.href,
              path_mode: groundedPlan.execution.mode,
            });
            continue;
          }
          if (step.type === "tool_call") {
            dispatchResult = await dispatchVoiceToolCall({
              toolCall: step.toolCall,
              userId: input.userId,
              vaultOwnerToken: input.vaultOwnerToken,
              vaultKey: input.vaultKey,
              router: input.router,
              handleBack: input.handleBack,
              executeKaiCommand: input.executeKaiCommand,
              setAnalysisParams: input.setAnalysisParams,
            });
            if (dispatchResult.status !== "executed") {
              const outcomeTelemetry = buildDispatchTelemetry("grounded_execution", dispatchResult, {
                action_id: groundedPlan.actionId,
                execution_mode: groundedPlan.execution.mode,
                navigated,
              });
              emitExecutionTelemetry(input, outcomeTelemetry.event, outcomeTelemetry.payload);
              return {
                shortTermMemoryWrite: false,
                toolName: null,
                ticker: null,
                responseKind: response.kind,
              };
            }
            executedToolName = dispatchResult.toolName;
            extractedTicker = extractedTicker || extractTickerFromToolCall(step.toolCall);
            continue;
          }
          notifyInfo(step.message);
        }
      } catch (error) {
        const message = VOICE_UNAVAILABLE_MESSAGE;
        notifyInfo(message);
        emitExecutionTelemetry(input, "grounded_execution_failure", {
          action_id: groundedPlan.actionId,
          error: error instanceof Error ? error.message : "unknown_error",
        });
        return {
          shortTermMemoryWrite: false,
          toolName: null,
          ticker: null,
          responseKind: response.kind,
        };
      }

      emitExecutionTelemetry(input, "grounded_execution_success", {
        action_id: groundedPlan.actionId,
        execution_mode: groundedPlan.execution.mode,
        tool_name: executedToolName || null,
        navigated,
      });
      return {
        shortTermMemoryWrite: Boolean(executedToolName || navigated),
        toolName: executedToolName || (navigated ? "navigate" : null),
        ticker: extractedTicker,
        responseKind: response.kind,
      };
    }
  }

  if (groundedPlan && groundedPlan.status !== "none" && !groundedExecutionEnabled) {
    emitExecutionTelemetry(input, "grounded_execution_skipped_rollout_flag", {
      action_id: groundedPlan.actionId,
      status: groundedPlan.status,
    });
  }

  if (response.kind === "execute") {
    if (
      waitingForConfirmation &&
      input.setPendingConfirmation &&
      (response.tool_call.tool_name === "cancel_active_analysis" ||
        response.tool_call.tool_name === "execute_kai_command" ||
        response.tool_call.tool_name === "resume_active_analysis")
    ) {
      input.setPendingConfirmation({
        kind: response.tool_call.tool_name,
        toolCall: response.tool_call,
        prompt: response.message,
        transcript: response.message,
        turnId: input.turnId || null,
        responseId: input.responseId || null,
      });
      emitExecutionTelemetry(input, "confirmation_required", {
        tool_name: response.tool_call.tool_name,
      });
      notifyInfo(response.message);
      return {
        shortTermMemoryWrite: false,
        toolName: null,
        ticker: null,
        responseKind: response.kind,
      };
    }

    if (waitingForConfirmation) {
      emitExecutionTelemetry(input, "execution_deferred_confirmation_without_handler", {
        tool_name: response.tool_call.tool_name,
      });
      return {
        shortTermMemoryWrite: false,
        toolName: null,
        ticker: null,
        responseKind: response.kind,
      };
    }

    try {
      const dispatchResult = await dispatchVoiceToolCall({
        toolCall: response.tool_call,
        userId: input.userId,
        vaultOwnerToken: input.vaultOwnerToken,
        vaultKey: input.vaultKey,
        router: input.router,
        handleBack: input.handleBack,
        executeKaiCommand: input.executeKaiCommand,
        setAnalysisParams: input.setAnalysisParams,
      });
      if (dispatchResult.status !== "executed") {
        const outcomeTelemetry = buildDispatchTelemetry("legacy_execute", dispatchResult);
        emitExecutionTelemetry(input, outcomeTelemetry.event, outcomeTelemetry.payload);
        return {
          shortTermMemoryWrite: false,
          toolName: null,
          ticker: null,
          responseKind: response.kind,
        };
      }
    } catch (error) {
      notifyInfo(VOICE_UNAVAILABLE_MESSAGE);
      emitExecutionTelemetry(input, "legacy_execute_failure", {
        tool_name: response.tool_call.tool_name,
        error: error instanceof Error ? error.message : "unknown_error",
      });
      return {
        shortTermMemoryWrite: false,
        toolName: null,
        ticker: null,
        responseKind: response.kind,
      };
    }
    emitExecutionTelemetry(input, "legacy_execute_success", {
      tool_name: response.tool_call.tool_name,
    });
    return {
      shortTermMemoryWrite: true,
      toolName: response.tool_call.tool_name,
      ticker: extractTickerFromExecute(response),
      responseKind: response.kind,
    };
  }

  if (response.kind === "background_started") {
    notifySuccess(response.message, {
      description: `Run ${response.run_id} started for ${response.ticker}.`,
    });
    emitExecutionTelemetry(input, "background_started", {
      task: response.task,
      ticker: response.ticker,
      run_id: response.run_id,
    });
    return {
      shortTermMemoryWrite: true,
      toolName: "background_started",
      ticker: response.ticker,
      responseKind: response.kind,
    };
  }

  if (response.kind === "already_running") {
    notifyInfo(response.message);
    emitExecutionTelemetry(input, "already_running", {
      task: response.task,
      ticker: response.ticker ?? null,
      run_id: response.run_id ?? null,
    });
    return {
      shortTermMemoryWrite: true,
      toolName: "already_running",
      ticker: response.ticker ?? null,
      responseKind: response.kind,
    };
  }

  if (response.kind === "clarify") {
    notifyInfo(response.message);
    emitExecutionTelemetry(input, "clarify", {
      reason: response.reason,
    });
    return {
      shortTermMemoryWrite: response.reason !== "stt_unusable",
      toolName: response.reason === "stt_unusable" ? null : "clarify",
      ticker: null,
      responseKind: response.kind,
    };
  }

  if (response.kind === "blocked") {
    const message = String(response.message || "").trim() || VOICE_UNAVAILABLE_MESSAGE;
    notifyInfo(message);
    emitExecutionTelemetry(input, "action_blocked", {
      reason: response.reason,
    });
    return {
      shortTermMemoryWrite: false,
      toolName: null,
      ticker: null,
      responseKind: response.kind,
    };
  }

  notifyInfo(String(response.message || "").trim() || VOICE_UNAVAILABLE_MESSAGE);
  emitExecutionTelemetry(input, "fallback_speak_only", {
    response_kind: response.kind,
  });
  return {
    shortTermMemoryWrite: false,
    toolName: null,
    ticker: null,
    responseKind: response.kind,
  };
}
