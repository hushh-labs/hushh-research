"use client";

import { ApiService } from "@/lib/services/api-service";
import { getVoiceV2Flags } from "@/lib/voice/voice-feature-flags";
import { normalizeClarifyToolCall, validateVoicePlanPayload } from "@/lib/voice/voice-json-validator";
import { createVoiceTurnId, logVoiceMetric } from "@/lib/voice/voice-telemetry";
import { buildStructuredScreenContext, type StructuredScreenContext } from "@/lib/voice/screen-context-builder";
import { composeVoiceSpeechAfterExecution } from "@/lib/voice/voice-response-composer";
import {
  resolveGroundedVoicePlan,
  type GroundedVoicePlan,
  VOICE_MANUAL_ONLY_MESSAGE,
  VOICE_UNAVAILABLE_MESSAGE,
} from "@/lib/voice/voice-grounding";
import {
  type DurableMemoryItem,
  type DurableMemoryWriteCandidate,
  type ShortTermTurn,
  voiceMemoryStore,
} from "@/lib/voice/voice-memory-store";
import type {
  AppRuntimeState,
  VoiceActionResult,
  VoiceComposeResponsePayload,
  VoiceComposedSpeech,
  VoiceMemoryHint,
  VoicePlanPayload,
  VoiceResponse,
} from "@/lib/voice/voice-types";

export type VoiceOrchestratorSource = "microphone" | "example_chip" | "replay";

export type VoiceSpeakSegmentType = "ack" | "final";

export type VoiceTurnOrchestratorSpeakInput = {
  text: string;
  turnId: string;
  responseId: string;
  segmentType: VoiceSpeakSegmentType;
};

export type VoiceTurnOrchestratorInput = {
  transcript: string;
  source: VoiceOrchestratorSource;
};

type VoicePlannerV2Envelope = {
  turn_id?: unknown;
  response_id?: unknown;
  intent?: { name?: unknown; confidence?: unknown } | null;
  action?: { type?: unknown; payload?: unknown } | null;
  execution_allowed?: unknown;
  needs_confirmation?: unknown;
  ack_text?: unknown;
  final_text?: unknown;
  is_long_running?: unknown;
  memory_write_candidates?: unknown;
  response?: unknown;
  tool_call?: unknown;
  memory?: unknown;
  elapsed_ms?: unknown;
  openai_http_ms?: unknown;
  model?: unknown;
};

type VoiceComposerEnvelope = VoiceComposeResponsePayload & {
  detail?: unknown;
};

function parsePlannerMemoryWriteCandidates(
  raw: unknown
): DurableMemoryWriteCandidate[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((value) => {
      if (!value || typeof value !== "object") return null;
      const row = value as Record<string, unknown>;
      const category = String(row.category || "").trim();
      const summary = String(row.summary || row.text || "").trim();
      if (!category || !summary) return null;
      return {
        category,
        summary,
      } as DurableMemoryWriteCandidate;
    })
    .filter((value): value is DurableMemoryWriteCandidate => Boolean(value));
}

function plannerSafeText(raw: unknown): string | null {
  const text = String(raw || "").trim();
  return text ? text : null;
}

function makeResponseId(turnId: string): string {
  return `vrsp_${turnId.replace(/^vturn_/, "")}`;
}

function inferModeFromResponse(response: VoiceResponse): NonNullable<VoicePlanPayload["mode"]> {
  if (response.kind === "clarify") return "clarify";
  if (response.kind === "background_started") return "start_background_and_ack";
  if (response.kind === "execute") return "execute_and_wait";
  return "answer_now";
}

function createNoopGroundedPlan(): GroundedVoicePlan {
  return {
    status: "none",
    actionId: null,
    actionLabel: null,
    destructive: false,
    message: null,
    resolutionSource: "none",
    execution: {
      mode: "none",
      steps: [],
    },
  };
}

