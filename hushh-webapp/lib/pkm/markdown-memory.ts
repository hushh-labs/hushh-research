"use client";

import type { AgentPkmContext, AgentPkmPreviewCard } from "@/lib/agent/agent-pkm-memory";
import type { PkmReconciliationCandidate } from "@/lib/agent/agent-pkm-context-store";
import { pkmPlanIdForIdempotencyScope, type PkmWriteAuthorization } from "@/lib/personal-knowledge-model/mutation-plan";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { subscribeToPkmDomainChanges } from "@/lib/pkm/pkm-domain-change-events";
import { SECRET_PLACEHOLDER } from "@/lib/pkm/secret-patterns";
import { maskSecretSpans, omitCredentialsFromMemory } from "@/lib/pkm/secret-span-guard";
import { emptySoulDocument, insertSoulFacts, isSoulFact, normalizeSoulDocument, soulFactText, type SoulFact, type SoulSection } from "@/lib/pkm/soul-document";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { SecureResourceCacheService } from "@/lib/services/secure-resource-cache-service";
import { SecureDurableResourceService } from "@/lib/services/secure-durable-resource-service";
import { assertLightweightReceiptFacts, assertReceiptMemoryBudget } from "@/lib/mail/receipt-lightweight-memory";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
} from "@/lib/vault/session-epoch";

import { readLabelledSoulFacts } from "@/lib/pkm/soul-labelled-facts";
import type { PwmClaim } from "@/lib/services/world-model-decision-service";

export const MARKDOWN_MEMORY_DOMAIN = "one_memory";
export const MARKDOWN_MEMORY_SCHEMA = "one.memory.md.v1";
export const MAX_MARKDOWN_MEMORY_CHARS = 18_000;

type CachedMarkdownMemory = {
  userId: string;
  vaultEpoch: number;
  markdown: string;
  updatedAt: string | null;
  dataVersion?: number;
  persisted: boolean;
  syncStatus?: "synced" | "saving" | "retryable";
  /** Private control metadata; never part of Soul.md or model context. */
  kycIntakeCompletedAt?: string | null;
  /** Ownership of generated bullets, kept outside the document and prompts. */
  sourceSummaries?: SourceSummaries;
  /** Owner deletions must not resurrect an older structured identity value. */
  deletedFactLabels?: string[];
  /** Owner decisions on research statements; private, never model context. */
  pwmClaims?: PwmClaims;
};

type PwmClaims = Record<string, PwmClaim>;
const PWM_DECISIONS = new Set(["accepted", "edited", "rejected", "removed"]);
// Keep every No from a full 269-point draft, plus room for later refreshes.
const MAX_DECLINED_PWM_CLAIMS = 512;

function readPwmClaims(value: unknown): PwmClaims {
  return Object.fromEntries(Object.entries(record(value)).filter(([key, raw]) => {
    const claim = record(raw);
    return /^[a-f0-9]{64}$/.test(key) && claim.key === key && PWM_DECISIONS.has(String(claim.decision)) &&
      typeof claim.text === "string" && Boolean(claim.text) && typeof claim.topic === "string" &&
      typeof claim.decided_at === "string" && Number.isFinite(Date.parse(claim.decided_at)) && claim.basis === "owner_declaration";
  })) as PwmClaims;
}

function samePwmClaim(a: PwmClaim | undefined, b: PwmClaim | undefined): boolean {
  return a === b || (!!a && !!b && a.decision === b.decision && a.text === b.text && a.decided_at === b.decided_at);
}

/** Saved decisions are kept; only the newest declined ones are remembered. */
function boundPwmClaims(claims: PwmClaims): PwmClaims {
  const declined = Object.values(claims).filter(claim => claim.decision === "rejected" || claim.decision === "removed")
    .sort((a, b) => Date.parse(b.decided_at) - Date.parse(a.decided_at));
  const dropped = new Set(declined.slice(MAX_DECLINED_PWM_CLAIMS).map(claim => claim.key));
  return Object.fromEntries(Object.entries(claims).filter(([key]) => !dropped.has(key)));
}

type SourceSummaries = Record<string, { observedAt: string; facts: string[] }>;
type ReceiptSnapshotFence = { resourceKey: string; revision: number };
class ReceiptWriteInvalidatedError extends Error {}
type MemoryCheckpoint = { version: number; userId: string; facts: SoulFact[]; confirmation: PkmWriteAuthorization; completeKycIntake?: boolean; replaceSource?: ReplaceSource; stagingOrder?: number; receiptGeneration?: number; receiptSnapshotFence?: ReceiptSnapshotFence };
type ReplaceSource = { key: string; observedAt: string };
function isReceiptSnapshotFence(value: unknown): value is ReceiptSnapshotFence {
  const v = record(value);
  return Object.keys(v).length === 2 && typeof v.resourceKey === "string" && /^mail_receipts\.v1:[a-f0-9]{64}$/.test(v.resourceKey) && Number.isSafeInteger(v.revision) && Number(v.revision) > 0;
}
async function assertReceiptWriteFence(params: { userId: string; receiptGeneration?: number; receiptSnapshotFence?: ReceiptSnapshotFence }) {
  if (params.receiptGeneration === undefined) return;
  const current = await SecureDurableResourceService.version(params.userId, params.receiptSnapshotFence?.resourceKey ?? "mail_receipt_memory.v1");
  if (current.generation !== params.receiptGeneration || (params.receiptSnapshotFence && current.revision !== params.receiptSnapshotFence.revision))
    throw new ReceiptWriteInvalidatedError("Receipt memory was reset or its saved snapshot changed");
}

function isReplaceSource(value: unknown): value is ReplaceSource {
  const entry = record(value);
  return typeof entry.key === "string" && /^gmail_receipt_radar:[a-f0-9]{64}$/.test(entry.key) &&
    typeof entry.observedAt === "string" && Number.isFinite(Date.parse(entry.observedAt));
}

function readSourceSummaries(value: unknown): SourceSummaries {
  return Object.fromEntries(Object.entries(record(value)).filter(([key, raw]) => {
    const entry = record(raw);
    return isReplaceSource({ key, observedAt: entry.observedAt }) && Array.isArray(entry.facts) &&
      entry.facts.every(fact => typeof fact === "string");
  })) as SourceSummaries;
}

export type MarkdownMemoryAppendResult = {
  success: boolean;
  saved: number;
  markdown: string | null;
  message?: string;
};

const cache = new Map<string, CachedMarkdownMemory>();
const listeners = new Map<string, Set<() => void>>();
let memoryGeneration = 0;
let lastStagingOrder = 0;

