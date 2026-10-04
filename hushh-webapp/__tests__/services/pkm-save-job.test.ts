import "fake-indexeddb/auto";

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A long explicit memory save runs as a resumable job. Production 2026-09-29: a
 * ~17 KB pasted context transfer lost every section that was still unprepared
 * at the 300 s / 8 min deadlines, and a degraded section was filed as
 * unreadable instead of retried. Every line of the owner's text must end up
 * saved, accounted for with a reason, or shown as "not yet saved" with Retry.
 * All content here is synthetic.
 */

const mocks = vi.hoisted(() => ({ preview: vi.fn(), add: vi.fn() }));

vi.mock("@/lib/agent/agent-pkm-memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/agent-pkm-memory")>()),
  previewAgentPkmMemory: mocks.preview,
  addToPKM: mocks.add,
}));

import type { AgentPkmPreviewCard, AgentPkmSaveResult } from "@/lib/agent/agent-pkm-memory";
import { runExplicitPkmSave } from "@/lib/agent/agent-pkm-explicit-save";
import { sha256Hex } from "@/lib/personal-knowledge-model/mutation-plan";
import { computePkmLineCoverage, locatePkmQuote } from "@/lib/pkm/pkm-save-coverage";
import {
  addPkmSaveJobReprepareSteps,
  buildPkmSaveJobCoverage,
  buildPkmSaveJobReceipt,
  createPkmSaveJob,
  loadPkmSaveJob,
  persistPkmSaveJob,
  resumeExplicitPkmSaveJob,
  retryPkmSaveJob,
  retryPkmSaveJobLines,
  runPkmSaveJob,
  startExplicitPkmSaveJob,
  withPkmSaveJobLock,
  type PkmSaveJob,
  type PkmSaveJobDeps,
} from "@/lib/pkm/pkm-save-job";
import { sourceChunkRange, sourceChunkText } from "@/lib/pkm/pkm-source-chunks";
import { planSecretCaptures, UnguardedSecretError } from "@/lib/pkm/secret-span-guard";
import { ApiService } from "@/lib/services/api-service";

const USER = "owner-synthetic";
const VAULT_KEY = "ab".repeat(32);
const MARK = "Synthetic-QZX-7";
const NOT_KNOWN = "# Information not known";
const REPEATED = "- Housing fact 1: synthetic detail 1 for Housing";
const KNOWN = "- Food fact 2: synthetic detail 2 for Food";

const TOPICS = [
  "Identity basics", "Work and role", "Company", "Product", "Core stack", "Infrastructure", "Vendors",
  "People", "Metrics", "Compensation", "Immigration", "Housing", "Health habits", "Food", "Travel",
  "Learning", "Communication style", "Goals", "Projects", "Information not known",
];

/** Founder-shaped: a title, 20 `#` sections, a 25-bullet stack, a disclaimer, a repeat. */
function founderShapedDocument(): string {
  const parts = [`Personal context transfer for One (${MARK})`, ""];
  for (const topic of TOPICS) {
    parts.push(`# ${topic}`);
    if (topic === "Core stack") {
      for (let index = 1; index <= 25; index += 1) parts.push(`- Stack item ${index}: synthetic tool ${index} for layer ${index}`);
    } else if (topic === "Information not known") {
      parts.push("I do not have reliable information for:", "- Exact home street address", "- Passwords or keys", "- Exact salary history");
    } else {
      for (let index = 1; index <= 4; index += 1) parts.push(`- ${topic} fact ${index}: synthetic detail ${index} for ${topic}`);
      if (topic === "Travel") parts.push(REPEATED);
      parts.push(`Background: ${Array.from({ length: 6 }, (_, index) =>
        `The ${topic.toLowerCase()} note ${index + 1} describes a synthetic routine with ordinary words and no identifiers at all.`,
      ).join(" ")}`);
    }
    parts.push("");
  }
  return parts.join("\n");
}

const SOURCE = founderShapedDocument();

