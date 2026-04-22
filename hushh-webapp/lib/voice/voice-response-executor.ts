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
import {
  buildVoiceActionResult,
  type ExecuteKaiCommandResult,
  type VoiceActionResult,
} from "@/lib/kai/command-executor";

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
  // Temporary Phase 4 shim: legacy speak_only transcript/response grounding must be
  // explicitly re-enabled instead of silently executing on the normal path.
  allowSpeakOnlyCompatibilityFallback?: boolean;
  suppressNotifications?: boolean;
  turnId?: string;
  responseId?: string;
  currentRoute?: string | null;
  currentScreen?: string | null;
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
  actionResult: VoiceActionResult;
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

function buildExecutorActionResult(
  status: VoiceActionResult["status"],
  input: ExecuteVoiceResponseInput,
  overrides: Partial<VoiceActionResult> & Pick<VoiceActionResult, "resultSummary">
): VoiceActionResult {
  return buildVoiceActionResult({
    status,
    actionId: overrides.actionId ?? null,
    routeBefore: overrides.routeBefore ?? input.currentRoute ?? null,
    routeAfter: overrides.routeAfter ?? null,
    screenBefore: overrides.screenBefore ?? input.currentScreen ?? null,
    screenAfter: overrides.screenAfter ?? null,
    resultSummary: overrides.resultSummary,
    data: overrides.data,
  });
}

function mergeActionResult(
  input: ExecuteVoiceResponseInput,
  actionResult: VoiceActionResult | undefined,
  defaults: Partial<VoiceActionResult> & Pick<VoiceActionResult, "resultSummary" | "status">
): VoiceActionResult {
  const mergedData =
    actionResult?.data || defaults.data
      ? {
          ...(defaults.data || {}),
          ...(actionResult?.data || {}),
        }
      : undefined;

  return buildVoiceActionResult({
    status: actionResult?.status ?? defaults.status,
    actionId: actionResult?.actionId ?? defaults.actionId ?? null,
    routeBefore: actionResult?.routeBefore ?? defaults.routeBefore ?? input.currentRoute ?? null,
    routeAfter: actionResult?.routeAfter ?? defaults.routeAfter ?? null,
    screenBefore:
      actionResult?.screenBefore ?? defaults.screenBefore ?? input.currentScreen ?? null,
    screenAfter: actionResult?.screenAfter ?? defaults.screenAfter ?? null,
    resultSummary: actionResult?.resultSummary || defaults.resultSummary,
    data: mergedData,
  });
}

function fallbackDispatchSummary(
  status: VoiceDispatchResult["status"],
  scope: "legacy" | "grounded"
): string {
  const subject =
    scope === "grounded" ? "The requested grounded voice action" : "The requested voice action";

  if (status === "executed") {
    return scope === "grounded"
      ? "Completed the grounded voice action."
      : "Executed the requested voice action.";
  }
  if (status === "blocked") {
    return `${subject} was blocked.`;
  }
  if (status === "invalid") {
    return `${subject} was invalid.`;
  }
  return `${subject} failed.`;
}