type AppendParams = Parameters<typeof appendMarkdownMemoryFacts>[0];
type SyncJob = AppendParams & { recoveryKey?: string; checkpoint?: Promise<void>; committed?: boolean; needsReceiptLookup?: boolean };
const RECOVERY_PREFIX = "one_memory_pending:v1:";
const recoveryLoads = new Map<string, Promise<void>>();
type SyncQueue = {
  epoch: number;
  jobs: SyncJob[];
  running: boolean;
  retries: number;
  timer?: ReturnType<typeof setTimeout>;
};
const syncQueues = new Map<string, SyncQueue>();
const loads = new Map<string, Promise<CachedMarkdownMemory | null>>();
type MemorySession = { userId: string; vaultKey: string; vaultOwnerToken: string };
const observers = new Map<string, { epoch: number; params: MemorySession; pending: boolean; updatedAt: string | null; dataVersion: number | null; unsubscribe: () => void }>();

function observeMemoryChanges(params: MemorySession): void {
  const epoch = snapshotVaultSessionEpoch();
  const prior = observers.get(params.userId);
  if (prior?.epoch === epoch) { prior.params = params; return; }
  prior?.unsubscribe();
  const observer = { epoch, params, pending: false, updatedAt: null as string | null, dataVersion: null as number | null, unsubscribe: () => {} };
  observer.unsubscribe = subscribeToPkmDomainChanges(detail => {
    if (detail.userId !== params.userId || detail.domain !== MARKDOWN_MEMORY_DOMAIN || !isVaultSessionEpochCurrent(epoch)) return;
    observer.pending = true; observer.updatedAt = detail.updatedAt; observer.dataVersion = detail.dataVersion;
    reconcileMemoryChanges(params.userId);
  });
  observers.set(params.userId, observer);
}

/** Reconcile mutation doorbells outside chat; local writers and editor drafts win. */
function reconcileMemoryChanges(userId: string): void {
  const observer = observers.get(userId);
  const queue = syncQueues.get(userId);
  if (!observer?.pending || queue?.running || queue?.jobs.length || !isVaultSessionEpochCurrent(observer.epoch)) return;
  observer.pending = false;
  const current = peekMarkdownMemory(userId);
  if ((observer.updatedAt && current?.updatedAt === observer.updatedAt) ||
    (observer.dataVersion !== null && current?.dataVersion !== undefined && observer.dataVersion <= current.dataVersion)) return;
  void loadMarkdownMemory({ ...observer.params, forceRefresh: true }).catch(() => {
    // Keep the current document and retry on the next mutation or explicit reload.
    observer.pending = true;
  });
}

/** Notifications never carry plaintext; consumers read the same RAM snapshot. */
export function subscribeMarkdownMemory(userId: string, listener: () => void): () => void {
  const entries = listeners.get(userId) ?? new Set<() => void>();
  entries.add(listener); listeners.set(userId, entries);
  return () => { entries.delete(listener); if (!entries.size) listeners.delete(userId); };
}

function notifyMemory(userId: string): void { listeners.get(userId)?.forEach(listener => listener()); }

function syncStatus(userId: string): "synced" | "saving" | "retryable" {
  const queue = syncQueues.get(userId);
  return !queue?.jobs.length ? "synced" : queue.running || queue.timer ? "saving" : "retryable";
}

function publishSyncStatus(userId: string): void {
  const entry = peekMarkdownMemory(userId);
  if (entry) cache.set(userId, { ...entry, syncStatus: syncStatus(userId) });
  notifyMemory(userId);
  reconcileMemoryChanges(userId);
}

export function snapshotMarkdownMemoryGeneration(): number {
  return memoryGeneration;
}

