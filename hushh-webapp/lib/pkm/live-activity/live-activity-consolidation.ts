"use client";

/**
 * Background consolidation of the live activity journal into memory.md.
 *
 * A bounded digest of first-person activity statements goes through the same
 * memory pipeline as ambient chat capture (prepareNaturalLanguagePkm with the
 * soul_markdown_v1 profile). The model decides what is durable; this module
 * only fences ownership, fails closed on degraded output, refuses deletes and
 * stages the model's facts once per cycle. It is the only PKM writer for activity.
 */

import {
  AGENT_PKM_PRODUCT_DEFAULT_EFFECTIVE_AT,
  DEFAULT_AGENT_PKM_AUTO_SAVE_POLICY,
} from "@/lib/agent/agent-pkm-auto-save-policy";
import {
  isUnresolvedSourceBlock,
  prepareNaturalLanguagePkm,
  type PkmNaturalLanguagePreparationResult,
} from "@/lib/pkm/pkm-natural-language-ingestion";
import {
  findMarkdownMemoryBullet,
  loadMarkdownMemory,
  markdownFactsFromCards,
  markdownMemoryFactText,
  MAX_MARKDOWN_MEMORY_CHARS,
  peekMarkdownMemory,
  soulMemoryCandidates,
  stageMarkdownMemoryFacts,
  type SoulMemoryCandidate,
} from "@/lib/pkm/markdown-memory";
import { soulFactText, type SoulFact } from "@/lib/pkm/soul-document";
import { liveActivityDayKey, liveActivityStatements } from "@/lib/pkm/live-activity/live-activity-copy";
import {
  readUnconsolidatedLiveActivity,
  settleLiveActivityBatch,
  type LiveActivityBatch,
} from "@/lib/pkm/live-activity/live-activity-journal";
import type { LiveActivityEvent } from "@/lib/pkm/live-activity/live-activity-types";

export type LiveActivityConsolidationOutcome =
  | "saved"
  /** The model kept nothing new (or only facts memory.md already holds). */
  | "nothing_durable"
  /** Only kinds the digest never describes: settled without asking the model. */
  | "host_skipped"
  /** A counted failure (degraded output, a refused removal, a rejected write), memory.md could not be read, or a local memory save is stuck. */
  | "failed"
  /** Nothing ready to consolidate. */
  | "skipped"
  /** The run went stale (owner, vault session or attachment changed, aborted, offline) or a local memory save is in flight: nothing settled. */
  | "cancelled"
  | "busy"
  | "memory_full";

/** `more`: a settled run left events of a later day or past the batch bound pending. */
type ConsolidationResult = { outcome: LiveActivityConsolidationOutcome; saved: number; more: boolean };

type ConsolidationParams = {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  reason: "interval" | "attach";
  isCurrent: () => boolean;
  signal?: AbortSignal;
};

const MAX_BATCH_EVENTS = 120;
const DUE_PENDING = 20;
const DUE_OLDEST_MS = 10 * 60_000;
const MIN_RUN_GAP_MS = 5 * 60_000;
// Stay clear of memory.md's hard ceilings (256 bullets, 18,000 characters).
const MEMORY_FULL_BULLETS = 240;
const MEMORY_FULL_CHARS = 17_000;

const inFlight = new Set<string>();
/** memory.md length at which staging last would have overflowed; no model call until it shrinks. */
const fullAt = new Map<string, number>();

const result = (outcome: LiveActivityConsolidationOutcome, saved = 0, more = false): ConsolidationResult => ({ outcome, saved, more });

export function shouldConsolidateLiveActivity(stats: {
  pending: number;
  oldestPendingAt: number | null;
  lastRunAt: number | null;
  now: number;
}): boolean {
  if (stats.pending < 1) return false;
  const due = stats.pending >= DUE_PENDING ||
    (stats.oldestPendingAt !== null && stats.now - stats.oldestPendingAt >= DUE_OLDEST_MS);
  if (!due) return false;
  // Every run, including a retry after a failure, waits out the gap.
  return stats.lastRunAt === null || stats.now - stats.lastRunAt >= MIN_RUN_GAP_MS;
}

function isCurrentRun(params: ConsolidationParams): boolean {
  return !params.signal?.aborted && params.isCurrent();
}

const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

/**
 * A thrown failure while offline or after cancellation says nothing about the
 * batch: the model never judged it, so it must not use up an attempt. Any
 * other failure, a server rejection or a model timeout included, counts.
 */
function isTransientFailure(params: ConsolidationParams): boolean {
  return Boolean(params.signal?.aborted) || isOffline();
}

/**
 * The batch's oldest local day only, as a seq prefix of each stream, so every
 * line of that day reaches the model and the ledger never passes an event
 * whose line was not sent. The day comes from the lowest seq of the first
 * event's stream, so its first event is always included (even after the
 * clock moved back) and each cycle makes progress.
 */
