"use client";

import type { AgentActionRuntimeResult } from "@/lib/agent/agent-action-runtime";
import type { AgentChatHandoffReason } from "@/lib/agent/one-conversation-session";
import {
  buildVoiceActionResult,
  type VoiceActionResult as CommandVoiceActionResult,
} from "@/lib/kai/command-executor";
import { planOneGoal } from "@/lib/one-goal/one-goal-planner";
import { runOneGoal } from "@/lib/one-goal/one-goal-runner";
import type { OneGoalPlan } from "@/lib/one-goal/one-goal-types";
import type { AnalysisParams } from "@/lib/stores/kai-session-store";
import { getKaiActionById } from "@/lib/voice/kai-action-gateway";
import type { OneVoiceActionProposal } from "@/lib/voice/one-voice-transport";
import {
  VoiceTurnOrchestrator,
  type VoiceSpeakSegmentType,
  type VoiceTurnOrchestratorSpeakInput,
} from "@/lib/voice/voice-turn-orchestrator";
import type {
  AppRuntimeState,
  VoicePlanPayload,
  VoiceResponse,
} from "@/lib/voice/voice-types";
import type { GroundedVoicePlan } from "@/lib/voice/voice-grounding";

type BridgeActionResult = {
  actionResult: CommandVoiceActionResult;
};

type BridgeHandoffInput = {
  reason: AgentChatHandoffReason;
  transcript?: string | null;
  assistantText?: string | null;
  actionId?: string | null;
  resultSummary?: string | null;
};

type RouterLike = {
  push: (href: string) => void;
};

type PendingGoalPlan = Extract<OneGoalPlan, { status: "input_needed" }>;

export type OneVoiceLiveActionBridgeConfig = {
  userId: string | null | undefined;
  vaultOwnerToken: string | null | undefined;
  vaultKey?: string | null;
  getAppRuntimeState: () => AppRuntimeState | undefined;
  getVoiceContext: () => Record<string, unknown> | undefined;
  executeAction: (
    actionId: string,
    slots?: Record<string, unknown>
  ) => Promise<AgentActionRuntimeResult>;
  router?: RouterLike | null;
  setAnalysisParams?: (params: AnalysisParams | null) => void;
  speak: (input: VoiceTurnOrchestratorSpeakInput) => Promise<void>;
  mirrorAssistantText?: (payload: {
    text: string;
    turnId: string;
    segmentType: VoiceSpeakSegmentType;
  }) => void;
  openChatHandoff: (handoff: BridgeHandoffInput) => void;
  setStage?: (stage: "planning" | "dispatch" | "speaking_ack" | "speaking_final" | "idle") => void;
  onDebug?: (event: string, payload?: Record<string, unknown>) => void;
};

function actionResultFromRuntime(result: AgentActionRuntimeResult): CommandVoiceActionResult {
  return buildVoiceActionResult({
    status: result.status,
    actionId: result.actionId,
    routeBefore: result.routeBefore,
    routeAfter: result.routeAfter,
    screenBefore: result.screenBefore,
    screenAfter: result.screenAfter,
    resultSummary: result.resultSummary,
    data: result.data,
  });
}

function blockedActionResult(input: {
  actionId: string | null;
  routeBefore?: string | null;
  screenBefore?: string | null;
  resultSummary: string;
  errorCode: string;
}): CommandVoiceActionResult {
  return buildVoiceActionResult({
    status: "blocked",
    actionId: input.actionId,
    routeBefore: input.routeBefore,
    screenBefore: input.screenBefore,
    resultSummary: input.resultSummary,
    data: {
      errorCode: input.errorCode,
    },
  });
}

