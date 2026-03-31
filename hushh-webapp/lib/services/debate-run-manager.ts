"use client";

import { ApiService } from "@/lib/services/api-service";
import { consumeCanonicalKaiStream } from "@/lib/streaming/kai-stream-client";
import type { KaiStreamEnvelope } from "@/lib/streaming/kai-stream-types";
import {
  KaiHistoryService,
  type AnalysisHistoryEntry,
} from "@/lib/services/kai-history-service";
import { AppBackgroundTaskService } from "@/lib/services/app-background-task-service";
import { getSessionItem, setSessionItem } from "@/lib/utils/session-storage";

const RUN_MANAGER_STORAGE_KEY = "kai_debate_run_manager_v1";
const RUN_MANAGER_SESSION_KEY = "kai_debate_session_id_v1";
const RETRY_DELAYS_MS = [750, 2000, 4500];
const FINANCIAL_WRITE_WAIT_TIMEOUT_MS = 20_000;
const FINANCIAL_WRITE_POLL_MS = 400;

export type DebateRunStatus = "running" | "completed" | "failed" | "canceled";
export type DebateTaskPersistenceState = "none" | "pending" | "saved" | "failed";

export interface DebateRunTask {
  runId: string;
  userId: string;
  debateSessionId: string;
  ticker: string;
  pickSource?: string;
  pickSourceLabel?: string;
  pickSourceKind?: string;
  status: DebateRunStatus;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
  latestCursor: number;
  persistenceState: DebateTaskPersistenceState;
  persistenceError: string | null;
  dismissedAt: string | null;
  finalDecision: {
    decision: string;
    confidence: number;
    finalStatement: string;
  } | null;
}

export interface DebateRunManagerState {
  debateSessionId: string;
  tasks: DebateRunTask[];
  activeRunId: string | null;
}

interface PersistedDebateRunManagerState {
  version: 1;
  debateSessionId: string;
  tasks: DebateRunTask[];
}

interface RunSecrets {
  vaultOwnerToken: string;
  vaultKey?: string;
}

type StateListener = (state: DebateRunManagerState) => void;
type RunEnvelopeListener = (envelope: KaiStreamEnvelope) => void;
type HistoryListener = (entry: AnalysisHistoryEntry, task: DebateRunTask) => void;

export type EnsureRunResult =
  | { kind: "started"; task: DebateRunTask }
  | { kind: "attached"; task: DebateRunTask }
  | { kind: "blocked"; task: DebateRunTask };

const AGENTS = ["fundamental", "sentiment", "valuation"] as const;

