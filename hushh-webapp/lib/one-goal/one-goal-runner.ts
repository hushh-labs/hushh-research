"use client";

import type { AgentActionRuntimeResult } from "@/lib/agent/agent-action-runtime";
import { ROUTES } from "@/lib/navigation/routes";
import {
  DebateRunManagerService,
  type DebateRunTask,
  type EnsureRunResult,
} from "@/lib/services/debate-run-manager";
import { getStockContext } from "@/lib/services/kai-service";
import type { AnalysisParams } from "@/lib/stores/kai-session-store";
import type { KaiStreamEnvelope } from "@/lib/streaming/kai-stream-types";
import { useOneGoalSessionStore } from "@/lib/one-goal/one-goal-session-store";
import type {
  OneGoalEvent,
  OneGoalPlan,
  OneGoalResultSummary,
  OneGoalRunnerResult,
  OneGoalSession,
  OneGoalState,
} from "@/lib/one-goal/one-goal-types";

type RouterLike = {
  push: (href: string) => void;
};

export type OneGoalRunnerCallbacks = {
  onEvent?: (event: OneGoalEvent, session: OneGoalSession) => void;
  onProgressText?: (text: string) => void | Promise<void>;
  onFinalText?: (text: string) => void | Promise<void>;
};

export type RunOneGoalOptions = {
  plan: Extract<OneGoalPlan, { status: "ready" }>;
  userId: string;
  vaultOwnerToken: string;
  vaultKey?: string | null;
  router?: RouterLike | null;
  setAnalysisParams?: (params: AnalysisParams | null) => void;
  executeAction: (
    actionId: string,
    slots?: Record<string, unknown>
  ) => Promise<AgentActionRuntimeResult>;
  waitForCompletion?: boolean;
  timeoutMs?: number;
  callbacks?: OneGoalRunnerCallbacks;
};

const DEFAULT_ANALYSIS_TIMEOUT_MS = 6 * 60 * 1000;

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toUpperTicker(value: unknown): string {
  return String(value || "").trim().toUpperCase();
}

function createEvent(input: {
  goalId: string;
  actionId: string;
  state: OneGoalState;
  message: string;
  data?: Record<string, unknown>;
}): Omit<OneGoalEvent, "id" | "createdAtMs"> {
  return {
    goalId: input.goalId,
    actionId: input.actionId,
    state: input.state,
    message: input.message,
    data: input.data,
  };
}

function currentSession(sessionId: string): OneGoalSession {
  const session = useOneGoalSessionStore
    .getState()
    .sessions.find((entry) => entry.id === sessionId);
  if (!session) {
    throw new Error("One goal session disappeared while running.");
  }
  return session;
}

function appendGoalEvent(
  sessionId: string,
  event: Omit<OneGoalEvent, "id" | "createdAtMs">,
  callbacks?: OneGoalRunnerCallbacks
): OneGoalSession {
  const store = useOneGoalSessionStore.getState();
  store.appendEvent(sessionId, event);
  const session = currentSession(sessionId);
  const appended = session.events[session.events.length - 1];
  if (appended) {
    callbacks?.onEvent?.(appended, session);
  }
  return session;
}

function updateGoalResult(
  sessionId: string,
  state: OneGoalState,
  result: OneGoalResultSummary
): OneGoalSession {
  useOneGoalSessionStore.getState().updateSession(sessionId, {
    state,
    result,
  });
  return currentSession(sessionId);
}

function buildSyntheticActionResult(input: {
  status: AgentActionRuntimeResult["status"];
  actionId: string;
  label: string;
  routeBefore?: string | null;
  routeAfter?: string | null;
  screenBefore?: string | null;
  screenAfter?: string | null;
  resultSummary: string;
  reason?: string | null;
  data?: Record<string, unknown>;
}): AgentActionRuntimeResult {
  return {
    status: input.status,
    actionId: input.actionId,
    label: input.label,
    routeBefore: input.routeBefore ?? null,
    routeAfter: input.routeAfter,
    screenBefore: input.screenBefore,
    screenAfter: input.screenAfter,
    resultSummary: input.resultSummary,
    reason: input.reason,
    data: input.data,
  };
}

