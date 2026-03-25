import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { ROUTES } from "@/lib/navigation/routes";
import { DebateRunManagerService } from "@/lib/services/debate-run-manager";
import type { AnalysisParams } from "@/lib/stores/kai-session-store";
import type { VoiceToolCall } from "@/lib/voice/voice-types";
import type { ExecuteKaiCommandResult } from "@/lib/kai/command-executor";
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
  executeKaiCommand: () => ExecuteKaiCommandResult;
  setAnalysisParams: (params: AnalysisParams | null) => void;
};

export async function dispatchVoiceToolCall(input: VoiceDispatchInput): Promise<void> {
  const {
    toolCall,
    userId,
    vaultOwnerToken,
    vaultKey,
    router,
    handleBack,
    executeKaiCommand,
    setAnalysisParams,
  } = input;

  const canonicalAction = getInvestorKaiActionByVoiceToolCall(toolCall);
  if (canonicalAction) {
    const resolution = resolveInvestorKaiActionWiring(canonicalAction);
    if (!resolution.resolvable) {
      console.warn(
        `[KAI_ACTION_REGISTRY] unresolved_voice_action id=${canonicalAction.id} reason=${resolution.reason}`
      );
    } else {
      console.info(`[KAI_ACTION_REGISTRY] resolved_voice_action id=${canonicalAction.id}`);
    }
  } else {
    console.warn(`[KAI_ACTION_REGISTRY] missing_action_for_voice_tool tool=${toolCall.tool_name}`);
  }

  console.info("[VOICE_UI] dispatch_tool_call=", toolCall);

  if (toolCall.tool_name === "clarify") {
    toast.info(toolCall.args.question);
    console.info("[VOICE_UI] dispatch_result=clarify");
    return;
  }

  if (toolCall.tool_name === "navigate_back") {
    handleBack();
    console.info("[VOICE_UI] dispatch_result=navigate_back");
    return;
  }

  if (toolCall.tool_name === "execute_kai_command") {
    const result = executeKaiCommand();
    console.info("[VOICE_UI] dispatch_result=execute_kai_command", result);
    if (result.status === "invalid") {
      toast.error("Voice command could not be executed.", {
        description: result.reason || "Invalid command payload.",
      });
    }
    return;
  }

  if (!vaultOwnerToken) {
    toast.error("Unlock your vault to use voice actions.");
    console.info("[VOICE_UI] dispatch_result=blocked_missing_vault_token");
    return;
  }

  if (toolCall.tool_name === "resume_active_analysis") {
    try {
      const task = await DebateRunManagerService.resumeActiveRun({
        userId,
        vaultOwnerToken,
        vaultKey,
      });
      if (task) {
        router.push(`${ROUTES.KAI_ANALYSIS}?focus=active&run_id=${encodeURIComponent(task.runId)}`);
        console.info("[VOICE_UI] dispatch_result=resume_active_analysis attached_run=true");
        return;
      }
      toast.info("No active debate run found.");
      router.push(`${ROUTES.KAI_ANALYSIS}?tab=history`);
      console.info("[VOICE_UI] dispatch_result=resume_active_analysis attached_run=false");
    } catch (error) {
      toast.error("Could not resume active analysis.", {
        description: (error as Error).message,
      });
      console.error("[VOICE_UI] dispatch_result=resume_active_analysis error=", error);
    }
    return;
  }

  if (toolCall.tool_name === "cancel_active_analysis") {
    const activeTask = DebateRunManagerService.getActiveTaskForUser(userId);
    if (!activeTask) {
      toast.info("No active debate run to cancel.");
      console.info("[VOICE_UI] dispatch_result=cancel_active_analysis no_active_task");
      return;
    }

    if (toolCall.args.confirm !== true) {
      toast.info("Cancel request not confirmed.");
      console.info("[VOICE_UI] dispatch_result=cancel_active_analysis not_confirmed");
      return;
    }

    try {
      await DebateRunManagerService.cancelRun({
        runId: activeTask.runId,
        userId: activeTask.userId,
        vaultOwnerToken,
      });
      setAnalysisParams(null);
      router.push(`${ROUTES.KAI_ANALYSIS}?tab=history`);
      toast.success("Active analysis canceled.");
      console.info("[VOICE_UI] dispatch_result=cancel_active_analysis canceled");
    } catch (error) {
      toast.error("Failed to cancel active analysis.", {
        description: (error as Error).message,
      });
      console.error("[VOICE_UI] dispatch_result=cancel_active_analysis error=", error);
    }
  }
}
