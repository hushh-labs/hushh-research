import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { buildKaiMarketRoute } from "@/lib/navigation/routes";
import { DebateRunManagerService } from "@/lib/services/debate-run-manager";
import type { Persona } from "@/lib/services/ria-service";
import type { AnalysisParams } from "@/lib/stores/kai-session-store";
import type { VoiceExecuteKaiCommandCall, VoiceToolCall } from "@/lib/voice/voice-types";
import { previewPkmAgentLabCapture } from "@/lib/profile/pkm-agent-lab-capture";
import {
  buildVoiceActionResult,
  type ExecuteKaiCommandResult,
  type VoiceActionResult,
} from "@/lib/kai/command-executor";
import {
  getInvestorKaiActionByVoiceToolCall,
  resolveInvestorKaiActionWiring,
} from "@/lib/voice/investor-kai-action-registry";

type RouterLike = {
  push: (href: string) => void;
};

export type VoiceDispatchInput = {
  toolCall: VoiceToolCall;
  userId: string;
  vaultOwnerToken?: string;
  vaultKey?: string;
  router: RouterLike;
  handleBack: () => void;
  switchPersona?: (target: Persona) => Promise<unknown>;
  executeKaiCommand: (toolCall: VoiceExecuteKaiCommandCall) => ExecuteKaiCommandResult;
  setAnalysisParams: (params: AnalysisParams | null) => void;
  currentRoute?: string | null;
  currentScreen?: string | null;
  activePersona?: Persona | null;
};

export type VoiceDispatchResult = {
  status: "executed" | "blocked" | "invalid" | "failed";
  toolName: VoiceToolCall["tool_name"];
  reason?: string;
  actionResult: VoiceActionResult;
};

type BuildDispatchResultInput = {
  status: VoiceDispatchResult["status"];
  toolName: VoiceToolCall["tool_name"];
  reason?: string;
  actionResult: VoiceActionResult;
};

function buildDispatchResult(input: BuildDispatchResultInput): VoiceDispatchResult {
  return {
    status: input.status,
    toolName: input.toolName,
    reason: input.reason,
    actionResult: input.actionResult,
  };
}

function fallbackCommandActionResult(
  result: Pick<ExecuteKaiCommandResult, "status" | "reason">,
  toolName: VoiceToolCall["tool_name"],
  actionId: string | null,
  routeBefore: string | null,
  screenBefore: string | null
): VoiceActionResult {
  const status =
    result.status === "executed"
      ? "succeeded"
      : result.status === "blocked"
        ? "blocked"
        : "invalid";
  const summary =
    result.status === "executed"
      ? "Executed the requested Kai command."
      : result.status === "blocked"
        ? "The requested Kai command was blocked."
        : "The requested Kai command was invalid.";

  return buildVoiceActionResult({
    status,
    actionId,
    routeBefore,
    screenBefore,
    resultSummary: summary,
    data: {
      toolName,
      reason: result.reason ?? null,
    },
  });
}