export async function executeVoiceResponse(
  input: ExecuteVoiceResponseInput
): Promise<ExecuteVoiceResponseResult> {
  const { response, groundedPlan } = input;
  const voiceFlags = getVoiceV2Flags();
  const groundedExecutionEnabled = voiceFlags.groundedActionExecutionEnabled;
  const executionAllowed = input.executionAllowed !== false;
  const allowSpeakOnlyCompatibilityFallback =
    input.allowSpeakOnlyCompatibilityFallback === true;
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
      actionResult: buildExecutorActionResult("blocked", input, {
        actionId: groundedPlan?.actionId ?? null,
        resultSummary: "Execution was disallowed by the backend for this response.",
        data: {
          responseKind: response.kind,
          groundedStatus: groundedPlan?.status || "none",
        },
      }),
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
        actionResult: buildExecutorActionResult("blocked", input, {
          actionId: groundedPlan.actionId,
          resultSummary: message,
          data: {
            executionMode: groundedPlan.execution.mode,
            policy: "manual_only",
          },
        }),
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
        actionResult: buildExecutorActionResult("blocked", input, {
          actionId: groundedPlan.actionId,
          resultSummary: message,
          data: {
            executionMode: groundedPlan.execution.mode,
            policy: "unavailable",
          },
        }),
      };
    }

    const shouldExecuteResolvedGroundedPlan =
      response.kind === "execute" ||
      groundedPlan.resolutionSource === "canonical" ||
      allowSpeakOnlyCompatibilityFallback;

    if (
      response.kind === "speak_only" &&
      groundedPlan.status === "resolved" &&
      groundedPlan.execution.steps.length > 0 &&
      !shouldExecuteResolvedGroundedPlan
    ) {
      emitExecutionTelemetry(input, "speak_only_execution_skipped_missing_canonical", {
        action_id: groundedPlan.actionId,
        resolution_source: groundedPlan.resolutionSource,
        compatibility_fallback_enabled: allowSpeakOnlyCompatibilityFallback,
      });
      return {
        shortTermMemoryWrite: false,
        toolName: null,
        ticker: null,
        responseKind: response.kind,
        actionResult: buildExecutorActionResult("noop", input, {
          actionId: groundedPlan.actionId,
          resultSummary: "I couldn't complete that action from the current Kai voice plan.",
          data: {
            executionMode: groundedPlan.execution.mode,
            resolutionSource: groundedPlan.resolutionSource,
            compatibilityFallbackRequired: true,
          },
        }),
      };
    }

    if (
      response.kind === "speak_only" &&
      groundedPlan.status === "resolved" &&
      groundedPlan.execution.steps.length > 0 &&
      shouldExecuteResolvedGroundedPlan
    ) {
      emitExecutionTelemetry(
        input,
        groundedPlan.resolutionSource === "canonical"
          ? "speak_only_execution_via_canonical_action"
          : "speak_only_execution_compatibility_fallback_used",
        {
          action_id: groundedPlan.actionId,
          resolution_source: groundedPlan.resolutionSource,
        }
      );
    }

    if (groundedPlan.status === "resolved" && groundedPlan.execution.steps.length === 0) {
      emitExecutionTelemetry(input, "grounded_execution_noop", {
        action_id: groundedPlan.actionId,
        execution_mode: groundedPlan.execution.mode,
        resolution_source: groundedPlan.resolutionSource,
      });
      return {
        shortTermMemoryWrite: false,
        toolName: null,
        ticker: null,
        responseKind: response.kind,
        actionResult: buildExecutorActionResult("noop", input, {
          actionId: groundedPlan.actionId,
          resultSummary:
            groundedPlan.execution.mode === "navigate_only"
              ? "You're already on the right Kai screen."
              : "That Kai voice action is already in the expected state.",
          data: {
            executionMode: groundedPlan.execution.mode,
            resolutionSource: groundedPlan.resolutionSource,
          },
        }),
      };
    }

    if (groundedPlan.status === "resolved" && groundedPlan.execution.steps.length > 0) {
      let executedToolName: string | null = null;
      let extractedTicker: string | null = null;
      let navigated = false;
      let dispatchResult: VoiceDispatchResult | null = null;
      let routeAfter: string | null = null;

      try {
        for (const step of groundedPlan.execution.steps) {
          if (step.type === "navigate") {
            input.router.push(step.href);
            navigated = true;
            routeAfter = step.href;
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
              currentRoute: routeAfter ?? input.currentRoute ?? null,
              currentScreen: input.currentScreen ?? null,
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
                actionResult: mergeActionResult(input, dispatchResult.actionResult, {
                  status:
                    dispatchResult.status === "failed"
                      ? "failed"
                : dispatchResult.status === "invalid"
                  ? "invalid"
                  : "blocked",
                  actionId: groundedPlan.actionId,
                  routeAfter,
                  resultSummary: fallbackDispatchSummary(dispatchResult.status, "grounded"),
                  data: {
                    executionMode: groundedPlan.execution.mode,
                    navigated,
                  },
                }),
              };
            }
            executedToolName = dispatchResult.toolName;
            extractedTicker = extractedTicker || extractTickerFromToolCall(step.toolCall);
            routeAfter = dispatchResult.actionResult?.routeAfter ?? routeAfter;
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
          actionResult: buildExecutorActionResult("failed", input, {
            actionId: groundedPlan.actionId,
            routeAfter,
            resultSummary: message,
            data: {
              executionMode: groundedPlan.execution.mode,
              error: error instanceof Error ? error.message : "unknown_error",
            },
          }),
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
        actionResult: mergeActionResult(input, dispatchResult?.actionResult, {
          status: navigated || executedToolName ? "succeeded" : "noop",
          actionId: groundedPlan.actionId,
          routeAfter,
          resultSummary:
            dispatchResult?.actionResult?.resultSummary ||
            (routeAfter ? `Navigated to ${routeAfter}.` : "Completed the grounded voice action."),
          data: {
            executionMode: groundedPlan.execution.mode,
            navigated,
            toolName: executedToolName,
          },
        }),
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
        actionResult: buildExecutorActionResult("noop", input, {
          resultSummary: "Waiting for confirmation before running the requested action.",
          data: {
            toolName: response.tool_call.tool_name,
          },
        }),
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
        actionResult: buildExecutorActionResult("noop", input, {
          resultSummary: "Execution is waiting for confirmation, but no confirmation handler is registered.",
          data: {
            toolName: response.tool_call.tool_name,
          },
        }),
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
        currentRoute: input.currentRoute ?? null,
        currentScreen: input.currentScreen ?? null,
      });
      if (dispatchResult.status !== "executed") {
        const outcomeTelemetry = buildDispatchTelemetry("legacy_execute", dispatchResult);
        emitExecutionTelemetry(input, outcomeTelemetry.event, outcomeTelemetry.payload);
        return {
          shortTermMemoryWrite: false,
          toolName: null,
          ticker: null,
          responseKind: response.kind,
          actionResult: mergeActionResult(input, dispatchResult.actionResult, {
            status:
              dispatchResult.status === "failed"
                ? "failed"
                : dispatchResult.status === "invalid"
                  ? "invalid"
                  : "blocked",
            resultSummary: fallbackDispatchSummary(dispatchResult.status, "legacy"),
          }),
        };
      }
      const actionResult = mergeActionResult(input, dispatchResult.actionResult, {
        status: "succeeded",
        resultSummary: fallbackDispatchSummary(dispatchResult.status, "legacy"),
      });
      emitExecutionTelemetry(input, "legacy_execute_success", {
        tool_name: response.tool_call.tool_name,
      });
      return {
        shortTermMemoryWrite: true,
        toolName: response.tool_call.tool_name,
        ticker: extractTickerFromExecute(response),
        responseKind: response.kind,
        actionResult,
      };
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
        actionResult: buildExecutorActionResult("failed", input, {
          resultSummary: VOICE_UNAVAILABLE_MESSAGE,
          data: {
            toolName: response.tool_call.tool_name,
            error: error instanceof Error ? error.message : "unknown_error",
          },
        }),
      };
    }
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
      actionResult: buildExecutorActionResult("started", input, {
        resultSummary: response.message,
        data: {
          task: response.task,
          ticker: response.ticker,
          runId: response.run_id,
        },
      }),
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
      actionResult: buildExecutorActionResult("noop", input, {
        resultSummary: response.message,
        data: {
          task: response.task,
          ticker: response.ticker ?? null,
          runId: response.run_id ?? null,
        },
      }),
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
      actionResult: buildExecutorActionResult("noop", input, {
        resultSummary: response.message,
        data: {
          reason: response.reason,
        },
      }),
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
      actionResult: buildExecutorActionResult("blocked", input, {
        resultSummary: message,
        data: {
          reason: response.reason,
        },
      }),
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
    actionResult: buildExecutorActionResult("noop", input, {
      resultSummary: String(response.message || "").trim() || VOICE_UNAVAILABLE_MESSAGE,
      data: {
        responseKind: response.kind,
      },
    }),
  };
}