export type VoiceTurnOrchestratorConfig = {
  userId: string;
  vaultOwnerToken: string;
  getAppRuntimeState: () => AppRuntimeState | undefined;
  getVoiceContext: () => Record<string, unknown> | undefined;
  onVoiceResponse: (payload: {
    turnId: string;
    responseId: string;
    transcript: string;
    response: VoiceResponse;
    plan: VoicePlanPayload;
    groundedPlan?: GroundedVoicePlan;
    memory?: VoiceMemoryHint;
    executionAllowed?: boolean;
    needsConfirmation?: boolean;
  }) => Promise<unknown> | unknown;
  speak: (input: VoiceTurnOrchestratorSpeakInput) => Promise<void>;
  onStageChange?: (stage: "planning" | "dispatch" | "speaking_ack" | "speaking_final" | "idle") => void;
  onDebug?: (event: string, payload?: Record<string, unknown>) => void;
  onAssistantText?: (payload: {
    text: string;
    kind: VoiceResponse["kind"] | "ack";
    turnId: string;
    responseId: string;
    segmentType: VoiceSpeakSegmentType;
  }) => void;
};

function shouldWriteMemoryFromDispatch(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return true;
  if ("shortTermMemoryWrite" in raw && typeof raw.shortTermMemoryWrite === "boolean") {
    return raw.shortTermMemoryWrite;
  }
  return true;
}