export function isMarkdownMemoryGenerationCurrent(generation: number): boolean {
  return generation === memoryGeneration;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readStoredDocument(data: unknown): { markdown: string; updatedAt: string | null; kycIntakeCompletedAt: string | null; sourceSummaries: SourceSummaries; deletedFactLabels: string[]; pwmClaims: PwmClaims } | null {
  const root = record(data);
  if (typeof root.markdown !== "string") {
    if (Object.keys(root).length) throw new Error("memory.md document is invalid.");
    return null;
  }
  const markdown = normalizeSoulDocument(omitCredentialsFromMemory(root.markdown));
  return {
    markdown,
    updatedAt: typeof root.updated_at === "string" ? root.updated_at : null,
    kycIntakeCompletedAt: typeof root._kyc_intake_completed_at === "string" ? root._kyc_intake_completed_at : null,
    sourceSummaries: readSourceSummaries(root._source_summaries),
    deletedFactLabels: Array.isArray(root._deleted_fact_labels) ? root._deleted_fact_labels.filter((label): label is string => typeof label === "string") : [],
    pwmClaims: readPwmClaims(root._pwm_claims),
  };
}

function normalizeFact(value: SoulFact): string {
  return omitCredentialsFromMemory(soulFactText(value))
    .replace(SECRET_PLACEHOLDER.tokens(), "[protected value recorded separately]")
    .replace(/^\s*[-*]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function factKey(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** The bullet text a fact is stored as, or "" when it cannot be saved. */
export function markdownMemoryFactText(value: string): string {
  const fact = normalizeFact(value);
  return fact === "[credential omitted]" || !factKey(fact) ? "" : fact;
}

/** The exact bullet the store treats as this fact, using its own dedupe identity. */
export function findMarkdownMemoryBullet(markdown: string, text: string): string | null {
  const wanted = factKey(normalizeFact(text));
  if (!wanted) return null;
  const bullets = scanSoulBullets(markdown);
  return bullets.find(bullet => bullet.target === `- ${text}`)?.target ??
    bullets.find(bullet => factKey(normalizeFact(bullet.target)) === wanted)?.target ?? null;
}

function storedFactKeys(markdown: string): Set<string> {
  const keys = new Set<string>();
  let fence: { marker: string; size: number } | null = null;
  for (const line of markdown.split("\n")) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      const marker = delimiter[1]![0]!;
      if (!fence) fence = { marker, size: delimiter[1]!.length };
      else if (marker === fence.marker && delimiter[1]!.length >= fence.size && !delimiter[2]!.trim()) fence = null;
    } else if (!fence && /^\s*[-*]\s+/.test(line)) {
      const key = factKey(normalizeFact(line));
      if (key) keys.add(key);
    }
  }
  return keys;
}

function appendFactsToMarkdown(markdown: string, facts: readonly SoulFact[]): {
  markdown: string;
  saved: number;
} {
  let base = normalizeSoulDocument(markdown).trim() || emptySoulDocument().trim();
  let mutations = 0;
  for (const fact of facts) {
    if (typeof fact === "string" || !fact.mutation) continue;
    if (!isSoulFact(fact)) throw new Error("Invalid memory mutation.");
    // An exact target needs no reconciliation cap; only offered candidates are bounded.
    const offered = scanSoulBullets(base).filter(candidate => candidate.target === fact.mutation!.target);
    if (offered.length !== 1) throw new Error("Memory changed during preparation. Reassess before updating it.");
    const lines = base.split("\n");
    lines.splice(offered[0]!.lineIndex, 1);
    base = lines.join("\n");
    mutations += 1;
  }
  const keys = storedFactKeys(base);
  const additions = new Map<SoulSection, string[]>();
  let saved = mutations;
  for (const raw of facts) {
    if (typeof raw !== "string" && raw.mutation?.kind === "delete") continue;
    const fact = normalizeFact(raw);
    const key = factKey(fact);
    if (!fact || !key || fact === "[credential omitted]" || keys.has(key)) continue;
    keys.add(key);
    const section = typeof raw === "string" ? "Facts" : raw.section;
    const sectionFacts = additions.get(section) ?? [];
    sectionFacts.push(fact); additions.set(section, sectionFacts); saved += 1;
  }
  if (saved === 0) return { markdown: `${base}\n`, saved: 0 };
  let next = `${base}\n`;
  for (const [section, sectionFacts] of additions) next = insertSoulFacts(next, section, sectionFacts);
  if (next.length > MAX_MARKDOWN_MEMORY_CHARS) {
    throw new Error("Memory is full. Review it before adding more information.");
  }
  return { markdown: next, saved };
}

/** Replace only unchanged generated bullets. Owner edits/deletions win. */
function applyMemoryFacts(markdown: string, summaries: SourceSummaries, facts: readonly SoulFact[], source?: ReplaceSource) {
  if (!source) return { ...appendFactsToMarkdown(markdown, facts), sourceSummaries: summaries, changed: false };
  if (!isReplaceSource(source)) throw new Error("Invalid receipt summary source.");
  const previous = summaries[source.key];
  if (previous && Date.parse(previous.observedAt) >= Date.parse(source.observedAt))
    return { markdown, saved: 0, sourceSummaries: summaries, changed: false };
  const remaining = new Set(previous?.facts ?? []);
  const lines = markdown.split("\n");
  let fence: { marker: string; size: number } | null = null;
  const retained = lines.filter(line => {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      const marker = delimiter[1]![0]!;
      if (!fence) fence = { marker, size: delimiter[1]!.length };
      else if (marker === fence.marker && delimiter[1]!.length >= fence.size && !delimiter[2]!.trim()) fence = null;
      return true;
    }
    if (fence || !/^\s*[-*]\s+/.test(line)) return true;
    const fact = normalizeFact(line);
    if (!remaining.has(fact)) return true;
    remaining.delete(fact);
    return false;
  });
  if (remaining.size) return { markdown, saved: 0, sourceSummaries: summaries, changed: false };
  const base = retained.join("\n");
  const existingKeys = storedFactKeys(base);
  const appended = appendFactsToMarkdown(base, facts);
  const owned = [...new Set(facts.map(normalizeFact).filter(fact => fact && !existingKeys.has(factKey(fact))))];
  return { ...appended, sourceSummaries: { ...summaries, [source.key]: { observedAt: source.observedAt, facts: owned } }, changed: true };
}

function applyPendingMemory(markdown: string, summaries: SourceSummaries, jobs: readonly SyncJob[]) {
  let current = { markdown, sourceSummaries: summaries };
  for (const job of jobs) current = applyMemoryFacts(current.markdown, current.sourceSummaries, job.facts, job.replaceSource);
  return current;
}

function cacheDocument(params: {
  userId: string;
  markdown: string;
  updatedAt: string | null;
  dataVersion?: number;
  persisted: boolean;
  syncStatus?: CachedMarkdownMemory["syncStatus"];
  kycIntakeCompletedAt?: string | null;
  sourceSummaries?: SourceSummaries;
  /** Owner deletions must not resurrect an older structured identity value. */
  deletedFactLabels?: string[];
  pwmClaims?: PwmClaims;
}): CachedMarkdownMemory {
  const entry = {
    ...params,
    deletedFactLabels: params.deletedFactLabels ?? cache.get(params.userId)?.deletedFactLabels ?? [],
    pwmClaims: params.pwmClaims ?? cache.get(params.userId)?.pwmClaims ?? {},
    vaultEpoch: snapshotVaultSessionEpoch(),
  };
  cache.set(params.userId, entry);
  notifyMemory(params.userId);
  return entry;
}

export function peekMarkdownMemory(userId: string): CachedMarkdownMemory | null {
  const entry = cache.get(userId);
  if (!entry || !isVaultSessionEpochCurrent(entry.vaultEpoch)) {
    cache.delete(userId);
    return null;
  }
  return entry;
}

export async function loadMarkdownMemory(params: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  forceRefresh?: boolean;
}): Promise<CachedMarkdownMemory | null> {
  observeMemoryChanges(params);
  const existing = peekMarkdownMemory(params.userId);
  const queue = syncQueues.get(params.userId);
  if (existing && (!params.forceRefresh || queue?.running || queue?.jobs.length)) return existing;
  const loadKey = `${params.userId}:${snapshotVaultSessionEpoch()}:${params.forceRefresh === true}`;
  const pending = loads.get(loadKey);
  if (pending) return pending;
  const loading = readMarkdownMemory(params).finally(() => { if (loads.get(loadKey) === loading) loads.delete(loadKey); });
  loads.set(loadKey, loading);
  return loading;
}

async function readMarkdownMemory(params: {
  userId: string; vaultKey: string; vaultOwnerToken: string; forceRefresh?: boolean;
}): Promise<CachedMarkdownMemory | null> {
  const epoch = snapshotVaultSessionEpoch();
  const generation = snapshotMarkdownMemoryGeneration();
  const beforeRead = peekMarkdownMemory(params.userId);
  const snapshot = await PkmDomainResourceService.getStaleFirst({
    userId: params.userId,
    domain: MARKDOWN_MEMORY_DOMAIN,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    forceRefresh: params.forceRefresh,
    backgroundRefresh: false,
  });
  if (
    !isVaultSessionEpochCurrent(epoch) ||
    !isMarkdownMemoryGenerationCurrent(generation)
  ) return null;
  const stored = snapshot ? readStoredDocument(snapshot.data) : null;
  if (snapshot && !stored) throw new Error("memory.md document is invalid.");
  // A local fact may have arrived while this cold/remote read was in flight.
  const pendingJobs = syncQueues.get(params.userId)?.jobs ?? [];
  const current = peekMarkdownMemory(params.userId);
  if (current !== beforeRead && !pendingJobs.length) return current;
  const pending = applyPendingMemory(stored?.markdown ?? emptySoulDocument(), stored?.sourceSummaries ?? {}, pendingJobs);
  return cacheDocument({
    userId: params.userId,
    markdown: pending.markdown,
    sourceSummaries: pending.sourceSummaries,
    deletedFactLabels: stored?.deletedFactLabels ?? [],
    pwmClaims: stored?.pwmClaims ?? {},
    updatedAt: stored?.updatedAt ?? null,
    dataVersion: snapshot?.key?.contentRevision ?? undefined,
    persisted: Boolean(stored),
    syncStatus: syncStatus(params.userId),
    kycIntakeCompletedAt: syncQueues.get(params.userId)?.jobs.some(job => job.completeKycIntake)
      ? current?.kycIntakeCompletedAt ?? new Date().toISOString() : stored?.kycIntakeCompletedAt ?? null,
  });
}