function shouldHandoffToChat(params: {
  response: VoiceResponse;
  plan: VoicePlanPayload;
  groundedPlan?: GroundedVoicePlan;
  executionAllowed?: boolean;
  needsConfirmation?: boolean;
}): { handoff: boolean; reason: AgentChatHandoffReason } {
  const actionId = params.groundedPlan?.actionId || params.plan.action_id || null;
  const action = getKaiActionById(actionId);
  if (action?.delegate_agent_id && action.delegate_agent_id !== "one") {
    return { handoff: true, reason: "delegated_action" };
  }
  if (params.needsConfirmation || params.plan.needs_confirmation) {
    return { handoff: true, reason: "sensitive_action" };
  }
  if (params.executionAllowed === false) {
    return { handoff: true, reason: "action_requires_chat" };
  }
  if (params.groundedPlan?.status === "manual_only") {
    return { handoff: true, reason: "manual_only" };
  }
  if (
    params.plan.mode === "start_background_and_ack" ||
    (params.plan as Record<string, unknown>).is_long_running === true
  ) {
    return { handoff: true, reason: "long_running" };
  }
  if (params.response.kind === "execute" && !actionId) {
    return { handoff: true, reason: "action_requires_chat" };
  }
  return { handoff: false, reason: "action_requires_chat" };
}

function goalUsesService(actionId: string | null | undefined, service: string): boolean {
  const action = getKaiActionById(actionId);
  return Boolean(action?.goal.workflow_steps.some((step) => step.service === service));
}

function goalRunsLongLivedService(actionId: string | null | undefined): boolean {
  return goalUsesService(actionId, "kai_debate.ensure_run");
}

function formatGoalOptions(plan: PendingGoalPlan): string {
  const options = plan.prompt.options.filter((option) => option.trim().length > 0);
  if (options.length === 0) {
    return `${plan.prompt.prompt} I do not have a separate option list exposed for this input yet.`;
  }
  const optionText = options.join(", ");
  return `Available options: ${optionText}. Say which one to use, or say cancel to stop this goal.`;
}

function formatGoalPrompt(plan: PendingGoalPlan): string {
  const options = plan.prompt.options.filter((option) => option.trim().length > 0);
  if (options.length === 0) {
    return plan.prompt.prompt;
  }
  return `${plan.prompt.prompt} Available options: ${options.join(", ")}.`;
}

function isGoalOptionQuestion(transcript: string): boolean {
  return /\b(what|which|show|list|tell)\b.*\b(options?|lists?|sources?|choices?|available)\b/i.test(transcript) ||
    /\b(options?|lists?|sources?|choices?)\b.*\b(available|can|use)\b/i.test(transcript);
}

function isCancelGoalRequest(transcript: string): boolean {
  return /\b(cancel|stop|never mind|nevermind|forget it)\b/i.test(transcript);
}

export class OneVoiceLiveActionBridge {
  private config: OneVoiceLiveActionBridgeConfig;
  private orchestrator: VoiceTurnOrchestrator | null = null;
  private pendingGoalPlan: PendingGoalPlan | null = null;

  constructor(config: OneVoiceLiveActionBridgeConfig) {
    this.config = config;
    this.rebuildOrchestrator();
  }

  updateConfig(config: OneVoiceLiveActionBridgeConfig): void {
    const identityChanged =
      this.config.userId !== config.userId ||
      this.config.vaultOwnerToken !== config.vaultOwnerToken;
    this.config = config;
    if (identityChanged) {
      this.pendingGoalPlan = null;
    }
    this.rebuildOrchestrator();
  }

  cancel(reason: string): void {
    this.pendingGoalPlan = null;
    this.orchestrator?.cancelActiveTurn(reason);
    this.config.setStage?.("idle");
  }

  async processTranscript(input: {
    transcript: string;
    candidate?: OneVoiceActionProposal | null;
  }): Promise<void> {
    const transcript = input.transcript.trim();
    if (!transcript) return;
    if (/\b(open|switch|move|show)\b.*\b(chat|text)\b/i.test(transcript)) {
      this.config.openChatHandoff({
        reason: "user_requested",
        transcript,
        assistantText: "I moved this voice turn into chat.",
      });
      return;
    }
    if (!this.config.userId || !this.config.vaultOwnerToken || !this.orchestrator) {
      this.config.openChatHandoff({
        reason: "action_requires_chat",
        transcript,
        assistantText: "Unlock your vault to let One use governed app actions.",
      });
      return;
    }
    const handledByGoal = await this.tryProcessGoalTranscript({
      transcript,
      candidate: input.candidate,
    });
    if (handledByGoal) return;
    await this.orchestrator.processTranscript({
      transcript,
      source: "gemini_live",
      candidateActionId: input.candidate?.action_id ?? null,
      candidateSlots: input.candidate?.slots ?? null,
      candidateReason: input.candidate?.reason ?? null,
    });
  }