function payloadRecord(envelope: KaiStreamEnvelope): Record<string, unknown> {
  return envelope.payload && typeof envelope.payload === "object"
    ? (envelope.payload as Record<string, unknown>)
    : {};
}

function summarizeAgentProgress(envelope: KaiStreamEnvelope, ticker: string): string | null {
  const payload = payloadRecord(envelope);
  if (envelope.event === "agent_complete") {
    const agent = readString(payload.agent) || readString(payload.agent_id) || "One specialist";
    const recommendation = readString(payload.recommendation);
    const confidence = typeof payload.confidence === "number" ? payload.confidence : null;
    const confidenceText =
      confidence !== null && Number.isFinite(confidence)
        ? ` at ${Math.round(confidence * 100)}% confidence`
        : "";
    return recommendation
      ? `${agent} finished ${ticker}: ${recommendation}${confidenceText}.`
      : `${agent} finished its ${ticker} pass.`;
  }
  if (envelope.event === "progress") {
    const message = readString(payload.message);
    if (message) return message;
  }
  return null;
}

function resultSummaryFromTask(task: DebateRunTask): OneGoalResultSummary {
  const decision = task.finalDecision?.decision || "hold";
  const confidence = task.finalDecision?.confidence ?? null;
  const confidenceText =
    typeof confidence === "number" && Number.isFinite(confidence)
      ? ` Confidence ${Math.round(confidence * 100)}%.`
      : "";
  const finalStatement = task.finalDecision?.finalStatement || "";
  const text = `Kai completed ${task.ticker}: ${decision.toUpperCase()}.${confidenceText}${
    finalStatement ? ` ${finalStatement}` : ""
  }`;
  return {
    text,
    decision,
    confidence,
    finalStatement,
    route: `${ROUTES.KAI_ANALYSIS}?focus=active&ticker=${encodeURIComponent(task.ticker)}`,
  };
}

function analysisActiveRoute(ticker: string): string {
  return `${ROUTES.KAI_ANALYSIS}?focus=active&ticker=${encodeURIComponent(ticker)}`;
}

function hasWorkflowService(plan: Extract<OneGoalPlan, { status: "ready" }>, service: string): boolean {
  return plan.action.goal.workflow_steps.some((step) => step.service === service);
}

function waitForDebateCompletion(input: {
  runId: string;
  ticker: string;
  timeoutMs: number;
  sessionId: string;
  actionId: string;
  goalId: string;
  callbacks?: OneGoalRunnerCallbacks;
}): Promise<OneGoalResultSummary> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cleanup = () => {};
    cleanup = DebateRunManagerService.subscribeRunEvents(
      input.runId,
      (envelope) => {
        if (settled) return;
        const progressText = summarizeAgentProgress(envelope, input.ticker);
        if (progressText) {
          appendGoalEvent(
            input.sessionId,
            createEvent({
              goalId: input.goalId,
              actionId: input.actionId,
              state: "progress",
              message: progressText,
              data: {
                event: envelope.event,
                seq: envelope.seq,
              },
            }),
            input.callbacks
          );
          void input.callbacks?.onProgressText?.(progressText);
        }
        if (!envelope.terminal) return;
        settled = true;
        if (timer) globalThis.clearTimeout(timer);
        cleanup();
        const task = DebateRunManagerService.getTask(input.runId);
        if (envelope.event === "decision" && task) {
          resolve(resultSummaryFromTask(task));
          return;
        }
        if (envelope.event === "aborted") {
          reject(new Error("Kai debate was canceled."));
          return;
        }
        const payload = payloadRecord(envelope);
        reject(new Error(readString(payload.message) || "Kai debate failed."));
      },
      { replay: true }
    );
    if (settled) {
      cleanup();
      return;
    }
    timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      const task = DebateRunManagerService.getTask(input.runId);
      if (task?.status === "completed") {
        resolve(resultSummaryFromTask(task));
        return;
      }
      reject(new Error("Kai debate is still running. I will keep tracking it in the analysis workspace."));
    }, input.timeoutMs);
  });
}