export type SoulMemoryCandidate = PkmReconciliationCandidate & { target: string; lineIndex: number };

/** Offered references are session-local; neither IDs nor paths enter Soul.md. */
export function soulMemoryCandidates(markdown: string): SoulMemoryCandidate[] {
  const candidates = scanSoulBullets(markdown);
  if (candidates.length > 256) throw new Error("Memory has too many items for automatic reconciliation.");
  return candidates;
}

function scanSoulBullets(markdown: string): SoulMemoryCandidate[] {
  const candidates: SoulMemoryCandidate[] = [];
  const lines = markdown.split("\n");
  let fence: { marker: string; size: number } | null = null;
  lines.forEach((line, index) => {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      const marker = delimiter[1]![0]!;
      if (!fence) fence = { marker, size: delimiter[1]!.length };
      else if (marker === fence.marker && delimiter[1]!.length >= fence.size && !delimiter[2]!.trim()) fence = null;
      return;
    }
    // A multiline/nested owner-authored item needs the editor, not a partial deletion.
    if (fence || !/^[-*] \S/.test(line) || /^\s+\S/.test(lines[index + 1] ?? "")) return;
    candidates.push({ domain: MARKDOWN_MEMORY_DOMAIN, entity_id: `soul_${index}`,
      entity_scope: "markdown", message: maskSecretSpans(line.slice(2)), active: true, target: line, lineIndex: index });
  });
  return candidates;
}

export function markdownFactsFromCards(cards: readonly AgentPkmPreviewCard[], candidates: readonly SoulMemoryCandidate[] = []): SoulFact[] {
  return cards
    .filter((card) => card.write_mode !== "do_not_save" && !card.preview_degraded && !card.preparation_requires_review && !card.drift_flags?.fallback_used)
    .filter(card => Boolean(card.source_text?.trim()) && (card.merge_mode || card.merge_decision?.merge_mode) !== "no_op")
    .map(card => {
      const intent = card.intent_class || card.intent_frame?.intent_class;
      // These are authored semantic enums, not keyword-based guesses.
      const mode = card.merge_mode || card.merge_decision?.merge_mode;
      const payload = record(card.candidate_payload);
      const section: SoulSection = ["Facts", "Preferences", "Commitments"].includes(String(payload.soul_section))
        ? payload.soul_section as SoulSection
        : intent === "preference" ? "Preferences" : intent === "plan_or_goal" ? "Commitments" : "Facts";
      const text = typeof payload.soul_text === "string" ? payload.soul_text
        : [...(card.context_quotes ?? []), card.source_text].join(": ");
      if (mode !== "correct_entity" && mode !== "delete_entity" && mode !== "extend_entity") return { text, section };
      const id = card.merge_decision?.target_entity_id ?? card.target_entity_id;
      const path = card.merge_decision?.target_entity_path;
      const target = candidates.find(candidate => candidate.entity_id === id &&
        path === `${candidate.entity_scope}.entities.${candidate.entity_id}` &&
        card.merge_decision?.target_domain === candidate.domain);
      if (!target) throw new Error("Memory mutation names an unoffered target.");
      if (mode !== "delete_entity" && (text.includes("[hidden secret]") || target.message !== target.target.slice(2)))
        throw new Error("A masked value cannot replace private memory.");
      return { text: mode === "delete_entity" ? "" : text, section,
        mutation: { kind: mode === "delete_entity" ? "delete" as const : "correct" as const, target: target.target } };
    });
}

/** Explicit deletions suppress older structured facts until the owner supplies them again. */
function deletedLabelsAfter(before: string, after: string, previous: readonly string[] = []): string[] {
  const beforeFacts = readLabelledSoulFacts(before);
  const afterFacts = readLabelledSoulFacts(after);
  return [...new Set([...previous, ...[...beforeFacts.keys()].filter(key => !afterFacts.has(key))])]
    .filter(key => !afterFacts.has(key));
}

