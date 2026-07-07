"use client";

import {
  KAI_ACTION_GATEWAY,
  getKaiActionById,
  type KaiActionDefinition,
} from "@/lib/voice/kai-action-gateway";
import type {
  OneGoalInputPrompt,
  OneGoalPlan,
  OneGoalPlannerInput,
} from "@/lib/one-goal/one-goal-types";
import { resolveStockTargetSymbol } from "@/lib/one-goal/stock-target-resolver";

const STOP_WORDS = new Set([
  "A",
  "AN",
  "AND",
  "ASK",
  "CAN",
  "DO",
  "FOR",
  "I",
  "IN",
  "IT",
  "KAI",
  "ME",
  "MY",
  "OF",
  "ON",
  "ONE",
  "OR",
  "PLEASE",
  "START",
  "THE",
  "TO",
  "USE",
  "WITH",
  "YOU",
]);

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeTicker(value: unknown): string | null {
  const raw = readString(value);
  if (!raw) return null;
  const match = raw.toUpperCase().match(/\b([A-Z]{1,5}(?:\.[A-Z])?)(?:\b|$)/);
  return match?.[1] ?? null;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9._-]+/i)
    .map((token) => token.trim())
    .filter(Boolean);
}

function actionDictionary(action: KaiActionDefinition): string {
  return [
    action.action_id,
    action.label,
    action.meaning,
    ...action.aliases,
    ...action.search_keywords,
    ...action.goal.input_resolvers,
    ...action.goal.required_inputs.map((input) => `${input.name} ${input.slot || ""}`),
  ]
    .join(" ")
    .toLowerCase();
}

function scoreActionForTranscript(action: KaiActionDefinition, transcript: string): number {
  const normalizedTranscript = transcript.trim().toLowerCase();
  if (!normalizedTranscript) return 0;
  let score = 0;
  const phrases = [
    action.label,
    ...action.aliases,
    ...action.search_keywords,
    action.meaning,
  ]
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  for (const phrase of phrases) {
    if (phrase === normalizedTranscript) score += 12;
    else if (phrase.length >= 4 && normalizedTranscript.includes(phrase)) score += 6;
  }
  const actionTokens = new Set(tokenize(actionDictionary(action)));
  for (const token of tokenize(normalizedTranscript)) {
    if (actionTokens.has(token)) score += 2;
  }
  if (
    action.goal.input_resolvers.includes("ticker_symbol") &&
    resolveTickerFromTranscript(transcript, action)
  ) {
    score += 8;
  }
  return score;
}