export async function dispatchVoiceToolCall(input: VoiceDispatchInput): Promise<VoiceDispatchResult> {
  const {
    toolCall,
    userId,
    vaultOwnerToken,
    vaultKey,
    router,
    handleBack,
    switchPersona,
    executeKaiCommand,
    setAnalysisParams,
    currentRoute,
    currentScreen,
    activePersona,
  } = input;
  const toolName = toolCall.tool_name;
  const handledBuiltinTool =
    toolName === "clarify" ||
    toolName === "navigate_back" ||
    toolName === "execute_kai_command" ||
    toolName === "resume_active_analysis" ||
    toolName === "cancel_active_analysis" ||
    toolName === "switch_persona" ||
    toolName === "capture_pkm_memory" ||
    toolName === "specialist_chat.turn";

  const canonicalAction = getInvestorKaiActionByVoiceToolCall(toolCall);
  const canonicalActionId = canonicalAction?.id ?? null;
  if (canonicalAction) {
    const resolution = resolveInvestorKaiActionWiring(canonicalAction);
    if (!resolution.resolvable) {
      console.warn(
        `[KAI_ACTION_REGISTRY] unresolved_voice_action id=${canonicalAction.id} reason=${resolution.reason}`
      );
    } else {
      console.info(`[KAI_ACTION_REGISTRY] resolved_voice_action id=${canonicalAction.id}`);
    }
  } else if (!handledBuiltinTool) {
    console.warn(`[KAI_ACTION_REGISTRY] missing_action_for_voice_tool tool=${toolName}`);
  }

  console.info("[VOICE_UI] dispatch_tool_call=", toolCall);

  if (toolCall.tool_name === "clarify") {
    toast.info(toolCall.args.question);
    console.info("[VOICE_UI] dispatch_result=clarify");
    return buildDispatchResult({
      status: "executed",
      toolName: "clarify",
      actionResult: buildVoiceActionResult({
        status: "noop",
        actionId: canonicalActionId,
        routeBefore: currentRoute,
        screenBefore: currentScreen,
        resultSummary: `Asked for clarification: ${toolCall.args.question}`,
        data: {
          toolName: "clarify",
        },
      }),
    });
  }

  if (toolCall.tool_name === "navigate_back") {
    handleBack();
    console.info("[VOICE_UI] dispatch_result=navigate_back");
    return buildDispatchResult({
      status: "executed",
      toolName: "navigate_back",
      actionResult: buildVoiceActionResult({
        status: "succeeded",
        actionId: canonicalActionId,
        routeBefore: currentRoute,
        screenBefore: currentScreen,
        resultSummary: "Navigated back.",
        data: {
          toolName: "navigate_back",
        },
      }),
    });
  }

  if (toolCall.tool_name === "execute_kai_command") {
    const result = executeKaiCommand(toolCall);
    console.info("[VOICE_UI] dispatch_result=execute_kai_command", result);
    if (result.status === "invalid") {
      toast.error("Voice command could not be executed.", {
        description: result.reason || "Invalid command payload.",
      });
    }
    return buildDispatchResult({
      status: result.status,
      toolName: "execute_kai_command",
      reason: result.reason,
      actionResult:
        result.actionResult ||
        fallbackCommandActionResult(
          result,
          "execute_kai_command",
          canonicalActionId,
          currentRoute ?? null,
          currentScreen ?? null
        ),
    });
  }

  if (toolCall.tool_name === "switch_persona") {
    const targetPersona = toolCall.args.target_persona;
    if (!switchPersona) {
      return buildDispatchResult({
        status: "invalid",
        toolName: "switch_persona",
        reason: "missing_persona_switch_handler",
        actionResult: buildVoiceActionResult({
          status: "failed",
          actionId: canonicalActionId,
          routeBefore: currentRoute,
          screenBefore: currentScreen,
          resultSummary: "Persona switch is not available in this Kai runtime.",
          data: {
            toolName: "switch_persona",
            targetPersona,
          },
        }),
      });
    }

    if (activePersona === targetPersona) {
      return buildDispatchResult({
        status: "executed",
        toolName: "switch_persona",
        actionResult: buildVoiceActionResult({
          status: "noop",
          actionId: canonicalActionId,
          routeBefore: currentRoute,
          routeAfter: currentRoute,
          screenBefore: currentScreen,
          screenAfter: currentScreen,
          resultSummary: `Already in the ${targetPersona.toUpperCase()} workspace.`,
          data: {
            toolName: "switch_persona",
            targetPersona,
          },
        }),
      });
    }

    try {
      await switchPersona(targetPersona);
      const routeAfter = toolCall.args.after_route || currentRoute || null;
      if (toolCall.args.after_route) {
        router.push(toolCall.args.after_route);
      }
      return buildDispatchResult({
        status: "executed",
        toolName: "switch_persona",
        actionResult: buildVoiceActionResult({
          status: "succeeded",
          actionId: canonicalActionId,
          routeBefore: currentRoute,
          routeAfter,
          screenBefore: currentScreen,
          screenAfter: toolCall.args.after_screen || null,
          resultSummary: `Switched to the ${targetPersona.toUpperCase()} workspace.`,
          data: {
            toolName: "switch_persona",
            targetPersona,
          },
        }),
      });
    } catch (error) {
      return buildDispatchResult({
        status: "failed",
        toolName: "switch_persona",
        reason: "persona_switch_failed",
        actionResult: buildVoiceActionResult({
          status: "failed",
          actionId: canonicalActionId,
          routeBefore: currentRoute,
          screenBefore: currentScreen,
          resultSummary:
            error instanceof Error && error.message.trim()
              ? error.message.trim()
              : `Could not switch to the ${targetPersona.toUpperCase()} workspace.`,
          data: {
            toolName: "switch_persona",
            targetPersona,
          },
        }),
      });
    }
  }

  if (!vaultOwnerToken) {
    toast.error("Unlock your vault to use voice actions.");
    console.info("[VOICE_UI] dispatch_result=blocked_missing_vault_token");
    return buildDispatchResult({
      status: "blocked",
      toolName,
      reason: "missing_vault_token",
      actionResult: buildVoiceActionResult({
        status: "blocked",
        actionId: canonicalActionId,
        routeBefore: currentRoute,
        screenBefore: currentScreen,
        resultSummary: "Unlock the vault before using this One Voice action.",
        data: {
          toolName,
          reason: "missing_vault_token",
        },
      }),
    });
  }

  if (toolCall.tool_name === "capture_pkm_memory") {
    const message = String(toolCall.args.message || "").trim();
    if (!message) {
      const routeAfter = "/profile/pkm-agent-lab";
      router.push(routeAfter);
      return buildDispatchResult({
        status: "blocked",
        toolName: "capture_pkm_memory",
        reason: "missing_pkm_capture_message",
        actionResult: buildVoiceActionResult({
          status: "blocked",
          actionId: canonicalActionId,
          routeBefore: currentRoute,
          routeAfter,
          screenBefore: currentScreen,
          screenAfter: "profile_pkm_agent_lab",
          resultSummary: "Tell One the memory to preview and review, then try again.",
          data: {
            toolName: "capture_pkm_memory",
            reason: "missing_pkm_capture_message",
          },
        }),
      });
    }
    try {
      const preview = await previewPkmAgentLabCapture({
        userId,
        message,
        vaultOwnerToken,
      });
      const routeAfter = "/profile/pkm-agent-lab";
      router.push(routeAfter);
      toast.info("Review the PKM preview before saving.");
      return buildDispatchResult({
        status: "executed",
        toolName: "capture_pkm_memory",
        actionResult: buildVoiceActionResult({
          status: "succeeded",
          actionId: canonicalActionId,
          routeBefore: currentRoute,
          routeAfter,
          screenBefore: currentScreen,
          screenAfter: "profile_pkm_agent_lab",
          resultSummary: "Prepared a PKM capture preview for owner review.",
          data: {
            toolName: "capture_pkm_memory",
            writeMode: preview.preview_summary?.primary_write_mode || null,
            confirmationRequired: true,
          },
        }),
      });
    } catch (error) {
      toast.error("Could not prepare this memory preview.", {
        description: error instanceof Error ? error.message : undefined,
      });
      return buildDispatchResult({
        status: "failed",
        toolName: "capture_pkm_memory",
        reason: "pkm_capture_failed",
        actionResult: buildVoiceActionResult({
          status: "failed",
          actionId: canonicalActionId,
          routeBefore: currentRoute,
          screenBefore: currentScreen,
          resultSummary:
            error instanceof Error && error.message.trim()
              ? error.message.trim()
              : "Could not prepare this memory preview.",
          data: {
            toolName: "capture_pkm_memory",
            reason: "pkm_capture_failed",
          },
        }),
      });
    }
  }

  if (toolCall.tool_name === "resume_active_analysis") {
    try {
      const task = await DebateRunManagerService.resumeActiveRun({
        userId,
        vaultOwnerToken,
        vaultKey,
      });
      if (task) {
        const routeAfter = buildKaiMarketRoute("analysis", {
          focus: "active",
          run_id: task.runId,
        });
        router.push(routeAfter);
        console.info("[VOICE_UI] dispatch_result=resume_active_analysis attached_run=true");
        return buildDispatchResult({
          status: "executed",
          toolName: "resume_active_analysis",
        actionResult: buildVoiceActionResult({
          status: "succeeded",
          actionId: canonicalActionId,
          routeBefore: currentRoute,
          routeAfter,
          screenBefore: currentScreen,
          screenAfter: "kai_analysis",
          resultSummary: "Resumed the active analysis run.",
          data: {
            toolName: "resume_active_analysis",
            runId: task.runId,
            },
          }),
        });
      }
      toast.info("No active debate run found.");
      const routeAfter = buildKaiMarketRoute("analysis", { view: "history" });
      router.push(routeAfter);
      console.info("[VOICE_UI] dispatch_result=resume_active_analysis attached_run=false");
      return buildDispatchResult({
        status: "blocked",
        toolName: "resume_active_analysis",
        reason: "no_active_task",
        actionResult: buildVoiceActionResult({
          status: "blocked",
          actionId: canonicalActionId,
          routeBefore: currentRoute,
          routeAfter,
          screenBefore: currentScreen,
          screenAfter: "kai_analysis",
          resultSummary: "No active analysis run was available to resume.",
          data: {
            toolName: "resume_active_analysis",
            reason: "no_active_task",
          },
        }),
      });
    } catch (error) {
      toast.error("Could not resume active analysis.", {
        description: (error as Error).message,
      });
      console.error("[VOICE_UI] dispatch_result=resume_active_analysis error=", error);
      return buildDispatchResult({
        status: "failed",
        toolName: "resume_active_analysis",
        reason: "resume_failed",
        actionResult: buildVoiceActionResult({
          status: "failed",
          actionId: canonicalActionId,
          routeBefore: currentRoute,
          screenBefore: currentScreen,
          resultSummary: "Could not resume the active analysis run.",
          data: {
            toolName: "resume_active_analysis",
            reason: "resume_failed",
          },
        }),
      });
    }
  }

  if (toolCall.tool_name === "cancel_active_analysis") {
    const activeTask = DebateRunManagerService.getActiveTaskForUser(userId);
    if (!activeTask) {
      toast.info("No active debate run to cancel.");
      console.info("[VOICE_UI] dispatch_result=cancel_active_analysis no_active_task");
      return buildDispatchResult({
        status: "blocked",
        toolName: "cancel_active_analysis",
        reason: "no_active_task",
        actionResult: buildVoiceActionResult({
          status: "blocked",
          actionId: canonicalActionId,
          routeBefore: currentRoute,
          screenBefore: currentScreen,
          resultSummary: "No active analysis run was available to cancel.",
          data: {
            toolName: "cancel_active_analysis",
            reason: "no_active_task",
          },
        }),
      });
    }

    if (toolCall.args.confirm !== true) {
      toast.info("Cancel request not confirmed.");
      console.info("[VOICE_UI] dispatch_result=cancel_active_analysis not_confirmed");
      return buildDispatchResult({
        status: "blocked",
        toolName: "cancel_active_analysis",
        reason: "not_confirmed",
        actionResult: buildVoiceActionResult({
          status: "blocked",
          actionId: canonicalActionId,
          routeBefore: currentRoute,
          screenBefore: currentScreen,
          resultSummary: "Canceling the active analysis run still needs confirmation.",
          data: {
            toolName: "cancel_active_analysis",
            reason: "not_confirmed",
          },
        }),
      });
    }

    try {
      await DebateRunManagerService.cancelRun({
        runId: activeTask.runId,
        userId: activeTask.userId,
        vaultOwnerToken,
      });
      setAnalysisParams(null);
      const routeAfter = buildKaiMarketRoute("analysis", { view: "history" });
      router.push(routeAfter);
      toast.success("Active analysis canceled.");
      console.info("[VOICE_UI] dispatch_result=cancel_active_analysis canceled");
      return buildDispatchResult({
        status: "executed",
        toolName: "cancel_active_analysis",
        actionResult: buildVoiceActionResult({
          status: "succeeded",
          actionId: canonicalActionId,
          routeBefore: currentRoute,
          routeAfter,
          screenBefore: currentScreen,
          screenAfter: "kai_analysis",
          resultSummary: "Canceled the active analysis run.",
          data: {
            toolName: "cancel_active_analysis",
            runId: activeTask.runId,
          },
        }),
      });
    } catch (error) {
      toast.error("Failed to cancel active analysis.", {
        description: (error as Error).message,
      });
      console.error("[VOICE_UI] dispatch_result=cancel_active_analysis error=", error);
      return buildDispatchResult({
        status: "failed",
        toolName: "cancel_active_analysis",
        reason: "cancel_failed",
        actionResult: buildVoiceActionResult({
          status: "failed",
          actionId: canonicalActionId,
          routeBefore: currentRoute,
          screenBefore: currentScreen,
          resultSummary: "Failed to cancel the active analysis run.",
          data: {
            toolName: "cancel_active_analysis",
            reason: "cancel_failed",
          },
        }),
      });
    }
  }

  if (toolCall.tool_name === "specialist_chat.turn") {
    return buildDispatchResult({
      status: "blocked",
      toolName,
      reason: "requires_one_goal_runner",
      actionResult: buildVoiceActionResult({
        status: "blocked",
        actionId: canonicalActionId,
        routeBefore: currentRoute,
        screenBefore: currentScreen,
        resultSummary:
          "This specialist turn must run through One Goal and Agent Chat, not direct voice dispatch.",
        data: {
          toolName,
          reason: "requires_one_goal_runner",
          delegateAgentId: toolCall.args.delegate_agent_id ?? null,
        },
      }),
    });
  }

  return buildDispatchResult({
    status: "invalid",
    toolName,
    reason: "unsupported_tool_call",
    actionResult: buildVoiceActionResult({
      status: "invalid",
      actionId: canonicalActionId,
      routeBefore: currentRoute,
      screenBefore: currentScreen,
      resultSummary: "The requested voice tool call is not supported.",
      data: {
        toolName,
        reason: "unsupported_tool_call",
      },
    }),
  });
}