export async function appendMarkdownMemoryFacts(params: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  facts: readonly SoulFact[];
  confirmation: PkmWriteAuthorization;
  beforeEffect?: () => Promise<void>;
  idempotencyScope?: string;
  /** An explicit KYC import completed; keep its control marker outside the file. */
  completeKycIntake?: boolean;
  /** Update one generated receipt summary, never accumulate old scan versions. */
  replaceSource?: ReplaceSource;
  receiptGeneration?: number;
  receiptSnapshotFence?: ReceiptSnapshotFence;
  /** Owner decision on a research statement, committed in the same write as its bullet. */
  pwmClaim?: PwmClaim;
  /** The decision this one replaces (null when none); a different stored one is a conflict. */
  pwmClaimPrevious?: PwmClaim | null;
}): Promise<MarkdownMemoryAppendResult> {
  if (params.replaceSource) assertLightweightReceiptFacts(params.facts);
  const facts = params.facts.map(fact => typeof fact === "string" ? normalizeFact(fact) : { ...fact, text: normalizeFact(fact) }).filter(fact => Boolean(soulFactText(fact)) || (typeof fact !== "string" && fact.mutation?.kind === "delete"));
  if (facts.length === 0 && !params.completeKycIntake && !params.replaceSource && !params.pwmClaim) {
    return { success: true, saved: 0, markdown: peekMarkdownMemory(params.userId)?.markdown ?? null };
  }
  const seed = peekMarkdownMemory(params.userId)?.markdown ?? emptySoulDocument();
  const seedSourceSummaries = peekMarkdownMemory(params.userId)?.sourceSummaries ?? {};
  const generation = snapshotMarkdownMemoryGeneration();
  const epoch = snapshotVaultSessionEpoch();
  const owner = snapshotValidatedAuthSessionOwner();
  const mayPublish = () => isVaultSessionEpochCurrent(epoch) && isMarkdownMemoryGenerationCurrent(generation) &&
    (!owner || isValidatedAuthSessionOwnerCurrent(owner));
  let writtenMarkdown: string | null = null;
  let saved = 0;
  let kycIntakeCompletedAt: string | null = null;
  let sourceSummaries: SourceSummaries = {};
  let deletedFactLabels = peekMarkdownMemory(params.userId)?.deletedFactLabels ?? [];
  let pwmClaims = peekMarkdownMemory(params.userId)?.pwmClaims ?? {};
  const result = await PkmWriteCoordinator.savePreparedDomain({
    userId: params.userId,
    domain: MARKDOWN_MEMORY_DOMAIN,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    confirmation: params.confirmation,
    beforeEffect: async () => { await params.beforeEffect?.(); await assertReceiptWriteFence(params); },
    idempotencyScope: params.idempotencyScope,
    mayPublish,
    build: (context) => {
      const stored = readStoredDocument(context.currentDomainData);
      const appended = applyMemoryFacts(stored?.markdown ?? seed, stored?.sourceSummaries ?? seedSourceSummaries, facts, params.replaceSource);
      if (params.replaceSource) assertReceiptMemoryBudget(appended.sourceSummaries);
      sourceSummaries = appended.sourceSummaries;
      deletedFactLabels = deletedLabelsAfter(stored?.markdown ?? seed, appended.markdown, stored?.deletedFactLabels ?? deletedFactLabels);
      const currentClaims = stored ? stored.pwmClaims : pwmClaims;
      // A decision made on a stale view (another tab, a quick second tap) must
      // not overwrite a newer one and leave an orphaned bullet behind.
      if (params.pwmClaim && !samePwmClaim(currentClaims[params.pwmClaim.key], params.pwmClaimPrevious ?? undefined))
        throw new Error("Memory changed during preparation. Reassess before updating it.");
      pwmClaims = params.pwmClaim ? boundPwmClaims({ ...currentClaims, [params.pwmClaim.key]: params.pwmClaim }) : currentClaims;
      writtenMarkdown = appended.markdown;
      saved = appended.saved;
      const updatedAt = new Date().toISOString();
      kycIntakeCompletedAt = stored?.kycIntakeCompletedAt ?? (params.completeKycIntake ? updatedAt : null);
      return {
        domainData: {
          ...record(context.currentDomainData),
          schema_version: MARKDOWN_MEMORY_SCHEMA,
          markdown: appended.markdown,
          _deleted_fact_labels: deletedFactLabels,
          updated_at: updatedAt,
          ...(kycIntakeCompletedAt ? { _kyc_intake_completed_at: kycIntakeCompletedAt } : {}),
          ...(Object.keys(sourceSummaries).length ? { _source_summaries: sourceSummaries } : {}),
          ...(Object.keys(pwmClaims).length ? { _pwm_claims: pwmClaims } : {}),
        },
        summary: {
          schema_version: MARKDOWN_MEMORY_SCHEMA,
          storage_mode: "encrypted_markdown",
          character_count: appended.markdown.length,
          updated_at: updatedAt,
        },
      };
    },
  });
  if (!result.success || !writtenMarkdown) {
    return { success: false, saved: 0, markdown: null, message: result.message };
  }
  if (mayPublish() && !result.idempotentReplay) {
    const pending = applyPendingMemory(writtenMarkdown, sourceSummaries,
      (syncQueues.get(params.userId)?.jobs ?? []).filter(job => !params.idempotencyScope || job.idempotencyScope !== params.idempotencyScope));
    cacheDocument({
      userId: params.userId,
      markdown: pending.markdown,
      sourceSummaries: pending.sourceSummaries,
      deletedFactLabels: deletedLabelsAfter(writtenMarkdown, pending.markdown, deletedFactLabels),
      pwmClaims,
      updatedAt: result.updatedAt ?? new Date().toISOString(),
      dataVersion: result.dataVersion,
      persisted: true,
      syncStatus: syncStatus(params.userId),
      kycIntakeCompletedAt: syncQueues.get(params.userId)?.jobs.some(job => job.completeKycIntake)
        ? peekMarkdownMemory(params.userId)?.kycIntakeCompletedAt ?? kycIntakeCompletedAt : kycIntakeCompletedAt,
    });
  }
  if (result.idempotentReplay) requestMemoryReconciliation(params.userId);
  return { success: true, saved, markdown: writtenMarkdown };
}

function requestMemoryReconciliation(userId: string): void {
  const observer = observers.get(userId);
  if (observer) { observer.pending = true; observer.updatedAt = null; observer.dataVersion = null; }
}

async function checkpointCommitted(params: MemorySession, recoveryKey: string): Promise<boolean> {
  const [receipt] = await PersonalKnowledgeModelService.lookupMutationCommits({
    userId: params.userId, vaultOwnerToken: params.vaultOwnerToken,
    commits: [{ domain: MARKDOWN_MEMORY_DOMAIN, planId: pkmPlanIdForIdempotencyScope(recoveryKey) }],
  });
  if (!receipt) throw new Error("Memory commit receipt unavailable.");
  return receipt.exists;
}

async function flushMarkdownMemory(userId: string, queue: SyncQueue): Promise<void> {
  if (queue.running || !queue.jobs.length || syncQueues.get(userId) !== queue || !isVaultSessionEpochCurrent(queue.epoch)) return;
  queue.running = true; publishSyncStatus(userId);
  try {
    while (queue.jobs.length && syncQueues.get(userId) === queue && isVaultSessionEpochCurrent(queue.epoch)) {
      const job = queue.jobs[0]!;
      let result: MarkdownMemoryAppendResult;
      try {
        await assertReceiptWriteFence(job);
        await job.checkpoint;
        if (job.needsReceiptLookup && !job.committed && job.recoveryKey) {
          await job.beforeEffect?.();
          job.committed = await checkpointCommitted(job, job.recoveryKey);
          await job.beforeEffect?.();
          if (job.committed) requestMemoryReconciliation(userId);
        }
        result = job.committed ? { success: true, saved: 0, markdown: null } : await appendMarkdownMemoryFacts(job);
        if (!result.success) await assertReceiptWriteFence(job);
        if (result.success) {
          job.committed = true;
          if (job.recoveryKey) await SecureResourceCacheService.invalidateResourceRequired(userId, job.recoveryKey);
        }
      }
      catch (error) {
        if (error instanceof ReceiptWriteInvalidatedError && syncQueues.get(userId) === queue && isVaultSessionEpochCurrent(queue.epoch)) {
          // A superseded snapshot cannot become current through a retry. Retire
          // only this job, then restore cloud facts plus the remaining overlay.
          queue.jobs.shift(); queue.retries = 0;
          if (job.recoveryKey) await SecureResourceCacheService.invalidateResource(job.userId, job.recoveryKey).catch(() => undefined);
          requestMemoryReconciliation(userId);
          await readMarkdownMemory({ ...job, forceRefresh: true }).catch(() => {
            const current = peekMarkdownMemory(userId);
            const source = job.replaceSource;
            if (current && source && current.sourceSummaries?.[source.key]?.observedAt === source.observedAt) {
              const cleared = applyMemoryFacts(current.markdown, current.sourceSummaries, [], { ...source, observedAt: new Date(Date.parse(source.observedAt) + 1).toISOString() });
              const pending = applyPendingMemory(cleared.markdown, cleared.sourceSummaries, queue.jobs);
              cacheDocument({ ...current, ...pending, syncStatus: syncStatus(userId) });
            }
          });
          publishSyncStatus(userId);
          continue;
        }
        result = { success: false, saved: 0, markdown: null };
      }
      if (syncQueues.get(userId) !== queue || !isVaultSessionEpochCurrent(queue.epoch)) return;
      if (!result.success) {
        job.needsReceiptLookup = true;
        queue.retries += 1;
        if (queue.retries <= 3) {
          queue.timer = setTimeout(() => { queue.timer = undefined; void flushMarkdownMemory(userId, queue); }, 1000 * 5 ** (queue.retries - 1));
        }
        return;
      }
      queue.jobs.shift(); queue.retries = 0;
      publishSyncStatus(userId);
    }
  } finally {
    queue.running = false;
    if (syncQueues.get(userId) === queue) publishSyncStatus(userId);
  }
}