/** Stand-in for the memory agents: one exact quote per stated fact, at most eight per call. */
function simulatedAgent(message: string) {
  const facts: string[] = [];
  const notMemory: Array<{ quote: string; reason: "duplicate" | "disclaimer" }> = [];
  const heading = /^#\s+(.+)$/m.exec(message)?.[1] ?? "context";
  for (const line of message.split("\n")) {
    if (!line.trim() || /^#{1,6}\s/.test(line)) continue;
    if (heading === "Information not known") notMemory.push({ quote: line, reason: "disclaimer" });
    else if (heading === "Travel" && line === REPEATED) notMemory.push({ quote: line, reason: "duplicate" });
    else if (line.startsWith("Background: ")) facts.push(...(line.match(/[^.]+\./g) ?? []));
    else facts.push(line);
  }
  const domain = heading.toLowerCase().replace(/[^a-z]+/g, "_");
  return {
    agent_id: "agent_memory_segmentation", agent_name: "Memory", model: "stub", used_fallback: false,
    cards: facts.slice(0, 8).map((quote, index): AgentPkmPreviewCard => ({
      card_id: `c${index}`, source_text: quote, write_mode: "can_save", target_domain: domain,
      candidate_payload: { note: quote.replace(/^-\s*/, "").trim() }, structure_decision: { target_domain: domain },
      merge_decision: { merge_mode: "create_entity" }, primary_json_path: `${domain}.note_${index + 1}`,
    })),
    preview_summary: {
      total_segments_detected: facts.length,
      split_recommended: facts.length > 8, has_more_candidates: facts.length > 8, not_memory: notMemory,
    },
  };
}

/** The server: one write per commit id; a second write under the same id is refused. */
function fakeServer() {
  const writes = new Map<string, number>();
  let version = 0;
  const commit = vi.fn(async ({ cards, idempotencyScopes }: { cards: AgentPkmPreviewCard[]; idempotencyScopes?: readonly (string | undefined)[] }) => {
    const results: AgentPkmSaveResult["results"] = cards.map((card, index) => {
      // The one-shot save sends no scope: every call is then a fresh write.
      const scope = idempotencyScopes?.[index] ?? `unscoped_${writes.size}_${card.card_id}`;
      if (writes.has(scope)) {
        return { cardId: card.card_id, domain: "", scope: null, sharingPosture: "", success: false, message: "pkm_commit_id_binding_mismatch" };
      }
      version += 1;
      writes.set(scope, version);
      return {
        cardId: card.card_id, domain: String(card.target_domain), scope: null, sharingPosture: "", success: true, outcome: "saved",
        result: { saveState: "saved", success: true, dataVersion: version, fullBlob: {}, commitId: `commit_${version}` },
      };
    });
    const saved = results.filter((result) => result.success).length;
    return { attempted: cards.length, saved, failed: cards.length - saved, domains: [], results };
  });
  return { writes, commit };
}

function harness(overrides: Partial<PkmSaveJobDeps> = {}) {
  const server = fakeServer();
  const state = { clock: Date.now(), unlocked: true };
  const deps: PkmSaveJobDeps = {
    prepare: vi.fn(async ({ text }: { text: string }) => {
      state.clock += 2_000;
      return simulatedAgent(text);
    }),
    commit: server.commit,
    persist: (job) => persistPkmSaveJob(job, VAULT_KEY),
    isUnlocked: () => state.unlocked,
    findDuplicate: (candidate) => (candidate === KNOWN ? { kind: "exact", domain: "food", path: ["breakfast"] } : null),
    now: () => state.clock,
    sleep: async (ms) => {
      state.clock += ms;
    },
    ...overrides,
  };
  return { server, state, deps };
}

async function newJob(now = Date.now()): Promise<PkmSaveJob> {
  return createPkmSaveJob({ userId: USER, message: SOURCE, currentDomains: [], assistantMessageId: "message-1", now });
}

/** Same schema as the service, so opening it here never leaves a store-less database. */
function openSecureCache(): IDBOpenDBRequest {
  const request = indexedDB.open("hushh-secure-resource-cache", 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore("resource_cache", { keyPath: "key" }).createIndex("userId", "userId", { unique: false });
  };
  return request;
}

/** Empty the store in place: the service keeps its connections open, so a delete would block. */
function clearSecureCache(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = openSecureCache();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("resource_cache")) {
        database.close();
        resolve();
        return;
      }
      const transaction = database.transaction("resource_cache", "readwrite");
      transaction.objectStore("resource_cache").clear();
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    };
  });
}

function rawCacheRecords(): Promise<Array<{ key: string }>> {
  return new Promise((resolve, reject) => {
    const request = openSecureCache();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("resource_cache")) {
        database.close();
        resolve([]);
        return;
      }
      const all = database.transaction("resource_cache", "readonly").objectStore("resource_cache").getAll();
      all.onsuccess = () => {
        resolve(all.result as Array<{ key: string }>);
        database.close();
      };
      all.onerror = () => reject(all.error);
    };
  });
}

beforeEach(() => {
  mocks.preview.mockReset();
  mocks.add.mockReset();
});

afterEach(async () => {
  await clearSecureCache();
  localStorage.clear();
  sessionStorage.clear();
});

describe("line coverage", () => {
  it("maps a repeated quote to its own occurrence and needs every word quoted", () => {
    const source = "# Pets\n- Dog: Rex\n- Dog: Rex\n- Cat: Tom and Ivy\n";
    const range = { start: 0, end: source.length };
    const first = locatePkmQuote({ source, range, quote: "Dog: Rex", cursor: 0 })!;
    const second = locatePkmQuote({ source, range, quote: "Dog: Rex", cursor: first.end })!;
    expect(second.start).toBeGreaterThan(first.start);
    const coverage = computePkmLineCoverage({
      source,
      spans: [
        { ...first, kind: "committed", cardId: "a" },
        { ...second, kind: "not_memory", reason: "duplicate" },
        // Negative control: "and Ivy" is never quoted, so the line is not saved.
        { ...locatePkmQuote({ source, range, quote: "Cat: Tom" })!, kind: "committed", cardId: "b" },
      ],
      destinations: new Map([["a", { cardId: "a", domain: "pets", path: "pets.dog", commitId: "commit_1" }]]),
    });
    expect(coverage.lines.map((line) => line.status)).toEqual(["structure", "saved", "not_memory", "not_yet_saved"]);
    expect(coverage.lines[1]!.destinations).toEqual([{ cardId: "a", domain: "pets", path: "pets.dog", commitId: "commit_1" }]);
    expect(coverage.accounted).toBe(3);
  });
});

