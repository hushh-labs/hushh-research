"use client";

import type { AgentActionRuntimeResult } from "@/lib/agent/agent-action-runtime";
import type { AgentChatHandoffReason } from "@/lib/agent/one-conversation-session";
import type { SpecialistDirectiveEvent } from "@/lib/services/agent-chat-client";
import {
  buildVoiceActionResult,
  type VoiceActionResult as CommandVoiceActionResult,
} from "@/lib/kai/command-executor";
import { planOneGoal } from "@/lib/one-goal/one-goal-planner";
import { runOneGoal } from "@/lib/one-goal/one-goal-runner";
import type { OneGoalPlan } from "@/lib/one-goal/one-goal-types";
import type { AnalysisParams } from "@/lib/stores/kai-session-store";
import {
  evaluateKaiActionAvailability,
  getKaiActionById,
} from "@/lib/voice/kai-action-gateway";
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
  specialistDirective?: SpecialistDirectiveEvent | null;
};

type RouterLike = {
  push: (href: string) => void;
};

type PendingGoalPlan = Extract<OneGoalPlan, { status: "input_needed" }>;

const ACTION_PROPOSAL_CONFIDENCE_FLOOR = 0.55;

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
  if (
    action?.delegate_agent_id &&
    action.delegate_agent_id !== "one" &&
    !goalUsesService(actionId, "specialist_chat.turn")
  ) {
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

function getPlannerCandidate(
  proposal: OneVoiceActionProposal | null | undefined
): OneVoiceActionProposal | null {
  if (!proposal) return null;
  const confidence = proposal.confidence;
  // A proposal without a finite numeric confidence must NOT bypass the floor:
  // model self-reports are already optimistic, and a null/absent confidence is
  // the least trustworthy signal of all. Fail closed and let the lexical
  // planner rank the transcript from scratch instead.
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < ACTION_PROPOSAL_CONFIDENCE_FLOOR
  ) {
    return null;
  }
  return proposal;
}

function containsSensitiveMemoryText(transcript: string): boolean {
  const lower = transcript.toLowerCase();
  const forbidden = [
    "password",
    "passphrase",
    "secret",
    "private key",
    "api key",
    "token",
    "ssn",
    "social security",
    "passport",
    "driver license",
    "routing number",
    "account number",
  ];
  if (forbidden.some((keyword) => lower.includes(keyword))) return true;
  if (/\b\d{8,}\b/.test(transcript)) return true;
  if (/\b[a-zA-Z0-9_-]{24,}\b/.test(transcript)) return true;
  return false;
}