/** Publish accepted facts immediately; encryption and CAS commits run in parallel with chat. */
export async function stageMarkdownMemoryFacts(params: Omit<AppendParams, "pwmClaim"> & { recoveryKey?: string; stagingOrder?: number }): Promise<MarkdownMemoryAppendResult> {
  await params.beforeEffect?.();
  const receiptGeneration = params.replaceSource ? params.receiptGeneration ?? (await SecureDurableResourceService.version(params.userId, "mail_receipt_memory.v1")).generation : undefined;
  if (receiptGeneration !== undefined && (await SecureDurableResourceService.version(params.userId, "mail_receipt_memory.v1")).generation !== receiptGeneration)
    throw new Error("Receipt memory was reset. Ask again.");
  if (params.replaceSource) assertLightweightReceiptFacts(params.facts);
  const existing = peekMarkdownMemory(params.userId);
  if (!existing) return { success: false, saved: 0, markdown: null, message: "Open your memory before adding details." };
  // Retrying discovery must not delete an uncommitted live job's checkpoint.
  if (params.recoveryKey && syncQueues.get(params.userId)?.jobs.some(job => job.recoveryKey === params.recoveryKey))
    return { success: true, saved: 0, markdown: existing.markdown };
  const next = applyMemoryFacts(existing.markdown, existing.sourceSummaries ?? {}, params.facts, params.replaceSource);
  if (params.replaceSource) assertReceiptMemoryBudget(next.sourceSummaries);
  if (!next.saved && !next.changed && (!params.completeKycIntake || existing.kycIntakeCompletedAt)) {
    if (params.recoveryKey) await SecureResourceCacheService.invalidateResource(params.userId, params.recoveryKey);
    return { success: true, saved: 0, markdown: existing.markdown };
  }
  const epoch = snapshotVaultSessionEpoch();
  const owner = snapshotValidatedAuthSessionOwner();
  const generation = snapshotMarkdownMemoryGeneration();
  const checkCurrent = () => {
    if (!isVaultSessionEpochCurrent(epoch) || !isMarkdownMemoryGenerationCurrent(generation) ||
      !owner || owner.userId !== params.userId || !isValidatedAuthSessionOwnerCurrent(owner))
      throw new DOMException("Memory sync session changed", "AbortError");
  };
  const assertCurrent = async () => {
    checkCurrent();
    await assertReceiptWriteFence({ ...params, receiptGeneration });
    checkCurrent();
  };
  checkCurrent();
  const queue = syncQueues.get(params.userId) ?? { epoch, jobs: [], running: false, retries: 0 };
  const previousKeys = storedFactKeys(existing.markdown);
  const newFacts = params.facts.map(fact => typeof fact === "string" ? normalizeFact(fact) : { ...fact, text: normalizeFact(fact) })
    .filter(fact => params.replaceSource || (typeof fact !== "string" && fact.mutation) || !previousKeys.has(factKey(soulFactText(fact))));
  // The queue owns its lifetime; a finished capture's AbortSignal must not cancel saving.
  const recoveryKey = params.recoveryKey ?? `${RECOVERY_PREFIX}${crypto.randomUUID()}`;
  const stagingOrder = params.stagingOrder ?? Math.max(Date.now(), lastStagingOrder + 1);
  lastStagingOrder = Math.max(lastStagingOrder, stagingOrder);
  const checkpoint = SecureResourceCacheService.writeRequired({ userId: params.userId,
    resourceKey: recoveryKey, vaultKey: params.vaultKey, ttlMs: 7 * 24 * 60 * 60 * 1000,
    ...(receiptGeneration === undefined ? {} : { ownerGeneration: receiptGeneration }),
    value: { version: 1, userId: params.userId, facts: newFacts, confirmation: params.confirmation, stagingOrder,
      ...(params.completeKycIntake ? { completeKycIntake: true } : {}),
      ...(params.replaceSource ? { replaceSource: params.replaceSource, receiptGeneration, ...(params.receiptSnapshotFence ? { receiptSnapshotFence: params.receiptSnapshotFence } : {}) } : {}) },
  }).catch(() => undefined); // Cloud saving still works when device storage is unavailable.
  queue.jobs.push({ ...params, receiptGeneration, facts: newFacts, beforeEffect: assertCurrent, recoveryKey, checkpoint,
    idempotencyScope: recoveryKey });
  syncQueues.set(params.userId, queue);
  cacheDocument({ ...existing, markdown: next.markdown, updatedAt: new Date().toISOString(), syncStatus: "saving",
    sourceSummaries: next.sourceSummaries,
    deletedFactLabels: deletedLabelsAfter(existing.markdown, next.markdown, existing.deletedFactLabels),
    kycIntakeCompletedAt: existing.kycIntakeCompletedAt ?? (params.completeKycIntake ? new Date().toISOString() : null) });
  void flushMarkdownMemory(params.userId, queue);
  return { success: true, saved: next.saved, markdown: next.markdown };
}