describe("resumable explicit save job", () => {
  it("accounts for every line of a founder-shaped document", async () => {
    expect(SOURCE.length).toBeGreaterThan(15_000);
    expect(SOURCE.length).toBeLessThan(19_000);
    const { deps, server } = harness();
    const job = await newJob();
    const outcome = await runPkmSaveJob(job, deps);
    expect(outcome.paused).toBeNull();
    expect(job.state).toBe("completed");

    const { coverage } = buildPkmSaveJobCoverage(job);
    expect(coverage.totals.not_yet_saved).toBe(0);
    expect(coverage.totals.held).toBe(0);
    expect(coverage.accounted).toBe(coverage.totals.lines);
    expect(coverage.totals).toEqual({ lines: 141, saved: 115, not_memory: 6, structure: 20, held: 0, not_yet_saved: 0 });
    // The 25-bullet stack was split past the eight-fact cap, and every bullet landed.
    const stackLines = coverage.lines.filter((line) => SOURCE.slice(line.start, line.end).startsWith("- Stack item"));
    expect(stackLines).toHaveLength(25);
    expect(stackLines.every((line) => line.status === "saved" && line.destinations[0]?.commitId)).toBe(true);
    const reasonOf = (text: string) =>
      coverage.lines.find((line) => SOURCE.slice(line.start, line.end).trimEnd() === text)?.reason;
    expect(reasonOf("- Passwords or keys")).toBe("disclaimer");
    expect(reasonOf(KNOWN)).toBe("already_known");
    expect(reasonOf(NOT_KNOWN)).toBe("heading");

    const { receipt } = buildPkmSaveJobReceipt(job);
    expect(receipt.saved).toBe(server.writes.size);
    expect(receipt.coverage).toMatchObject({ totalLines: 141, accountedLines: 141, notYetSavedLines: 0, jobState: "completed" });
    expect(receipt.unprepared).toBe(0);
    // Completed jobs leave nothing behind in the encrypted cache.
    expect(await loadPkmSaveJob(USER, job.id, VAULT_KEY)).toBeNull();
  });

  it("turns a timeout and a degraded answer into retries, and a deadline into a pause", async () => {
    // Negative control, the one-shot save: a section still unprepared at the
    // preparation budget, and a degraded one, are reported and never saved.
    const hang = (signal?: AbortSignal) => new Promise<never>((_, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")), { once: true });
    });
    mocks.preview.mockImplementation(async ({ message, signal }: { message: string; signal?: AbortSignal }) => {
      if (message.startsWith("# Core stack")) return hang(signal);
      const answer = simulatedAgent(message);
      return message.startsWith("# Vendors") ? { ...answer, used_fallback: true } : answer;
    });
    mocks.add.mockImplementation(fakeServer().commit);
    const oneShot = await runExplicitPkmSave({
      userId: USER, message: SOURCE, currentDomains: [], vaultKey: VAULT_KEY, vaultOwnerToken: "token", preparationBudgetMs: 400,
    });
    expect(oneShot.receipt.unprepared).toBeGreaterThan(0);

    let stackAttempts = 0;
    let vendorAttempts = 0;
    const { deps, state } = harness({
      prepareTimeoutMs: 25,
      prepare: vi.fn(async ({ text, signal }: { text: string; signal: AbortSignal }) => {
        state.clock += 2_000;
        if (text.startsWith("# Core stack") && (stackAttempts += 1) === 1) return hang(signal);
        if (text.startsWith("# Vendors") && (vendorAttempts += 1) === 1) return { ...simulatedAgent(text), used_fallback: true };
        return simulatedAgent(text);
      }),
    });
    const job = await newJob(state.clock);
    const first = await runPkmSaveJob(job, deps, { pauseAt: state.clock + 20_000 });
    expect(first.paused).toBe("deadline");
    const paused = buildPkmSaveJobReceipt(job).receipt.coverage!;
    expect(paused.notYetSavedLines).toBeGreaterThan(0);

    // A reload: a fresh runner continues from the encrypted record.
    const reloaded = (await loadPkmSaveJob(USER, job.id, VAULT_KEY))!;
    expect(reloaded.steps.some((step) => step.state === "committed")).toBe(true);
    const second = await runPkmSaveJob(reloaded, deps);
    expect(second.paused).toBeNull();
    expect(reloaded.state).toBe("completed");
    expect(stackAttempts).toBeGreaterThan(1);
    // The degraded section was asked again (then split), never filed as unreadable.
    expect(vendorAttempts).toBeGreaterThan(1);
    const { coverage } = buildPkmSaveJobCoverage(reloaded);
    expect(coverage.accounted).toBe(coverage.totals.lines);
    expect(coverage.lines.filter((line) => SOURCE.slice(line.start, line.end).startsWith("- Vendors fact"))
      .every((line) => line.status === "saved")).toBe(true);
    expect(buildPkmSaveJobReceipt(reloaded).receipt.unreadable).toBe(0);
  });

  it("pauses on a relock mid-job and finishes after unlock without a second write", async () => {
    // Negative control, the one-shot save: a relock during writing loses them.
    mocks.preview.mockImplementation(async ({ message }: { message: string }) => simulatedAgent(message));
    mocks.add.mockImplementation(async ({ cards }: { cards: AgentPkmPreviewCard[] }) => ({
      attempted: cards.length, saved: 0, failed: cards.length, domains: [],
      results: cards.map((card) => ({ cardId: card.card_id, domain: "", scope: null, sharingPosture: "", success: false })),
    }));
    const oneShot = await runExplicitPkmSave({ userId: USER, message: SOURCE, currentDomains: [], vaultKey: VAULT_KEY, vaultOwnerToken: "token" });
    expect(oneShot.receipt.saved).toBe(0);
    expect(oneShot.receipt.failed).toBeGreaterThan(0);

    const { deps, server, state } = harness();
    let commits = 0;
    deps.commit = vi.fn(async (params) => {
      if ((commits += 1) === 3) {
        // The vault locked mid-write: the coordinator's guard refuses every card.
        state.unlocked = false;
        return { attempted: params.cards.length, saved: 0, failed: params.cards.length, domains: [],
          results: params.cards.map((card) => ({ cardId: card.card_id, domain: "", scope: null, sharingPosture: "", success: false })) };
      }
      return server.commit(params);
    });
    const job = await newJob(state.clock);
    const first = await runPkmSaveJob(job, deps);
    expect(first.paused).toBe("locked");
    const stored = (await loadPkmSaveJob(USER, job.id, VAULT_KEY))!;
    expect(stored.state).toBe("paused_locked");
    expect(stored.steps.filter((step) => step.state === "prepared")).toHaveLength(1);
    expect(buildPkmSaveJobReceipt(stored).receipt.coverage!.notYetSavedLines).toBeGreaterThan(0);

    state.unlocked = true;
    const resumed = await runPkmSaveJob(stored, deps);
    expect(resumed.paused).toBeNull();
    expect(stored.state).toBe("completed");
    const { coverage } = buildPkmSaveJobCoverage(stored);
    expect(coverage.accounted).toBe(coverage.totals.lines);
    expect(buildPkmSaveJobReceipt(stored).receipt.saved).toBe(server.writes.size);
  });

  it("never writes a replayed step twice and never counts an unconfirmed write", async () => {
    const { deps, server, state } = harness();
    let dropped = false;
    deps.commit = vi.fn(async (params) => {
      const result = await server.commit(params);
      // The first write lands on the server, then the connection drops.
      if (!dropped) {
        dropped = true;
        throw new TypeError("network dropped after commit");
      }
      return result;
    });
    const job = await newJob(state.clock);
    await runPkmSaveJob(job, deps);
    const firstScopes = (deps.commit as ReturnType<typeof vi.fn>).mock.calls[0]![0].idempotencyScopes as string[];
    const replays = (deps.commit as ReturnType<typeof vi.fn>).mock.calls
      .map(([params]) => params.idempotencyScopes as string[])
      .filter((scopes) => scopes[0] === firstScopes[0]);
    expect(replays.length).toBeGreaterThan(1);
    expect(replays.every((scopes) => JSON.stringify(scopes) === JSON.stringify(firstScopes))).toBe(true);
    // The scope is sha256(jobId, span) plus the card's place in the step.
    const replayedStep = job.steps.find((step) => firstScopes[0]!.startsWith(`${step.id}:`))!;
    const range = sourceChunkRange(replayedStep.chunk);
    expect(replayedStep.id).toBe(await sha256Hex(`${job.id}:${range.start}:${range.end}`));
    // One write per scope on the server, and the receipt counts only acknowledged commits.
    const { receipt } = buildPkmSaveJobReceipt(job);
    expect(receipt.saved).toBe(server.writes.size - firstScopes.length);
    expect(receipt.coverage!.notYetSavedLines).toBeGreaterThan(0);
    expect(job.state).toBe("completed_with_gaps");

    // Re-running a finished job, or racing a second runner, does nothing new.
    const calls = (deps.commit as ReturnType<typeof vi.fn>).mock.calls.length;
    await runPkmSaveJob(job, deps);
    expect((deps.commit as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
    let release!: () => void;
    const holder = withPkmSaveJobLock(job.id, () => new Promise<string>((resolve) => {
      release = () => resolve("first");
    }));
    expect(await withPkmSaveJobLock(job.id, async () => "second")).toBeNull();
    release();
    expect(await holder).toBe("first");
  });

  it("counts a write the device never heard back about once the server confirms it", async () => {
    // The previous test is the negative control: with no lookup, the same lost
    // answer leaves the step "not yet saved" and the job completed_with_gaps.
    const { deps, server, state } = harness();
    let dropped = false;
    deps.commit = vi.fn(async (params) => {
      const result = await server.commit(params);
      if (!dropped) {
        dropped = true;
        throw new TypeError("network dropped after commit");
      }
      return result;
    });
    const lookups: string[][] = [];
    deps.lookupCommits = vi.fn(async ({ idempotencyScopes }: { idempotencyScopes: string[] }) => {
      lookups.push(idempotencyScopes);
      return idempotencyScopes.map((scope) => {
        const version = server.writes.get(scope);
        return version === undefined ? null : { dataVersion: version };
      });
    });
    const job = await newJob(state.clock);
    await runPkmSaveJob(job, deps);

    expect(job.state).toBe("completed");
    expect(lookups).toHaveLength(1);
    const { receipt } = buildPkmSaveJobReceipt(job);
    expect(receipt.saved).toBe(server.writes.size);
    expect(receipt.coverage!.notYetSavedLines).toBe(0);
    const confirmed = job.steps.flatMap((step) => Object.values(step.commits ?? {}))
      .filter((commit) => commit.confirmedBy === "lookup");
    expect(confirmed.length).toBe(lookups[0]!.length);
    expect(confirmed.every((commit) => commit.dataVersion > 0 && commit.commitId === null)).toBe(true);
    // Each detail was written exactly once.
    expect(new Set(server.writes.values()).size).toBe(server.writes.size);
  });

  it("keeps the job only in the vault-encrypted cache, never in web storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    mocks.preview.mockImplementation(async ({ message }: { message: string }) => simulatedAgent(message));
    const server = fakeServer();
    mocks.add.mockImplementation(server.commit);
    const started = await startExplicitPkmSaveJob({
      userId: USER, message: SOURCE, currentDomains: [], vaultKey: VAULT_KEY, vaultOwnerToken: "token",
      assistantMessageId: "message-1", pauseAt: Date.now() - 1,
    });
    expect(started.paused).toBe("deadline");

    const records = await rawCacheRecords();
    expect(records.length).toBe(2);
    expect(records.every((record) => record.key.startsWith(`${USER}:pkm_save_job:v1:`))).toBe(true);
    expect(JSON.stringify(records)).not.toContain(MARK);
    // Control: the decrypted job does hold the owner's text.
    expect(JSON.stringify(await loadPkmSaveJob(USER, started.jobId, VAULT_KEY))).toContain(MARK);

    const finished = (await resumeExplicitPkmSaveJob({
      userId: USER, jobId: started.jobId, vaultKey: VAULT_KEY, vaultOwnerToken: "token",
    }))!;
    expect(finished.jobState).toBe("completed");
    expect(finished.receipt.coverage!.accountedLines).toBe(finished.receipt.coverage!.totalLines);
    const createdAt = new Date(JSON.parse(JSON.stringify(mocks.add.mock.calls[0]![0])).confirmation.confirmedAt).getTime();
    expect(mocks.add.mock.calls.every(([params]) => params.idempotencyScopes.length === params.cards.length &&
      new Date(params.confirmation.confirmedAt).getTime() === createdAt)).toBe(true);

    expect(await rawCacheRecords()).toEqual([]);
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    setItem.mockRestore();
  });
});

/**
 * Secrets meet the save job. The device guard keeps a pasted secret in Secrets
 * and leaves a placeholder; the job record, every preparation call and every
 * commit must carry that placeholder only. Values are assembled from parts.
 */
describe("Secrets placeholders through the resumable save job", () => {
  const join = (...parts: string[]) => parts.join("");
  const TOKEN = join("gh", "p_", "fakefake0000fakefake0000fakefake4f2a");
  const PASSPORT = join("X12", "34567");
  const RAW = [
    "# Work context",
    `- CI deploy token: ${TOKEN}`,
    `- My passport ${PASSPORT} is renewed every ten years`,
    "- The product runs on Postgres and Next.js",
  ].join("\n");

  it("persists, prepares and commits only the placeholders the guard left", async () => {
    let counter = 0;
    const plan = planSecretCaptures([RAW], { idFactory: () => `sec_${(counter += 1).toString(16).padStart(16, "0")}` });
    expect(plan.captures).toHaveLength(2);
    const [guarded] = plan.render();
    mocks.preview.mockImplementation(async ({ message }: { message: string }) => simulatedAgent(message));
    const server = fakeServer();
    mocks.add.mockImplementation(server.commit);

    const started = await startExplicitPkmSaveJob({
      userId: USER, message: guarded!, currentDomains: [], vaultKey: VAULT_KEY, vaultOwnerToken: "token",
      assistantMessageId: "message-secrets", pauseAt: Date.now() - 1,
    });
    const stored = JSON.stringify(await loadPkmSaveJob(USER, started.jobId, VAULT_KEY));
    expect(stored).toContain("⟦secret:sec_0000000000000001");
    for (const value of [TOKEN, PASSPORT]) expect(stored).not.toContain(value);

    const finished = (await resumeExplicitPkmSaveJob({
      userId: USER, jobId: started.jobId, vaultKey: VAULT_KEY, vaultOwnerToken: "token",
    }))!;
    expect(finished.jobState).toBe("completed");
    expect(finished.receipt.coverage!.notYetSavedLines).toBe(0);
    const sent = JSON.stringify([mocks.preview.mock.calls, mocks.add.mock.calls]);
    expect(sent).toContain("⟦secret:");
    for (const value of [TOKEN, PASSPORT]) expect(sent).not.toContain(value);
  });

  it("refuses to open a job, or write its record, for text that still holds a raw secret", async () => {
    await expect(
      startExplicitPkmSaveJob({
        userId: USER, message: RAW, currentDomains: [], vaultKey: VAULT_KEY, vaultOwnerToken: "token",
      }),
    ).rejects.toBeInstanceOf(UnguardedSecretError);
    expect(await rawCacheRecords()).toEqual([]);
    expect(mocks.preview).not.toHaveBeenCalled();
  });
});


/**
 * A founder-shaped context transfer, answered by the REAL server pipeline.
 *
 * `context-transfer.recording.v1.json` holds what `/api/pkm/memory/proposals`
 * returned for each step text: the backend's own segmentation sanitizer and
 * structure normalization, driven by scripted memory agents
 * (`consent-protocol/tests/services/context_transfer_agents.py`, which also
 * proves every recorded answer is still what the server produces). Here the
 * answers go through the real client: preview normalization, the explicit-save
 * partition, the resumable job and the line coverage. Synthetic content only.
 */
describe("context transfer, recorded from the memory agents", () => {
  const FIXTURES = path.resolve(__dirname, "../fixtures/pkm");
  const DOCUMENT = readFileSync(path.join(FIXTURES, "context-transfer.v1.md"), "utf8");
  const RECORDING_PATH = path.join(FIXTURES, "context-transfer.recording.v1.json");
  const RECORD = process.env.PKM_CONTEXT_TRANSFER_RECORD === "1";
  const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  type RecordedStep = { text: string; answer: Record<string, unknown> };
  type Recording = { version: 1; document_sha256: string; steps: Record<string, RecordedStep> };
  const recording: Recording = RECORD
    ? { version: 1, document_sha256: sha(DOCUMENT), steps: {} }
    : JSON.parse(readFileSync(RECORDING_PATH, "utf8"));

  function serverAnswer(text: string): Record<string, unknown> {
    const key = sha(text);
    if (!recording.steps[key]) {
      if (!RECORD) throw new Error("No recorded server answer for this step; re-record (context_transfer_agents.py).");
      const backend = path.resolve(__dirname, "../../../consent-protocol");
      const output = execFileSync(path.join(backend, ".venv/bin/python"), ["-m", "tests.services.context_transfer_agents"], {
        cwd: backend,
        input: text,
        env: {
          ...process.env,
          TESTING: "true",
          APP_SIGNING_KEY: "test_secret_key_for_pytest_only_32chars_min",
          VAULT_DATA_KEY: "0".repeat(64),
        },
      });
      recording.steps[key] = { text, answer: JSON.parse(output.toString("utf8")) };
    }
    return { agent_id: "agent_pkm_structure", agent_name: "PKM Structure Agent", model: "recorded", ...recording.steps[key]!.answer };
  }

  async function runRecorded(transform: (answer: Record<string, unknown>) => Record<string, unknown> = (answer) => answer) {
    const actual = await vi.importActual<typeof import("@/lib/agent/agent-pkm-memory")>("@/lib/agent/agent-pkm-memory");
    const fetch = vi.spyOn(ApiService, "apiFetch").mockImplementation(async (url: string, init?: RequestInit) => {
      expect(url).toBe("/api/pkm/memory/proposals");
      const { message } = JSON.parse(String(init?.body)) as { message: string };
      return new Response(JSON.stringify(transform(serverAnswer(message))), { status: 200 });
    });
    // The real client preview (normalization, secret check), the real partition
    // and job; only the network answer is recorded and the write is faked.
    const { deps, server, state } = harness({
      prepare: ({ text, signal }) =>
        actual.previewAgentPkmMemory({ userId: USER, message: text, currentDomains: [], vaultOwnerToken: "token", signal }),
    });
    const job = await createPkmSaveJob({ userId: USER, message: DOCUMENT, currentDomains: [], now: state.clock });
    await runPkmSaveJob(job, deps);
    fetch.mockRestore();
    return { job, server, coverage: buildPkmSaveJobCoverage(job).coverage, receipt: buildPkmSaveJobReceipt(job).receipt };
  }

  it("saves every stated line or accounts for it, with zero unaccounted", async () => {
    expect(DOCUMENT.length).toBeGreaterThan(15_000);
    expect((DOCUMENT.match(/^# /gm) ?? []).length).toBe(20);
    if (!RECORD) expect(recording.document_sha256).toBe(sha(DOCUMENT));

    const { job, server, coverage, receipt } = await runRecorded();
    if (RECORD) {
      // One step per line: compact, and a re-record diffs step by step.
      const steps = Object.keys(recording.steps).sort()
        .map((key) => `  ${JSON.stringify(key)}: ${JSON.stringify(recording.steps[key])}`).join(",\n");
      writeFileSync(RECORDING_PATH,
        `{\n "version": 1,\n "document_sha256": ${JSON.stringify(recording.document_sha256)},\n "steps": {\n${steps}\n }\n}\n`);
    }

    expect(job.state).toBe("completed");
    expect(coverage.totals.not_yet_saved).toBe(0);
    expect(coverage.totals.held).toBe(0);
    expect(coverage.accounted).toBe(coverage.totals.lines);
    expect(receipt.coverage).toMatchObject({ notYetSavedLines: 0, heldLines: 0, accountedLines: coverage.totals.lines });
    expect(receipt.needsOwner).toBe(0);
    expect(receipt.saved).toBe(server.writes.size);

    const source = job.source;
    const lineOf = (text: string) => {
      const matches = coverage.lines.filter(
        (line) => source.slice(line.start, line.end).trimEnd() === text,
      );
      expect(matches.length, text).toBeGreaterThan(0);
      return matches;
    };
    const saved = (text: string) => {
      const [line] = lineOf(text);
      expect(line!.status, text).toBe("saved");
      expect(line!.destinations[0]?.domain, text).toBeTruthy();
      return line!.destinations[0]!;
    };
    // Work context, technical identifiers and people are memory.
    for (const text of [
      "- Backend: FastAPI on Python 3.13",
      "- Design: Figma with a shared component library",
      "- GCP project: lumen-demo-482910 in region us-central1",
      "- The API reads its signing key from the LUMEN_SIGNING_KEY environment variable",
      "- The Google OAuth callback is https://app.lumen-demo.dev/api/auth/callback/google",
      "- The iOS bundle identifier is com.lumendemo.one and the Android app id is com.lumendemo.one.android",
      "- The monorepo has about 9,800 commits since May 2022",
      "- The local mixture-of-experts model runs at about 62 tokens per second on that laptop",
      "- Asha Varma is our CTO in all but title and owns the data platform",
      "- Daniel Cho at Harbor Light Ventures is our board member and lead investor",
      "- I code every day with Claude Code and Gemini CLI, usually in two terminals side by side",
    ]) saved(text);
    // Sensitive details are saved, without a tap.
    for (const text of [
      "- Base salary: USD 185,000 per year, set by the board in March 2026",
      "- My I-140 was approved on 2024-02-11 in the EB-2 category",
      "- The security deposit was USD 4,800, held by the landlord until the lease ends",
    ]) saved(text);
    // A quote returned with its Markdown cleaned, or its dash flattened, still lands.
    saved("- **Preferred name:** Rowan Ellery, and I go by Ro with close friends");
    saved("- **Role:** Founder and CEO of Lumen Ledger \u2014 I also act as the de facto head of engineering");
    // A protocol-named subject is kept in a real domain.
    expect(saved("- Our agents are orchestrated with Google ADK and talk to each other over A2A").domain).toBe("professional");
    // The masked secret's line is saved as the placeholder, never a value.
    saved("- Our GitHub deploy token is \u27e6secret:sec_00000000000000a1 GitHub deploy token ending 9f3c\u27e7 and it rotates every 90 days");
    const committed = JSON.stringify(server.commit.mock.calls);
    expect(committed).toContain("\u27e6secret:sec_00000000000000a1");
    // The disclaimer and the repeat are accounted for, not saved.
    expect(lineOf("- Information not known: my exact home street address")[0]!.reason).toBe("disclaimer");
    const repeat = lineOf("- Stripe for payments and Twilio for SMS verification codes");
    expect(repeat.map((line) => line.status)).toEqual(["saved", "not_memory"]);
    expect(repeat[1]!.reason).toBe("duplicate");
  }, RECORD ? 600_000 : 30_000);

  it("negative control: without not_memory and context quotes the same answers leave gaps", async () => {
    // What the device received before this release: no not_memory list and no
    // context quotes. The disclaimer and the repeated line read "not yet saved".
    const { job, coverage } = await runRecorded((answer) => ({
      ...answer,
      preview_summary: { ...(answer.preview_summary as Record<string, unknown>), not_memory: [] },
      preview_cards: (answer.preview_cards as Array<Record<string, unknown>>).map(({ context_quotes: _drop, ...card }) => card),
    }));
    expect(job.state).toBe("completed_with_gaps");
    expect(coverage.totals.not_yet_saved).toBeGreaterThan(0);
  });
});

/**
 * A step can commit while lines inside it stay unaccounted: the agents dropped
 * a segment, or its quote did not match the owner's text
 * (`preview_summary.unmatched_quote_count`). Before 2026-10-02 the owner's Retry
 * re-ran only failed steps, so those lines read "not yet saved" for good. All
 * content is synthetic.
 */
describe("re-preparing lines a committed step left unaccounted", () => {
  const NOTE = [
    "# Work (synthetic)",
    "- Role: synthetic analyst",
    "- Team: synthetic platform",
    "- Office: synthetic north wing",
    "- Manager: synthetic lead",
  ].join("\n");
  const DROPPED = ["- Team: synthetic platform", "- Manager: synthetic lead"];

  /** The agents keep two of the four lines the first time they see them, then every line. */
  function droppingAgent() {
    const seen = new Set<string>();
    const texts: string[] = [];
    const answer = (message: string) => {
      texts.push(message);
      const lines = message.split("\n").filter((line) => line.startsWith("- "));
      const kept = lines.filter((line) => !(DROPPED.includes(line) && !seen.has(line)));
      lines.forEach((line) => seen.add(line));
      return {
        agent_id: "agent_memory_segmentation", agent_name: "Memory", model: "stub", used_fallback: false,
        cards: kept.map((quote, index): AgentPkmPreviewCard => ({
          card_id: `c${index}`, source_text: quote, write_mode: "can_save", target_domain: "professional",
          candidate_payload: { note: quote.replace(/^-\s*/, "") }, structure_decision: { target_domain: "professional" },
          merge_decision: { merge_mode: "create_entity" }, primary_json_path: `professional.note_${index + 1}`,
        })),
        preview_summary: { total_segments_detected: kept.length, unmatched_quote_count: lines.length - kept.length },
      };
    };
    return { answer, texts };
  }

  async function committedWithGaps() {
    const agent = droppingAgent();
    const context = harness({
      prepare: vi.fn(async ({ text }: { text: string }) => agent.answer(text)),
      findDuplicate: () => null,
    });
    const job = await createPkmSaveJob({ userId: USER, message: NOTE, currentDomains: [], now: context.state.clock });
    await runPkmSaveJob(job, context.deps);
    return { ...context, agent, job };
  }

  const commitCalls = (deps: PkmSaveJobDeps) =>
    (deps.commit as ReturnType<typeof vi.fn>).mock.calls.map(([params]) => params.idempotencyScopes as string[]);

  it("starts from a committed step with two unaccounted lines", async () => {
    const { job, server } = await committedWithGaps();
    expect(job.steps).toHaveLength(1);
    expect(job.steps[0]).toMatchObject({ state: "committed", unmatchedQuoteCount: 2 });
    expect(job.state).toBe("completed_with_gaps");
    expect(server.writes.size).toBe(2);
    const coverage = buildPkmSaveJobReceipt(job).receipt.coverage!;
    // The receipt offers "Retry 2 lines".
    expect(coverage.notYetSavedLines).toBe(2);
    expect(coverage.lines.filter((line) => line.status === "not_yet_saved").map((line) => line.text))
      .toEqual(["Team: synthetic platform", "Manager: synthetic lead"]);
  });

  it("negative control: the Retry before this change prepares nothing and the lines stay unsaved", async () => {
    const { job, deps, server, agent } = await committedWithGaps();
    retryPkmSaveJob(job);
    await runPkmSaveJob(job, deps);
    expect(agent.texts).toHaveLength(1);
    expect(server.writes.size).toBe(2);
    expect(buildPkmSaveJobReceipt(job).receipt.coverage!.notYetSavedLines).toBe(2);
    expect(job.state).toBe("completed_with_gaps");
  });

  it("re-prepares only the unaccounted lines on Retry, reaching every line with no duplicate write", async () => {
    const { job, deps, server, agent, state } = await committedWithGaps();
    const [parent] = job.steps;
    const parentCommits = structuredClone(parent!.commits);
    const parentScopes = commitCalls(deps)[0]!;

    await retryPkmSaveJobLines(job, state.clock);
    // Two runs (the saved Office line sits between them): two child steps.
    expect(job.steps).toHaveLength(3);
    const children = job.steps.slice(1);
    expect(children.every((child) => child.reprepareOf === parent!.id && child.generation === 1)).toBe(true);
    expect(new Set([parent!.id, ...children.map((child) => child.id)]).size).toBe(3);
    // Each child carries only its own line, with the heading that attributes it.
    expect(children.map((child) => sourceChunkText(job.source, child.chunk).trimEnd())).toEqual([
      "# Work (synthetic)\n- Team: synthetic platform",
      "# Work (synthetic)\n- Manager: synthetic lead",
    ]);

    await runPkmSaveJob(job, deps);
    expect(agent.texts.slice(1).join("\n")).not.toMatch(/Role|Office/);
    expect(job.state).toBe("completed");
    const { coverage } = buildPkmSaveJobCoverage(job);
    expect(coverage.totals.not_yet_saved).toBe(0);
    expect(coverage.accounted).toBe(coverage.totals.lines);
    expect(buildPkmSaveJobReceipt(job).receipt.coverage!.notYetSavedLines).toBe(0);
    // Four stated facts, four writes, each under its own scope.
    expect(server.writes.size).toBe(4);
    const scopes = commitCalls(deps).flat();
    expect(new Set(scopes).size).toBe(scopes.length);
    // The parent's saved cards were never sent again.
    expect(scopes.filter((scope) => scope.startsWith(`${parent!.id}:`))).toEqual(parentScopes);
    expect(parent!.commits).toEqual(parentCommits);
  });

  it("is idempotent on a double Retry", async () => {
    const { job, deps, server, agent } = await committedWithGaps();
    await retryPkmSaveJobLines(job);
    await retryPkmSaveJobLines(job);
    expect(await addPkmSaveJobReprepareSteps(job)).toEqual([]);
    expect(job.steps).toHaveLength(3);
    await runPkmSaveJob(job, deps);
    expect(server.writes.size).toBe(4);

    const prepared = agent.texts.length;
    const committed = commitCalls(deps).length;
    await retryPkmSaveJobLines(job);
    await runPkmSaveJob(job, deps);
    expect(job.steps).toHaveLength(3);
    expect(agent.texts).toHaveLength(prepared);
    expect(commitCalls(deps)).toHaveLength(committed);

    // A child's write replayed under its own scope is refused, not written twice.
    const child = job.steps[1]!;
    const replay = await server.commit({
      cards: child.cards!, idempotencyScopes: child.cards!.map((_card, index) => `${child.id}:${index}`),
    });
    expect(replay.saved).toBe(0);
    expect(server.writes.size).toBe(4);
  });

  it("works through the receipt's Retry (resume with retry)", async () => {
    const agent = droppingAgent();
    mocks.preview.mockImplementation(async ({ message }: { message: string }) => agent.answer(message));
    const server = fakeServer();
    mocks.add.mockImplementation(server.commit);
    const started = await startExplicitPkmSaveJob({
      userId: USER, message: NOTE, currentDomains: [], vaultKey: VAULT_KEY, vaultOwnerToken: "token",
      assistantMessageId: "message-1",
    });
    expect(started.jobState).toBe("completed_with_gaps");
    expect(started.receipt.coverage!.notYetSavedLines).toBe(2);

    const retried = (await resumeExplicitPkmSaveJob({
      userId: USER, jobId: started.jobId, vaultKey: VAULT_KEY, vaultOwnerToken: "token", retry: true,
    }))!;
    expect(retried.jobState).toBe("completed");
    expect(retried.receipt.coverage).toMatchObject({ notYetSavedLines: 0, accountedLines: 5, totalLines: 5 });
    expect(retried.receipt.saved).toBe(4);
    expect(server.writes.size).toBe(4);
    // Completed: nothing is left to retry, and a second tap writes nothing.
    expect(await resumeExplicitPkmSaveJob({
      userId: USER, jobId: started.jobId, vaultKey: VAULT_KEY, vaultOwnerToken: "token", retry: true,
    })).toBeNull();
    expect(server.writes.size).toBe(4);
  });
});