  private async tryProcessGoalTranscript(input: {
    transcript: string;
    candidate?: OneVoiceActionProposal | null;
  }): Promise<boolean> {
    const userId = this.config.userId;
    const vaultOwnerToken = this.config.vaultOwnerToken;
    if (!userId || !vaultOwnerToken) return false;
    const plan = planOneGoal({
      transcript: input.transcript,
      candidateActionId: input.candidate?.action_id ?? null,
      slots: input.candidate?.slots ?? null,
      appRuntimeState: this.config.getAppRuntimeState(),
      entrypoint: "voice",
    });
    const pendingPlan = this.pendingGoalPlan;
    if (pendingPlan && !input.candidate && isCancelGoalRequest(input.transcript)) {
      this.pendingGoalPlan = null;
      const turnId = `goal_cancel_${Date.now()}`;
      await this.speakWithStage({
        text: "Canceled that goal.",
        turnId,
        responseId: turnId,
        segmentType: "final",
      });
      return true;
    }
    const activePlan =
      pendingPlan && !input.candidate
        ? planOneGoal({
            transcript: input.transcript,
            actionId: pendingPlan.action.action_id,
            slots: pendingPlan.slots,
            appRuntimeState: this.config.getAppRuntimeState(),
            entrypoint: "voice",
          })
        : plan;
    if (
      pendingPlan &&
      !input.candidate &&
      activePlan.status === "input_needed" &&
      activePlan.action.action_id === pendingPlan.action.action_id &&
      activePlan.prompt.slot === pendingPlan.prompt.slot &&
      isGoalOptionQuestion(input.transcript)
    ) {
      this.pendingGoalPlan = activePlan;
      const turnId = `goal_options_${Date.now()}`;
      await this.speakWithStage({
        text: formatGoalOptions(activePlan),
        turnId,
        responseId: turnId,
        segmentType: "final",
      });
      return true;
    }
    return this.handleGoalPlan({
      plan: activePlan,
      transcript: input.transcript,
      userId,
      vaultOwnerToken,
    });
  }

  private async handleGoalPlan(input: {
    plan: OneGoalPlan;
    transcript: string;
    userId: string;
    vaultOwnerToken: string;
  }): Promise<boolean> {
    const { plan, transcript, userId, vaultOwnerToken } = input;
    if (plan.status === "blocked") {
      return Boolean(this.pendingGoalPlan);
    }
    if (plan.status === "input_needed") {
      this.pendingGoalPlan = plan;
      const turnId = `goal_input_${Date.now()}`;
      await this.speakWithStage({
        text: formatGoalPrompt(plan),
        turnId,
        responseId: turnId,
        segmentType: "final",
      });
      return true;
    }
    this.pendingGoalPlan = null;

    const action = plan.action;
    if (action.delegate_agent_id && action.delegate_agent_id !== "one") {
      this.config.openChatHandoff({
        reason: "delegated_action",
        transcript,
        actionId: action.action_id,
        assistantText: "One is handing this to the right specialist through Agent Chat.",
      });
      return true;
    }
    if (action.execution_policy !== "allow_direct") {
      this.config.openChatHandoff({
        reason: action.execution_policy === "confirm_required" ? "sensitive_action" : "manual_only",
        transcript,
        actionId: action.action_id,
        assistantText: "One needs the governed chat path before this action can run.",
      });
      return true;
    }

    const longRunning = goalRunsLongLivedService(action.action_id);
    const acknowledgement =
      longRunning
        ? `I have what I need. Starting the ${String(plan.slots.symbol || "").toUpperCase()} debate now.`
        : `I have what I need. Running ${action.label}.`;
    const ackTurnId = `goal_ack_${Date.now()}`;
    await this.speakWithStage({
      text: acknowledgement,
      turnId: ackTurnId,
      responseId: ackTurnId,
      segmentType: "ack",
    }, { settleToIdle: false });
    this.config.setStage?.("dispatch");
    try {
      const result = await runOneGoal({
        plan,
        userId,
        vaultOwnerToken,
        vaultKey: this.config.vaultKey,
        router: this.config.router,
        setAnalysisParams: this.config.setAnalysisParams,
        executeAction: this.config.executeAction,
        waitForCompletion: !longRunning,
        callbacks: {
          onProgressText: async (text) => {
            const turnId = `goal_progress_${Date.now()}`;
            await this.speakWithStage({
              text,
              turnId,
              responseId: turnId,
              segmentType: "ack",
            }, { settleToIdle: false });
          },
          onFinalText: async (text) => {
            const turnId = `goal_final_${Date.now()}`;
            await this.speakWithStage({
              text,
              turnId,
              responseId: turnId,
              segmentType: "final",
            });
          },
        },
      });
      if (longRunning && result.resultSummary.text) {
        const turnId = `goal_waiting_${Date.now()}`;
        await this.speakWithStage({
          text: result.resultSummary.text,
          turnId,
          responseId: turnId,
          segmentType: "final",
        });
      } else {
        this.config.setStage?.("idle");
      }
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : "One could not complete that goal.";
      const turnId = `goal_error_${Date.now()}`;
      await this.speakWithStage({
        text: message,
        turnId,
        responseId: turnId,
        segmentType: "final",
      });
    }
    return true;
  }