/** Decrypt pending device checkpoints once at unlock, then replay with fresh authority. */
export function recoverMarkdownMemorySync(params: {
  userId: string; vaultKey: string; vaultOwnerToken: string;
}): Promise<void> {
  const epoch = snapshotVaultSessionEpoch();
  const owner = snapshotValidatedAuthSessionOwner();
  const key = `${params.userId}:${epoch}`;
  const existing = recoveryLoads.get(key);
  if (existing) return existing;
  const assertCurrent = async () => {
    if (!isVaultSessionEpochCurrent(epoch) || !owner || owner.userId !== params.userId || !isValidatedAuthSessionOwnerCurrent(owner))
      throw new DOMException("Memory recovery session changed", "AbortError");
  };
  const recovery = (async () => {
    let readFailed = false;
    try {
      await assertCurrent();
      const recovered: { recoveryKey: string; pending: MemoryCheckpoint }[] = [];
      for (const recoveryKey of await SecureResourceCacheService.listResourceKeys(params.userId, RECOVERY_PREFIX)) {
        await assertCurrent();
        if (syncQueues.get(params.userId)?.jobs.some(job => job.recoveryKey === recoveryKey)) continue;
        const pending = await SecureResourceCacheService.readRequired<MemoryCheckpoint>({
          ...params, resourceKey: recoveryKey,
        }).catch(() => { readFailed = true; return null; });
        await assertCurrent();
        if (!pending || pending.version !== 1 || pending.userId !== params.userId || !Array.isArray(pending.facts) ||
          pending.facts.some(fact => !isSoulFact(fact)) || !pending.confirmation ||
          (pending.stagingOrder !== undefined && (!Number.isSafeInteger(pending.stagingOrder) || pending.stagingOrder < 0)) ||
          (pending.completeKycIntake !== undefined && typeof pending.completeKycIntake !== "boolean") ||
          (pending.replaceSource !== undefined && !isReplaceSource(pending.replaceSource)) ||
          (pending.receiptSnapshotFence !== undefined && !isReceiptSnapshotFence(pending.receiptSnapshotFence))) continue;
        if (pending.replaceSource) {
          if (!pending.receiptSnapshotFence || pending.receiptGeneration === undefined || pending.receiptGeneration !== (await SecureDurableResourceService.version(params.userId, "mail_receipt_memory.v1")).generation) continue;
          try { assertLightweightReceiptFacts(pending.facts); } catch { continue; }
          try { await assertReceiptWriteFence({ ...pending, userId: params.userId }); } catch { continue; }
        }
        recovered.push({ recoveryKey, pending });
      }
      // A missing earlier envelope could be a prerequisite for a later correction.
      if (readFailed) { recoveryLoads.delete(key); return; }
      recovered.sort((a, b) => (a.pending.stagingOrder ?? 0) - (b.pending.stagingOrder ?? 0));
      for (const { recoveryKey, pending } of recovered) {
        await assertCurrent();
        const committed = await checkpointCommitted(params, recoveryKey);
        await assertCurrent();
        if (committed) {
          // A cached encrypted snapshot may predate this committed import.
          // Reconcile before retiring its recovery proof; never replay its facts.
          requestMemoryReconciliation(params.userId);
          const queue = syncQueues.get(params.userId);
          if (queue?.running || queue?.jobs.length) { readFailed = true; continue; }
          const refreshed = await loadMarkdownMemory({ ...params, forceRefresh: true });
          await assertCurrent();
          if (!refreshed) { readFailed = true; continue; }
          await SecureResourceCacheService.invalidateResourceRequired(params.userId, recoveryKey);
          continue;
        }
        await stageMarkdownMemoryFacts({ ...params, facts: pending.facts, confirmation: pending.confirmation,
          completeKycIntake: pending.completeKycIntake, replaceSource: pending.replaceSource, receiptGeneration: pending.receiptGeneration, receiptSnapshotFence: pending.receiptSnapshotFence, stagingOrder: pending.stagingOrder, recoveryKey, beforeEffect: assertCurrent });
      }
      if (readFailed || syncQueues.get(params.userId)?.running) recoveryLoads.delete(key);
    } catch { recoveryLoads.delete(key); /* Retry discovery after a transient storage failure. */ }
  })();
  recoveryLoads.set(key, recovery);
  return recovery;
}

/** Retry retained RAM-only work using the currently authorized unlocked session. */
export async function retryMarkdownMemorySync(params: {
  userId: string; vaultKey: string; vaultOwnerToken: string; beforeEffect: () => Promise<void>;
}): Promise<void> {
  await params.beforeEffect();
  await recoverMarkdownMemorySync(params);
  const queue = syncQueues.get(params.userId);
  if (!queue || !isVaultSessionEpochCurrent(queue.epoch)) return;
  queue.jobs = queue.jobs.map(job => ({ ...job, vaultKey: params.vaultKey, vaultOwnerToken: params.vaultOwnerToken,
    beforeEffect: params.beforeEffect }));
  if (queue.timer) clearTimeout(queue.timer);
  queue.timer = undefined; queue.retries = 0;
  void flushMarkdownMemory(params.userId, queue);
}

/** Called only after the vault verified a renewal for the same owner and key. */
export function renewMarkdownMemorySession(params: {
  userId: string; previousEpoch: number; vaultKey: string; vaultOwnerToken: string; beforeEffect: () => Promise<void>;
}): void {
  const entry = cache.get(params.userId);
  if (!entry || entry.vaultEpoch !== params.previousEpoch) return;
  cache.set(params.userId, { ...entry, vaultEpoch: snapshotVaultSessionEpoch() });
  observeMemoryChanges(params);
  const queue = syncQueues.get(params.userId);
  if (queue) {
    // Withdraw old work. Its late completion cannot publish into the new queue.
    if (queue.timer) clearTimeout(queue.timer);
    const jobs = queue.jobs.map(job => ({ ...job, vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken, beforeEffect: params.beforeEffect, needsReceiptLookup: true }));
    queue.jobs.length = 0;
    const renewed = { epoch: snapshotVaultSessionEpoch(), jobs, running: false, retries: 0 };
    syncQueues.set(params.userId, renewed);
    void flushMarkdownMemory(params.userId, renewed);
  }
  notifyMemory(params.userId);
}