function firstLocalDay(batch: LiveActivityBatch): LiveActivityBatch {
  const first = batch.events[0];
  if (!first) return batch;
  const dayKey = liveActivityDayKey();
  const anchor = batch.events.reduce((low, event) => (event.streamId === first.streamId && event.seq < low.seq ? event : low), first);
  const day = dayKey(anchor.lastAt);
  const included = new Set<LiveActivityEvent>();
  const closedStreams = new Set<string>();
  const through: Record<string, number> = {};
  for (const event of [...batch.events].sort((a, b) => a.seq - b.seq)) {
    if (closedStreams.has(event.streamId)) continue;
    if (dayKey(event.lastAt) !== day) {
      closedStreams.add(event.streamId);
      continue;
    }
    included.add(event);
    through[event.streamId] = event.seq;
  }
  return Object.freeze({
    userId: batch.userId,
    events: Object.freeze(batch.events.filter(event => included.has(event))),
    through: Object.freeze(through),
    attempt: batch.attempt,
    attemptKey: batch.attemptKey,
  });
}

/** Same rule as ambient chat capture: any unresolved, degraded or fallback answer writes nothing. */
function isDegradedPreparation(prepared: PkmNaturalLanguagePreparationResult): boolean {
  return Boolean(
    prepared.sourceCoverage?.some(isUnresolvedSourceBlock) ||
    prepared.cards.some(card => card.preparation_requires_review || card.preview_degraded || card.drift_flags?.fallback_used) ||
    prepared.previews?.some(preview => preview.used_fallback || preview.error),
  );
}

/** memory.md near its ceilings, too large to reconcile, or still as long as when staging last overflowed, is full. */
function memoryCandidatesOrFull(userId: string, markdown: string): SoulMemoryCandidate[] | null {
  // The mark holds only while the document stays at least as long as when staging overflowed.
  if (markdown.length < (fullAt.get(userId) ?? 0)) fullAt.delete(userId);
  if (markdown.length >= MEMORY_FULL_CHARS || markdown.length >= (fullAt.get(userId) ?? Infinity)) return null;
  try {
    const candidates = soulMemoryCandidates(markdown);
    return candidates.length >= MEMORY_FULL_BULLETS ? null : candidates;
  } catch {
    return null;
  }
}

/** Estimated against the document staging appends to; it over-counts, so it errs toward keeping events. */
function wouldOverflow(userId: string, facts: readonly SoulFact[]): boolean {
  const base = peekMarkdownMemory(userId)?.markdown.length ?? 0;
  const added = facts.reduce((total, fact) => total + soulFactText(fact).length + 3, 0);
  if (base + added <= MAX_MARKDOWN_MEMORY_CHARS) return false;
  fullAt.set(userId, base);
  return true;
}

/**
 * Activity never removes an owner's bullet: a delete, or a correction whose
 * replacement cannot land (it saves as nothing, or as another existing bullet),
 * takes the target out with nothing in its place.
 */
function removesABullet(fact: SoulFact, markdown: string): boolean {
  if (typeof fact === "string" || !fact.mutation) return false;
  if (fact.mutation.kind === "delete") return true;
  const text = soulFactText(fact);
  if (!markdownMemoryFactText(text)) return true;
  return (findMarkdownMemoryBullet(markdown, text) ?? fact.mutation.target) !== fact.mutation.target;
}

/** True when the ledger was written. A batch read for one owner is never settled under another session. */
async function settle(params: ConsolidationParams, batch: LiveActivityBatch, outcome: "consolidated" | "failed"): Promise<boolean> {
  if (!isCurrentRun(params)) return false;
  return settleOnJournalFence(params, batch, outcome);
}

/** The journal's own fence (same owner, vault key and live attachment), without this run's epoch. */
async function settleOnJournalFence(params: ConsolidationParams, batch: LiveActivityBatch, outcome: "consolidated" | "failed"): Promise<boolean> {
  try {
    return await settleLiveActivityBatch({ userId: params.userId, vaultKey: params.vaultKey, batch, outcome });
  } catch {
    // The ledger stays where it was; the batch is offered again next cycle.
    return false;
  }
}

async function settleFailed(params: ConsolidationParams, batch: LiveActivityBatch): Promise<ConsolidationResult> {
  await settle(params, batch, "failed");
  return result(isCurrentRun(params) ? "failed" : "cancelled");
}

