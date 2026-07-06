"use client";

import type { AgentActionRuntimeResult } from "@/lib/agent/agent-action-runtime";
import type { KaiActionDefinition } from "@/lib/voice/kai-action-gateway";
import type { AppRuntimeState } from "@/lib/voice/voice-types";

export type OneGoalState =
  | "input_needed"
  | "preview"
  | "started"
  | "progress"
  | "waiting"
  | "cancel_available"
  | "completed"
  | "failed"
  | "blocked";

export type OneGoalEntrypoint =
  | "voice"
  | "chat"
  | "typed_search"
  | "command_bar"
  | "ui";

export type OneGoalPlannerInput = {
  transcript?: string | null;
  actionId?: string | null;
  candidateActionId?: string | null;
  slots?: Record<string, unknown> | null;
  appRuntimeState?: AppRuntimeState;
  entrypoint: OneGoalEntrypoint;
};

export type OneGoalInputPrompt = {
  inputName: string;
  slot: string;
  prompt: string;
  options: string[];
};

export type OneGoalPlan =
  | {
      status: "ready";
      goalId: string;
      action: KaiActionDefinition;
      slots: Record<string, unknown>;
      summary: string;
    }
  | {
      status: "input_needed";
      goalId: string;
      action: KaiActionDefinition;
      slots: Record<string, unknown>;
      prompt: OneGoalInputPrompt;
    }
  | {
      status: "blocked";
      goalId: string | null;
      action: KaiActionDefinition | null;
      slots: Record<string, unknown>;
      reason: string;
    };

export type OneGoalResultSummary = {
  text: string;
  decision?: string | null;
  confidence?: number | null;
  finalStatement?: string | null;
  route?: string | null;
};

export type OneGoalEvent = {
  id: string;
  goalId: string;
  actionId: string;
  state: OneGoalState;
  message: string;
  createdAtMs: number;
  data?: Record<string, unknown>;
};

export type OneGoalSession = {
  id: string;
  goalId: string;
  actionId: string;
  state: OneGoalState;
  slots: Record<string, unknown>;
  events: OneGoalEvent[];
  result?: OneGoalResultSummary | null;
  createdAtMs: number;
  updatedAtMs: number;
};

export type OneGoalRunnerResult = {
  session: OneGoalSession;
  actionResult: AgentActionRuntimeResult;
  resultSummary: OneGoalResultSummary;
};
