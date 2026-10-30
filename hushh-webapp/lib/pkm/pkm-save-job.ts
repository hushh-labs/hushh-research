"use client";

/**
 * A long explicit save ("save this to my memory") as a resumable job.
 *
 * The one-shot explicit save prepares every section within 300 s, then writes,
 * and the chat gives the whole job 8 minutes. Anything still unprepared at
 * either deadline used to be dropped. Here each source section is a persisted
 * step, so a deadline, a relock, going offline, an app switch or a reload is a
 * pause, never a loss: the job continues where it stopped.
 *
 * Job:  planned -> running <-> paused_locked | paused_offline -> completed | completed_with_gaps
 * Step: pending -> preparing(n) -> prepared -> committing -> committed | needs_owner | failed_retryable
 *
 * - Persistence: the vault-keyed SecureResourceCacheService (AES-GCM in
 *   IndexedDB) under `pkm_save_job:v1:<id>`, for at most 7 days (the server's
 *   confirmation-receipt window). Never localStorage or sessionStorage.
 * - Retries: 1, 4 and 16 s backoff, then the owner's Retry. A fallback or
 *   degraded answer is retried, never filed as unreadable.
 * - Splits: `split_recommended` / `has_more_candidates` split the step with the
 *   existing splitter (splitPkmSourceChunk); each half becomes its own step.
 * - Re-prepare: a step can commit while lines inside it stay unaccounted (the
 *   agent dropped a segment, or its quote did not match: `unmatched_quote_count`).
 *   The owner's Retry turns each run of those lines into a child step over just
 *   those lines, with its own id and so its own idempotency scope; the parent's
 *   saved cards are never sent again (addPkmSaveJobReprepareSteps).
 * - Idempotency: each card's commit id derives from sha256(jobId, span) plus the
 *   card's place in the step, so replaying a step cannot write a detail twice.
 * - One runner per job: a Web Lock across tabs, an in-process lock where Web
 *   Locks are unavailable (a second tab then can only replay idempotent commits).
 * - Receipts count only commits that came back with a dataVersion. A write
 *   whose answer never arrived is asked about (`lookupCommits`, owner-scoped,
 *   existence and dataVersion only) before it is retried or reported unsaved.
 */

import {
  addToPKM,
  previewAgentPkmMemory,
  resolveCardTargetDomain,
  type AgentPkmPreviewCard,
  type AgentPkmPreviewResponse,
  type AgentPkmSaveResult,
} from "@/lib/agent/agent-pkm-memory";
import type { PkmReconciliationCandidate } from "@/lib/agent/agent-pkm-context-store";
import {
  EXPLICIT_SAVE_CONFIRMATION,
  partitionExplicitSaveCards,
  type ExplicitPkmSaveResult,
} from "@/lib/agent/agent-pkm-explicit-save";
import {
  buildPkmSaveReceipt,
  isCommittedPkmSave,
  type ExplicitPkmSaveProgress,
  type ExplicitSavePartition,
  type PkmSaveReceipt,
} from "@/lib/agent/pkm-save-receipt";
import { pkmPlanIdForIdempotencyScope, sha256Hex } from "@/lib/personal-knowledge-model/mutation-plan";
import {
  MAX_CONCURRENT_PROPOSALS,
  planExplicitSaveSourceChunks,
  type PkmNaturalLanguageDuplicateMatch,
  type PkmNaturalLanguageSourceCoverage,
} from "@/lib/pkm/pkm-natural-language-ingestion";
import {
  computePkmLineCoverage,
  locatePkmQuote,
  type PkmCoverageDestination,
  type PkmCoverageSpan,
  type PkmLineCoverage,
} from "@/lib/pkm/pkm-save-coverage";
import {
  PKM_PROPOSAL_CHARS,
  pkmSourceRunChunk,
  sourceChunkRange,
  sourceChunkText,
  splitPkmSourceChunk,
  type PkmSourceChunk,
} from "@/lib/pkm/pkm-source-chunks";
import type { PkmMergeOutcome } from "@/lib/pkm/pkm-supersede-merge";
import { isDegradedPreviewCard } from "@/lib/profile/pkm-agent-lab-preview";
import { assertNoUnguardedSecrets } from "@/lib/pkm/secret-span-guard";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { SecureResourceCacheService } from "@/lib/services/secure-resource-cache-service";

export const PKM_SAVE_JOB_RESOURCE_PREFIX = "pkm_save_job:v1:";
const INDEX_RESOURCE_KEY = "pkm_save_job:v1:index";
/** At most 7 days, inside the server's 7-day confirmation-receipt window. */
export const PKM_SAVE_JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000 - 10 * 60 * 1000;
export const PKM_SAVE_JOB_BACKOFF_MS = [1_000, 4_000, 16_000] as const;
/** One section's proposal; the server's own budget is 45 s. */
const PREPARE_STEP_TIMEOUT_MS = 90_000;
/** Splits are bounded: a step that would exceed this keeps what it has. */
const MAX_JOB_STEPS = 128;

export type PkmSaveJobState =
  | "planned"
  | "running"
  | "paused_locked"
  | "paused_offline"
  | "completed"
  | "completed_with_gaps";

export type PkmSaveJobStepState =
  | "pending"
  | "preparing"
  | "prepared"
  | "committing"
  | "committed"
  | "needs_owner"
  | "failed_retryable";

export type PkmSaveJobCommit = {
  cardId: string;
  dataVersion: number;
  commitId: string | null;
  outcome?: PkmMergeOutcome;
  domain: string;
  path: string | null;
  /** Set when the write's own answer was lost and the server confirmed it later. */
  confirmedBy?: "lookup";
};