async function stageDigest(
  params: ConsolidationParams,
  batch: LiveActivityBatch,
  statements: readonly string[],
  memory: { markdown: string; candidates: readonly SoulMemoryCandidate[] },
  more: boolean,
): Promise<ConsolidationResult> {
  const { candidates } = memory;
  const assertCurrent = async () => {
    if (!isCurrentRun(params)) throw new DOMException("Activity owner changed.", "AbortError");
  };
  const prepared = await prepareNaturalLanguagePkm({
    userId: params.userId,
    message: statements.join("\n"),
    currentDomains: ["one_memory"],
    currentManifests: [],
    memoryProfile: "soul_markdown_v1",
    findReconciliationCandidates: () => candidates.map(candidate => ({
      domain: candidate.domain, entity_id: candidate.entity_id, entity_scope: candidate.entity_scope,
      message: candidate.message, active: true,
    })),
    vaultOwnerToken: params.vaultOwnerToken,
    source: "app_activity_digest",
    allowEmpty: true,
    beforeEffect: assertCurrent,
    isEffectCurrent: () => isCurrentRun(params),
  });
  if (!isCurrentRun(params)) return result("cancelled");
  if (isDegradedPreparation(prepared)) return settleFailed(params, batch);
  const facts = markdownFactsFromCards(prepared.cards, candidates);
  // Activity never removes an owner's bullet. A delete can pair with a create to
  // express a move, so the whole day fails closed rather than applying half of it.
  if (facts.some(fact => removesABullet(fact, memory.markdown))) return settleFailed(params, batch);
  if (!facts.length) {
    const settled = await settle(params, batch, "consolidated");
    return result(isCurrentRun(params) ? "nothing_durable" : "cancelled", 0, settled && more);
  }
  if (!isCurrentRun(params)) return result("cancelled");
  // Keep the events: they are offered again once the owner makes room.
  if (wouldOverflow(params.userId, facts)) return result("memory_full");
  const staged = await stageMarkdownMemoryFacts({
    userId: params.userId,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    facts,
    beforeEffect: assertCurrent,
    confirmation: {
      authorizationMode: "product_default_auto_save_policy",
      surface: "web",
      source: "app_activity_product_default_auto_save",
      autoSavePolicyVersion: DEFAULT_AGENT_PKM_AUTO_SAVE_POLICY.version,
      productDefaultEffectiveAt: AGENT_PKM_PRODUCT_DEFAULT_EFFECTIVE_AT,
    },
  });
  if (!staged.success) return settleFailed(params, batch);
  // The facts are staged: settle even if this run went stale since (a token
  // renewal, the app hiding), so the day is never offered and written twice.
  const settled = await settleOnJournalFence(params, batch, "consolidated");
  return result(staged.saved > 0 ? "saved" : "nothing_durable", staged.saved, settled && more);
}

async function runConsolidation(params: ConsolidationParams): Promise<ConsolidationResult> {
  const { userId, vaultKey, vaultOwnerToken } = params;
  if (isOffline()) return result("cancelled");
  const pending = await readUnconsolidatedLiveActivity({ userId, vaultKey, max: MAX_BATCH_EVENTS });
  if (!isCurrentRun(params)) return result("cancelled");
  if (!pending?.events.length) return result("skipped");
  // One local day per cycle; later days stay pending for the next cycle.
  const batch = firstLocalDay(pending);
  const more = pending.events.length > batch.events.length || pending.events.length >= MAX_BATCH_EVENTS;
  const statements = liveActivityStatements(batch.events);
  if (!statements.length) {
    // Only kinds the digest never describes: nothing for the model to judge.
    const settled = await settle(params, batch, "consolidated");
    return result(isCurrentRun(params) ? "host_skipped" : "cancelled", 0, settled && more);
  }
  // Read from the server: after a Reset on another device this device's cached
  // memory.md is stale, and staging onto it would bring the old document back.
  const memory = await loadMarkdownMemory({ userId, vaultKey, vaultOwnerToken, forceRefresh: true }).catch(() => null);
  if (!isCurrentRun(params)) return result("cancelled");
  // Not a model decision: the batch keeps its attempt and waits for new activity.
  if (!memory) return result(isOffline() ? "cancelled" : "failed");
  // A local memory save still pending means this is the device's own copy, not
  // the server's: wait for it rather than write onto a possibly stale document.
  if (memory.syncStatus === "saving") return result("cancelled");
  if (memory.syncStatus === "retryable") return result("failed");
  const candidates = memoryCandidatesOrFull(userId, memory.markdown);
  if (!candidates) return result("memory_full");
  try {
    return await stageDigest(params, batch, statements, { markdown: memory.markdown, candidates }, more);
  } catch {
    if (isTransientFailure(params) || !isCurrentRun(params)) return result("cancelled");
    return settleFailed(params, batch);
  }
}

/** One leader per owner across tabs; without Web Locks this tab consolidates alone. */
async function withOwnerLeadership(userId: string, run: () => Promise<ConsolidationResult>): Promise<ConsolidationResult> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks?.request) return run();
  return locks.request(`one-activity-consolidate:${userId}`, { ifAvailable: true }, async (lock) =>
    lock ? run() : result("busy"));
}

export async function consolidateLiveActivity(params: ConsolidationParams): Promise<ConsolidationResult> {
  if (!params.userId) return result("skipped");
  if (!isCurrentRun(params)) return result("cancelled");
  if (inFlight.has(params.userId)) return result("busy");
  inFlight.add(params.userId);
  try {
    return await withOwnerLeadership(params.userId, () => runConsolidation(params));
  } catch {
    return result(isCurrentRun(params) ? "failed" : "cancelled");
  } finally {
    inFlight.delete(params.userId);
  }
}