async function runAnalysisGoal(options: RunOneGoalOptions): Promise<OneGoalRunnerResult> {
  const { plan } = options;
  const actionId = plan.action.action_id;
  const ticker = toUpperTicker(plan.slots.symbol || plan.slots.ticker);
  const pickSource = readString(plan.slots.pickSource) || "default";
  const pickSourceLabel =
    readString(plan.slots.pickSourceLabel) ||
    (pickSource === "default" ? "Default list" : pickSource);
  const pickSourceKind = readString(plan.slots.pickSourceKind) || pickSource;
  const store = useOneGoalSessionStore.getState();
  const session = store.startSession({
    goalId: plan.goalId,
    actionId,
    slots: {
      ...plan.slots,
      symbol: ticker,
      pickSource,
      pickSourceLabel,
      pickSourceKind,
    },
  });

  appendGoalEvent(
    session.id,
    createEvent({
      goalId: plan.goalId,
      actionId,
      state: "started",
      message: `Starting Kai debate for ${ticker} using ${pickSourceLabel}.`,
    }),
    options.callbacks
  );

  const actionResult = await options.executeAction(actionId, {
    ...plan.slots,
    symbol: ticker,
    pickSource,
    pickSourceLabel,
    pickSourceKind,
  });
  if (actionResult.status === "blocked" || actionResult.status === "invalid" || actionResult.status === "failed") {
    const summary = { text: actionResult.resultSummary, route: actionResult.routeAfter || null };
    const blocked = updateGoalResult(session.id, "blocked", summary);
    return { session: blocked, actionResult, resultSummary: summary };
  }

  const activeRoute = analysisActiveRoute(ticker);
  options.setAnalysisParams?.({
    ticker,
    userId: options.userId,
    riskProfile: "balanced",
    launchConfirmed: true,
    userContext: {},
    pickSource,
    pickSourceLabel,
  });
  options.router?.push(activeRoute);
  appendGoalEvent(
    session.id,
    createEvent({
      goalId: plan.goalId,
      actionId,
      state: "progress",
      message: `Opening the ${ticker} debate workspace while Kai hydrates context.`,
      data: {
        route: activeRoute,
        settlement_target: "kai_analysis_workspace",
      },
    }),
    options.callbacks
  );
  void options.callbacks?.onProgressText?.(
    `Opening the ${ticker} debate workspace while Kai hydrates context.`
  );

  const userContext = await getStockContext(ticker, options.vaultOwnerToken);
  const riskProfile = userContext.user_risk_profile || "balanced";
  options.setAnalysisParams?.({
    ticker,
    userId: options.userId,
    riskProfile,
    launchConfirmed: true,
    userContext,
    pickSource,
    pickSourceLabel,
  });

  const runResult: EnsureRunResult = await DebateRunManagerService.ensureRun({
    userId: options.userId,
    ticker,
    riskProfile,
    userContext,
    pickSource,
    pickSourceLabel,
    pickSourceKind,
    vaultOwnerToken: options.vaultOwnerToken,
    vaultKey: options.vaultKey || undefined,
  });

  if (runResult.kind === "blocked") {
    const message = `A ${runResult.task.ticker} debate is already running. I can resume tracking it or cancel it from the analysis workspace.`;
    appendGoalEvent(
      session.id,
      createEvent({
        goalId: plan.goalId,
        actionId,
        state: "cancel_available",
        message,
        data: { runId: runResult.task.runId },
      }),
      options.callbacks
    );
    const summary = {
      text: message,
      route: `${ROUTES.KAI_ANALYSIS}?focus=active&ticker=${encodeURIComponent(runResult.task.ticker)}`,
    };
    const blocked = updateGoalResult(session.id, "blocked", summary);
    return {
      session: blocked,
      actionResult: buildSyntheticActionResult({
        status: "blocked",
        actionId,
        label: plan.action.label,
        routeAfter: summary.route,
        screenAfter: "kai_analysis_workspace",
        resultSummary: message,
        reason: "active_goal_exists",
        data: { runId: runResult.task.runId },
      }),
      resultSummary: summary,
    };
  }

  appendGoalEvent(
    session.id,
    createEvent({
      goalId: plan.goalId,
      actionId,
      state: "waiting",
      message: `Kai debate is running for ${ticker}. I will speak milestones and summarize the result.`,
      data: { runId: runResult.task.runId },
    }),
    options.callbacks
  );

  if (options.waitForCompletion === false) {
    const summary = {
      text: `Kai debate started for ${ticker}. I will keep it visible in the analysis workspace.`,
      route: activeRoute,
    };
    const waiting = updateGoalResult(session.id, "waiting", summary);
    return {
      session: waiting,
      actionResult: buildSyntheticActionResult({
        status: "started",
        actionId,
        label: plan.action.label,
        routeAfter: activeRoute,
        screenAfter: "kai_analysis_workspace",
        resultSummary: summary.text,
        data: { runId: runResult.task.runId },
      }),
      resultSummary: summary,
    };
  }

  const summary = await waitForDebateCompletion({
    runId: runResult.task.runId,
    ticker,
    timeoutMs: options.timeoutMs ?? DEFAULT_ANALYSIS_TIMEOUT_MS,
    sessionId: session.id,
    actionId,
    goalId: plan.goalId,
    callbacks: options.callbacks,
  });
  appendGoalEvent(
    session.id,
    createEvent({
      goalId: plan.goalId,
      actionId,
      state: "completed",
      message: summary.text,
      data: { runId: runResult.task.runId },
    }),
    options.callbacks
  );
  await options.callbacks?.onFinalText?.(summary.text);
  const completed = updateGoalResult(session.id, "completed", summary);
  return {
    session: completed,
    actionResult: buildSyntheticActionResult({
      status: "succeeded",
      actionId,
      label: plan.action.label,
      routeAfter: summary.route || activeRoute,
      screenAfter: "kai_analysis_workspace",
      resultSummary: summary.text,
      data: { runId: runResult.task.runId },
    }),
    resultSummary: summary,
  };
}