export function classifyOneVoicePkmMemoryCandidate(transcript: string): {
  candidate: boolean;
  explicit: boolean;
  reason: "explicit_remember" | "stable_user_preference" | null;
} {
  const text = transcript.trim();
  if (!text || text.length > 320 || containsSensitiveMemoryText(text)) {
    return { candidate: false, explicit: false, reason: null };
  }
  const explicit =
    /\b(?:remember|save|store|add)\b[\s\S]{0,140}\b(?:this|that|to memory|to my memory|to personal data|to pkm|as my preference)\b/i.test(
      text
    ) ||
    /\b(?:remember|save|store)\b\s+(?:that\s+)?(?:i|my)\b/i.test(text);
  if (explicit) {
    return { candidate: true, explicit: true, reason: "explicit_remember" };
  }
  const stablePreference =
    /\b(?:i prefer|i usually|i always|i normally|my default|call me|my preference is|i like to)\b/i.test(
      text
    ) && !/[?]/.test(text);
  if (stablePreference) {
    return { candidate: true, explicit: false, reason: "stable_user_preference" };
  }
  return { candidate: false, explicit: false, reason: null };
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
    const memoryCandidate = classifyOneVoicePkmMemoryCandidate(transcript);
    if (memoryCandidate.candidate) {
      this.config.openChatHandoff({
        reason: "pkm_memory_candidate",
        transcript,
        actionId: "profile.pkm.preview_capture",
        assistantText: memoryCandidate.explicit
          ? "I can review that before saving it to your personal data."
          : "That may be useful to remember. Review it before saving it to your personal data.",
      });
      return;
    }
    if (!this.config.userId || !this.config.vaultOwnerToken || !this.orchestrator) {
      // Pre-vault (onboarding/anon/locked) lane: pure navigation contracts are
      // still governed app actions and never touch private data, so voice can
      // move a brand-new person through getting-started, sign-in, and vault
      // setup instead of dead-ending on "unlock your vault".
      const handledPreVault = await this.tryProcessPreVaultNavigation({
        transcript,
        candidate: getPlannerCandidate(input.candidate),
      });
      if (handledPreVault) return;
      this.config.openChatHandoff({
        reason: "action_requires_chat",
        transcript,
        assistantText: "Unlock your vault to let One use governed app actions.",
      });
      return;
    }
    const plannerCandidate = getPlannerCandidate(input.candidate);
    const handledByGoal = await this.tryProcessGoalTranscript({
      transcript,
      candidate: plannerCandidate,
    });
    if (handledByGoal) return;
    await this.orchestrator.processTranscript({
      transcript,
      source: "gemini_live",
      candidateActionId: plannerCandidate?.action_id ?? null,
      candidateSlots: plannerCandidate?.slots ?? null,
      candidateReason: plannerCandidate?.reason ?? null,
    });
  }

  private currentVoiceScreen(): string | null {
    const context = this.config.getVoiceContext();
    const route =
      context && typeof context.route === "object" && context.route !== null
        ? (context.route as Record<string, unknown>)
        : null;
    const screen = route?.screen;
    return typeof screen === "string" && screen.trim() ? screen.trim() : null;
  }

  /**
   * Pre-vault navigation lane. Only pure route actions that are low-risk,
   * allow_direct, wired, and pass availability for the CURRENT (locked/anon)
   * runtime state may execute. Everything else falls back to the chat handoff.
   * This keeps voice useful from the very first onboarding screen without
   * widening any data or execution authority.
   */
  private async tryProcessPreVaultNavigation(input: {
    transcript: string;
    candidate?: OneVoiceActionProposal | null;
  }): Promise<boolean> {
    const plan = planOneGoal({
      transcript: input.transcript,
      candidateActionId: input.candidate?.action_id ?? null,
      appRuntimeState: this.config.getAppRuntimeState(),
      currentScreen: this.currentVoiceScreen(),
      entrypoint: "voice",
    });
    if (plan.status !== "ready") return false;
    const action = plan.action;
    const isPureNavigation =
      action.execution_policy === "allow_direct" &&
      action.execution_target.status === "wired" &&
      action.execution_target.path === "route" &&
      action.risk_level === "low" &&
      action.goal.required_inputs.length === 0;
    if (!isPureNavigation) return false;
    const availability = evaluateKaiActionAvailability({
      action,
      appRuntimeState: this.config.getAppRuntimeState(),
    });
    if (availability.status !== "available") return false;
    this.config.setStage?.("dispatch");
    const result = await this.config.executeAction(action.action_id);
    const turnId = `prevault_nav_${Date.now()}`;
    const text =
      result.status === "started" || result.status === "succeeded"
        ? `Opening ${action.label.replace(/^Open\s+/i, "")}.`
        : result.resultSummary || "I could not open that right now.";
    await this.speakWithStage({
      text,
      turnId,
      responseId: turnId,
      segmentType: "final",
    });
    return result.status === "started" || result.status === "succeeded";
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
      currentScreen: this.currentVoiceScreen(),
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
            currentScreen: this.currentVoiceScreen(),
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
      // A blocked plan WITH an inferred action carries a real prerequisite
      // explanation ("Unlock the vault...", "Import your portfolio first.").
      // Speak it so the user hears why, instead of the model improvising or
      // the turn dying silently. Blocked plans with no action fall through to
      // the conversational path.
      if (plan.action && plan.reason) {
        const turnId = `goal_blocked_${Date.now()}`;
        await this.speakWithStage({
          text: plan.reason,
          turnId,
          responseId: turnId,
          segmentType: "final",
        });
        return true;
      }
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
    const specialistGoal = goalUsesService(action.action_id, "specialist_chat.turn");
    if (action.delegate_agent_id && action.delegate_agent_id !== "one" && !specialistGoal) {
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
        screenContext: this.config.getVoiceContext(),
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
      if (result.actionResult.data?.requiresChatHandoff === true) {
        const specialistDirective =
          result.actionResult.data.specialistDirective &&
          typeof result.actionResult.data.specialistDirective === "object"
            ? (result.actionResult.data.specialistDirective as SpecialistDirectiveEvent)
            : null;
        this.config.openChatHandoff({
          reason: "delegated_action",
          transcript,
          actionId: action.action_id,
          assistantText: result.resultSummary.text,
          resultSummary: result.resultSummary.text,
          specialistDirective,
        });
        this.config.setStage?.("idle");
        return true;
      }
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