type TranscriptAgentState = {
  stage: "idle" | "active" | "complete" | "error";
  text: string;
  thoughts: string[];
  error?: string;
  recommendation?: string;
  confidence?: number;
  metrics?: Record<string, unknown>;
  sources?: string[];
  keyMetrics?: Record<string, unknown>;
  quantMetrics?: Record<string, unknown>;
  businessMoat?: string;
  financialResilience?: string;
  growthEfficiency?: string;
  bullCase?: string;
  bearCase?: string;
  sentimentScore?: number;
  keyCatalysts?: string[];
  valuationMetrics?: Record<string, unknown>;
  peerComparison?: Record<string, unknown>;
  priceTargets?: Record<string, unknown>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function createSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `debate_session_${crypto.randomUUID()}`;
  }
  return `debate_session_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

function toUpperTicker(value: string): string {
  return String(value || "").trim().toUpperCase();
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function buildEmptyTranscriptRound(): Record<string, TranscriptAgentState> {
  const round: Record<string, TranscriptAgentState> = {};
  for (const agent of AGENTS) {
    round[agent] = {
      stage: "idle",
      text: "",
      thoughts: [],
    };
  }
  return round;
}

function resolveRound(payload: Record<string, unknown>): 1 | 2 {
  const roundValue = payload.round;
  if (roundValue === 2 || roundValue === "2") return 2;
  if (roundValue === 1 || roundValue === "1") return 1;
  const phase = typeof payload.phase === "string" ? payload.phase.toLowerCase() : "";
  if (phase === "debate" || phase === "round2" || phase === "decision") return 2;
  return 1;
}

function cloneRound(round: Record<string, TranscriptAgentState>): Record<string, TranscriptAgentState> {
  const next: Record<string, TranscriptAgentState> = {};
  for (const [agent, state] of Object.entries(round)) {
    next[agent] = { ...state };
  }
  return next;
}

function buildTranscriptFromEnvelopes(envelopes: KaiStreamEnvelope[]): {
  round1: Record<string, TranscriptAgentState>;
  round2: Record<string, TranscriptAgentState>;
} {
  const round1 = buildEmptyTranscriptRound();
  const round2 = buildEmptyTranscriptRound();

  for (const envelope of envelopes) {
    const payload =
      envelope.payload && typeof envelope.payload === "object"
        ? (envelope.payload as Record<string, unknown>)
        : {};
    const round = resolveRound(payload);
    const bucket = round === 1 ? round1 : round2;
    const agent = String(payload.agent || payload.agent_name || "")
      .trim()
      .toLowerCase();
    if (!agent || !bucket[agent]) continue;

    if (envelope.event === "agent_start") {
      bucket[agent] = { ...bucket[agent], stage: "active" };
      continue;
    }
    if (envelope.event === "agent_token") {
      const token = String(payload.text || payload.token || "");
      if (!token) continue;
      bucket[agent] = {
        ...bucket[agent],
        stage: bucket[agent].stage === "idle" ? "active" : bucket[agent].stage,
        text: `${bucket[agent].text || ""}${token}`,
      };
      continue;
    }
    if (envelope.event === "agent_complete") {
      bucket[agent] = {
        ...bucket[agent],
        stage: "complete",
        text: String(payload.summary || payload.text || ""),
        recommendation: typeof payload.recommendation === "string" ? payload.recommendation : undefined,
        confidence: toFiniteNumber(payload.confidence, 0),
        sources: Array.isArray(payload.sources)
          ? payload.sources.map((value) => String(value))
          : undefined,
        keyMetrics:
          payload.key_metrics && typeof payload.key_metrics === "object"
            ? (payload.key_metrics as Record<string, unknown>)
            : undefined,
        quantMetrics:
          payload.quant_metrics && typeof payload.quant_metrics === "object"
            ? (payload.quant_metrics as Record<string, unknown>)
            : undefined,
        businessMoat: typeof payload.business_moat === "string" ? payload.business_moat : undefined,
        financialResilience:
          typeof payload.financial_resilience === "string"
            ? payload.financial_resilience
            : undefined,
        growthEfficiency:
          typeof payload.growth_efficiency === "string"
            ? payload.growth_efficiency
            : undefined,
        bullCase: typeof payload.bull_case === "string" ? payload.bull_case : undefined,
        bearCase: typeof payload.bear_case === "string" ? payload.bear_case : undefined,
        sentimentScore:
          typeof payload.sentiment_score === "number" ? payload.sentiment_score : undefined,
        keyCatalysts: Array.isArray(payload.key_catalysts)
          ? payload.key_catalysts.map((value) => String(value))
          : undefined,
        valuationMetrics:
          payload.valuation_metrics && typeof payload.valuation_metrics === "object"
            ? (payload.valuation_metrics as Record<string, unknown>)
            : undefined,
        peerComparison:
          payload.peer_comparison && typeof payload.peer_comparison === "object"
            ? (payload.peer_comparison as Record<string, unknown>)
            : undefined,
        priceTargets:
          payload.price_targets && typeof payload.price_targets === "object"
            ? (payload.price_targets as Record<string, unknown>)
            : undefined,
      };
      continue;
    }
    if (envelope.event === "agent_error") {
      bucket[agent] = {
        ...bucket[agent],
        stage: "error",
        error: String(payload.error || payload.message || "Agent analysis failed"),
      };
    }
  }

  return {
    round1: cloneRound(round1),
    round2: cloneRound(round2),
  };
}

class DebateRunManager {
  private tasks = new Map<string, DebateRunTask>();
  private listeners = new Set<StateListener>();
  private runEventListeners = new Map<string, Set<RunEnvelopeListener>>();
  private historyListeners = new Set<HistoryListener>();
  private runBuffers = new Map<string, KaiStreamEnvelope[]>();
  private runSeenSeq = new Map<string, Set<number>>();
  private runSecrets = new Map<string, RunSecrets>();
  private runHistoryEntries = new Map<string, AnalysisHistoryEntry>();
  private streamControllers = new Map<string, AbortController>();
  private debateSessionId: string;

  constructor() {
    this.debateSessionId = this.loadOrCreateSessionId();
    this.hydrate();
  }

  private loadOrCreateSessionId(): string {
    const cached = getSessionItem(RUN_MANAGER_SESSION_KEY);
    if (cached && cached.trim().length > 0) {
      return cached.trim();
    }
    const next = createSessionId();
    setSessionItem(RUN_MANAGER_SESSION_KEY, next);
    return next;
  }

  private hydrate(): void {
    const raw = getSessionItem(RUN_MANAGER_STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedDebateRunManagerState>;
      if (parsed.version !== 1) return;
      if (Array.isArray(parsed.tasks)) {
        for (const task of parsed.tasks) {
          if (!task || typeof task !== "object") continue;
          if (!task.runId || !task.userId || !task.ticker) continue;
          this.tasks.set(task.runId, {
            ...task,
            persistenceState: task.persistenceState || "none",
            persistenceError: task.persistenceError || null,
            dismissedAt: task.dismissedAt || null,
            finalDecision: task.finalDecision || null,
          });
        }
      }
      if (parsed.debateSessionId && parsed.debateSessionId.trim()) {
        this.debateSessionId = parsed.debateSessionId.trim();
        setSessionItem(RUN_MANAGER_SESSION_KEY, this.debateSessionId);
      }
    } catch {
      // Ignore corrupted snapshot.
    }
  }

  private persist(): void {
    const payload: PersistedDebateRunManagerState = {
      version: 1,
      debateSessionId: this.debateSessionId,
      tasks: Array.from(this.tasks.values()),
    };
    setSessionItem(RUN_MANAGER_STORAGE_KEY, JSON.stringify(payload));
  }

  private getActiveRunId(): string | null {
    const running = Array.from(this.tasks.values())
      .filter((task) => task.status === "running" && !task.dismissedAt)
      .sort((a, b) => {
        const aTs = Date.parse(a.startedAt);
        const bTs = Date.parse(b.startedAt);
        return bTs - aTs;
      });
    return running.at(0)?.runId || null;
  }

  private emitState(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  private emitRunEnvelope(runId: string, envelope: KaiStreamEnvelope): void {
    const listeners = this.runEventListeners.get(runId);
    if (!listeners) return;
    for (const listener of listeners) {
      listener(envelope);
    }
  }

  private upsertTask(task: DebateRunTask): DebateRunTask {
    const existing = this.tasks.get(task.runId);
    const merged: DebateRunTask = {
      ...existing,
      ...task,
      persistenceState: task.persistenceState || existing?.persistenceState || "none",
      persistenceError:
        task.persistenceError !== undefined
          ? task.persistenceError
          : (existing?.persistenceError ?? null),
      dismissedAt:
        task.dismissedAt !== undefined ? task.dismissedAt : (existing?.dismissedAt ?? null),
      finalDecision:
        task.finalDecision !== undefined
          ? task.finalDecision
          : (existing?.finalDecision ?? null),
    };
    this.tasks.set(merged.runId, merged);
    this.persist();
    this.emitState();
    return merged;
  }

  private makeTaskFromServer(run: Record<string, unknown>): DebateRunTask {
    const statusRaw = String(run.status || "running").toLowerCase();
    const status: DebateRunStatus =
      statusRaw === "completed" || statusRaw === "failed" || statusRaw === "canceled"
        ? (statusRaw as DebateRunStatus)
        : "running";
    return {
      runId: String(run.run_id || ""),
      userId: String(run.user_id || ""),
      debateSessionId: String(run.debate_session_id || this.debateSessionId),
      ticker: toUpperTicker(String(run.ticker || "")),
      status,
      startedAt: String(run.started_at || nowIso()),
      completedAt:
        typeof run.completed_at === "string" && run.completed_at.length > 0
          ? String(run.completed_at)
          : null,
      updatedAt: String(run.updated_at || nowIso()),
      latestCursor: toFiniteNumber(run.latest_cursor, 0),
      pickSource:
        typeof run.pick_source === "string" && run.pick_source.trim().length > 0
          ? run.pick_source.trim()
          : undefined,
      pickSourceLabel:
        typeof run.pick_source_label === "string" && run.pick_source_label.trim().length > 0
          ? run.pick_source_label.trim()
          : undefined,
      pickSourceKind:
        typeof run.pick_source_kind === "string" && run.pick_source_kind.trim().length > 0
          ? run.pick_source_kind.trim()
          : undefined,
      persistenceState: "none",
      persistenceError: null,
      dismissedAt: null,
      finalDecision: null,
    };
  }

  private getOrCreateBuffer(runId: string): KaiStreamEnvelope[] {
    if (!this.runBuffers.has(runId)) {
      this.runBuffers.set(runId, []);
    }
    if (!this.runSeenSeq.has(runId)) {
      this.runSeenSeq.set(runId, new Set<number>());
    }
    return this.runBuffers.get(runId)!;
  }

  private resetRunBuffer(runId: string): void {
    this.runBuffers.set(runId, []);
    this.runSeenSeq.set(runId, new Set<number>());
  }

  getDebateSessionId(): string {
    return this.debateSessionId;
  }

  getState(): DebateRunManagerState {
    const tasks = Array.from(this.tasks.values()).sort((a, b) => {
      const aTs = Date.parse(a.startedAt);
      const bTs = Date.parse(b.startedAt);
      return bTs - aTs;
    });
    return {
      debateSessionId: this.debateSessionId,
      tasks,
      activeRunId: this.getActiveRunId(),
    };
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeHistory(listener: HistoryListener): () => void {
    this.historyListeners.add(listener);
    return () => {
      this.historyListeners.delete(listener);
    };
  }

  getHistoryEntriesForUser(userId: string): Array<{ entry: AnalysisHistoryEntry; task: DebateRunTask }> {
    const normalizedUserId = String(userId || "").trim();
    if (!normalizedUserId) return [];
    const items: Array<{ entry: AnalysisHistoryEntry; task: DebateRunTask }> = [];
    for (const task of this.tasks.values()) {
      if (task.userId !== normalizedUserId || task.dismissedAt) continue;
      const existingEntry = this.runHistoryEntries.get(task.runId);
      if (existingEntry) {
        items.push({ entry: existingEntry, task });
        continue;
      }
      if (task.status !== "completed" || !task.finalDecision) continue;
      const buffer = this.runBuffers.get(task.runId) || [];
      const decisionEnvelope = [...buffer].reverse().find((event) => event.event === "decision");
      const payload =
        decisionEnvelope?.payload && typeof decisionEnvelope.payload === "object"
          ? (decisionEnvelope.payload as Record<string, unknown>)
          : {};
      const rawCard =
        payload.raw_card && typeof payload.raw_card === "object"
          ? ({ ...(payload.raw_card as Record<string, unknown>) } as Record<string, unknown>)
          : {};
      rawCard.debate_run_id = task.runId;
      if (!rawCard.pick_source && task.pickSource) {
        rawCard.pick_source = task.pickSource;
      }
      if (!rawCard.pick_source_label && task.pickSourceLabel) {
        rawCard.pick_source_label = task.pickSourceLabel;
      }
      if (!rawCard.pick_source_kind && task.pickSourceKind) {
        rawCard.pick_source_kind = task.pickSourceKind;
      }
      const transcript = buildTranscriptFromEnvelopes(buffer);
      items.push({
        task,
        entry: {
          ticker: toUpperTicker(String(payload.ticker || task.ticker)),
          timestamp:
            typeof payload.analysis_updated_at === "string" && payload.analysis_updated_at.trim().length > 0
              ? payload.analysis_updated_at
              : task.completedAt || task.updatedAt || nowIso(),
          decision: String(payload.decision || task.finalDecision.decision || "hold"),
          confidence: toFiniteNumber(payload.confidence, task.finalDecision.confidence || 0),
          consensus_reached: Boolean(payload.consensus_reached),
          agent_votes:
            payload.agent_votes && typeof payload.agent_votes === "object"
              ? (payload.agent_votes as Record<string, string>)
              : {},
          final_statement: String(
            payload.final_statement || task.finalDecision.finalStatement || ""
          ),
          raw_card: rawCard as Record<string, any>,
          debate_transcript: transcript as AnalysisHistoryEntry["debate_transcript"],
        },
      });
    }
    return items.sort((left, right) => Date.parse(right.entry.timestamp) - Date.parse(left.entry.timestamp));
  }

  subscribeRunEvents(
    runId: string,
    listener: RunEnvelopeListener,
    options?: { replay?: boolean }
  ): () => void {
    const replay = options?.replay ?? true;
    const listeners = this.runEventListeners.get(runId) || new Set<RunEnvelopeListener>();
    listeners.add(listener);
    this.runEventListeners.set(runId, listeners);
    if (replay) {
      const buffer = this.runBuffers.get(runId) || [];
      for (const envelope of buffer) {
        listener(envelope);
      }
    }
    return () => {
      const current = this.runEventListeners.get(runId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.runEventListeners.delete(runId);
      }
    };
  }

  getTask(runId: string): DebateRunTask | null {
    return this.tasks.get(runId) || null;
  }

  getActiveTaskForUser(userId: string): DebateRunTask | null {
    const normalized = String(userId || "").trim();
    if (!normalized) return null;
    const active = Array.from(this.tasks.values())
      .filter(
        (task) => task.userId === normalized && task.status === "running" && !task.dismissedAt
      )
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    return active[0] || null;
  }

  private markMissingActiveRun(userId: string): void {
    const staleRunning = Array.from(this.tasks.values()).filter(
      (task) => task.userId === userId && task.status === "running" && !task.dismissedAt
    );
    for (const stale of staleRunning) {
      this.upsertTask({
        ...stale,
        status: "failed",
        completedAt: stale.completedAt || nowIso(),
        updatedAt: nowIso(),
        persistenceError: stale.persistenceError || "Active debate run is no longer available.",
      });
    }
  }

  private async waitForFinancialWritesToSettle(userId: string): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < FINANCIAL_WRITE_WAIT_TIMEOUT_MS) {
      const portfolioSaveRunning = AppBackgroundTaskService.hasRunningTask(
        userId,
        "portfolio_save"
      );
      const profileSyncRunning = AppBackgroundTaskService.hasRunningTask(
        userId,
        "portfolio_postsave_sync"
      );
      if (!portfolioSaveRunning && !profileSyncRunning) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, FINANCIAL_WRITE_POLL_MS));
    }
  }

  async resumeActiveRun(params: {
    userId: string;
    vaultOwnerToken: string;
    vaultKey?: string;
  }): Promise<DebateRunTask | null> {
    const { userId, vaultOwnerToken, vaultKey } = params;
    const response = await ApiService.getActiveKaiDebateRun({
      userId,
      debateSessionId: this.debateSessionId,
      vaultOwnerToken,
    });
    if (!response.ok) {
      if (response.status === 404) {
        this.markMissingActiveRun(userId);
        return null;
      }
      throw new Error(`Failed to check active run: HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { run?: Record<string, unknown> };
    if (!payload.run) {
      this.markMissingActiveRun(userId);
      return null;
    }
    const task = this.upsertTask(this.makeTaskFromServer(payload.run));
    this.runSecrets.set(task.runId, { vaultOwnerToken, vaultKey });
    if (task.status === "running") {
      await this.connectRunStream(task.runId, {
        userId,
        vaultOwnerToken,
        vaultKey,
        cursor: 0,
        resetBuffer: true,
      });
    }
    return this.getTask(task.runId);
  }

  async ensureRun(params: {
    userId: string;
    ticker: string;
    riskProfile: string;
    userContext?: Record<string, unknown> | null;
    pickSource?: string;
    pickSourceLabel?: string;
    pickSourceKind?: string;
    vaultOwnerToken: string;
    vaultKey?: string;
  }): Promise<EnsureRunResult> {
    const {
      userId,
      ticker,
      riskProfile,
      userContext,
      pickSource,
      pickSourceKind,
      pickSourceLabel,
      vaultOwnerToken,
      vaultKey,
    } = params;
    const activeTask = this.getActiveTaskForUser(userId);
    if (activeTask) {
      const refreshedActiveTask = this.upsertTask({
        ...activeTask,
        pickSource: pickSource || activeTask.pickSource,
        pickSourceLabel: pickSourceLabel || activeTask.pickSourceLabel,
        pickSourceKind: pickSourceKind || activeTask.pickSourceKind,
      });
      this.runSecrets.set(refreshedActiveTask.runId, { vaultOwnerToken, vaultKey });
      if (refreshedActiveTask.status === "running") {
        await this.connectRunStream(refreshedActiveTask.runId, {
          userId,
          vaultOwnerToken,
          vaultKey,
          cursor: 0,
          resetBuffer: this.getOrCreateBuffer(refreshedActiveTask.runId).length === 0,
        });
      }
      return { kind: "blocked", task: refreshedActiveTask };
    }

    const response = await ApiService.startKaiDebateRun({
      userId,
      debateSessionId: this.debateSessionId,
      ticker,
      riskProfile,
      userContext: userContext || undefined,
      pickSource,
      pickSourceLabel,
      pickSourceKind,
      vaultOwnerToken,
    });

    if (response.status === 409) {
      const conflict = (await response.json()) as {
        detail?: { active_run?: Record<string, unknown> };
      };
      const run = conflict.detail?.active_run;
      if (!run) {
        throw new Error("Active run lock returned without active_run metadata.");
      }
      const task = this.upsertTask({
        ...this.makeTaskFromServer(run),
        pickSource: pickSource || undefined,
        pickSourceLabel: pickSourceLabel || undefined,
        pickSourceKind: pickSourceKind || undefined,
      });
      this.runSecrets.set(task.runId, { vaultOwnerToken, vaultKey });
      await this.connectRunStream(task.runId, {
        userId,
        vaultOwnerToken,
        vaultKey,
        cursor: 0,
        resetBuffer: true,
      });
      return { kind: "blocked", task };
    }

    if (!response.ok) {
      throw new Error(`Failed to start analyze run: HTTP ${response.status}`);
    }

    const payload = (await response.json()) as { run?: Record<string, unknown> };
    if (!payload.run) {
      throw new Error("Run start response missing run payload.");
    }

    const task = this.upsertTask({
      ...this.makeTaskFromServer(payload.run),
      pickSource: pickSource || undefined,
      pickSourceLabel: pickSourceLabel || undefined,
      pickSourceKind: pickSourceKind || undefined,
    });
    this.runSecrets.set(task.runId, { vaultOwnerToken, vaultKey });
    await this.connectRunStream(task.runId, {
      userId,
      vaultOwnerToken,
      vaultKey,
      cursor: 0,
      resetBuffer: true,
    });
    return { kind: "started", task };
  }

  private async connectRunStream(
    runId: string,
    params: {
      userId: string;
      vaultOwnerToken: string;
      vaultKey?: string;
      cursor: number;
      resetBuffer: boolean;
    }
  ): Promise<void> {
    if (this.streamControllers.has(runId)) return;
    const task = this.tasks.get(runId);
    if (!task || task.status !== "running") return;

    if (params.resetBuffer) {
      this.resetRunBuffer(runId);
    }
    this.runSecrets.set(runId, {
      vaultOwnerToken: params.vaultOwnerToken,
      vaultKey: params.vaultKey,
    });

    const controller = new AbortController();
    this.streamControllers.set(runId, controller);

    try {
      const response = await ApiService.streamKaiDebateRun({
        userId: params.userId,
        runId,
        resumeCursor: params.cursor,
        vaultOwnerToken: params.vaultOwnerToken,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Run stream request failed: HTTP ${response.status}`);
      }

      await consumeCanonicalKaiStream(
        response,
        (envelope) => {
          this.handleEnvelope(runId, envelope);
        },
        {
          signal: controller.signal,
          idleTimeoutMs: 360000,
          requireTerminal: true,
        }
      );
    } catch (error) {
      if ((error as Error)?.name === "AbortError") {
        return;
      }
      const synthetic: KaiStreamEnvelope = {
        schema_version: "1.0",
        stream_id: `run_${runId}`,
        stream_kind: "stock_analyze",
        seq: Date.now(),
        event: "error",
        terminal: true,
        payload: {
          code: "ANALYZE_RUN_STREAM_FAILED",
          message: (error as Error)?.message || "Run stream failed",
          run_id: runId,
          timestamp: nowIso(),
          phase: "decision",
          progress_pct: 100,
        },
      };
      this.handleEnvelope(runId, synthetic);
    } finally {
      this.streamControllers.delete(runId);
    }
  }

  private handleEnvelope(runId: string, envelope: KaiStreamEnvelope): void {
    const task = this.tasks.get(runId);
    if (!task) return;

    const buffer = this.getOrCreateBuffer(runId);
    const seen = this.runSeenSeq.get(runId)!;
    if (seen.has(envelope.seq)) {
      return;
    }
    seen.add(envelope.seq);
    buffer.push(envelope);

    const nextTask: DebateRunTask = {
      ...task,
      updatedAt: nowIso(),
      latestCursor: Math.max(task.latestCursor, envelope.seq),
    };

    if (envelope.terminal) {
      if (envelope.event === "decision") {
        const payload =
          envelope.payload && typeof envelope.payload === "object"
            ? (envelope.payload as Record<string, unknown>)
            : {};
        nextTask.status = "completed";
        nextTask.completedAt = nowIso();
        nextTask.finalDecision = {
          decision: String(payload.decision || "hold"),
          confidence: toFiniteNumber(payload.confidence, 0),
          finalStatement: String(payload.final_statement || ""),
        };
      } else if (envelope.event === "aborted") {
        nextTask.status = "canceled";
        nextTask.completedAt = nowIso();
      } else {
        nextTask.status = "failed";
        nextTask.completedAt = nowIso();
      }
    }

    const persistedTask = this.upsertTask(nextTask);
    this.emitRunEnvelope(runId, envelope);

    if (envelope.terminal && envelope.event === "decision") {
      void this.persistDecisionHistory(runId, persistedTask);
    }
  }

  private async persistDecisionHistory(
    runId: string,
    task: DebateRunTask
  ): Promise<void> {
    const secrets = this.runSecrets.get(runId);
    if (!secrets?.vaultKey || !secrets.vaultOwnerToken) {
      this.upsertTask({
        ...task,
        persistenceState: "failed",
        persistenceError: "Missing vault credentials for history persistence.",
      });
      return;
    }

    const buffer = this.runBuffers.get(runId) || [];
    const decisionEnvelope = [...buffer].reverse().find((event) => event.event === "decision");
    const payload =
      decisionEnvelope?.payload && typeof decisionEnvelope.payload === "object"
        ? (decisionEnvelope.payload as Record<string, unknown>)
        : {};
    const transcript = buildTranscriptFromEnvelopes(buffer);
    const rawCard =
      payload.raw_card && typeof payload.raw_card === "object"
        ? ({ ...(payload.raw_card as Record<string, unknown>) } as Record<string, unknown>)
        : ({} as Record<string, unknown>);
    rawCard.debate_run_id = runId;
    if (!rawCard.pick_source && task.pickSource) {
      rawCard.pick_source = task.pickSource;
    }
    if (!rawCard.pick_source_label && task.pickSourceLabel) {
      rawCard.pick_source_label = task.pickSourceLabel;
    }
    if (!rawCard.pick_source_kind && task.pickSourceKind) {
      rawCard.pick_source_kind = task.pickSourceKind;
    }

    const entry: AnalysisHistoryEntry = {
      ticker: toUpperTicker(String(payload.ticker || task.ticker)),
      timestamp:
        typeof payload.analysis_updated_at === "string" && payload.analysis_updated_at.trim().length > 0
          ? payload.analysis_updated_at
          : nowIso(),
      decision: String(payload.decision || task.finalDecision?.decision || "hold"),
      confidence: toFiniteNumber(payload.confidence, task.finalDecision?.confidence || 0),
      consensus_reached: Boolean(payload.consensus_reached),
      agent_votes:
        payload.agent_votes && typeof payload.agent_votes === "object"
          ? (payload.agent_votes as Record<string, string>)
          : {},
      final_statement: String(payload.final_statement || task.finalDecision?.finalStatement || ""),
      raw_card: rawCard as Record<string, any>,
      debate_transcript: transcript as AnalysisHistoryEntry["debate_transcript"],
    };

    this.runHistoryEntries.set(runId, entry);
    let pendingTask = this.upsertTask({
      ...task,
      persistenceState: "pending",
      persistenceError: null,
    });
    for (const listener of this.historyListeners) {
      listener(entry, pendingTask);
    }

    await this.waitForFinancialWritesToSettle(task.userId);

    let success = false;
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const saved = await KaiHistoryService.saveAnalysis({
          userId: task.userId,
          vaultKey: secrets.vaultKey,
          vaultOwnerToken: secrets.vaultOwnerToken,
          entry,
        });
        if (saved) {
          success = true;
          break;
        }
      } catch (error) {
        lastError = error;
      }
      if (attempt < RETRY_DELAYS_MS.length) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
      }
    }

    if (success) {
      const savedTask = this.upsertTask({
        ...pendingTask,
        persistenceState: "saved",
        persistenceError: null,
      });
      for (const listener of this.historyListeners) {
        listener(entry, savedTask);
      }
      return;
    }

    this.upsertTask({
      ...pendingTask,
      persistenceState: "failed",
      persistenceError:
        (lastError as Error | undefined)?.message ||
        "Could not persist analysis history. Retry from task center.",
    });
  }

  async retryTaskPersistence(runId: string): Promise<void> {
    const task = this.tasks.get(runId);
    if (!task) return;
    if (task.status !== "completed") return;
    await this.persistDecisionHistory(runId, task);
  }

  async cancelRun(params: {
    runId: string;
    userId: string;
    vaultOwnerToken: string;
  }): Promise<void> {
    const { runId, userId, vaultOwnerToken } = params;
    const response = await ApiService.cancelKaiDebateRun({
      runId,
      userId,
      vaultOwnerToken,
    });
    if (!response.ok) {
      throw new Error(`Failed to cancel run: HTTP ${response.status}`);
    }
    const controller = this.streamControllers.get(runId);
    if (controller) {
      controller.abort();
    }
    const task = this.tasks.get(runId);
    if (!task) return;
    this.upsertTask({
      ...task,
      status: "canceled",
      completedAt: task.completedAt || nowIso(),
      updatedAt: nowIso(),
    });
  }

  dismissTask(runId: string): void {
    const task = this.tasks.get(runId);
    if (!task) return;
    this.upsertTask({
      ...task,
      dismissedAt: nowIso(),
    });
  }
}

export const DebateRunManagerService = new DebateRunManager();