function rankActionsForTranscript(transcript: string): Array<{
  action: KaiActionDefinition;
  score: number;
}> {
  return KAI_ACTION_GATEWAY.actions
    .map((action) => ({ action, score: scoreActionForTranscript(action, transcript) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.action.action_id.localeCompare(right.action.action_id));
}

function shouldOverrideCandidate(input: {
  candidate: KaiActionDefinition;
  top: { action: KaiActionDefinition; score: number } | undefined;
  candidateScore: number;
  transcript: string;
}): boolean {
  const { candidate, top, candidateScore, transcript } = input;
  if (!top || top.action.action_id === candidate.action_id) return false;
  const candidateIsRouteOnly =
    candidate.action_id.startsWith("route.") &&
    candidate.goal.required_inputs.length === 0;
  const topResolvesTicker =
    top.action.goal.input_resolvers.includes("ticker_symbol") &&
    Boolean(resolveTickerFromTranscript(transcript, top.action));
  if (candidateIsRouteOnly && topResolvesTicker && top.score >= candidateScore + 2) {
    return true;
  }
  const topCollectsMoreInputs =
    top.action.goal.required_inputs.length > candidate.goal.required_inputs.length;
  return topCollectsMoreInputs && top.score >= candidateScore + 6;
}

function inferAction(input: OneGoalPlannerInput): KaiActionDefinition | null {
  if (input.actionId) return getKaiActionById(input.actionId);
  const transcript = input.transcript || "";
  const ranked = rankActionsForTranscript(transcript);
  const candidate = input.candidateActionId ? getKaiActionById(input.candidateActionId) : null;
  if (candidate) {
    const candidateScore = scoreActionForTranscript(candidate, transcript);
    if (
      shouldOverrideCandidate({
        candidate,
        top: ranked[0],
        candidateScore,
        transcript,
      })
    ) {
      return ranked[0]?.action ?? candidate;
    }
    return candidate;
  }
  return ranked[0]?.action ?? null;
}

function resolveTickerFromTranscript(
  transcript: string,
  action: KaiActionDefinition
): string | null {
  const dictionaryTokens = new Set(tokenize(actionDictionary(action)).map((token) => token.toUpperCase()));
  return resolveStockTargetSymbol({
    transcript,
    ignoredTokens: new Set([...STOP_WORDS, ...dictionaryTokens]),
  });
}

function resolveTickerSymbol(input: {
  transcript: string;
  action: KaiActionDefinition;
  slots: Record<string, unknown>;
  slot: string;
}): Record<string, unknown> {
  const existing =
    normalizeTicker(input.slots[input.slot]) ||
    normalizeTicker(input.slots.symbol) ||
    normalizeTicker(input.slots.ticker);
  const symbol = existing || resolveTickerFromTranscript(input.transcript, input.action);
  if (!symbol) return {};
  return {
    [input.slot]: symbol,
    symbol,
  };
}

function resolveKaiPickSource(input: {
  transcript: string;
  slots: Record<string, unknown>;
  slot: string;
}): Record<string, unknown> {
  if (readString(input.slots[input.slot])) return {};
  if (/\b(default|default list|kai default)\b/i.test(input.transcript)) {
    return {
      [input.slot]: "default",
      pickSource: "default",
      pickSourceLabel: "Default list",
    };
  }
  return {};
}

function inferSlots(input: OneGoalPlannerInput, action: KaiActionDefinition): Record<string, unknown> {
  const slots: Record<string, unknown> = { ...(input.slots || {}) };
  const transcript = input.transcript || "";
  for (const requiredInput of action.goal.required_inputs) {
    const slot = requiredInput.slot || requiredInput.name;
    if (requiredInput.resolver === "ticker_symbol") {
      Object.assign(slots, resolveTickerSymbol({ transcript, action, slots, slot }));
    } else if (requiredInput.resolver === "kai_pick_source") {
      Object.assign(slots, resolveKaiPickSource({ transcript, slots, slot }));
    } else if (requiredInput.resolver === "user_utterance" && !readString(slots[slot])) {
      const utterance = readString(transcript);
      if (utterance) {
        slots[slot] = utterance;
      }
    }
  }
  return slots;
}

function isInputSatisfied(slotValue: unknown): boolean {
  return typeof slotValue === "string" ? slotValue.trim().length > 0 : slotValue !== undefined && slotValue !== null;
}

function nextMissingInput(
  action: KaiActionDefinition,
  slots: Record<string, unknown>
): OneGoalInputPrompt | null {
  for (const input of action.goal.required_inputs) {
    if (input.required === false) continue;
    const slot = input.slot || input.name;
    if (isInputSatisfied(slots[slot])) continue;
    return {
      inputName: input.name,
      slot,
      prompt: input.prompt,
      options: input.options || [],
    };
  }
  return null;
}

export function planOneGoal(input: OneGoalPlannerInput): OneGoalPlan {
  const action = inferAction(input);
  if (!action) {
    return {
      status: "blocked",
      goalId: null,
      action: null,
      slots: { ...(input.slots || {}) },
      reason: "One could not map that request to a generated goal contract.",
    };
  }
  const slots = inferSlots(input, action);
  const missing = nextMissingInput(action, slots);
  if (missing) {
    return {
      status: "input_needed",
      goalId: action.goal.goal_id,
      action,
      slots,
      prompt: missing,
    };
  }
  return {
    status: "ready",
    goalId: action.goal.goal_id,
    action,
    slots,
    summary: `Ready to run ${action.label}.`,
  };
}