/** Replace only the document the owner actually edited, including after CAS retries. */
export async function replaceMarkdownMemoryDocument(params: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  markdown: string;
  expectedMarkdown: string;
  expectedPersisted: boolean;
  beforeEffect: () => Promise<void>;
}): Promise<{ success: boolean; conflict?: boolean; markdown?: string; message?: string }> {
  const local = peekMarkdownMemory(params.userId);
  if (local && local.markdown !== params.expectedMarkdown) return { success: false, conflict: true, message: "memory.md changed while you were editing. Your draft is still here." };
  const previousQueue = syncQueues.get(params.userId);
  if (previousQueue?.running || previousQueue?.jobs.length) return { success: false, message: "Your latest memories haven't finished syncing. Your draft is still here; retry sync before saving changes." };
  const cleaned = omitCredentialsFromMemory(params.markdown).trim();
  const markdown = cleaned ? `${cleaned}\n` : "";
  if (markdown.length > MAX_MARKDOWN_MEMORY_CHARS) {
    return { success: false, message: "memory.md is too long. Shorten it before saving." };
  }
  const epoch = snapshotVaultSessionEpoch();
  const seed = peekMarkdownMemory(params.userId)?.markdown ?? "";
  // Reserve even an empty queue: a new automatic fact must wait behind this edit.
  const queue: SyncQueue = previousQueue ?? { epoch, jobs: [], running: false, retries: 0 };
  if (queue.timer) clearTimeout(queue.timer);
  queue.timer = undefined; queue.running = true;
  syncQueues.set(params.userId, queue);
  const releaseQueue = () => {
    if (syncQueues.get(params.userId) !== queue) return;
    queue.running = false;
    publishSyncStatus(params.userId);
    if (queue.retries <= 3) void flushMarkdownMemory(params.userId, queue);
  };
  let conflict = false;
  let kycIntakeCompletedAt = local?.kycIntakeCompletedAt ?? null;
  let sourceSummaries = local?.sourceSummaries ?? {};
  let deletedFactLabels = local?.deletedFactLabels ?? [];
  let pwmClaims = local?.pwmClaims ?? {};
  const result = await PkmWriteCoordinator.savePreparedDomain({
    userId: params.userId,
    domain: MARKDOWN_MEMORY_DOMAIN,
    vaultKey: params.vaultKey,
    vaultOwnerToken: params.vaultOwnerToken,
    confirmation: { confirmedByUser: true, surface: "web", source: "pkm_memory_edited_button" },
    beforeEffect: params.beforeEffect,
    mayPublish: () => isVaultSessionEpochCurrent(epoch),
    build: (context) => {
      const stored = readStoredDocument(context.currentDomainData);
      kycIntakeCompletedAt = stored?.kycIntakeCompletedAt ?? kycIntakeCompletedAt;
      sourceSummaries = stored?.sourceSummaries ?? sourceSummaries;
      deletedFactLabels = stored?.deletedFactLabels ?? deletedFactLabels;
      pwmClaims = stored?.pwmClaims ?? pwmClaims;
      const currentMarkdown = stored?.markdown ?? seed;
      if ((params.expectedPersisted && !stored) || currentMarkdown !== params.expectedMarkdown ||
        (peekMarkdownMemory(params.userId)?.markdown ?? params.expectedMarkdown) !== params.expectedMarkdown) {
        conflict = true;
        throw new Error("Markdown memory changed during editing.");
      }
      deletedFactLabels = deletedLabelsAfter(currentMarkdown, markdown, deletedFactLabels);
      const updatedAt = new Date().toISOString();
      return {
        domainData: { ...context.currentDomainData, schema_version: MARKDOWN_MEMORY_SCHEMA, markdown,
          _deleted_fact_labels: deletedFactLabels, updated_at: updatedAt,
          ...(Object.keys(pwmClaims).length ? { _pwm_claims: pwmClaims } : {}) },
        summary: { schema_version: MARKDOWN_MEMORY_SCHEMA, storage_mode: "encrypted_markdown", character_count: markdown.length, updated_at: updatedAt },
      };
    },
  }).catch(error => { releaseQueue(); throw error; });
  if (conflict) {
    releaseQueue();
    return { success: false, conflict: true, message: "memory.md changed while you were editing. Your draft is still here. Copy your changes, then reload the latest version." };
  }
  if (!result.success) { releaseQueue(); return { success: false, message: result.message }; }
  try { await params.beforeEffect(); } catch (error) { releaseQueue(); throw error; }
  if (!isVaultSessionEpochCurrent(epoch)) { releaseQueue(); return { success: false, message: "Unlock your vault to reopen memory.md." }; }
  const pending = applyPendingMemory(markdown, sourceSummaries, queue.jobs);
  cacheDocument({ userId: params.userId, markdown: pending.markdown, sourceSummaries: pending.sourceSummaries, deletedFactLabels, pwmClaims, updatedAt: result.updatedAt ?? new Date().toISOString(), dataVersion: result.dataVersion, persisted: true, syncStatus: syncStatus(params.userId),
    kycIntakeCompletedAt: queue.jobs.some(job => job.completeKycIntake)
      ? peekMarkdownMemory(params.userId)?.kycIntakeCompletedAt ?? kycIntakeCompletedAt : kycIntakeCompletedAt });
  releaseQueue();
  return { success: true, markdown };
}

export function markdownMemoryToAgentContext(
  memory: CachedMarkdownMemory,
): AgentPkmContext {
  const excluded = new Set<string>();
  for (const source of Object.values(memory.sourceSummaries ?? {})) for (const fact of source.facts) {
    try { assertLightweightReceiptFacts([fact]); } catch { excluded.add(fact); }
  }
  const markdown = memory.markdown.split("\n").filter(line => !excluded.has(line.trim().replace(/^[-*]\s+/, ""))).join("\n");
  const bulletCount = markdown.split("\n").filter((line) => /^\s*[-*]\s+/.test(line)).length;
  const usedChars = markdown.length;
  return {
    text: markdown,
    domains: [MARKDOWN_MEMORY_DOMAIN],
    totalAttributes: bulletCount,
    updatedAt: memory.updatedAt,
    detailCount: bulletCount,
    source: "decrypted_session_pkm",
    mode: "full",
    coverage: {
      totalFactCount: bulletCount,
      matchedFactCount: bulletCount,
      selectedFactCount: bulletCount,
      omittedFactCount: 0,
      domainCount: 1,
      listedDomainCount: 1,
      omittedDomainCount: 0,
      skippedFactCount: 0,
      safetyOmittedNodeCount: 0,
      budgetChars: MAX_MARKDOWN_MEMORY_CHARS,
      usedChars,
      clipped: false,
      inventoryOnly: false,
      valueTruncatedCount: 0,
    },
  };
}

export function clearMarkdownMemory(userId?: string): void {
  memoryGeneration += 1;
  for (const [ownerId, queue] of syncQueues) {
    if (userId && userId !== ownerId) continue;
    if (queue.timer) clearTimeout(queue.timer);
    queue.jobs.length = 0;
    syncQueues.delete(ownerId);
  }
  loads.clear();
  recoveryLoads.clear();
  for (const [ownerId, observer] of observers) {
    if (userId && userId !== ownerId) continue;
    observer.unsubscribe(); observers.delete(ownerId);
  }
  if (userId) cache.delete(userId);
  else cache.clear();
  if (userId) notifyMemory(userId);
  else listeners.forEach((_entries, ownerId) => notifyMemory(ownerId));
}