export async function runOneGoal(options: RunOneGoalOptions): Promise<OneGoalRunnerResult> {
  const { plan } = options;
  if (hasWorkflowService(plan, "kai_debate.ensure_run")) {
    return runAnalysisGoal(options);
  }

  const session = useOneGoalSessionStore.getState().startSession({
    goalId: plan.goalId,
    actionId: plan.action.action_id,
    slots: plan.slots,
  });
  appendGoalEvent(
    session.id,
    createEvent({
      goalId: plan.goalId,
      actionId: plan.action.action_id,
      state: "started",
      message: `Running ${plan.action.label}.`,
    }),
    options.callbacks
  );
  const actionResult = await options.executeAction(plan.action.action_id, plan.slots);
  const state: OneGoalState =
    actionResult.status === "succeeded" || actionResult.status === "started"
      ? "completed"
      : actionResult.status === "blocked"
        ? "blocked"
        : "failed";
  const resultSummary = {
    text: actionResult.resultSummary,
    route: actionResult.routeAfter || null,
  };
  appendGoalEvent(
    session.id,
    createEvent({
      goalId: plan.goalId,
      actionId: plan.action.action_id,
      state,
      message: actionResult.resultSummary,
      data: actionResult.data,
    }),
    options.callbacks
  );
  const completed = updateGoalResult(session.id, state, resultSummary);
  if (state === "completed") {
    await options.callbacks?.onFinalText?.(resultSummary.text);
  }
  return {
    session: completed,
    actionResult,
    resultSummary,
  };
}

export async function cancelActiveAnalysisGoal(input: {
  userId: string;
  vaultOwnerToken: string;
}): Promise<boolean> {
  const active = DebateRunManagerService.getActiveTaskForUser(input.userId);
  if (!active) return false;
  await DebateRunManagerService.cancelRun({
    runId: active.runId,
    userId: input.userId,
    vaultOwnerToken: input.vaultOwnerToken,
  });
  return true;
}