function getNullableString(
  record: Record<string, unknown>,
  snakeKey: string,
  camelKey: string
): string | null {
  const value = record[snakeKey] ?? record[camelKey];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function getOptionalData(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function normalizeActionResultStatus(raw: unknown): VoiceActionResult["status"] | null {
  if (raw === "succeeded" || raw === "started" || raw === "blocked" || raw === "failed" || raw === "noop") {
    return raw;
  }
  if (raw === "invalid") {
    return "failed";
  }
  return null;
}

function normalizeSettledBy(raw: unknown): VoiceActionResult["settled_by"] | undefined {
  if (
    raw === "none" ||
    raw === "route" ||
    raw === "screen" ||
    raw === "background_start" ||
    raw === "timeout"
  ) {
    return raw;
  }
  return undefined;
}

function extractActionResultFromDispatch(raw: unknown): VoiceActionResult | null {
  if (!raw || typeof raw !== "object") return null;
  const envelope = raw as Record<string, unknown>;
  const candidate =
    envelope.actionResult && typeof envelope.actionResult === "object"
      ? (envelope.actionResult as Record<string, unknown>)
      : envelope;
  const status = normalizeActionResultStatus(candidate.status);
  const resultSummary = getNullableString(candidate, "result_summary", "resultSummary");
  if (!status || !resultSummary) {
    return null;
  }
  return {
    status,
    action_id: getNullableString(candidate, "action_id", "actionId"),
    route_before: getNullableString(candidate, "route_before", "routeBefore"),
    route_after: getNullableString(candidate, "route_after", "routeAfter"),
    screen_before: getNullableString(candidate, "screen_before", "screenBefore"),
    screen_after: getNullableString(candidate, "screen_after", "screenAfter"),
    settled_by: normalizeSettledBy(candidate.settled_by),
    result_summary: resultSummary,
    data: getOptionalData(candidate, "data"),
    error_code: getNullableString(candidate, "error_code", "errorCode"),
    tool_name: getNullableString(candidate, "tool_name", "toolName"),
    ticker: getNullableString(candidate, "ticker", "ticker"),
  };
}

function extractComposedSpeech(raw: unknown): VoiceComposedSpeech | null {
  if (!raw || typeof raw !== "object") return null;
  const envelope = raw as Record<string, unknown>;
  const text = plannerSafeText(envelope.text);
  const segmentType = envelope.segment_type;
  if (!text) return null;
  if (segmentType !== "ack" && segmentType !== "final") return null;
  return {
    text,
    segmentType,
  };
}

export type VoiceTurnOrchestratorResult = {
  turnId: string;
  responseId: string;
  response: VoiceResponse;
  plan: VoicePlanPayload;
  groundedPlan: GroundedVoicePlan;
  actionResult: VoiceActionResult | null;
  spokenText: string | null;
  source: VoiceOrchestratorSource;
};

export class VoiceTurnOrchestrator {
  private config: VoiceTurnOrchestratorConfig;
  private activeToken = 0;
  private activeAbortController: AbortController | null = null;

  constructor(config: VoiceTurnOrchestratorConfig) {
    this.config = config;
  }

  updateConfig(config: VoiceTurnOrchestratorConfig): void {
    this.config = config;
  }

  isBusy(): boolean {
    return Boolean(this.activeAbortController);
  }

  cancelActiveTurn(reason: string): void {
    this.activeToken += 1;
    const active = this.activeAbortController;
    this.activeAbortController = null;
    if (!active) return;
    active.abort(reason);
    this.config.onStageChange?.("idle");
    this.config.onDebug?.("orchestrator_turn_cancelled", { reason });
  }

  private isTokenActive(token: number): boolean {
    return token === this.activeToken;
  }

  async processTranscript(input: VoiceTurnOrchestratorInput): Promise<VoiceTurnOrchestratorResult | null> {
    const cleanTranscript = String(input.transcript || "").trim();
    if (!cleanTranscript) return null;

    this.cancelActiveTurn("new_turn_started");
    const token = ++this.activeToken;
    const turnId = createVoiceTurnId();
    const abortController = new AbortController();
    this.activeAbortController = abortController;

    const appRuntimeState = this.config.getAppRuntimeState();
    const voiceContext = this.config.getVoiceContext() || {};
    const structuredContext: StructuredScreenContext = buildStructuredScreenContext({
      appRuntimeState,
      voiceContext,
    });

    const memoryShort: ShortTermTurn[] = voiceMemoryStore.getShortTerm(this.config.userId, 20);
    const memoryRetrieved: DurableMemoryItem[] = voiceMemoryStore.retrieveDurable(
      this.config.userId,
      cleanTranscript,
      8
    );

    this.config.onDebug?.("orchestrator_turn_started", {
      turn_id: turnId,
      source: input.source,
      transcript_chars: cleanTranscript.length,
      memory_short_count: memoryShort.length,
      memory_retrieved_count: memoryRetrieved.length,
    });

    try {
      this.config.onStageChange?.("planning");
      const planningResponse = await ApiService.planKaiVoiceIntent({
        userId: this.config.userId,
        vaultOwnerToken: this.config.vaultOwnerToken,
        transcript: cleanTranscript,
        plannerV2: {
          turnId,
          transcriptFinal: cleanTranscript,
          structuredContext,
          memoryShort,
          memoryRetrieved,
        },
        context: {
          ...(voiceContext || {}),
          planner_v2_enabled: true,
          planner_turn_id: turnId,
        },
        appState: appRuntimeState,
        voiceTurnId: turnId,
        signal: abortController.signal,
      });
      if (!this.isTokenActive(token)) return null;

      const plannerEnvelope = (await planningResponse
        .json()
        .catch(() => ({}))) as VoicePlannerV2Envelope;
      if (!planningResponse.ok) {
        const detail =
          plannerEnvelope &&
          typeof plannerEnvelope === "object" &&
          "detail" in plannerEnvelope
            ? plannerSafeText((plannerEnvelope as Record<string, unknown>).detail)
            : null;
        this.config.onDebug?.("planner_http_error", {
          status: planningResponse.status,
          response_id: plannerSafeText(plannerEnvelope.response_id),
          detail,
        });
        throw new Error(detail || `VOICE_PLANNER_HTTP_${planningResponse.status}`);
      }
      const validatedPlan = validateVoicePlanPayload(plannerEnvelope);
      const normalizedPlan =
        validatedPlan ||
        validateVoicePlanPayload({
          response: {
            kind: "clarify",
            reason: "stt_unusable",
            message: "I couldn’t understand that clearly. Could you repeat it?",
            speak: true,
          },
          tool_call: normalizeClarifyToolCall("I couldn’t understand that clearly. Could you repeat it?"),
          memory: {
            allow_durable_write: false,
          },
          model: "clarify_fallback",
        });

      if (!normalizedPlan) {
        throw new Error("VOICE_ORCHESTRATOR_INVALID_PLAN_PAYLOAD");
      }

      const plannerResponse = normalizedPlan.response;
      const responseId =
        plannerSafeText(plannerEnvelope.response_id) || makeResponseId(turnId);
      const executionAllowed = normalizedPlan.execution_allowed !== false;
      const needsConfirmation = normalizedPlan.needs_confirmation === true;
      const ackText = plannerSafeText(plannerEnvelope.ack_text);
      const memoryWriteCandidates = parsePlannerMemoryWriteCandidates(
        plannerEnvelope.memory_write_candidates
      );
      const voiceFlags = getVoiceV2Flags();
      const groundedPlan = voiceFlags.groundedActionResolutionEnabled
        ? resolveGroundedVoicePlan({
            transcript: cleanTranscript,
            response: plannerResponse,
            structuredContext,
            canonicalActionId: normalizedPlan.action_id ?? null,
            allowCompatibilityFallback: !normalizedPlan.action_id,
          })
        : createNoopGroundedPlan();
      if (!voiceFlags.groundedActionResolutionEnabled) {
        this.config.onDebug?.("grounding_skipped_rollout_flag", {
          flag: "NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_RESOLUTION_ENABLED",
        });
      }
      const plannerIntentName =
        plannerEnvelope.intent &&
        typeof plannerEnvelope.intent === "object" &&
        typeof plannerEnvelope.intent.name === "string"
          ? plannerEnvelope.intent.name.trim()
          : "";
      this.config.onDebug?.("grounding_resolved", {
        status: groundedPlan.status,
        action_id: groundedPlan.actionId,
        action_label: groundedPlan.actionLabel,
        execution_mode: groundedPlan.execution.mode,
        destructive: groundedPlan.destructive,
        resolution_source: groundedPlan.resolutionSource,
        planner_intent: plannerIntentName || null,
        canonical_action_id: normalizedPlan.action_id ?? null,
        rollout_grounded_resolution_enabled: voiceFlags.groundedActionResolutionEnabled,
        rollout_grounded_policy_enabled: voiceFlags.groundedActionPolicyEnforcementEnabled,
      });
      if (
        normalizedPlan.action_id &&
        groundedPlan.resolutionSource === "canonical" &&
        groundedPlan.status === "unavailable"
      ) {
        this.config.onDebug?.("grounding_canonical_action_unavailable", {
          canonical_action_id: normalizedPlan.action_id,
          grounded_status: groundedPlan.status,
        });
      }
      if (
        voiceFlags.groundedActionResolutionEnabled &&
        !normalizedPlan.action_id &&
        groundedPlan.resolutionSource !== "none" &&
        groundedPlan.resolutionSource !== "canonical"
      ) {
        this.config.onDebug?.("grounding_fallback_resolution_used", {
          resolution_source: groundedPlan.resolutionSource,
          grounded_status: groundedPlan.status,
          action_id: groundedPlan.actionId,
        });
        logVoiceMetric({
          metric: "grounding_fallback_resolution_used",
          value: 1,
          turnId,
          tags: {
            resolution_source: groundedPlan.resolutionSource,
            grounded_status: groundedPlan.status,
            action_id: groundedPlan.actionId || "none",
          },
        });
      }
      this.config.onDebug?.("intent_grounded_action_mapped", {
        intent_name: plannerIntentName || null,
        action_id: groundedPlan.actionId,
        grounded_status: groundedPlan.status,
      });
      logVoiceMetric({
        metric: "intent_grounded_action_mapping",
        value: groundedPlan.actionId ? 1 : 0,
        turnId,
        tags: {
          intent_name: plannerIntentName || "unknown",
          action_id: groundedPlan.actionId || "none",
          grounded_status: groundedPlan.status,
        },
      });

      if (
        groundedPlan.status === "resolved" &&
        groundedPlan.execution.mode === "navigate_then_action"
      ) {
        const hiddenPath = groundedPlan.execution.steps.map((step) =>
          step.type === "navigate"
            ? `navigate:${step.href}`
            : step.type === "tool_call"
              ? `tool:${step.toolCall.tool_name}`
              : "prompt"
        );
        this.config.onDebug?.("hidden_navigation_resolution_path", {
          action_id: groundedPlan.actionId,
          path: hiddenPath,
        });
        logVoiceMetric({
          metric: "hidden_navigation_resolution",
          value: 1,
          turnId,
          tags: {
            action_id: groundedPlan.actionId || "none",
            path: hiddenPath.join("->"),
          },
        });
      }

      let response: VoiceResponse = plannerResponse;
      if (voiceFlags.groundedActionPolicyEnforcementEnabled && groundedPlan.status === "manual_only") {
        if (groundedPlan.destructive) {
          this.config.onDebug?.("destructive_intent_blocked_self_serve_required", {
            action_id: groundedPlan.actionId,
            action_label: groundedPlan.actionLabel,
          });
          logVoiceMetric({
            metric: "destructive_intent_blocked",
            value: 1,
            turnId,
            tags: {
              action_id: groundedPlan.actionId || "none",
            },
          });
        }
        const message =
          (groundedPlan.message && groundedPlan.message.trim()) || VOICE_MANUAL_ONLY_MESSAGE;
        response = {
          kind: "speak_only",
          message,
          speak: true,
        };
      } else if (voiceFlags.groundedActionPolicyEnforcementEnabled && groundedPlan.status === "unavailable") {
        this.config.onDebug?.("grounded_action_unavailable", {
          action_id: groundedPlan.actionId,
          action_label: groundedPlan.actionLabel,
        });
        logVoiceMetric({
          metric: "grounded_action_unavailable",
          value: 1,
          turnId,
          tags: {
            action_id: groundedPlan.actionId || "none",
          },
        });
        const message =
          (groundedPlan.message && groundedPlan.message.trim()) || VOICE_UNAVAILABLE_MESSAGE;
        response = {
          kind: "speak_only",
          message,
          speak: true,
        };
      }

      if (!this.isTokenActive(token)) return null;

      this.config.onStageChange?.("dispatch");
      const dispatchOutcome = await Promise.resolve(
        this.config.onVoiceResponse({
          turnId,
          responseId,
          transcript: cleanTranscript,
          response,
          plan: normalizedPlan,
          groundedPlan,
          memory: normalizedPlan.memory,
          executionAllowed,
          needsConfirmation,
        })
      );

      if (!this.isTokenActive(token)) return null;

      const actionResult = extractActionResultFromDispatch(dispatchOutcome);
      const appRuntimeStateAfter = this.config.getAppRuntimeState();
      const voiceContextAfter = this.config.getVoiceContext() || {};
      const structuredContextAfter: StructuredScreenContext = buildStructuredScreenContext({
        appRuntimeState: appRuntimeStateAfter,
        voiceContext: voiceContextAfter,
      });

      let composedSpeech: VoiceComposedSpeech | null = null;
      if (response.speak && normalizedPlan.reply_strategy === "llm") {
        try {
          const composeResponse = await ApiService.composeKaiVoiceReply({
            userId: this.config.userId,
            vaultOwnerToken: this.config.vaultOwnerToken,
            transcript: cleanTranscript,
            response: response as unknown as Record<string, unknown>,
            appState: appRuntimeStateAfter,
            context: {
              ...(voiceContextAfter || {}),
              planner_v2_enabled: true,
              planner_turn_id: turnId,
            },
            structuredContext: structuredContextAfter,
            turnId,
            responseId,
            mode: normalizedPlan.mode || inferModeFromResponse(response),
            actionId: actionResult?.action_id || normalizedPlan.action_id || null,
            slots: normalizedPlan.slots || {},
            guards: normalizedPlan.guards || [],
            replyStrategy: normalizedPlan.reply_strategy,
            clarification: normalizedPlan.clarification || null,
            actionCompletion: (normalizedPlan as Record<string, unknown>).action_completion as
              | string
              | null
              | undefined,
            actionResult: (actionResult as unknown as Record<string, unknown> | null) ?? null,
            memoryShort,
            memoryRetrieved,
            voiceTurnId: turnId,
            signal: abortController.signal,
          });
          if (!this.isTokenActive(token)) return null;
          const composerEnvelope = (await composeResponse
            .json()
            .catch(() => ({}))) as VoiceComposerEnvelope;
          if (!composeResponse.ok) {
            this.config.onDebug?.("voice_compose_http_error", {
              status: composeResponse.status,
              response_id: plannerSafeText(composerEnvelope.response_id),
              detail: plannerSafeText(composerEnvelope.detail),
            });
          } else {
            composedSpeech = extractComposedSpeech(composerEnvelope);
            if (!composedSpeech) {
              this.config.onDebug?.("voice_compose_invalid_payload", {
                response_id: plannerSafeText(composerEnvelope.response_id),
              });
            }
          }
        } catch (error) {
          this.config.onDebug?.("voice_compose_failed_falling_back_to_template", {
            error: error instanceof Error ? error.message : "unknown_error",
            mode: normalizedPlan.mode || inferModeFromResponse(response),
          });
        }
      }
      if (!composedSpeech) {
        composedSpeech = composeVoiceSpeechAfterExecution({
          response,
          plan: normalizedPlan,
          actionResult,
          plannerFinalText: plannerSafeText(plannerEnvelope.final_text),
          plannerAckText: ackText,
        });
      }

      if (composedSpeech && composedSpeech.text.trim()) {
        const segmentType = composedSpeech.segmentType;
        this.config.onStageChange?.(segmentType === "ack" ? "speaking_ack" : "speaking_final");
        this.config.onAssistantText?.({
          text: composedSpeech.text,
          kind: segmentType === "ack" ? "ack" : response.kind,
          turnId,
          responseId,
          segmentType,
        });
        try {
          await this.config.speak({
            text: composedSpeech.text,
            turnId,
            responseId,
            segmentType,
          });
        } catch (error) {
          this.config.onDebug?.("post_dispatch_tts_failed_turn_continues", {
            error: error instanceof Error ? error.message : "unknown_error",
            response_kind: response.kind,
            segment_type: segmentType,
          });
        }
      }

      if (!this.isTokenActive(token)) return null;

      if (shouldWriteMemoryFromDispatch(dispatchOutcome)) {
        voiceMemoryStore.appendShortTerm(this.config.userId, {
          turn_id: turnId,
          transcript_final: cleanTranscript,
          response_text:
            composedSpeech?.text ||
            plannerSafeText(plannerEnvelope.final_text) ||
            response.message,
          response_kind: response.kind,
          created_at_ms: Date.now(),
        });

        if (normalizedPlan.memory?.allow_durable_write && memoryWriteCandidates.length > 0) {
          voiceMemoryStore.writeDurable(this.config.userId, memoryWriteCandidates);
        }
      }

      return {
        turnId,
        responseId,
        response,
        plan: normalizedPlan,
        groundedPlan,
        actionResult,
        spokenText: composedSpeech?.text || null,
        source: input.source,
      };
    } finally {
      if (this.activeAbortController === abortController) {
        this.activeAbortController = null;
      }
      this.config.onStageChange?.("idle");
    }
  }
}