  private async speakWithStage(
    input: VoiceTurnOrchestratorSpeakInput,
    options?: { settleToIdle?: boolean }
  ): Promise<void> {
    const settleToIdle = options?.settleToIdle ?? true;
    this.config.setStage?.(
      input.segmentType === "ack" ? "speaking_ack" : "speaking_final"
    );
    try {
      await this.config.speak(input);
    } finally {
      if (settleToIdle) {
        this.config.setStage?.("idle");
      }
    }
  }

  private rebuildOrchestrator(): void {
    if (!this.config.userId || !this.config.vaultOwnerToken) {
      this.orchestrator = null;
      return;
    }
    const config = this.config;
    const userId = config.userId as string;
    const vaultOwnerToken = config.vaultOwnerToken as string;
    this.orchestrator = new VoiceTurnOrchestrator({
      userId,
      vaultOwnerToken,
      vaultKey: config.vaultKey,
      getAppRuntimeState: config.getAppRuntimeState,
      getVoiceContext: config.getVoiceContext,
      speak: config.speak,
      onStageChange: config.setStage,
      onDebug: config.onDebug,
      onAssistantText: ({ text, turnId, segmentType }) => {
        config.mirrorAssistantText?.({ text, turnId, segmentType });
      },
      onVoiceResponse: async (payload): Promise<BridgeActionResult | null> => {
        return this.handleVoiceResponse(payload);
      },
    });
  }

  private async handleVoiceResponse(payload: {
    transcript: string;
    response: VoiceResponse;
    plan: VoicePlanPayload;
    groundedPlan?: GroundedVoicePlan;
    executionAllowed?: boolean;
    needsConfirmation?: boolean;
  }): Promise<BridgeActionResult | null> {
    const appRuntimeState = this.config.getAppRuntimeState();
    const actionId = payload.groundedPlan?.actionId || payload.plan.action_id || null;
    const handoffDecision = shouldHandoffToChat(payload);
    if (handoffDecision.handoff) {
      const summary =
        actionId && getKaiActionById(actionId)?.delegate_agent_id
          ? "One is handing this to the right specialist through Agent Chat."
          : "One needs the governed chat path before this action can run.";
      this.config.openChatHandoff({
        reason: handoffDecision.reason,
        transcript: payload.transcript,
        actionId,
        assistantText: summary,
      });
      return {
        actionResult: blockedActionResult({
          actionId,
          routeBefore: appRuntimeState?.route.pathname,
          screenBefore: appRuntimeState?.route.screen,
          resultSummary: summary,
          errorCode: handoffDecision.reason,
        }),
      };
    }

    if (!actionId || payload.response.kind !== "execute") {
      return null;
    }

    const result = await this.config.executeAction(actionId, payload.plan.slots || {});
    return {
      actionResult: actionResultFromRuntime(result),
    };
  }
}