export type PkmSaveJobNotMemory = { quote: string; reason: "duplicate" | "disclaimer" };

export type PkmSaveJobStep = {
  /** sha256(jobId, span): also the idempotency scope of this step's commits. */
  id: string;
  chunk: PkmSourceChunk;
  state: PkmSaveJobStepState;
  /** preparing(n): preparation attempts in the current retry round. */
  attempt: number;
  commitAttempt: number;
  retryPhase?: "prepare" | "commit";
  retryAt?: number;
  /** Automatic retries are spent; the owner's Retry starts a new round. */
  exhausted?: boolean;
  issue?: "cannot_split" | "too_large";
  detectedFactCount?: number;
  cards?: AgentPkmPreviewCard[];
  /** Exact quotes dropped because the same value is already in Memory. */
  duplicateQuotes?: string[];
  notMemory?: PkmSaveJobNotMemory[];
  /** Quotes the server could not match to the owner's text; their lines stay unaccounted. */
  unmatchedQuoteCount?: number;
  commits?: Record<string, PkmSaveJobCommit>;
  /** The settled step whose unaccounted lines this step re-prepares. */
  reprepareOf?: string;
  /** 0 (absent) for a planned step; a re-prepare step is its parent's plus one. */
  generation?: number;
};

export type PkmSaveJob = {
  version: 1;
  id: string;
  userId: string;
  assistantMessageId?: string;
  /** The owner's text, trimmed; every offset in the job is in this text. */
  source: string;
  currentDomains: string[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  state: PkmSaveJobState;
  steps: PkmSaveJobStep[];
};

export type PkmSaveJobPause = "locked" | "offline" | "deadline" | "canceled";

export type PkmSaveJobDeps = {
  prepare: (params: { text: string; signal: AbortSignal }) => Promise<
    AgentPkmPreviewResponse & { cards: AgentPkmPreviewCard[] }
  >;
  commit: (params: {
    cards: AgentPkmPreviewCard[];
    idempotencyScopes: string[];
  }) => Promise<AgentPkmSaveResult>;
  /**
   * Whether writes already committed on the server, in order: the committed
   * dataVersion, or null. Asked only for cards whose own answer never arrived.
   */
  lookupCommits?: (params: {
    cards: AgentPkmPreviewCard[];
    idempotencyScopes: string[];
  }) => Promise<Array<{ dataVersion: number } | null>>;
  persist: (job: PkmSaveJob) => Promise<void>;
  /** The vault session is unlocked and current. Checked before every effect. */
  isUnlocked: () => boolean;
  isOnline?: () => boolean;
  findDuplicate?: (candidate: string) => PkmNaturalLanguageDuplicateMatch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  prepareTimeoutMs?: number;
};

const TERMINAL_JOB_STATES: ReadonlySet<PkmSaveJobState> = new Set(["completed", "completed_with_gaps"]);
const SETTLED_STEP_STATES: ReadonlySet<PkmSaveJobStepState> = new Set(["committed", "needs_owner"]);
/** A step whose own writes are done; only its unaccounted lines can be prepared again. */
const REPREPARABLE_STEP_STATES = SETTLED_STEP_STATES;

function stepId(jobId: string, chunk: PkmSourceChunk): Promise<string> {
  const range = sourceChunkRange(chunk);
  return sha256Hex(`${jobId}:${range.start}:${range.end}`);
}

async function newStep(jobId: string, chunk: PkmSourceChunk): Promise<PkmSaveJobStep> {
  return { id: await stepId(jobId, chunk), chunk, state: "pending", attempt: 0, commitAttempt: 0 };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = globalThis.setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener("abort", () => {
      globalThis.clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function readNotMemory(preview: AgentPkmPreviewResponse): PkmSaveJobNotMemory[] {
  // Added by the segmentation contract in a later release; tolerate its absence.
  const raw = (preview.preview_summary as { not_memory?: unknown } | undefined)?.not_memory ??
    (preview as { not_memory?: unknown }).not_memory;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const { quote, reason } = (entry ?? {}) as { quote?: unknown; reason?: unknown };
    return typeof quote === "string" && quote.trim() && (reason === "duplicate" || reason === "disclaimer")
      ? [{ quote, reason }]
      : [];
  });
}

function readCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export async function createPkmSaveJob(params: {
  userId: string;
  message: string;
  currentDomains: string[];
  assistantMessageId?: string;
  now?: number;
}): Promise<PkmSaveJob> {
  const source = params.message.trim();
  if (!source) throw new Error("A memory save needs some text to process.");
  // The job record outlives the turn: it must hold Secrets placeholders only,
  // never a raw value the device guard should already have kept.
  assertNoUnguardedSecrets([source]);
  const createdAt = params.now ?? Date.now();
  const id = globalThis.crypto?.randomUUID?.() ?? `pkm_job_${createdAt.toString(36)}`;
  const steps = await Promise.all(planExplicitSaveSourceChunks(source).map((chunk) => newStep(id, chunk)));
  return {
    version: 1, id, userId: params.userId,
    ...(params.assistantMessageId ? { assistantMessageId: params.assistantMessageId } : {}),
    source, currentDomains: [...params.currentDomains],
    createdAt, updatedAt: createdAt, expiresAt: createdAt + PKM_SAVE_JOB_TTL_MS,
    state: "planned", steps,
  };
}

/** The owner's Retry: every step whose automatic retries are spent starts a new round. */
export function retryPkmSaveJob(job: PkmSaveJob, now = Date.now()): PkmSaveJob {
  for (const step of job.steps) {
    if (step.state !== "failed_retryable") continue;
    step.exhausted = false;
    step.retryAt = now;
    if (step.retryPhase === "commit") step.commitAttempt = 0;
    else step.attempt = 0;
  }
  if (TERMINAL_JOB_STATES.has(job.state)) job.state = "running";
  return job;
}

/**
 * Re-prepare what a settled step left unaccounted. Each "not yet saved" line
 * belongs to the deepest step that covers it; when that step has committed (or
 * waits only on the owner), every contiguous run of such lines becomes a child
 * step over exactly those lines, inserted after its parent in source order.
 *
 * The child's id is sha256(jobId, "reprepare", parentId, run), so its commit
 * scopes (`<id>:<card>`) can never collide with the parent's: the parent's
 * saved cards are not sent again, and a fact the child writes is never refused
 * as a replay of one the parent wrote. The id is deterministic, so a second
 * Retry before the child settles finds it and adds nothing. Bounded by
 * MAX_JOB_STEPS. Returns the steps it added.
 */
export async function addPkmSaveJobReprepareSteps(job: PkmSaveJob): Promise<PkmSaveJobStep[]> {
  const { coverage } = buildPkmSaveJobCoverage(job);
  const ownerOf = (start: number): PkmSaveJobStep | null => {
    let owner: PkmSaveJobStep | null = null;
    for (const step of job.steps) {
      const range = sourceChunkRange(step.chunk);
      if (start < range.start || start >= range.end) continue;
      if (!owner || (step.generation ?? 0) > (owner.generation ?? 0)) owner = step;
    }
    return owner;
  };
  // Blank lines are not coverage lines, so they never break a run; any other
  // line (saved, a heading, held) does.
  const runs: Array<{ owner: PkmSaveJobStep; start: number; end: number }> = [];
  let contiguous = false;
  for (const line of coverage.lines) {
    const owner = line.status === "not_yet_saved" ? ownerOf(line.start) : null;
    if (!owner || !owner.cards || !REPREPARABLE_STEP_STATES.has(owner.state)) {
      contiguous = false;
      continue;
    }
    const last = runs[runs.length - 1];
    if (contiguous && last?.owner === owner) last.end = line.end;
    else runs.push({ owner, start: line.start, end: line.end });
    contiguous = true;
  }
  const added: PkmSaveJobStep[] = [];
  for (const run of runs) {
    if (job.steps.length >= MAX_JOB_STEPS) break;
    const id = await sha256Hex(`${job.id}:reprepare:${run.owner.id}:${run.start}:${run.end}`);
    if (job.steps.some((step) => step.id === id)) continue;
    const chunk = pkmSourceRunChunk(job.source, run.owner.chunk, run);
    if (!chunk) continue;
    const child: PkmSaveJobStep = {
      id, chunk, state: "pending", attempt: 0, commitAttempt: 0,
      reprepareOf: run.owner.id, generation: (run.owner.generation ?? 0) + 1,
    };
    // After the parent and any earlier steps inside it, so writes stay in source order.
    const parentRange = sourceChunkRange(run.owner.chunk);
    let at = job.steps.indexOf(run.owner) + 1;
    while (at < job.steps.length) {
      const range = sourceChunkRange(job.steps[at]!.chunk);
      if (range.start < parentRange.start || range.start >= parentRange.end || range.start > run.start) break;
      at += 1;
    }
    job.steps.splice(at, 0, child);
    added.push(child);
  }
  if (added.length && TERMINAL_JOB_STATES.has(job.state)) job.state = "running";
  return added;
}

/**
 * The receipt's "Retry N lines": failed steps start a new round, and lines a
 * settled step left unaccounted are prepared again as their own steps.
 */
export async function retryPkmSaveJobLines(job: PkmSaveJob, now = Date.now()): Promise<PkmSaveJob> {
  retryPkmSaveJob(job, now);
  await addPkmSaveJobReprepareSteps(job);
  return job;
}

/**
 * Drive one job until it completes or pauses. Every transition is persisted
 * before the effect it guards, so a reload resumes from the last durable state.
 */
export async function runPkmSaveJob(
  job: PkmSaveJob,
  deps: PkmSaveJobDeps,
  options: {
    signal?: AbortSignal;
    /** A deadline (epoch ms): the job pauses here and resumes later. */
    pauseAt?: number;
    onUpdate?: (job: PkmSaveJob) => void;
  } = {},
): Promise<{ job: PkmSaveJob; paused: PkmSaveJobPause | null }> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const online = () => deps.isOnline?.() ?? true;
  const interrupted = () => Boolean(options.signal?.aborted) || !deps.isUnlocked() || !online();
  const save = async () => {
    job.updatedAt = now();
    await deps.persist(job);
    options.onUpdate?.(job);
  };
  const due = (step: PkmSaveJobStep) => !step.exhausted && (step.retryAt ?? 0) <= now();
  const failRetryable = (step: PkmSaveJobStep, phase: "prepare" | "commit") => {
    const spent = phase === "prepare" ? step.attempt : step.commitAttempt;
    step.state = "failed_retryable";
    step.retryPhase = phase;
    if (spent > PKM_SAVE_JOB_BACKOFF_MS.length) {
      step.exhausted = true;
      delete step.retryAt;
    } else {
      step.retryAt = now() + PKM_SAVE_JOB_BACKOFF_MS[spent - 1]!;
    }
  };
  const settleStep = (step: PkmSaveJobStep, state: PkmSaveJobStepState) => {
    step.state = state;
    delete step.retryAt;
    delete step.retryPhase;
    delete step.exhausted;
  };

  const split = async (step: PkmSaveJobStep): Promise<boolean> => {
    const children = splitPkmSourceChunk(job.source, step.chunk);
    if (!children || job.steps.length - 1 + children.length > MAX_JOB_STEPS) return false;
    const replacement = await Promise.all(children.map((chunk) => newStep(job.id, chunk)));
    job.steps.splice(job.steps.indexOf(step), 1, ...replacement);
    return true;
  };

  const accept = (
    step: PkmSaveJobStep,
    preview: AgentPkmPreviewResponse & { cards: AgentPkmPreviewCard[] },
    issue?: PkmSaveJobStep["issue"],
  ) => {
    const duplicateQuotes: string[] = [];
    const cards: AgentPkmPreviewCard[] = [];
    preview.cards.forEach((raw, index) => {
      const { preparation_requires_review: _unused, ...card } = raw;
      const match = card.write_mode === "do_not_save" ? null : deps.findDuplicate?.(String(card.source_text || ""));
      if (match?.kind === "exact") {
        duplicateQuotes.push(card.source_quote ?? card.source_text);
        return;
      }
      cards.push({
        ...card,
        card_id: `${step.id.slice(0, 16)}_${index + 1}`,
        ...(match?.kind === "possible"
          ? { write_mode: "confirm_first", validation_hints: [...(card.validation_hints || []), "possible_duplicate"] }
          : {}),
      });
    });
    step.cards = cards;
    step.duplicateQuotes = duplicateQuotes;
    step.notMemory = readNotMemory(preview);
    step.detectedFactCount = readCount(preview.preview_summary?.total_segments_detected) ?? preview.cards.length;
    const unmatched = readCount(
      (preview.preview_summary as { unmatched_quote_count?: unknown } | undefined)?.unmatched_quote_count,
    );
    if (unmatched) step.unmatchedQuoteCount = unmatched;
    else delete step.unmatchedQuoteCount;
    if (issue) step.issue = issue;
    else delete step.issue;
    settleStep(step, "prepared");
  };

  const prepareOne = async (step: PkmSaveJobStep) => {
    const text = sourceChunkText(job.source, step.chunk);
    if (text.length > PKM_PROPOSAL_CHARS) return { kind: "oversized" as const };
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = globalThis.setTimeout(abort, deps.prepareTimeoutMs ?? PREPARE_STEP_TIMEOUT_MS);
    try {
      return { kind: "answered" as const, text, preview: await deps.prepare({ text, signal: controller.signal }) };
    } catch {
      return { kind: "failed" as const };
    } finally {
      globalThis.clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  };

  const prepareWave = async (wave: PkmSaveJobStep[]) => {
    for (const step of wave) {
      step.state = "preparing";
      step.attempt += 1;
    }
    await save();
    const results = await Promise.all(wave.map(prepareOne));
    for (const [index, step] of wave.entries()) {
      const result = results[index]!;
      if (result.kind === "oversized") {
        if (!(await split(step))) {
          step.issue = "too_large";
          step.attempt = PKM_SAVE_JOB_BACKOFF_MS.length + 1;
          failRetryable(step, "prepare");
        }
        continue;
      }
      if (result.kind === "failed") {
        // A relock, going offline or cancelation is not this step's failure.
        if (interrupted()) {
          step.state = "pending";
          step.attempt = Math.max(0, step.attempt - 1);
        } else {
          failRetryable(step, "prepare");
        }
        continue;
      }
      const { preview, text } = result;
      const cards = Array.isArray(preview.cards) ? preview.cards : [];
      if (preview.used_fallback === true || Boolean(preview.error) || cards.some(isDegradedPreviewCard)) {
        // A degraded answer is a failed attempt: retry it rather than file
        // its details as unreadable.
        failRetryable(step, "prepare");
        continue;
      }
      const summary = preview.preview_summary ?? {};
      const detected = readCount(summary.total_segments_detected) ?? cards.length;
      const wantsSplit = summary.split_recommended === true || summary.has_more_candidates === true ||
        (detected > cards.length && text.length > 96);
      if (wantsSplit) {
        if (await split(step)) continue;
        accept(step, { ...preview, cards }, "cannot_split");
        continue;
      }
      accept(step, { ...preview, cards });
    }
    await save();
  };

  const commitStep = async (step: PkmSaveJobStep) => {
    const cards = step.cards ?? [];
    const partition = partitionExplicitSaveCards(cards);
    const commits = step.commits ?? {};
    const pending = partition.save.filter((card) => !commits[card.card_id]);
    const scopeOf = (card: AgentPkmPreviewCard) => `${step.id}:${cards.indexOf(card)}`;
    if (pending.length) {
      step.state = "committing";
      await save();
      const result = await deps.commit({
        cards: pending,
        idempotencyScopes: pending.map(scopeOf),
      }).catch(() => null);
      pending.forEach((card, index) => {
        const ack = result?.results[index];
        if (!ack || !isCommittedPkmSave(ack)) return;
        commits[card.card_id] = {
          cardId: card.card_id,
          dataVersion: ack.result!.dataVersion!,
          commitId: ack.result?.commitId ?? null,
          ...(ack.outcome ? { outcome: ack.outcome } : {}),
          domain: ack.domain,
          path: card.primary_json_path ?? card.retrieval_hints?.path ?? ack.scope ?? null,
        };
      });
      // A write can land on the server while its answer is lost (the network
      // dropped, the tab slept). Replaying it is refused by its own commit id,
      // so without asking, a saved detail would read "not yet saved" forever.
      const unconfirmed = pending.filter((card) => !commits[card.card_id]);
      if (unconfirmed.length && deps.lookupCommits && !interrupted()) {
        const found = await deps.lookupCommits({
          cards: unconfirmed,
          idempotencyScopes: unconfirmed.map(scopeOf),
        }).catch(() => null);
        unconfirmed.forEach((card, index) => {
          const hit = found?.[index];
          if (!hit) return;
          commits[card.card_id] = {
            cardId: card.card_id,
            dataVersion: hit.dataVersion,
            commitId: null,
            domain: resolveCardTargetDomain(card),
            path: card.primary_json_path ?? card.retrieval_hints?.path ?? null,
            confirmedBy: "lookup",
          };
        });
      }
      step.commits = commits;
      if (partition.save.some((card) => !commits[card.card_id])) {
        if (interrupted()) step.state = "prepared";
        else {
          step.commitAttempt += 1;
          failRetryable(step, "commit");
        }
        await save();
        return;
      }
    }
    settleStep(step, partition.needsOwner.length ? "needs_owner" : "committed");
    await save();
  };

  if (TERMINAL_JOB_STATES.has(job.state)) return { job, paused: null };
  if (now() >= job.expiresAt) {
    job.state = "completed_with_gaps";
    await save();
    return { job, paused: null };
  }
  while (true) {
    if (options.signal?.aborted) {
      await save();
      return { job, paused: "canceled" };
    }
    if (!deps.isUnlocked()) {
      job.state = "paused_locked";
      await save();
      return { job, paused: "locked" };
    }
    if (!online()) {
      job.state = "paused_offline";
      await save();
      return { job, paused: "offline" };
    }
    if (job.state !== "running") {
      job.state = "running";
      await save();
    }
    if (options.pauseAt !== undefined && now() >= options.pauseAt) {
      await save();
      return { job, paused: "deadline" };
    }
    // Writes stay sequential and in source order; a prepared step commits first.
    const commitReady = job.steps.find((step) =>
      step.state === "prepared" || step.state === "committing" ||
      (step.state === "failed_retryable" && step.retryPhase === "commit" && due(step)),
    );
    if (commitReady) {
      await commitStep(commitReady);
      continue;
    }
    const wave = job.steps.filter((step) =>
      step.state === "pending" || step.state === "preparing" ||
      (step.state === "failed_retryable" && step.retryPhase !== "commit" && due(step)),
    ).slice(0, MAX_CONCURRENT_PROPOSALS);
    if (wave.length) {
      await prepareWave(wave);
      continue;
    }
    const waiting = job.steps.filter((step) => step.state === "failed_retryable" && !step.exhausted);
    if (waiting.length) {
      const next = Math.min(...waiting.map((step) => step.retryAt ?? now()));
      const until = options.pauseAt === undefined ? next : Math.min(next, options.pauseAt);
      await sleep(Math.max(0, until - now()), options.signal);
      continue;
    }
    const coverage = buildPkmSaveJobCoverage(job).coverage;
    const gaps = coverage.totals.held + coverage.totals.not_yet_saved > 0 ||
      job.steps.some((step) => !SETTLED_STEP_STATES.has(step.state) || step.issue);
    job.state = gaps ? "completed_with_gaps" : "completed";
    await save();
    return { job, paused: null };
  }
}

/** Every line of the job's text mapped to where it went, or why it did not. */
export function buildPkmSaveJobCoverage(job: PkmSaveJob): {
  coverage: PkmLineCoverage;
  heldCardIds: Map<number, string[]>;
} {
  const spans: PkmCoverageSpan[] = [];
  const destinations = new Map<string, PkmCoverageDestination>();
  const heldSpans: Array<{ start: number; end: number; cardId: string }> = [];
  for (const step of job.steps) {
    if (!step.cards) continue;
    const range = sourceChunkRange(step.chunk);
    const context = step.chunk.context;
    const locate = (quote: string, cursor?: number) =>
      locatePkmQuote({ source: job.source, range, context, quote, cursor });
    // Spans this step's cards already account for. A repeated line is reported
    // once as a duplicate: it belongs to an occurrence no card claimed, not to
    // the first one, which the saved card already covers.
    const claimed: Array<{ start: number; end: number }> = [];
    const locateUnclaimed = (quote: string) => {
      for (let at = job.source.indexOf(quote, range.start); at >= 0 && at + quote.length <= range.end;
        at = job.source.indexOf(quote, at + 1)) {
        const span = { start: at, end: at + quote.length };
        if (!claimed.some((taken) => taken.start < span.end && taken.end > span.start)) return span;
      }
      return locate(quote);
    };
    const partition = partitionExplicitSaveCards(step.cards);
    const heldReason = new Map<string, "needs_owner" | "excluded" | "left_out">();
    partition.needsOwner.forEach((card) => heldReason.set(card.card_id, "needs_owner"));
    partition.excluded.forEach((card) => heldReason.set(card.card_id, "excluded"));
    partition.skipped.forEach((card) => heldReason.set(card.card_id, "left_out"));
    const known = new Set(partition.known.map((card) => card.card_id));
    let cursor = range.start;
    for (const card of step.cards) {
      const quotes = [card.source_quote ?? card.source_text, ...(card.context_quotes ?? [])];
      const located = quotes.map((quote, index) => locate(quote, index === 0 ? cursor : undefined));
      if (located[0]) {
        cursor = located[0].end;
        claimed.push(located[0]);
      }
      const commit = step.commits?.[card.card_id];
      for (const span of located) {
        if (!span) continue;
        if (commit) spans.push({ ...span, kind: "committed", cardId: card.card_id });
        else if (known.has(card.card_id)) spans.push({ ...span, kind: "not_memory", reason: "already_known" });
        else if (heldReason.has(card.card_id)) {
          spans.push({ ...span, kind: "held", reason: heldReason.get(card.card_id)!, cardId: card.card_id });
          if (heldReason.get(card.card_id) === "needs_owner") heldSpans.push({ ...span, cardId: card.card_id });
        }
      }
      if (commit) {
        destinations.set(card.card_id, {
          cardId: card.card_id, domain: commit.domain, path: commit.path, commitId: commit.commitId,
        });
      }
    }
    for (const quote of step.duplicateQuotes ?? []) {
      const span = locateUnclaimed(quote);
      if (span) {
        claimed.push(span);
        spans.push({ ...span, kind: "not_memory", reason: "already_known" });
      }
    }
    for (const entry of step.notMemory ?? []) {
      const span = locateUnclaimed(entry.quote);
      if (span) {
        claimed.push(span);
        spans.push({ ...span, kind: "not_memory", reason: entry.reason });
      }
    }
  }
  const coverage = computePkmLineCoverage({ source: job.source, spans, destinations });
  const heldCardIds = new Map<number, string[]>();
  for (const line of coverage.lines) {
    if (line.status !== "held" || line.reason !== "needs_owner") continue;
    const ids = [...new Set(heldSpans
      .filter((span) => span.start < line.end && span.end > line.start)
      .map((span) => span.cardId))];
    if (ids.length) heldCardIds.set(line.line, ids);
  }
  return { coverage, heldCardIds };
}

function stepCoverage(step: PkmSaveJobStep, index: number): PkmNaturalLanguageSourceCoverage {
  const base = {
    sourceBlockId: `source_block_${String(index + 1).padStart(3, "0")}`,
    sourceRange: sourceChunkRange(step.chunk),
    ...(step.chunk.context?.length ? { sourceContext: step.chunk.context } : {}),
  };
  const settled = SETTLED_STEP_STATES.has(step.state) ||
    (step.state === "failed_retryable" && step.retryPhase === "commit");
  if (!settled || !step.cards) {
    return { ...base, preparationIssue: "not_yet_saved", disposition: "review_required", detectedFactCount: 0, accountedFactCount: 0 };
  }
  const duplicates = step.duplicateQuotes?.length ?? 0;
  const disclaimers = step.notMemory?.filter((entry) => entry.reason === "disclaimer").length ?? 0;
  const agentDuplicates = (step.notMemory?.length ?? 0) - disclaimers;
  const accounted = step.cards.length + duplicates;
  return {
    ...base,
    ...(step.issue === "cannot_split" ? { preparationIssue: "cannot_split_context" as const } : {}),
    disposition: accounted === 0 ? "intentionally_ignored" : "proposed",
    detectedFactCount: Math.max(step.detectedFactCount ?? accounted, accounted),
    accountedFactCount: Math.max(step.detectedFactCount ?? accounted, accounted),
    ...(duplicates + agentDuplicates ? { duplicateCount: duplicates + agentDuplicates } : {}),
    ...(disclaimers ? { disclaimerCount: disclaimers } : {}),
  };
}

/** The receipt of a job at any point: committed counts plus line coverage. */
export function buildPkmSaveJobReceipt(
  job: PkmSaveJob,
  domainTitles?: ReadonlyMap<string, string>,
): ExplicitPkmSaveResult {
  const partition: ExplicitSavePartition = { save: [], needsOwner: [], known: [], unreadable: [], skipped: [], excluded: [] };
  const results: AgentPkmSaveResult["results"] = [];
  for (const step of job.steps) {
    const settled = SETTLED_STEP_STATES.has(step.state) ||
      (step.state === "failed_retryable" && step.retryPhase === "commit");
    if (!settled || !step.cards) continue;
    const stepPartition = partitionExplicitSaveCards(step.cards);
    for (const card of stepPartition.save) {
      const commit = step.commits?.[card.card_id];
      partition.save.push(card);
      results.push(commit
        ? {
            cardId: card.card_id, domain: commit.domain, scope: commit.path, sharingPosture: "", success: true,
            result: { saveState: "saved", success: true, dataVersion: commit.dataVersion, fullBlob: {},
              ...(commit.commitId ? { commitId: commit.commitId } : {}) },
            ...(commit.outcome ? { outcome: commit.outcome } : {}),
          }
        : { cardId: card.card_id, domain: "", scope: null, sharingPosture: "", success: false });
    }
    partition.needsOwner.push(...stepPartition.needsOwner);
    partition.known.push(...stepPartition.known);
    partition.unreadable.push(...stepPartition.unreadable);
    partition.skipped.push(...stepPartition.skipped);
    partition.excluded.push(...stepPartition.excluded);
  }
  const saved = results.filter(isCommittedPkmSave).length;
  const { coverage, heldCardIds } = buildPkmSaveJobCoverage(job);
  const receipt: PkmSaveReceipt = buildPkmSaveReceipt({
    coverage: job.steps.map(stepCoverage),
    partition,
    saveResult: {
      attempted: results.length, saved, failed: results.length - saved,
      domains: [...new Set(results.filter(isCommittedPkmSave).map((result) => result.domain))], results,
    },
    domainTitles,
    lineCoverage: { jobId: job.id, jobState: job.state, source: job.source, coverage, heldCardIds },
  });
  return { receipt, needsOwnerCards: partition.needsOwner };
}

// ---- Persistence: vault-keyed, encrypted, bounded -------------------------------

function jobResourceKey(jobId: string): string {
  return `${PKM_SAVE_JOB_RESOURCE_PREFIX}${jobId}`;
}

type PkmSaveJobIndex = { version: 1; jobs: Array<{ id: string; expiresAt: number }> };

async function readIndex(userId: string, vaultKey: string): Promise<PkmSaveJobIndex["jobs"]> {
  const index = await SecureResourceCacheService.read<PkmSaveJobIndex>({
    userId, resourceKey: INDEX_RESOURCE_KEY, vaultKey,
  });
  const now = Date.now();
  return index?.version === 1 && Array.isArray(index.jobs)
    ? index.jobs.filter((entry) => typeof entry?.id === "string" && entry.expiresAt > now)
    : [];
}

async function writeIndex(userId: string, vaultKey: string, jobs: PkmSaveJobIndex["jobs"]): Promise<void> {
  if (!jobs.length) {
    await SecureResourceCacheService.invalidateResource(userId, INDEX_RESOURCE_KEY);
    return;
  }
  await SecureResourceCacheService.writeRequired<PkmSaveJobIndex>({
    userId, resourceKey: INDEX_RESOURCE_KEY, vaultKey, value: { version: 1, jobs },
    ttlMs: Math.max(...jobs.map((entry) => entry.expiresAt)) - Date.now(),
  });
}

export async function persistPkmSaveJob(job: PkmSaveJob, vaultKey: string): Promise<void> {
  if (job.state === "completed") {
    await deletePkmSaveJob(job.userId, job.id, vaultKey);
    return;
  }
  const ttlMs = job.expiresAt - Date.now();
  if (ttlMs <= 0) {
    await deletePkmSaveJob(job.userId, job.id, vaultKey);
    return;
  }
  await SecureResourceCacheService.writeRequired<PkmSaveJob>({
    userId: job.userId, resourceKey: jobResourceKey(job.id), value: job, ttlMs, vaultKey,
  });
  const index = await readIndex(job.userId, vaultKey);
  if (!index.some((entry) => entry.id === job.id)) {
    await writeIndex(job.userId, vaultKey, [...index, { id: job.id, expiresAt: job.expiresAt }]);
  }
}

export async function loadPkmSaveJob(userId: string, jobId: string, vaultKey: string): Promise<PkmSaveJob | null> {
  const job = await SecureResourceCacheService.read<PkmSaveJob>({ userId, resourceKey: jobResourceKey(jobId), vaultKey });
  return job?.version === 1 && job.id === jobId && job.userId === userId && job.expiresAt > Date.now() ? job : null;
}

export async function deletePkmSaveJob(userId: string, jobId: string, vaultKey: string): Promise<void> {
  await SecureResourceCacheService.invalidateResource(userId, jobResourceKey(jobId));
  const index = await readIndex(userId, vaultKey).catch(() => []);
  if (index.some((entry) => entry.id === jobId)) {
    await writeIndex(userId, vaultKey, index.filter((entry) => entry.id !== jobId)).catch(() => undefined);
  }
}

/** Jobs this owner can still continue on this device (not completed, not expired). */
export async function listResumablePkmSaveJobs(params: {
  userId: string;
  vaultKey: string;
}): Promise<Array<{ id: string; assistantMessageId?: string; state: PkmSaveJobState }>> {
  const index = await readIndex(params.userId, params.vaultKey).catch(() => []);
  const jobs = await Promise.all(index.map((entry) => loadPkmSaveJob(params.userId, entry.id, params.vaultKey)));
  return jobs
    .filter((job): job is PkmSaveJob => Boolean(job) && job!.state !== "completed" && job!.state !== "completed_with_gaps")
    .map((job) => ({
      id: job.id, state: job.state,
      ...(job.assistantMessageId ? { assistantMessageId: job.assistantMessageId } : {}),
    }));
}

// ---- One runner per job ------------------------------------------------------------

const runningInThisTab = new Set<string>();

/**
 * Run `task` only if no other runner holds this job: a Web Lock across tabs,
 * or an in-process lock where Web Locks are unavailable. Returns null when busy.
 */
export async function withPkmSaveJobLock<T>(jobId: string, task: () => Promise<T>): Promise<T | null> {
  if (runningInThisTab.has(jobId)) return null;
  const locks = typeof navigator !== "undefined"
    ? (navigator as Navigator & { locks?: LockManager }).locks
    : undefined;
  const run = async () => {
    runningInThisTab.add(jobId);
    try {
      return await task();
    } finally {
      runningInThisTab.delete(jobId);
    }
  };
  if (!locks?.request) return run();
  return locks.request(`pkm_save_job:${jobId}`, { ifAvailable: true }, (lock) => (lock ? run() : null));
}

// ---- The explicit save, as a job --------------------------------------------------

export type ExplicitPkmSaveJobParams = {
  userId: string;
  currentManifests?: unknown[];
  vaultKey: string;
  vaultOwnerToken: string;
  findDuplicate?: (candidate: string) => PkmNaturalLanguageDuplicateMatch;
  findReconciliationCandidates?: (passage: string) => readonly PkmReconciliationCandidate[];
  domainTitles?: ReadonlyMap<string, string>;
  beforeEffect?: () => Promise<void>;
  isEffectCurrent?: () => boolean;
  mayPublish?: () => boolean;
  onProgress?: (progress: ExplicitPkmSaveProgress) => void;
  pauseAt?: number;
  signal?: AbortSignal;
};

export type ExplicitPkmSaveJobResult = ExplicitPkmSaveResult & {
  jobId: string;
  jobState: PkmSaveJobState;
  paused: PkmSaveJobPause | null;
  assistantMessageId?: string;
  /** The owner's text, for a later "Save these too" on held details. Session memory only. */
  sourceMessage: string;
};

function explicitSaveDeps(params: ExplicitPkmSaveJobParams, job: PkmSaveJob): PkmSaveJobDeps {
  let sequence = 0;
  return {
    prepare: ({ text, signal }) => previewAgentPkmMemory({
      userId: params.userId, message: text, currentDomains: job.currentDomains,
      currentManifests: params.currentManifests, vaultOwnerToken: params.vaultOwnerToken,
      ingestionId: job.id, chunkIndex: (sequence += 1),
      reconciliationCandidates: params.findReconciliationCandidates?.(text),
      signal, isEffectCurrent: params.isEffectCurrent,
    }),
    commit: ({ cards, idempotencyScopes }) => addToPKM({
      userId: params.userId, cards, sourceMessage: job.source,
      vaultKey: params.vaultKey, vaultOwnerToken: params.vaultOwnerToken,
      source: "agent_chat_owner_request",
      // The owner confirmed when they asked; a resumed job keeps that moment.
      confirmation: { ...EXPLICIT_SAVE_CONFIRMATION, confirmedAt: new Date(job.createdAt).toISOString() },
      beforeEffect: params.beforeEffect, mayPublish: params.mayPublish, idempotencyScopes,
    }),
    lookupCommits: async ({ cards, idempotencyScopes }) => {
      const rows = await PersonalKnowledgeModelService.lookupMutationCommits({
        userId: params.userId,
        vaultOwnerToken: params.vaultOwnerToken,
        commits: cards.map((card, index) => ({
          domain: resolveCardTargetDomain(card),
          planId: pkmPlanIdForIdempotencyScope(idempotencyScopes[index]!),
        })),
      });
      return rows.map((row) => (row.exists && row.dataVersion !== null ? { dataVersion: row.dataVersion } : null));
    },
    persist: async (current) => {
      try {
        await persistPkmSaveJob(current, params.vaultKey);
      } catch {
        // Storage unavailable (a private window): the job still runs in this
        // tab; it just cannot resume after a reload. Never log job content.
        console.warn("[PKM_SAVE_JOB] persist_failed", { job_id: current.id });
      }
    },
    isUnlocked: () => params.isEffectCurrent?.() ?? true,
    isOnline: () => typeof navigator === "undefined" || navigator.onLine !== false,
    findDuplicate: params.findDuplicate,
  };
}

function reportProgress(job: PkmSaveJob, onProgress?: (progress: ExplicitPkmSaveProgress) => void) {
  if (!onProgress) return;
  const committing = job.steps.find((step) => step.state === "committing");
  if (committing) {
    onProgress({ stage: "saving", total: partitionExplicitSaveCards(committing.cards ?? []).save.length });
    return;
  }
  const done = job.steps.filter((step) => step.cards && step.state !== "pending" && step.state !== "preparing").length;
  onProgress({ stage: "reading", done, total: job.steps.length });
}

async function driveExplicitJob(
  job: PkmSaveJob,
  params: ExplicitPkmSaveJobParams,
): Promise<ExplicitPkmSaveJobResult | null> {
  return withPkmSaveJobLock(job.id, async () => {
    const outcome = await runPkmSaveJob(job, explicitSaveDeps(params, job), {
      signal: params.signal,
      pauseAt: params.pauseAt,
      onUpdate: (current) => reportProgress(current, params.onProgress),
    });
    console.info("[PKM_SAVE_JOB] run_ended", {
      job_id: job.id, state: outcome.job.state, paused: outcome.paused, steps: outcome.job.steps.length,
    });
    return {
      ...buildPkmSaveJobReceipt(outcome.job, params.domainTitles),
      jobId: job.id, jobState: outcome.job.state, paused: outcome.paused,
      ...(job.assistantMessageId ? { assistantMessageId: job.assistantMessageId } : {}),
      sourceMessage: job.source,
    };
  });
}

/** Start an explicit save as a job. It pauses at `pauseAt` and resumes later. */
export async function startExplicitPkmSaveJob(
  params: ExplicitPkmSaveJobParams & { message: string; currentDomains: string[]; assistantMessageId?: string },
): Promise<ExplicitPkmSaveJobResult> {
  const job = await createPkmSaveJob({
    userId: params.userId, message: params.message, currentDomains: params.currentDomains,
    assistantMessageId: params.assistantMessageId,
  });
  const result = await driveExplicitJob(job, params);
  if (!result) throw new Error("This save is already running.");
  return result;
}

/** Continue a persisted job (after unlock, reconnect, reload, or the owner's Retry). */
export async function resumeExplicitPkmSaveJob(
  params: ExplicitPkmSaveJobParams & { jobId: string; retry?: boolean },
): Promise<ExplicitPkmSaveJobResult | null> {
  const job = await loadPkmSaveJob(params.userId, params.jobId, params.vaultKey);
  if (!job) return null;
  if (params.retry) await retryPkmSaveJobLines(job);
  return driveExplicitJob(job, params);
}
